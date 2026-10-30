import { execFile } from 'child_process';
import { promisify } from 'util';
import type { Request, Response } from 'express';

const execFileAsync = promisify(execFile);

export const KDS_SPEECH_MAX_TEXT = 500;
const SUPPORTED_LANG = /^[a-z]{2}(-[A-Z]{2})?$/;
const CACHE_LIMIT = 100;
const cache = new Map<string, Buffer>();

// Windows' built-in voices (including the offline Thai voice) through WinRT, returned as base64 WAV.
const SPEECH_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Media.SpeechSynthesis.SpeechSynthesizer, Windows.Media.SpeechSynthesis, ContentType = WindowsRuntime]
$null = [Windows.Storage.Streams.DataReader, Windows.Storage.Streams, ContentType = WindowsRuntime]
$asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1' } | Select-Object -First 1
function Await($op, [Type]$type) { $t = $asTask.MakeGenericMethod($type).Invoke($null, @($op)); $t.Wait(); $t.Result }
$lang = $env:FLO_TTS_LANG
$voices = [Windows.Media.SpeechSynthesis.SpeechSynthesizer]::AllVoices
$voice = $voices | Where-Object { $_.Language -eq $lang } | Select-Object -First 1
if (-not $voice) { $voice = $voices | Where-Object { $_.Language.StartsWith($lang.Substring(0, 2)) } | Select-Object -First 1 }
if (-not $voice) { exit 3 }
$synth = New-Object Windows.Media.SpeechSynthesis.SpeechSynthesizer
$synth.Voice = $voice
$stream = Await ($synth.SynthesizeTextToStreamAsync($env:FLO_TTS_TEXT)) ([Windows.Media.SpeechSynthesis.SpeechSynthesisStream])
$reader = New-Object Windows.Storage.Streams.DataReader($stream.GetInputStreamAt(0))
$size = [uint32]$stream.Size
$null = Await ($reader.LoadAsync($size)) ([uint32])
$bytes = New-Object byte[] $size
$reader.ReadBytes($bytes)
[Console]::Out.Write([Convert]::ToBase64String($bytes))
`;

const LOCAL_VOICE_TIMEOUT_MS = 30000;

/** A local voice service (such as F5-TTS-THAI) for Thai, when FloCafe is started with FLO_KDS_TTS_URL. */
export function kdsLocalVoiceUrl(): string | null {
  const url = (process.env.FLO_KDS_TTS_URL || '').trim().replace(/\/+$/, '');
  return /^https?:\/\//.test(url) ? url : null;
}

async function synthesizeWithLocalVoice(text: string, lang: string): Promise<Buffer | null> {
  const url = kdsLocalVoiceUrl();
  if (!url || !lang.toLowerCase().startsWith('th')) return null;
  try {
    const response = await fetch(`${url}/tts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(LOCAL_VOICE_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const audio = Buffer.from(await response.arrayBuffer());
    return audio.length > 0 ? audio : null;
  } catch (error) {
    console.warn('[KDS] Local voice unavailable, using the Windows voice:', (error as Error).message);
    return null;
  }
}

/** WAV audio of the text: the local voice service when set up, else this computer's own voice; null when neither speaks the language. */
export async function synthesizeKdsSpeech(text: string, lang: string): Promise<Buffer | null> {
  const local = await synthesizeWithLocalVoice(text, lang);
  if (local) return local;
  return synthesizeSystemSpeech(text, lang);
}

async function synthesizeSystemSpeech(text: string, lang: string): Promise<Buffer | null> {
  if (process.platform !== 'win32') return null;
  const key = `${lang}\n${text}`;
  const cached = cache.get(key);
  if (cached) return cached;
  try {
    const { stdout } = await execFileAsync(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(SPEECH_SCRIPT, 'utf16le').toString('base64')],
      {
        encoding: 'utf8',
        timeout: 15000,
        maxBuffer: 32 * 1024 * 1024,
        windowsHide: true,
        env: { ...process.env, FLO_TTS_TEXT: text, FLO_TTS_LANG: lang },
      },
    );
    const audio = Buffer.from(String(stdout).trim(), 'base64');
    if (audio.length === 0) return null;
    if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value as string);
    cache.set(key, audio);
    return audio;
  } catch {
    return null;
  }
}

/** GET: which voice the POS computer reads with, so displays know to prefer it over their own. */
export function handleKdsSpeechEngine(_req: Request, res: Response) {
  res.json({ engine: kdsLocalVoiceUrl() ? 'local' : 'system' });
}

/** POST { text, lang }: WAV audio, or 204 when this computer cannot speak that language. */
export async function handleKdsSpeech(req: Request, res: Response) {
  const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
  const lang = typeof req.body?.lang === 'string' ? req.body.lang : '';
  if (!text || text.length > KDS_SPEECH_MAX_TEXT || !SUPPORTED_LANG.test(lang)) {
    return res.status(400).json({ error: 'text and lang are required' });
  }
  const audio = await synthesizeKdsSpeech(text, lang);
  if (!audio) return res.status(204).end();
  res.set('Content-Type', 'audio/wav').set('Cache-Control', 'no-store').send(audio);
}

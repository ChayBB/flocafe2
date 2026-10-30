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
const VOICE_LIST_TTL_MS = 30000;

export interface KdsServerVoice {
  id: string;
  name: string;
}

/** Local voice services for Thai (such as F5-TTS-THAI or PyThaiTTS), from a comma-separated FLO_KDS_TTS_URL. */
export function kdsLocalVoiceUrls(): string[] {
  return (process.env.FLO_KDS_TTS_URL || '')
    .split(',')
    .map((url) => url.trim().replace(/\/+$/, ''))
    .filter((url) => /^https?:\/\//.test(url));
}

let voiceList: { key: string; at: number; voices: (KdsServerVoice & { url: string })[] } | null = null;

/** The local voice services that answer GET /health, named by their `engine` and `name`. */
async function kdsLocalVoices(): Promise<(KdsServerVoice & { url: string })[]> {
  const urls = kdsLocalVoiceUrls();
  const key = urls.join(',');
  if (voiceList && voiceList.key === key && Date.now() - voiceList.at < VOICE_LIST_TTL_MS) return voiceList.voices;
  const found = await Promise.all(
    urls.map(async (url, index) => {
      try {
        const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(3000) });
        if (!response.ok) return null;
        const health = (await response.json()) as { engine?: unknown; name?: unknown };
        const id = typeof health.engine === 'string' && health.engine ? health.engine : `local-${index + 1}`;
        return { id, name: typeof health.name === 'string' && health.name ? health.name : id, url };
      } catch {
        return null;
      }
    }),
  );
  const voices = found.filter((voice): voice is KdsServerVoice & { url: string } => voice !== null);
  voiceList = { key, at: Date.now(), voices };
  return voices;
}

async function synthesizeWithLocalVoice(url: string, text: string): Promise<Buffer | null> {
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
    console.warn('[KDS] Local voice unavailable at %s:', url, (error as Error).message);
    return null;
  }
}

/**
 * WAV audio of the text, or null when no voice speaks the language. Thai goes to the chosen local
 * voice service (or each one in order), then this computer's own voice; `voice: 'system'` skips them.
 */
export async function synthesizeKdsSpeech(text: string, lang: string, voice = ''): Promise<Buffer | null> {
  if (voice !== 'system' && lang.toLowerCase().startsWith('th')) {
    const urls = kdsLocalVoiceUrls();
    const chosen = voice ? (await kdsLocalVoices()).find((local) => local.id === voice)?.url : undefined;
    for (const url of chosen ? [chosen] : urls) {
      const local = await synthesizeWithLocalVoice(url, text);
      if (local) return local;
    }
  }
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

/** GET: which voices the POS computer reads with, so displays can prefer or pick one. */
export async function handleKdsSpeechEngine(_req: Request, res: Response) {
  const voices = (await kdsLocalVoices()).map(({ id, name }) => ({ id, name }));
  res.json({ engine: kdsLocalVoiceUrls().length > 0 ? 'local' : 'system', voices });
}

/** POST { text, lang, voice? }: WAV audio, or 204 when this computer cannot speak that language. */
export async function handleKdsSpeech(req: Request, res: Response) {
  const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
  const lang = typeof req.body?.lang === 'string' ? req.body.lang : '';
  const voice = typeof req.body?.voice === 'string' ? req.body.voice.slice(0, 64) : '';
  if (!text || text.length > KDS_SPEECH_MAX_TEXT || !SUPPORTED_LANG.test(lang)) {
    return res.status(400).json({ error: 'text and lang are required' });
  }
  const audio = await synthesizeKdsSpeech(text, lang, voice);
  if (!audio) return res.status(204).end();
  res.set('Content-Type', 'audio/wav').set('Cache-Control', 'no-store').send(audio);
}

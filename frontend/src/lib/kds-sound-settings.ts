import api from '@/lib/api';
import { playKdsAudio } from '@/lib/kds-alert-sound';

/** Which sounds this KDS display plays; kept per display like its stage switches. */
export interface KdsSoundSettings {
  /** Speak newly arrived menu items aloud. */
  readAloud: boolean;
  /** Beep when service staff change an item (take-away, cancel, confirmed served). */
  statusChange: boolean;
  /** Chime and announce when every item of an order is ready to serve. */
  orderReady: boolean;
}

export type KdsSoundSetting = keyof KdsSoundSettings;

const KEY = 'flocafe:kds-sound-settings';
export const DEFAULT_KDS_SOUND_SETTINGS: KdsSoundSettings = { readAloud: true, statusChange: true, orderReady: true };

export function readKdsSoundSettings(): KdsSoundSettings {
  if (typeof window === 'undefined') return DEFAULT_KDS_SOUND_SETTINGS;
  try {
    const stored = JSON.parse(window.localStorage.getItem(KEY) || '{}');
    const settings = { ...DEFAULT_KDS_SOUND_SETTINGS };
    for (const key of Object.keys(settings) as KdsSoundSetting[]) {
      if (typeof stored?.[key] === 'boolean') settings[key] = stored[key];
    }
    return settings;
  } catch {
    return DEFAULT_KDS_SOUND_SETTINGS;
  }
}

export function writeKdsSoundSettings(settings: KdsSoundSettings): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {}
}

const VOICE_WAIT_MS = 1000;
const SPEECH_TIMEOUT_MS = 20000;
let speechQueue: Promise<void> = Promise.resolve();
const serverVoiceMissing = new Set<string>();

const VOICE_KEY = 'flocafe:kds-voice';

/** The display's language for speech: Thai is spoken as th-TH. */
export function kdsSpeechLang(): string {
  if (typeof document === 'undefined') return 'en';
  const lang = document.documentElement.lang || 'en';
  return lang === 'th' ? 'th-TH' : lang;
}

/** The voice this display reads with, by name; empty means pick automatically. */
export function readKdsVoiceName(): string {
  if (typeof window === 'undefined') return '';
  try {
    return window.localStorage.getItem(VOICE_KEY) || '';
  } catch {
    return '';
  }
}

export function writeKdsVoiceName(name: string): void {
  try {
    if (name) window.localStorage.setItem(VOICE_KEY, name);
    else window.localStorage.removeItem(VOICE_KEY);
  } catch {}
}

/** Microsoft Edge's online neural voices, e.g. "Microsoft Premwadee Online (Natural) - Thai (Thailand)". */
export function isNaturalVoice(voice: SpeechSynthesisVoice): boolean {
  return /Online \(Natural\)/i.test(voice.name);
}

/** This device's voices for the language, Edge's natural voices first. Browsers list voices late. */
export async function kdsVoicesFor(lang: string): Promise<SpeechSynthesisVoice[]> {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) return [];
  const synth = window.speechSynthesis;
  if (synth.getVoices().length === 0) {
    await new Promise<void>((resolve) => {
      const timer = window.setTimeout(resolve, VOICE_WAIT_MS);
      synth.addEventListener?.(
        'voiceschanged',
        () => {
          window.clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });
  }
  const base = lang.slice(0, 2).toLowerCase();
  return synth
    .getVoices()
    .filter((voice) => voice.lang.toLowerCase().startsWith(base))
    .sort((a, b) => Number(isNaturalVoice(b)) - Number(isNaturalVoice(a)));
}

function speakOnDevice(text: string, lang: string, voice: SpeechSynthesisVoice): Promise<boolean> {
  return new Promise((resolve) => {
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = lang;
    utterance.voice = voice;
    utterance.rate = 0.95;
    const timer = window.setTimeout(() => resolve(true), SPEECH_TIMEOUT_MS);
    const done = (spoke: boolean) => {
      window.clearTimeout(timer);
      resolve(spoke);
    };
    utterance.onend = () => done(true);
    utterance.onerror = () => done(false);
    window.speechSynthesis.speak(utterance);
  });
}

/** The POS computer's own voice for the language (offline Windows voices), played on this display. */
async function speakFromServer(text: string, lang: string): Promise<boolean> {
  if (serverVoiceMissing.has(lang)) return false;
  try {
    const response = await api.post('/kds/speech', { text, lang }, { responseType: 'arraybuffer' });
    if (response.status === 204) {
      serverVoiceMissing.add(lang);
      return false;
    }
    return await playKdsAudio(response.data as ArrayBuffer);
  } catch {
    return false;
  }
}

/**
 * The POS computer's own voice service when it runs one, else the chosen voice, else an Edge
 * natural voice, else the POS computer's offline voice, else any voice this device has. An online voice that fails (no internet) falls through to the next.
 */
let serverEngine: Promise<string> | null = null;

/** 'local' when the POS computer runs its own voice service (such as F5-TTS-THAI). */
function kdsServerEngine(): Promise<string> {
  serverEngine ??= api
    .get('/kds/speech')
    .then((response) => String(response.data?.engine || 'system'))
    .catch(() => 'system');
  return serverEngine;
}

async function speakNow(text: string, lang: string): Promise<void> {
  if ((await kdsServerEngine()) === 'local' && !readKdsVoiceName() && (await speakFromServer(text, lang))) return;
  const voices = await kdsVoicesFor(lang);
  const chosenName = readKdsVoiceName();
  const preferred = voices.find((voice) => voice.name === chosenName) ?? voices.find(isNaturalVoice);
  if (preferred && (await speakOnDevice(text, lang, preferred))) return;
  if (await speakFromServer(text, lang)) return;
  const local = voices.find((voice) => voice !== preferred && voice.localService !== false);
  if (local) await speakOnDevice(text, lang, local);
}

/** Reads text aloud in the given language, one announcement after another. */
export function speakKds(text: string, lang: string): void {
  speechQueue = speechQueue.then(() => speakNow(text, lang)).catch(() => {});
}

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

/** Browsers list voices late, so wait briefly for them before deciding there is none. */
async function deviceVoice(lang: string): Promise<SpeechSynthesisVoice | null> {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) return null;
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
  const voices = synth.getVoices();
  const exact = lang.toLowerCase();
  const base = exact.slice(0, 2);
  return (
    voices.find((voice) => voice.lang.toLowerCase().replace('_', '-') === exact) ??
    voices.find((voice) => voice.lang.toLowerCase().startsWith(base)) ??
    null
  );
}

function speakOnDevice(text: string, lang: string, voice: SpeechSynthesisVoice): Promise<void> {
  return new Promise((resolve) => {
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = lang;
    utterance.voice = voice;
    utterance.rate = 0.95;
    const timer = window.setTimeout(resolve, SPEECH_TIMEOUT_MS);
    const done = () => {
      window.clearTimeout(timer);
      resolve();
    };
    utterance.onend = done;
    utterance.onerror = done;
    window.speechSynthesis.speak(utterance);
  });
}

/** The POS computer's own voice for the language (offline Windows voices), played on this display. */
async function speakFromServer(text: string, lang: string): Promise<void> {
  if (serverVoiceMissing.has(lang)) return;
  try {
    const response = await api.post('/kds/speech', { text, lang }, { responseType: 'arraybuffer' });
    if (response.status === 204) {
      serverVoiceMissing.add(lang);
      return;
    }
    await playKdsAudio(response.data as ArrayBuffer);
  } catch {}
}

async function speakNow(text: string, lang: string): Promise<void> {
  const voice = await deviceVoice(lang);
  if (voice) await speakOnDevice(text, lang, voice);
  else await speakFromServer(text, lang);
}

/** Reads text aloud in the given language, one announcement after another. */
export function speakKds(text: string, lang: string): void {
  speechQueue = speechQueue.then(() => speakNow(text, lang)).catch(() => {});
}

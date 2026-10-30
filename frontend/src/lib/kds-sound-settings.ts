/** Which sounds this KDS display plays; kept per display like its stage switches. */
export interface KdsSoundSettings {
  /** Speak newly arrived menu items aloud. */
  readAloud: boolean;
  /** Beep when service staff change an item (take-away, cancel, confirmed served). */
  statusChange: boolean;
  /** Chime when every item of an order is ready to serve. */
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

/** Reads text aloud in the display's language. Returns false where the browser cannot speak. */
export function speakKds(text: string, lang: string): boolean {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) return false;
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = lang;
  const base = lang.slice(0, 2).toLowerCase();
  const voice = window.speechSynthesis.getVoices().find((candidate) => candidate.lang.toLowerCase().startsWith(base));
  if (voice) utterance.voice = voice;
  utterance.rate = 0.95;
  window.speechSynthesis.speak(utterance);
  return true;
}

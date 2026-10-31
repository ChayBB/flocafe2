/**
 * One shared audio context for KDS alerts. Browsers keep it suspended until the page has been
 * tapped, so the display unlocks it on the first touch and reports whether sound is available.
 * The desktop app's KDS window starts it running.
 */
type AudioContextClass = typeof AudioContext;

let context: AudioContext | null = null;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

function getContext(): AudioContext | null {
  if (context || typeof window === 'undefined') return context;
  const AudioCtx: AudioContextClass | undefined =
    window.AudioContext ?? (window as unknown as { webkitAudioContext?: AudioContextClass }).webkitAudioContext;
  if (!AudioCtx) return null;
  try {
    context = new AudioCtx();
    context.onstatechange = notify;
  } catch {
    context = null;
  }
  return context;
}

/** True while the browser still blocks sound for this page. */
export function isKdsAlertSoundLocked(): boolean {
  const audio = getContext();
  return Boolean(audio) && audio!.state !== 'running';
}

export function subscribeKdsAlertSound(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Call from a tap or key press: that user gesture is what lets the browser play sound. */
export function unlockKdsAlertSound(): void {
  const audio = getContext();
  if (!audio || audio.state === 'running') return;
  void audio
    .resume()
    .then(notify)
    .catch(() => {});
}

/** Short beeps (three by default). Returns false when the browser blocked them, so the caller can alert visually. */
export function playKdsAlert(beeps = 3): boolean {
  const audio = getContext();
  if (!audio || audio.state !== 'running') return false;
  for (let beep = 0; beep < beeps; beep++) {
    const oscillator = audio.createOscillator();
    const gain = audio.createGain();
    oscillator.type = 'square';
    oscillator.frequency.value = 880;
    gain.gain.value = 0.15;
    oscillator.connect(gain).connect(audio.destination);
    const start = audio.currentTime + beep * 0.3;
    oscillator.start(start);
    oscillator.stop(start + 0.18);
  }
  return true;
}

const READY_BELL_URL = '/sounds/kds-ready-bell.wav';
const READY_BELL_LEAD_MS = 1200;
let readyBell: Promise<AudioBuffer | null> | null = null;

/**
 * Rings the ready-to-serve bell and resolves once its strike has sounded, so an announcement can
 * follow; two beeps stand in when the bell cannot be loaded. Resolves at once when sound is blocked.
 */
export async function playKdsReadyBell(): Promise<void> {
  const audio = getContext();
  if (!audio || audio.state !== 'running') return;
  readyBell ??= fetch(READY_BELL_URL)
    .then((response) => (response.ok ? response.arrayBuffer() : Promise.reject(new Error(String(response.status)))))
    .then((data) => audio.decodeAudioData(data))
    .catch(() => null);
  const buffer = await readyBell;
  if (!buffer) {
    readyBell = null;
    playKdsAlert(2);
    return;
  }
  const source = audio.createBufferSource();
  source.buffer = buffer;
  source.connect(audio.destination);
  source.start();
  await new Promise((resolve) => setTimeout(resolve, Math.min(buffer.duration * 1000, READY_BELL_LEAD_MS)));
}

/** Plays encoded audio (such as a spoken announcement) and resolves when it ends. False when sound is blocked. */
export async function playKdsAudio(data: ArrayBuffer): Promise<boolean> {
  const audio = getContext();
  if (!audio || audio.state !== 'running') return false;
  try {
    const buffer = await audio.decodeAudioData(data);
    const source = audio.createBufferSource();
    source.buffer = buffer;
    source.connect(audio.destination);
    await new Promise<void>((resolve) => {
      source.onended = () => resolve();
      source.start();
    });
    return true;
  } catch {
    return false;
  }
}

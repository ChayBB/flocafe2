import { useEffect, useState } from 'react';

/** This KDS display's palette: light for a bright kitchen, soft dark otherwise. */
export type KdsScreenMode = 'day' | 'night';

export const KDS_SCREEN_MODES: readonly KdsScreenMode[] = ['day', 'night'];

/** Screen brightness steps in percent; below 100 the whole display is dimmed. */
export const KDS_BRIGHTNESS_LEVELS = [20, 40, 60, 80, 100] as const;

const MODE_KEY = 'flocafe:kds-screen-mode';
const BRIGHTNESS_KEY = 'flocafe:kds-brightness';

/** The stored mode; a display that never chose one starts in the app's current light or dark theme. */
export function readKdsScreenMode(): KdsScreenMode {
  if (typeof window === 'undefined') return 'day';
  try {
    const stored = window.localStorage.getItem(MODE_KEY);
    if (stored === 'day' || stored === 'night') return stored;
    if (stored === 'lowlight') return 'night';
  } catch {}
  return document.documentElement.classList.contains('dark') ? 'night' : 'day';
}

export function readKdsBrightness(): number {
  if (typeof window === 'undefined') return 100;
  try {
    const stored = Number(window.localStorage.getItem(BRIGHTNESS_KEY));
    return (KDS_BRIGHTNESS_LEVELS as readonly number[]).includes(stored) ? stored : 100;
  } catch {
    return 100;
  }
}

function store(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {}
}

/**
 * Applies this display's palette to <html> while the KDS is open, holding the `dark` class against
 * app theme changes; the app's own theme comes back when the KDS closes.
 */
export function useKdsScreenMode() {
  const [mode, setMode] = useState<KdsScreenMode>(readKdsScreenMode);
  const [brightness, setBrightness] = useState<number>(readKdsBrightness);

  useEffect(() => {
    const html = document.documentElement;
    const wantDark = mode === 'night';
    let appDark = html.classList.contains('dark');
    const hold = () => {
      const dark = html.classList.contains('dark');
      if (dark === wantDark) return;
      appDark = dark;
      html.classList.toggle('dark', wantDark);
    };
    html.classList.add('theme-kds');
    hold();
    const observer = new MutationObserver(hold);
    observer.observe(html, { attributes: true, attributeFilter: ['class'] });
    return () => {
      observer.disconnect();
      html.classList.toggle('dark', appDark);
      html.classList.remove('theme-kds');
    };
  }, [mode]);

  return {
    mode,
    setMode: (next: KdsScreenMode) => {
      store(MODE_KEY, next);
      setMode(next);
    },
    brightness,
    setBrightness: (next: number) => {
      store(BRIGHTNESS_KEY, String(next));
      setBrightness(next);
    },
  };
}

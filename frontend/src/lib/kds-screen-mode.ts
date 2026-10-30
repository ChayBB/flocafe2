import { useEffect, useState } from 'react';

/** How bright this KDS display is: following the app theme, or fixed to day, night, or low light. */
export type KdsScreenMode = 'auto' | 'day' | 'night' | 'lowlight';

export const KDS_SCREEN_MODES: readonly KdsScreenMode[] = ['auto', 'day', 'night', 'lowlight'];

const KEY = 'flocafe:kds-screen-mode';

export function readKdsScreenMode(): KdsScreenMode {
  if (typeof window === 'undefined') return 'auto';
  try {
    const stored = window.localStorage.getItem(KEY) as KdsScreenMode | null;
    return stored && KDS_SCREEN_MODES.includes(stored) ? stored : 'auto';
  } catch {
    return 'auto';
  }
}

export function writeKdsScreenMode(mode: KdsScreenMode): void {
  try {
    if (mode === 'auto') window.localStorage.removeItem(KEY);
    else window.localStorage.setItem(KEY, mode);
  } catch {}
}

/**
 * Applies the KDS palette to <html> while the KDS is open. A fixed mode holds the `dark` class
 * against app theme changes, and the app's own theme comes back when the KDS closes.
 */
export function useKdsScreenMode(): [KdsScreenMode, (mode: KdsScreenMode) => void] {
  const [mode, setMode] = useState<KdsScreenMode>(readKdsScreenMode);

  useEffect(() => {
    const html = document.documentElement;
    html.classList.add('theme-kds');
    html.classList.toggle('kds-lowlight', mode === 'lowlight');
    if (mode === 'auto') return () => html.classList.remove('theme-kds', 'kds-lowlight');

    const wantDark = mode !== 'day';
    let appDark = html.classList.contains('dark');
    const hold = () => {
      const dark = html.classList.contains('dark');
      if (dark === wantDark) return;
      appDark = dark;
      html.classList.toggle('dark', wantDark);
    };
    hold();
    const observer = new MutationObserver(hold);
    observer.observe(html, { attributes: true, attributeFilter: ['class'] });
    return () => {
      observer.disconnect();
      html.classList.toggle('dark', appDark);
      html.classList.remove('theme-kds', 'kds-lowlight');
    };
  }, [mode]);

  const choose = (next: KdsScreenMode) => {
    writeKdsScreenMode(next);
    setMode(next);
  };
  return [mode, choose];
}

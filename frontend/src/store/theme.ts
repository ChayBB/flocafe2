import { create } from 'zustand';

export type ThemeMode = 'light' | 'dark' | 'system';
export type ThemeVariant = '1' | '2' | '3';

export const isThemeVariant = (v: unknown): v is ThemeVariant =>
  v === '1' || v === '2' || v === '3';

export const THEME_REHYDRATION_EVENT = 'flo:auth-changed';

interface ThemeState {
  mode: ThemeMode;
  /** Set by an explicit user choice this session; boot hydration must not override. */
  userSelected: boolean;
  /** Which dark palette applies whenever the resolved theme is dark. */
  darkVariant: ThemeVariant;
  setMode: (mode: ThemeMode) => void;
  setDarkVariant: (variant: ThemeVariant) => void;
  markUserSelected: () => void;
}

/** Renderer-owned theme state ('light' | 'dark' | 'system').
 * Persistence is handled by writers to keep store pure. */
export const useThemeMode = create<ThemeState>((set) => ({
  mode: 'system',
  userSelected: false,
  darkVariant: '1',
  setMode: (mode) => set({ mode }),
  setDarkVariant: (darkVariant) => set({ darkVariant }),
  markUserSelected: () => set({ userSelected: true }),
}));

import { create } from 'zustand';
import { resetTokenCache } from '@/styles/tokens';

/**
 * The site has a single dark theme (space, fire, satellites). The store stays so components that read the
 * theme (globe, map re-tint) keep working; there is no switch and no light palette in use.
 */
export type Theme = 'light' | 'dark';

function apply() {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  if (root.dataset.theme === 'dark') return;
  root.dataset.theme = 'dark';
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', '#0a0a0b');
  resetTokenCache();
}

interface ThemeStore {
  theme: Theme;
  explicit: boolean;
  setTheme: (theme: Theme) => void;
  toggle: () => void;
}

export const useThemeStore = create<ThemeStore>(() => ({
  theme: 'dark',
  explicit: true,
  setTheme: () => apply(),
  toggle: () => apply(),
}));

if (typeof window !== 'undefined') apply();

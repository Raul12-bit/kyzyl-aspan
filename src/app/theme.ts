import { create } from 'zustand';
import { resetTokenCache } from '@/styles/tokens';

/**
 * Light / dark theme. The visitor's explicit choice is stored; without one we follow the system.
 * index.html applies the same rule before first paint, so there is never a flash of the wrong theme.
 */
export type Theme = 'light' | 'dark';

const STORAGE_KEY = 'kyzylaspan.theme';
const META_COLOR: Record<Theme, string> = { dark: '#0a0a0b', light: '#f6f4ef' };

function systemTheme(): Theme {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

function storedTheme(): Theme | null {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v === 'light' || v === 'dark' ? v : null;
  } catch {
    return null;
  }
}

function apply(theme: Theme) {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  if (root.dataset.theme === theme) return;
  root.dataset.theme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', META_COLOR[theme]);
  // Libraries that cache CSS tokens (MapLibre layers) must re-read them.
  resetTokenCache();
}

interface ThemeStore {
  theme: Theme;
  /** True once the visitor picked a theme by hand (then the system setting no longer applies). */
  explicit: boolean;
  setTheme: (theme: Theme) => void;
  toggle: () => void;
}

const initial = storedTheme();

export const useThemeStore = create<ThemeStore>((set, get) => ({
  theme: initial ?? systemTheme(),
  explicit: initial !== null,
  setTheme: (theme) => {
    try {
      localStorage.setItem(STORAGE_KEY, theme);
    } catch {
      /* private mode: the choice lasts for this page only */
    }
    const commit = () => {
      apply(theme);
      set({ theme, explicit: true });
    };
    // One soft cross-fade of the whole page instead of dozens of colour transitions racing each other.
    const doc = document as Document & { startViewTransition?: (cb: () => void) => unknown };
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (doc.startViewTransition && !reduced) doc.startViewTransition(commit);
    else commit();
  },
  toggle: () => get().setTheme(get().theme === 'dark' ? 'light' : 'dark'),
}));

if (typeof window !== 'undefined') {
  apply(useThemeStore.getState().theme);
  window.matchMedia?.('(prefers-color-scheme: light)').addEventListener?.('change', () => {
    if (useThemeStore.getState().explicit) return;
    const theme = systemTheme();
    apply(theme);
    useThemeStore.setState({ theme });
  });
}

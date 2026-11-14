import { useMemo } from 'react';
import { create } from 'zustand';
import { en, type Messages } from './en';
import { ru } from './ru';

export type Locale = 'en' | 'ru';
export const LOCALES: readonly Locale[] = ['en', 'ru'];
const STORAGE_KEY = 'emberline.locale';

const dictionaries: Record<Locale, Messages> = { en, ru };

function initialLocale(): Locale {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'en' || stored === 'ru') return stored;
  } catch {
    /* storage unavailable (private mode) — fall through to the default */
  }
  return 'en';
}

interface LocaleState {
  locale: Locale;
  setLocale: (locale: Locale) => void;
}

export const useLocaleStore = create<LocaleState>((set) => ({
  locale: typeof window === 'undefined' ? 'en' : initialLocale(),
  setLocale: (locale) => {
    try {
      localStorage.setItem(STORAGE_KEY, locale);
    } catch {
      /* ignore */
    }
    document.documentElement.lang = locale;
    set({ locale });
  },
}));

export interface Formatters {
  int: (n: number) => string;
  dec: (n: number, digits?: number) => string;
  compact: (n: number) => string;
  pct: (fraction: number, digits?: number, signed?: boolean) => string;
  signed: (n: number, digits?: number) => string;
  range: (lo: number, hi: number, f?: (n: number) => string) => string;
  month: (month: number, style?: 'short' | 'long' | 'narrow') => string;
  yearMonth: (year: number, month: number) => string;
  /** Joins a list: "Apr, May and Sep" / "апр., май и сент." */
  list: (items: string[]) => string;
}

export function createFormatters(locale: Locale): Formatters {
  const tag = locale === 'ru' ? 'ru-RU' : 'en-US';
  const int = new Intl.NumberFormat(tag, { maximumFractionDigits: 0 });
  const compact = new Intl.NumberFormat(tag, { notation: 'compact', maximumFractionDigits: 1 });
  const decCache = new Map<number, Intl.NumberFormat>();
  const dec = (n: number, digits = 1) => {
    let f = decCache.get(digits);
    if (!f) {
      f = new Intl.NumberFormat(tag, { minimumFractionDigits: digits, maximumFractionDigits: digits });
      decCache.set(digits, f);
    }
    return f.format(n);
  };
  const minus = (s: string) => s.replace('-', '−');
  const monthFmt = {
    short: new Intl.DateTimeFormat(tag, { month: 'short', timeZone: 'UTC' }),
    long: new Intl.DateTimeFormat(tag, { month: 'long', timeZone: 'UTC' }),
    narrow: new Intl.DateTimeFormat(tag, { month: 'narrow', timeZone: 'UTC' }),
  };
  const ymFmt = new Intl.DateTimeFormat(tag, { month: 'short', year: 'numeric', timeZone: 'UTC' });
  const listFmt = new Intl.ListFormat(tag, { style: 'long', type: 'conjunction' });
  return {
    int: (n) => minus(int.format(Math.round(n))),
    dec: (n, digits) => minus(dec(n, digits)),
    compact: (n) => compact.format(n),
    pct: (fraction, digits = 0, signed = false) => {
      const s = dec(fraction * 100, digits);
      return `${signed && fraction > 0 ? '+' : ''}${minus(s)}%`;
    },
    signed: (n, digits = 1) => `${n > 0 ? '+' : ''}${minus(dec(n, digits))}`,
    range: (lo, hi, f) => {
      const fmt = f ?? ((n: number) => minus(int.format(Math.round(n))));
      return `${fmt(lo)}–${fmt(hi)}`;
    },
    month: (month, style = 'short') => monthFmt[style].format(new Date(Date.UTC(2001, month - 1, 1))),
    yearMonth: (year, month) => ymFmt.format(new Date(Date.UTC(year, month - 1, 1))),
    list: (items) => listFmt.format(items),
  };
}

/** Current messages + formatters. Re-renders on locale change. */
export function useI18n() {
  const locale = useLocaleStore((s) => s.locale);
  return useMemo(() => ({ locale, m: dictionaries[locale], fmt: createFormatters(locale) }), [locale]);
}

export function getMessages(locale: Locale): Messages {
  return dictionaries[locale];
}

export type { Messages };

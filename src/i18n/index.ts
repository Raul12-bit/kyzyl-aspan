import { useMemo } from 'react';
import { create } from 'zustand';
import { en, type Messages } from './locales/en';

/**
 * Interface languages. English ships in the main bundle; every other dictionary is a separate chunk
 * loaded on demand (`ensureLocale`), so adding a language costs nothing to visitors who don't use it.
 */
export const LOCALES = ['en', 'ru', 'kk', 'es', 'fr', 'de', 'pt', 'zh'] as const;
export type Locale = (typeof LOCALES)[number];

export const LOCALE_INFO: Record<Locale, { native: string; tag: string }> = {
  en: { native: 'English', tag: 'en-US' },
  ru: { native: 'Русский', tag: 'ru-RU' },
  kk: { native: 'Қазақша', tag: 'kk-KZ' },
  es: { native: 'Español', tag: 'es-ES' },
  fr: { native: 'Français', tag: 'fr-FR' },
  de: { native: 'Deutsch', tag: 'de-DE' },
  pt: { native: 'Português', tag: 'pt-BR' },
  zh: { native: '中文', tag: 'zh-CN' },
};

export function isLocale(v: unknown): v is Locale {
  return typeof v === 'string' && (LOCALES as readonly string[]).includes(v);
}

/** How the current language was chosen. A manual choice always wins over geolocation. */
export type LocaleSource = 'manual' | 'geo' | 'browser' | 'default';

const STORAGE_KEY = 'kyzylaspan.locale';

const loaders: Record<Exclude<Locale, 'en'>, () => Promise<Messages>> = {
  ru: () => import('./locales/ru').then((m) => m.ru),
  kk: () => import('./locales/kk').then((m) => m.kk),
  es: () => import('./locales/es').then((m) => m.es),
  fr: () => import('./locales/fr').then((m) => m.fr),
  de: () => import('./locales/de').then((m) => m.de),
  pt: () => import('./locales/pt').then((m) => m.pt),
  zh: () => import('./locales/zh').then((m) => m.zh),
};

const dictionaries: Partial<Record<Locale, Messages>> = { en };

/** Loads a dictionary chunk (no-op when already loaded). Falls back to English on a failed load. */
export async function ensureLocale(locale: Locale): Promise<Messages> {
  const hit = dictionaries[locale];
  if (hit) return hit;
  try {
    const m = await loaders[locale as Exclude<Locale, 'en'>]();
    dictionaries[locale] = m;
    return m;
  } catch (err) {
    console.warn(`[i18n] could not load "${locale}", using English`, err);
    return en;
  }
}

/** First supported locale among BCP-47 tags like 'es-MX', 'zh-Hant-TW', 'kk'. */
export function matchLocale(tags: readonly string[]): Locale | null {
  for (const tag of tags) {
    const base = tag.toLowerCase().split(/[-_]/)[0];
    if (isLocale(base)) return base;
  }
  return null;
}

function readStored(): { locale: Locale; source: LocaleSource } | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as { locale?: unknown; source?: unknown };
    if (isLocale(v.locale) && (v.source === 'manual' || v.source === 'geo')) return { locale: v.locale, source: v.source };
  } catch {
    /* storage unavailable or corrupt — fall through */
  }
  return null;
}

export function initialLocale(): { locale: Locale; source: LocaleSource } {
  if (typeof window === 'undefined') return { locale: 'en', source: 'default' };
  const stored = readStored();
  if (stored) return stored;
  const browser = matchLocale(navigator.languages?.length ? navigator.languages : [navigator.language]);
  return browser ? { locale: browser, source: 'browser' } : { locale: 'en', source: 'default' };
}

interface LocaleState {
  locale: Locale;
  source: LocaleSource;
  /** Switches language once its dictionary is loaded. */
  setLocale: (locale: Locale, source?: LocaleSource) => Promise<void>;
}

export const useLocaleStore = create<LocaleState>((set) => ({
  ...initialLocale(),
  setLocale: async (locale, source = 'manual') => {
    await ensureLocale(locale);
    if (source === 'manual' || source === 'geo') {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({ locale, source }));
      } catch {
        /* ignore */
      }
    }
    document.documentElement.lang = locale;
    set({ locale, source });
  },
}));

/**
 * Applies the languages of the visitor's country unless they picked one by hand.
 * Returns the locale it switched to, or null when nothing changed.
 */
export async function applyCountryLocale(candidates: readonly string[], force = false): Promise<Locale | null> {
  const { source, locale, setLocale } = useLocaleStore.getState();
  if (source === 'manual' && !force) return null;
  const next = candidates.find(isLocale);
  if (!next || next === locale) return null;
  await setLocale(next, 'geo');
  return next;
}

export interface Formatters {
  int: (n: number) => string;
  dec: (n: number, digits?: number) => string;
  compact: (n: number) => string;
  pct: (fraction: number, digits?: number, signed?: boolean) => string;
  signed: (n: number, digits?: number) => string;
  range: (lo: number, hi: number, f?: (n: number) => string) => string;
  month: (month: number, style?: 'short' | 'long' | 'narrow') => string;
  yearMonth: (year: number, month: number) => string;
  list: (items: string[]) => string;
  /** "2 h 15 min" */
  duration: (seconds: number) => string;
  /** Clock time of a simulation offset (s) from a fixed UTC epoch: "14:05 UTC". */
  clock: (seconds: number) => string;
  /** Country name for an ISO 3166-1 alpha-2 code, in the interface language. */
  country: (iso2: string, fallback?: string) => string;
  /** Language name in the interface language. */
  language: (locale: Locale) => string;
}

/** Fixed simulation epoch for the mission page clock (UTC midnight). */
const SIM_EPOCH = Date.UTC(2026, 7, 1);

export function createFormatters(locale: Locale): Formatters {
  const tag = LOCALE_INFO[locale].tag;
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
  const hours = new Intl.NumberFormat(tag, { style: 'unit', unit: 'hour', unitDisplay: 'narrow' });
  const minutes = new Intl.NumberFormat(tag, { style: 'unit', unit: 'minute', unitDisplay: 'short' });
  const clockFmt = new Intl.DateTimeFormat(tag, { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'UTC' });
  let regions: Intl.DisplayNames | null = null;
  let languages: Intl.DisplayNames | null = null;
  try {
    regions = new Intl.DisplayNames([tag], { type: 'region' });
    languages = new Intl.DisplayNames([tag], { type: 'language' });
  } catch {
    /* very old engines: fall back to English names */
  }
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
    duration: (seconds) => {
      const total = Math.max(0, Math.round(seconds / 60));
      const h = Math.floor(total / 60);
      const m = total % 60;
      if (h === 0) return minutes.format(m);
      return m === 0 ? hours.format(h) : `${hours.format(h)} ${minutes.format(m)}`;
    },
    clock: (seconds) => `${clockFmt.format(new Date(SIM_EPOCH + seconds * 1000))} UTC`,
    country: (iso2, fallback) => {
      try {
        return regions?.of(iso2) ?? fallback ?? iso2;
      } catch {
        return fallback ?? iso2;
      }
    },
    language: (l) => {
      try {
        return languages?.of(l) ?? LOCALE_INFO[l].native;
      } catch {
        return LOCALE_INFO[l].native;
      }
    },
  };
}

/** Current messages + formatters. Re-renders on locale change. */
export function useI18n() {
  const locale = useLocaleStore((s) => s.locale);
  return useMemo(() => ({ locale, m: dictionaries[locale] ?? en, fmt: createFormatters(locale) }), [locale]);
}

export function getMessages(locale: Locale): Messages {
  return dictionaries[locale] ?? en;
}

export type { Messages };

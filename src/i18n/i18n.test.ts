import { describe, expect, it } from 'vitest';
import { createFormatters, matchLocale } from './index';
import { de } from './locales/de';
import { en } from './locales/en';
import { es } from './locales/es';
import { fr } from './locales/fr';
import { kk } from './locales/kk';
import { pt } from './locales/pt';
import { ru } from './locales/ru';
import { zh } from './locales/zh';

const ALL = { en, ru, kk, es, fr, de, pt, zh };

function shape(value: unknown): unknown {
  if (typeof value === 'function') return 'fn';
  if (Array.isArray(value)) return value.map(shape);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, shape(v)]));
  }
  return typeof value;
}

describe('i18n', () => {
  it.each(Object.entries(ALL))('%s mirrors the EN structure exactly (including array lengths)', (_, dict) => {
    expect(shape(dict)).toEqual(shape(en));
  });

  it.each(Object.entries(ALL))('%s has no empty strings', (name, dict) => {
    const walk = (v: unknown, path: string) => {
      if (typeof v === 'string') expect(v.trim().length, path).toBeGreaterThan(0);
      else if (v && typeof v === 'object') Object.entries(v).forEach(([k, c]) => walk(c, `${path}.${k}`));
    };
    walk(dict, name);
  });

  it.each(Object.entries(ALL))('%s puts the title accent inside the title', (_, dict) => {
    expect(dict.intro.title).toContain(dict.intro.titleAccent);
  });

  it('interpolates every function with its arguments', () => {
    for (const dict of Object.values(ALL)) {
      expect(dict.geo.found('XX-COUNTRY')).toContain('XX-COUNTRY');
      expect(dict.mission.onboard.honest('0.111', '0.222')).toMatch(/0[.,]111[\s\S]*0[.,]222|0[.,]222[\s\S]*0[.,]111/);
    }
  });

  it('matches browser languages to supported locales', () => {
    expect(matchLocale(['es-MX', 'en'])).toBe('es');
    expect(matchLocale(['zh-Hant-TW'])).toBe('zh');
    expect(matchLocale(['kk-KZ', 'ru'])).toBe('kk');
    expect(matchLocale(['ja-JP', 'it'])).toBeNull();
  });

  it('formats numbers per locale with a real minus sign', () => {
    const enF = createFormatters('en');
    const ruF = createFormatters('ru');
    expect(enF.int(12345)).toBe('12,345');
    expect(ruF.int(12345).replace(/\s/g, ' ')).toBe('12 345');
    expect(enF.pct(-0.009, 1, true)).toBe('−0.9%');
    expect(enF.pct(0.012, 1, true)).toBe('+1.2%');
    expect(ruF.dec(1.5)).toBe('1,5');
    expect(enF.duration(2 * 3600 + 15 * 60)).toMatch(/2.*h.*15.*min/);
    expect(enF.country('ES')).toBe('Spain');
  });
});

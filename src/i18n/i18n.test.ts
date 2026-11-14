import { describe, expect, it } from 'vitest';
import { en } from './en';
import { pluralRu, ru } from './ru';
import { createFormatters } from './index';

function shape(value: unknown): unknown {
  if (typeof value === 'function') return 'fn';
  if (Array.isArray(value)) return value.map(shape);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, shape(v)]));
  }
  return typeof value;
}

describe('i18n', () => {
  it('RU mirrors the EN structure exactly (including array lengths)', () => {
    expect(shape(ru)).toEqual(shape(en));
  });

  it('has no empty strings', () => {
    const walk = (v: unknown, path: string) => {
      if (typeof v === 'string') expect(v.trim().length, path).toBeGreaterThan(0);
      else if (v && typeof v === 'object') Object.entries(v).forEach(([k, c]) => walk(c, `${path}.${k}`));
    };
    walk(en, 'en');
    walk(ru, 'ru');
  });

  it('pluralises Russian correctly', () => {
    const f = (n: number) => pluralRu(n, 'месяц', 'месяца', 'месяцев');
    expect([1, 2, 5, 11, 21, 22, 25, 112].map(f)).toEqual([
      'месяц',
      'месяца',
      'месяцев',
      'месяцев',
      'месяц',
      'месяца',
      'месяцев',
      'месяцев',
    ]);
  });

  it('formats numbers per locale with a real minus sign', () => {
    const enF = createFormatters('en');
    const ruF = createFormatters('ru');
    expect(enF.int(12345)).toBe('12,345');
    expect(ruF.int(12345).replace(/\s/g, ' ')).toBe('12 345');
    expect(enF.pct(-0.009, 1, true)).toBe('−0.9%');
    expect(enF.pct(0.012, 1, true)).toBe('+1.2%');
    expect(ruF.dec(1.5)).toBe('1,5');
  });
});

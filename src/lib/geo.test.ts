import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { CountriesFile } from '../domain/countries';
import { bboxAreaKm2, bboxContains, isValidBBox, normalizeBBox, parseBBoxParam, polygonsAreaKm2, ringAreaKm2, splitAntimeridian, wrapLng } from './geo';

describe('polygon area', () => {
  const countries = JSON.parse(readFileSync(new URL('../../public/data/countries.json', import.meta.url), 'utf8')) as CountriesFile;
  const outline = (id: string) => countries.countries.find((c) => c.id === id)!.polys;

  it('matches the box formula for a lon/lat rectangle, in either winding order', () => {
    const box = [46.47, 40.66, 87.36, 55.39] as const;
    const ring = [46.47, 40.66, 87.36, 40.66, 87.36, 55.39, 46.47, 55.39];
    // Rings follow great circles, the box follows parallels: close, not identical, at this size.
    expect(ringAreaKm2(ring) / bboxAreaKm2(box)).toBeGreaterThan(0.97);
    expect(ringAreaKm2(ring) / bboxAreaKm2(box)).toBeLessThan(1.03);
    // Reverse the winding by reversing the [lng, lat] PAIRS (a flat reverse would swap lat and lng).
    const reversed = Array.from({ length: ring.length / 2 }, (_, i) => ring.slice(ring.length - 2 * (i + 1), ring.length - 2 * i)).flat();
    expect(ringAreaKm2(reversed)).toBeCloseTo(ringAreaKm2(ring), 6);
  });

  it('gives a country its own area, not its box (Kazakhstan: 2 724 900 km² officially, box ≈5 M km²)', () => {
    const kz = polygonsAreaKm2(outline('KZ'));
    expect(Math.abs(kz - 2_724_900) / 2_724_900).toBeLessThan(0.02);
    expect(bboxAreaKm2([46.47, 40.66, 87.36, 55.39])).toBeGreaterThan(4.5e6);
    // Multi-part countries add up their parts (Russia ≈ 17.1 M km² incl. inland water; 1:110m outline).
    expect(polygonsAreaKm2(outline('RU')) / 17_098_246).toBeGreaterThan(0.95);
  });
});
import { fromMonthIndex, isoToDayOffset, dayOffsetToIso, monthIndex, MONTH_COUNT, parseYearMonth } from './date';

describe('geo', () => {
  it('wraps longitudes', () => {
    expect(wrapLng(190)).toBe(-170);
    expect(wrapLng(-190)).toBe(170);
    expect(wrapLng(180)).toBe(180);
  });

  it('normalises dragged boxes in any direction', () => {
    expect(normalizeBBox([80, 55], [60, 40])).toEqual([60, 40, 80, 55]);
    expect(normalizeBBox([170, 10], [190, 20])).toEqual([170, 10, -170, 20]);
  });

  it('validates and parses URL boxes', () => {
    expect(parseBBoxParam('46.47,40.66,87.36,55.39')).toEqual([46.47, 40.66, 87.36, 55.39]);
    expect(parseBBoxParam('1,2,3')).toBeNull();
    expect(parseBBoxParam('0,50,10,40')).toBeNull(); // south > north
    expect(parseBBoxParam('abc')).toBeNull();
    expect(isValidBBox([0, 0, 200, 10])).toBe(false);
  });

  it('handles antimeridian boxes', () => {
    expect(splitAntimeridian([170, 0, -170, 10])).toHaveLength(2);
    expect(bboxContains([170, 0, -170, 10], 179, 5)).toBe(true);
    expect(bboxContains([170, 0, -170, 10], 0, 5)).toBe(false);
  });

  it('computes areas on the sphere', () => {
    // 1°×1° at the equator ≈ 12 364 km²
    expect(bboxAreaKm2([0, 0, 1, 1])).toBeGreaterThan(12_300);
    expect(bboxAreaKm2([0, 0, 1, 1])).toBeLessThan(12_400);
  });
});

describe('date', () => {
  it('indexes months from 2000-01', () => {
    expect(monthIndex(2000, 1)).toBe(0);
    expect(monthIndex(2012, 1)).toBe(144);
    expect(fromMonthIndex(321)).toEqual({ year: 2026, month: 10 });
    expect(MONTH_COUNT).toBe(322);
  });
  it('parses YYYY-MM within the archive only', () => {
    expect(parseYearMonth('2012-03')).toEqual({ year: 2012, month: 3 });
    expect(parseYearMonth('2026-11')).toBeNull();
    expect(parseYearMonth('2010-13')).toBeNull();
    expect(parseYearMonth('nope')).toBeNull();
  });
  it('round-trips day offsets', () => {
    expect(isoToDayOffset('2012-01-01')).toBe(4383);
    expect(dayOffsetToIso(4383)).toBe('2012-01-01');
  });
});

import { describe, expect, it } from 'vitest';
import { bboxAreaKm2, bboxContains, isValidBBox, normalizeBBox, parseBBoxParam, splitAntimeridian, wrapLng } from './geo';
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

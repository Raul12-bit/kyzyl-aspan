import { describe, expect, it } from 'vitest';
import { anomalyScores, fitRatio, harmonize, HARMONIZATION } from './calendar';
import { erf, normalCdf } from './math';
import { zoneWeight } from './zones';

describe('math', () => {
  it('erf / normalCdf are accurate enough', () => {
    expect(erf(0)).toBeCloseTo(0, 6);
    expect(erf(1)).toBeCloseTo(0.8427007929, 6);
    expect(normalCdf(1.6448536)).toBeCloseTo(0.95, 5);
  });
});

describe('zoneWeight', () => {
  const zone = { center: [70, 50] as [number, number], sigma: [2, 1] as [number, number] };
  it('is 1 for a box containing the zone and 0 far away', () => {
    expect(zoneWeight(zone, [60, 40, 80, 60])).toBeCloseTo(1, 6);
    expect(zoneWeight(zone, [0, 0, 10, 10])).toBe(0);
  });
  it('is 0.5 for the western half', () => {
    expect(zoneWeight(zone, [60, 40, 70, 60])).toBeCloseTo(0.5, 6);
  });
  it('handles boxes crossing the antimeridian', () => {
    const z = { center: [179, 60] as [number, number], sigma: [1, 1] as [number, number] };
    expect(zoneWeight(z, [170, 50, -170, 70])).toBeCloseTo(1, 6);
  });
});

describe('fitRatio', () => {
  it('recovers a constant ratio and falls back to the prior when data are thin', () => {
    const months = 60;
    const start = 24;
    const modis = Array.from({ length: months }, (_, t) => 100 + (t % 12) * 10);
    const viirs = modis.map((m, t) => (t >= start ? m * 4 : null));
    const fit = fitRatio(modis, viirs, start);
    expect(fit.calibrated).toBe(true);
    expect(fit.value).toBeCloseTo(4, 6);
    expect(fit.lo).toBeLessThanOrEqual(4);
    expect(fit.hi).toBeGreaterThanOrEqual(4);

    const thin = fitRatio([0, 1, 0, 1], [null, null, 2, 3], 2);
    expect(thin.calibrated).toBe(false);
    expect(thin.value).toBe(HARMONIZATION.priorRatio.value);
  });
});

describe('harmonize', () => {
  it('puts VIIRS on the MODIS scale instead of summing, and narrows the interval', () => {
    const modis = [100, 100, 100, 100];
    const viirs = [null, null, 400, 400];
    const ratio = { value: 4, lo: 3.9, hi: 4.1, se: 0.05, calibrated: true };
    const out = harmonize(modis, viirs, ratio, 2);
    out.forEach((m) => expect(m.harmonized).toBeCloseTo(100, 0));
    const width = (i: number) => out[i]!.hi - out[i]!.lo;
    expect(width(3)).toBeLessThan(width(1));
  });
});

describe('anomalyScores', () => {
  it('flags a single burst against the same calendar month in other years', () => {
    const values: number[] = [];
    for (let y = 0; y < 20; y++) for (let m = 0; m < 12; m++) values.push(100 + ((y * 7 + m * 3) % 11));
    values[5 * 12 + 3] = 400;
    const z = anomalyScores(values);
    expect(z[5 * 12 + 3]!).toBeGreaterThan(5);
    expect(z.filter((v) => v !== null && v >= 2)).toHaveLength(1);
  });
  it('returns null for quiet months', () => {
    const values: number[] = [];
    for (let y = 0; y < 12; y++) for (let m = 0; m < 12; m++) values.push(m === 0 ? 0 : 100 + y);
    expect(anomalyScores(values)[0]).toBeNull();
  });
});

import { AQUA_START_INDEX, fromMonthIndex, toYearMonth } from '../../../lib/date';
import type { BBox, CalendarPoint, CalendarSeries } from '../../types';
import { mean, round, sd, tQuantile95, Z90 } from './math';
import { coverageShare, touchesCoverage, zoneWeight, type ZonesFile } from './zones';

/**
 * Harmonization model used by the mock "server" (method `ratio-ivw-v1`).
 *
 * 1. Calibrate: over the overlap period (VIIRS era) estimate k = ΣVIIRS / ΣMODIS for the area.
 *    Its uncertainty comes from the spread of the yearly ratios (Student-t, 90%).
 * 2. Rescale, never sum: VIIRS is divided by k to land on the MODIS-equivalent scale.
 * 3. Combine: after 2012 the two estimates are merged by inverse-variance weighting
 *    (over-dispersed Poisson counts + calibration error), so the interval narrows.
 *    Before 2012 the series is MODIS alone; before Aqua (2002-07) a single platform.
 * 4. Anomaly: z-score against the same calendar month in all *other* years.
 *
 * Every constant below is a modelling assumption for the demo, not a measured property of the sensors.
 */
export const HARMONIZATION = {
  method: 'ratio-ivw-v1',
  /** Over-dispersion of monthly detection counts relative to Poisson. */
  dispersion: 1.5,
  /** Structural relative uncertainty per era (coverage gaps, overpass count, product changes). */
  eraRelError: { terraOnly: 0.16, terraAqua: 0.085, dual: 0.05 },
  /** Ratio used when the area has too few detections in the overlap period to calibrate. */
  priorRatio: { value: 3.7, lo: 2.6, hi: 4.8 },
  minOverlapDetections: 40,
  /** Months whose climatological mean is below this share of the busiest month get no anomaly score. */
  quietMonthShare: 0.04,
  minYearsForAnomaly: 8,
} as const;

export interface AggregatedCounts {
  modis: number[];
  viirs: (number | null)[];
}

export function aggregateZones(file: ZonesFile, bbox: BBox): AggregatedCounts {
  const modis = new Array<number>(file.months).fill(0);
  const viirsAcc = new Array<number>(file.months - file.viirsStartIndex).fill(0);
  for (const zone of file.zones) {
    const w = zoneWeight(zone, bbox);
    if (w <= 1e-6) continue;
    for (let t = 0; t < file.months; t++) modis[t]! += w * zone.modis[t]!;
    for (let i = 0; i < viirsAcc.length; i++) viirsAcc[i]! += w * zone.viirs[i]!;
  }
  const viirs: (number | null)[] = new Array<number | null>(file.months).fill(null);
  for (let i = 0; i < viirsAcc.length; i++) viirs[file.viirsStartIndex + i] = Math.round(viirsAcc[i]!);
  return { modis: modis.map((v) => Math.round(v)), viirs };
}

export interface RatioFit {
  value: number;
  lo: number;
  hi: number;
  se: number;
  calibrated: boolean;
}

export function fitRatio(modis: readonly number[], viirs: readonly (number | null)[], viirsStart: number): RatioFit {
  let sm = 0;
  let sv = 0;
  const yearly = new Map<number, { m: number; v: number; n: number }>();
  for (let t = viirsStart; t < modis.length; t++) {
    const v = viirs[t];
    if (v == null) continue;
    const m = modis[t]!;
    sm += m;
    sv += v;
    const { year } = fromMonthIndex(t);
    const acc = yearly.get(year) ?? { m: 0, v: 0, n: 0 };
    acc.m += m;
    acc.v += v;
    acc.n += 1;
    yearly.set(year, acc);
  }
  if (sm < HARMONIZATION.minOverlapDetections) {
    const p = HARMONIZATION.priorRatio;
    return { value: p.value, lo: p.lo, hi: p.hi, se: (p.hi - p.lo) / (2 * Z90), calibrated: false };
  }
  const k = sv / sm;
  const ratios = [...yearly.values()].filter((y) => y.n === 12 && y.m >= 5).map((y) => y.v / y.m);
  const se = ratios.length >= 3 ? sd(ratios) / Math.sqrt(ratios.length) : k * 0.15;
  const half = tQuantile95(Math.max(1, ratios.length - 1)) * se;
  return { value: k, lo: Math.max(0, k - half), hi: k + half, se, calibrated: true };
}

export interface HarmonizedMonth {
  harmonized: number;
  lo: number;
  hi: number;
}

function eraRel(t: number, viirsStart: number): number {
  const e = HARMONIZATION.eraRelError;
  if (t < AQUA_START_INDEX) return e.terraOnly;
  if (t < viirsStart) return e.terraAqua;
  return e.dual;
}

export function harmonize(
  modis: readonly number[],
  viirs: readonly (number | null)[],
  ratio: RatioFit,
  viirsStart: number,
): HarmonizedMonth[] {
  const phi = HARMONIZATION.dispersion;
  const k = ratio.value;
  const relK = ratio.se / k;
  return modis.map((m, t) => {
    const varM = phi * (m + 1);
    const v = viirs[t];
    let h: number;
    let varH: number;
    if (v == null) {
      h = m;
      varH = varM;
    } else {
      const e = v / k;
      const varE = (phi * (v + 1)) / (k * k) + e * e * relK * relK;
      const wm = 1 / varM;
      const we = 1 / varE;
      h = (m * wm + e * we) / (wm + we);
      varH = 1 / (wm + we);
    }
    const rel = eraRel(t, viirsStart);
    const half = Z90 * Math.sqrt(varH + (rel * h) ** 2);
    return { harmonized: round(h, 1), lo: round(Math.max(0, h - half), 1), hi: round(h + half, 1) };
  });
}

/** z-score of each month against the same calendar month in all other years (leave-one-out). */
export function anomalyScores(values: readonly number[]): (number | null)[] {
  const byMonth: number[][] = Array.from({ length: 12 }, () => []);
  values.forEach((v, t) => byMonth[t % 12]!.push(v));
  const climatology = byMonth.map((xs) => mean(xs));
  const busiest = Math.max(...climatology.map((c) => (Number.isFinite(c) ? c : 0)));
  return values.map((v, t) => {
    const m = t % 12;
    if (busiest <= 0 || climatology[m]! < HARMONIZATION.quietMonthShare * busiest) return null;
    const others = byMonth[m]!.filter((_, i) => i !== Math.floor(t / 12));
    if (others.length < HARMONIZATION.minYearsForAnomaly) return null;
    const s = sd(others);
    if (!(s > 1e-9)) return null;
    return round((v - mean(others)) / s, 2);
  });
}

export function buildCalendar(file: ZonesFile, bbox: BBox, synthetic = true): CalendarSeries {
  const coverage = touchesCoverage(file.coverage, bbox) ? coverageShare(file.coverage, bbox) : 0;
  const ratioFallback = HARMONIZATION.priorRatio;
  if (coverage === 0) {
    return {
      bbox,
      points: [],
      meta: {
        scale: 'modis-equivalent-detections-per-month',
        interval: 0.9,
        ratio: { ...ratioFallback, overlapStart: '', overlapEnd: '' },
        coverage: 0,
        synthetic,
        method: HARMONIZATION.method,
      },
    };
  }
  const { modis, viirs } = aggregateZones(file, bbox);
  const ratio = fitRatio(modis, viirs, file.viirsStartIndex);
  const harmonized = harmonize(modis, viirs, ratio, file.viirsStartIndex);
  const z = anomalyScores(harmonized.map((h) => h.harmonized));
  const points: CalendarPoint[] = modis.map((m, t) => {
    const { year, month } = fromMonthIndex(t);
    const h = harmonized[t]!;
    return { year, month, modis: m, viirsRaw: viirs[t] ?? null, ...h, anomalyZ: z[t] ?? null };
  });
  const first = fromMonthIndex(file.viirsStartIndex);
  const last = fromMonthIndex(file.months - 1);
  return {
    bbox,
    points,
    meta: {
      scale: 'modis-equivalent-detections-per-month',
      interval: 0.9,
      ratio: {
        value: round(ratio.value, 3),
        lo: round(ratio.lo, 3),
        hi: round(ratio.hi, 3),
        overlapStart: toYearMonth(first.year, first.month),
        overlapEnd: toYearMonth(last.year, last.month),
      },
      coverage: round(coverage, 3),
      synthetic,
      method: HARMONIZATION.method,
    },
  };
}

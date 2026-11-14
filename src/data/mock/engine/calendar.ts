import { anomalyScores, fitRatio, harmonize, HARMONIZATION } from '../../../domain/harmonize';
import { fromMonthIndex, toYearMonth } from '../../../lib/date';
import { round } from '../../../lib/stats';
import type { BBox } from '../../types';
import { coverageShare, touchesCoverage, zoneWeight, type ZonesFile } from './zones';

/**
 * Zone-level calendar on raw detection counts. The mock *generator* uses it to tune the injected
 * anomalies of the synthetic archive (scripts/mock/generate.ts); the app itself serves the
 * hexagon-based calendar built in src/domain/hexCalendar.ts.
 *
 * The harmonization maths lives in src/domain/harmonize.ts and is re-exported here for the tests.
 */
export { anomalyScores, fitRatio, harmonize, HARMONIZATION };
export type { HarmonizedMonth, RatioFit } from '../../../domain/harmonize';

export interface ZoneCalendarPoint {
  year: number;
  month: number;
  modis: number;
  viirsRaw: number | null;
  harmonized: number;
  lo: number;
  hi: number;
  anomalyZ: number | null;
}

export interface ZoneCalendarSeries {
  bbox: BBox;
  points: ZoneCalendarPoint[];
  meta: {
    scale: 'modis-equivalent-detections-per-month';
    interval: number;
    ratio: { value: number; lo: number; hi: number; overlapStart: string; overlapEnd: string };
    coverage: number;
    synthetic: boolean;
    method: string;
  };
}

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

export function buildCalendar(file: ZonesFile, bbox: BBox, synthetic = true): ZoneCalendarSeries {
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
  const points: ZoneCalendarPoint[] = modis.map((m, t) => {
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

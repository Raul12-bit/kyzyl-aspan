import type { DetectionTable } from './detections';
import type { CellIndex } from './hexgrid';

/**
 * Noise filter, step 1 of the pipeline.
 *
 * Two kinds of detections are not vegetation fires:
 *  - low-confidence pixels (sun glint, hot bare ground, cloud edges) — dropped by the product's own flag;
 *  - persistent heat sources (gas flares, steel works, volcanoes) — they are real heat, often
 *    high-confidence, so confidence cannot catch them. What gives them away is *persistence*:
 *    the same small cell is hot in most years since it first appeared and in every season, whereas
 *    vegetation burns in a season and rarely returns to the exact same cell year after year.
 *
 * Real archives also offer the FIRMS `type` attribute (static land source / volcano / offshore) in the
 * standard-quality products; a production pipeline should combine both.
 */
export interface NoiseRule {
  /** Fewer detections than this in a cell: never called static. */
  minDetections: number;
  /** Distinct years with detections. */
  minYears: number;
  /** Share of the years between first and last appearance in which the cell was hot. */
  minYearShare: number;
  /** Distinct calendar months (1–12) with detections: a flare burns in all seasons. */
  minMonthSpread: number;
}

export const NOISE_RULE: NoiseRule = { minDetections: 8, minYears: 5, minYearShare: 0.6, minMonthSpread: 7 };

import { FLAG_LOW_CONFIDENCE, FLAG_STATIC } from './noiseSettings';

export { FLAG_LOW_CONFIDENCE, FLAG_STATIC };
export const FLAG_ALL_NOISE = FLAG_LOW_CONFIDENCE | FLAG_STATIC;

export interface CellPersistence {
  /** Detections per cell (all sensors, whole archive). */
  count: Uint32Array;
  /** Distinct years with detections. */
  years: Uint8Array;
  /** Distinct calendar months with detections. */
  months: Uint8Array;
  /** years / (last year − first year + 1). */
  yearShare: Float32Array;
  isStatic: Uint8Array;
  staticCells: number;
}

function popcount(v: number): number {
  let x = v >>> 0;
  let c = 0;
  while (x) {
    x &= x - 1;
    c += 1;
  }
  return c;
}

/** Persistence of every cell over the whole archive (independent of any time window). */
export function cellPersistence(table: DetectionTable, cells: CellIndex, rule: NoiseRule = NOISE_RULE): CellPersistence {
  const nCells = cells.ids.length;
  const count = new Uint32Array(nCells);
  const yearMask = new Uint32Array(nCells);
  const monthMask = new Uint16Array(nCells);
  for (let i = 0; i < table.n; i++) {
    const c = cells.cellOf[i]!;
    const month = table.month[i]!;
    count[c]! += 1;
    yearMask[c]! |= 1 << Math.min(31, Math.floor(month / 12));
    monthMask[c]! |= 1 << (month % 12);
  }
  const years = new Uint8Array(nCells);
  const months = new Uint8Array(nCells);
  const yearShare = new Float32Array(nCells);
  const isStatic = new Uint8Array(nCells);
  let staticCells = 0;
  for (let c = 0; c < nCells; c++) {
    const mask = yearMask[c]!;
    if (!mask) continue;
    const y = popcount(mask);
    const m = popcount(monthMask[c]!);
    const first = 31 - Math.clz32(mask & -mask);
    const last = 31 - Math.clz32(mask);
    years[c] = y;
    months[c] = m;
    yearShare[c] = y / (last - first + 1);
    if (count[c]! >= rule.minDetections && y >= rule.minYears && yearShare[c]! >= rule.minYearShare && m >= rule.minMonthSpread) {
      isStatic[c] = 1;
      staticCells += 1;
    }
  }
  return { count, years, months, yearShare, isStatic, staticCells };
}

/** Per-detection noise flags (bit 0 = low confidence, bit 1 = persistent static source). */
export function noiseFlags(table: DetectionTable, cells: CellIndex, persistence: CellPersistence): Uint8Array {
  const flags = new Uint8Array(table.n);
  for (let i = 0; i < table.n; i++) {
    let f = 0;
    if (table.conf[i] === 0) f |= FLAG_LOW_CONFIDENCE;
    if (persistence.isStatic[cells.cellOf[i]!]) f |= FLAG_STATIC;
    flags[i] = f;
  }
  return flags;
}

export interface FilterScore {
  /** Noise correctly removed / noise wrongly kept / fires wrongly removed / fires kept. */
  tp: number;
  fn: number;
  fp: number;
  tn: number;
  /** Of everything removed, the share that really was noise. */
  precision: number;
  /** Of all noise, the share that was removed. */
  recall: number;
  /** Share of real fires that survived the filter. */
  firesKept: number;
}

/** Scores a filter against synthetic ground truth. Returns null for data without truth labels. */
export function scoreFilter(table: DetectionTable, removed: (i: number) => boolean): FilterScore | null {
  if (!table.truth) return null;
  let tp = 0;
  let fn = 0;
  let fp = 0;
  let tn = 0;
  for (let i = 0; i < table.n; i++) {
    const noise = table.truth[i] !== 0;
    const out = removed(i);
    if (noise && out) tp += 1;
    else if (noise) fn += 1;
    else if (out) fp += 1;
    else tn += 1;
  }
  return {
    tp,
    fn,
    fp,
    tn,
    precision: tp + fp ? tp / (tp + fp) : 1,
    recall: tp + fn ? tp / (tp + fn) : 1,
    firesKept: fp + tn ? tn / (fp + tn) : 1,
  };
}

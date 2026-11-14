import { MONTH_COUNT } from '../lib/date';
import { SENSOR_MODIS, type DetectionTable } from './detections';
import type { CellIndex } from './hexgrid';
import { FLAG_LOW_CONFIDENCE } from './noise';

/**
 * Hexagon statistics, step 2 of the pipeline.
 *
 * The unit is the "burning hexagon-day": one grid cell with at least one detection on one day.
 * A fire front that lights up six VIIRS pixels and one MODIS pixel is one hexagon-day for both
 * sensors, which is why the VIIRS/MODIS ratio collapses from ~3–4× (raw pixels) towards ~1×.
 */
export interface HexTotals {
  /** Detections that survived the filters. */
  rawModis: number;
  rawViirs: number;
  hexDaysModis: number;
  hexDaysViirs: number;
  /** Hexagon-days seen by at least one sensor. */
  hexDaysAny: number;
  cellsModis: number;
  cellsViirs: number;
  cellsBoth: number;
  cellsAny: number;
  /** Detections in the window before filtering. */
  considered: number;
  removedLowConfidence: number;
  removedStatic: number;
}

export interface HexAggregate {
  /** Cells with at least one kept detection (indices into CellIndex.ids). */
  active: Int32Array;
  daysModis: Uint16Array;
  daysViirs: Uint16Array;
  daysAny: Uint16Array;
  /** Strongest fire radiative power seen in the cell, MW. */
  frpMax: Float32Array;
  maxDays: number;
  totals: HexTotals;
}

export interface AggregateOptions {
  /** Detection index range [from, to). */
  from: number;
  to: number;
  flags: Uint8Array;
  /** Detections whose flags intersect this mask are dropped. */
  hideMask: number;
  sensors: readonly [modis: boolean, viirs: boolean];
  /** Optional per-detection mask: 1 = inside the area of interest. */
  area?: Uint8Array | null;
}

export function aggregateHex(table: DetectionTable, cells: CellIndex, opts: AggregateOptions): HexAggregate {
  const nCells = cells.ids.length;
  const daysModis = new Uint16Array(nCells);
  const daysViirs = new Uint16Array(nCells);
  const daysAny = new Uint16Array(nCells);
  const frpMax = new Float32Array(nCells);
  const lastModis = new Int32Array(nCells).fill(-1);
  const lastViirs = new Int32Array(nCells).fill(-1);
  const lastAny = new Int32Array(nCells).fill(-1);
  const totals: HexTotals = {
    rawModis: 0,
    rawViirs: 0,
    hexDaysModis: 0,
    hexDaysViirs: 0,
    hexDaysAny: 0,
    cellsModis: 0,
    cellsViirs: 0,
    cellsBoth: 0,
    cellsAny: 0,
    considered: 0,
    removedLowConfidence: 0,
    removedStatic: 0,
  };
  const { flags, hideMask, sensors, area } = opts;
  const active: number[] = [];

  for (let i = opts.from; i < opts.to; i++) {
    const s = table.sensor[i]!;
    if (!sensors[s]) continue;
    if (area && !area[i]) continue;
    totals.considered += 1;
    const hidden = flags[i]! & hideMask;
    if (hidden) {
      if (hidden & FLAG_LOW_CONFIDENCE) totals.removedLowConfidence += 1;
      else totals.removedStatic += 1;
      continue;
    }
    const c = cells.cellOf[i]!;
    const day = table.day[i]!;
    if (lastAny[c] === -1) active.push(c);
    if (lastAny[c] !== day) {
      lastAny[c] = day;
      daysAny[c]! += 1;
      totals.hexDaysAny += 1;
    }
    if (s === SENSOR_MODIS) {
      totals.rawModis += 1;
      if (lastModis[c] !== day) {
        lastModis[c] = day;
        daysModis[c]! += 1;
        totals.hexDaysModis += 1;
      }
    } else {
      totals.rawViirs += 1;
      if (lastViirs[c] !== day) {
        lastViirs[c] = day;
        daysViirs[c]! += 1;
        totals.hexDaysViirs += 1;
      }
    }
    const frp = table.frp[i]!;
    if (frp > frpMax[c]!) frpMax[c] = frp;
  }

  let maxDays = 0;
  for (const c of active) {
    const m = daysModis[c]! > 0;
    const v = daysViirs[c]! > 0;
    if (m) totals.cellsModis += 1;
    if (v) totals.cellsViirs += 1;
    if (m && v) totals.cellsBoth += 1;
    if (daysAny[c]! > maxDays) maxDays = daysAny[c]!;
  }
  totals.cellsAny = active.length;
  return { active: Int32Array.from(active), daysModis, daysViirs, daysAny, frpMax, maxDays, totals };
}

export interface MonthlySeries {
  /** Kept detections per month. */
  rawModis: number[];
  rawViirs: number[];
  /** Burning hexagon-days per month. */
  hexModis: number[];
  hexViirs: number[];
  hexAny: number[];
  considered: number;
  removedLowConfidence: number;
  removedStatic: number;
}

/** Monthly raw counts and hexagon-days for the whole archive (optionally inside an area). */
export function monthlySeries(
  table: DetectionTable,
  cells: CellIndex,
  flags: Uint8Array,
  hideMask: number,
  area?: Uint8Array | null,
  months = MONTH_COUNT,
): MonthlySeries {
  const nCells = cells.ids.length;
  const zeros = () => new Array<number>(months).fill(0);
  const out: MonthlySeries = {
    rawModis: zeros(),
    rawViirs: zeros(),
    hexModis: zeros(),
    hexViirs: zeros(),
    hexAny: zeros(),
    considered: 0,
    removedLowConfidence: 0,
    removedStatic: 0,
  };
  const lastModis = new Int32Array(nCells).fill(-1);
  const lastViirs = new Int32Array(nCells).fill(-1);
  const lastAny = new Int32Array(nCells).fill(-1);
  for (let i = 0; i < table.n; i++) {
    if (area && !area[i]) continue;
    const t = table.month[i]!;
    if (t < 0 || t >= months) continue;
    out.considered += 1;
    const hidden = flags[i]! & hideMask;
    if (hidden) {
      if (hidden & FLAG_LOW_CONFIDENCE) out.removedLowConfidence += 1;
      else out.removedStatic += 1;
      continue;
    }
    const c = cells.cellOf[i]!;
    const day = table.day[i]!;
    if (lastAny[c] !== day) {
      lastAny[c] = day;
      out.hexAny[t]! += 1;
    }
    if (table.sensor[i] === SENSOR_MODIS) {
      out.rawModis[t]! += 1;
      if (lastModis[c] !== day) {
        lastModis[c] = day;
        out.hexModis[t]! += 1;
      }
    } else {
      out.rawViirs[t]! += 1;
      if (lastViirs[c] !== day) {
        lastViirs[c] = day;
        out.hexViirs[t]! += 1;
      }
    }
  }
  return out;
}

/** VIIRS / MODIS ratio, or null when MODIS saw nothing. */
export function sensorRatio(viirs: number, modis: number): number | null {
  return modis > 0 ? viirs / modis : null;
}

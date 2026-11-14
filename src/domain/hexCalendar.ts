import type { BBox, CalendarPoint, CalendarSeries } from '../data/types';
import { fromMonthIndex, MONTH_COUNT, toYearMonth, VIIRS_START_INDEX } from '../lib/date';
import { round } from '../lib/stats';
import type { DetectionTable } from './detections';
import { anomalyScores, fitRatio, harmonize, HARMONIZATION } from './harmonize';
import { gridInfo, type CellIndex } from './hexgrid';
import { monthlySeries, sensorRatio } from './hexStats';
import { FLAG_ALL_NOISE, type CellPersistence } from './noise';

export interface CalendarInput {
  table: DetectionTable;
  /** Detections on the harmonization grid. */
  grid: CellIndex;
  flags: Uint8Array;
  /** Persistence on the fine (base) grid — only its static-cell count is reported. */
  persistence: CellPersistence;
  /** Fine-grid index, used to count the static cells that fall inside the area. */
  base: CellIndex;
  /** Per-detection mask of the area; null = whole archive. */
  area: Uint8Array | null;
  bbox: BBox;
  synthetic: boolean;
}

const emptyMeta = (input: Pick<CalendarInput, 'grid' | 'synthetic'>): CalendarSeries['meta'] => {
  const g = gridInfo(input.grid.res);
  return {
    scale: 'modis-equivalent-hex-days-per-month',
    interval: 0.9,
    grid: { system: 'h3', resolution: g.res, cellAreaKm2: round(g.areaKm2, 1) },
    rawRatio: null,
    ratio: { ...HARMONIZATION.priorHexRatio, overlapStart: '', overlapEnd: '', calibrated: false },
    noise: { considered: 0, lowConfidence: 0, staticSources: 0, staticCells: 0 },
    coverage: 0,
    synthetic: input.synthetic,
    method: HARMONIZATION.method,
  };
};

/**
 * The full pipeline for one area: noise filter → burning hexagon-days per sensor →
 * residual ratio calibrated on the overlap → inverse-variance blend with a 90% interval → anomalies.
 */
export function buildHexCalendar(input: CalendarInput): CalendarSeries {
  const { table, grid, flags, area, bbox } = input;
  const series = monthlySeries(table, grid, flags, FLAG_ALL_NOISE, area);
  if (series.considered === 0) return { bbox, points: [], meta: emptyMeta(input) };

  const hexViirs: (number | null)[] = series.hexViirs.map((v, t) => (t >= VIIRS_START_INDEX ? v : null));
  const ratio = fitRatio(series.hexModis, hexViirs, VIIRS_START_INDEX, HARMONIZATION.priorHexRatio);
  const harmonized = harmonize(series.hexModis, hexViirs, ratio, VIIRS_START_INDEX);
  const z = anomalyScores(harmonized.map((h) => h.harmonized));

  const points: CalendarPoint[] = harmonized.map((h, t) => {
    const { year, month } = fromMonthIndex(t);
    const viirsEra = t >= VIIRS_START_INDEX;
    return {
      year,
      month,
      modis: series.rawModis[t]!,
      viirsRaw: viirsEra ? series.rawViirs[t]! : null,
      modisHex: series.hexModis[t]!,
      viirsHex: viirsEra ? series.hexViirs[t]! : null,
      ...h,
      anomalyZ: z[t] ?? null,
    };
  });

  let overlapModis = 0;
  let overlapViirs = 0;
  for (let t = VIIRS_START_INDEX; t < MONTH_COUNT; t++) {
    overlapModis += series.rawModis[t]!;
    overlapViirs += series.rawViirs[t]!;
  }
  const rawRatio = sensorRatio(overlapViirs, overlapModis);

  // Static cells with at least one detection inside the area.
  const seen = new Uint8Array(input.base.ids.length);
  let staticCells = 0;
  for (let i = 0; i < table.n; i++) {
    if (area && !area[i]) continue;
    const c = input.base.cellOf[i]!;
    if (input.persistence.isStatic[c] && !seen[c]) {
      seen[c] = 1;
      staticCells += 1;
    }
  }

  const first = fromMonthIndex(VIIRS_START_INDEX);
  const last = fromMonthIndex(MONTH_COUNT - 1);
  const g = gridInfo(grid.res);
  return {
    bbox,
    points,
    meta: {
      scale: 'modis-equivalent-hex-days-per-month',
      interval: 0.9,
      grid: { system: 'h3', resolution: g.res, cellAreaKm2: round(g.areaKm2, 1) },
      rawRatio: rawRatio === null ? null : round(rawRatio, 3),
      ratio: {
        value: round(ratio.value, 3),
        lo: round(ratio.lo, 3),
        hi: round(ratio.hi, 3),
        overlapStart: toYearMonth(first.year, first.month),
        overlapEnd: toYearMonth(last.year, last.month),
        calibrated: ratio.calibrated,
      },
      noise: {
        considered: series.considered,
        lowConfidence: series.removedLowConfidence,
        staticSources: series.removedStatic,
        staticCells,
      },
      coverage: 1,
      synthetic: input.synthetic,
      method: HARMONIZATION.method,
    },
  };
}

import type { Confidence, FireFeature, Sensor } from '../data/types';
import { isoToDayOffset, isoToMonthIndex, START_YEAR } from '../lib/date';

export const SENSORS: readonly Sensor[] = ['MODIS', 'VIIRS'];
export const CONFIDENCES: readonly Confidence[] = ['low', 'nominal', 'high'];
/** Ground truth exists only in synthetic data; real archives carry at most the FIRMS `type` attribute. */
export const TRUTHS = ['fire', 'static', 'false-alarm'] as const;
export type Truth = (typeof TRUTHS)[number];

export const SENSOR_MODIS = 0;
export const SENSOR_VIIRS = 1;

/**
 * Detections as parallel typed arrays, sorted by acquisition day. Everything heavy (H3 indexing,
 * noise filtering, hexagon statistics, the onboard classifier) runs on this compact form; GeoJSON
 * features are only built for what the map actually draws.
 */
export interface DetectionTable {
  n: number;
  lng: Float32Array;
  lat: Float32Array;
  /** 0 = MODIS, 1 = VIIRS. */
  sensor: Uint8Array;
  /** Days since 2000-01-01 (UTC), ascending. */
  day: Int32Array;
  /** Month index, 0 = 2000-01. */
  month: Int16Array;
  /** Fire radiative power, MW. */
  frp: Float32Array;
  /** 0 low, 1 nominal, 2 high. */
  conf: Uint8Array;
  /** 0 fire, 1 static source, 2 false alarm — or null when the data carry no ground truth. */
  truth: Uint8Array | null;
}

/** Compact row of fires.json: [lng, lat, sensor, day, frp, confidence, truth?]. */
export type FireRow = readonly [number, number, number, number, number, number, number?];

const DAY_MS = 86_400_000;
const EPOCH_MS = Date.UTC(START_YEAR, 0, 1);

function monthOfDay(day: number): number {
  const d = new Date(EPOCH_MS + day * DAY_MS);
  return (d.getUTCFullYear() - START_YEAR) * 12 + d.getUTCMonth();
}

function allocate(n: number, withTruth: boolean): DetectionTable {
  return {
    n,
    lng: new Float32Array(n),
    lat: new Float32Array(n),
    sensor: new Uint8Array(n),
    day: new Int32Array(n),
    month: new Int16Array(n),
    frp: new Float32Array(n),
    conf: new Uint8Array(n),
    truth: withTruth ? new Uint8Array(n) : null,
  };
}

export function tableFromRows(rows: readonly FireRow[]): DetectionTable {
  const order = rows.map((_, i) => i).sort((a, b) => rows[a]![3] - rows[b]![3] || a - b);
  const withTruth = rows.length > 0 && rows[0]![6] !== undefined;
  const t = allocate(rows.length, withTruth);
  order.forEach((src, i) => {
    const row = rows[src]!;
    t.lng[i] = row[0];
    t.lat[i] = row[1];
    t.sensor[i] = row[2];
    t.day[i] = row[3];
    t.month[i] = monthOfDay(row[3]);
    t.frp[i] = row[4];
    t.conf[i] = row[5];
    if (t.truth) t.truth[i] = row[6] ?? 0;
  });
  return t;
}

/**
 * Builds the table from GeoJSON features and returns the features in table order, so index `i`
 * addresses the same detection in both.
 */
export function tableFromFeatures(features: readonly FireFeature[]): { table: DetectionTable; ordered: FireFeature[] } {
  const ordered = [...features].sort((a, b) =>
    a.properties.date < b.properties.date ? -1 : a.properties.date > b.properties.date ? 1 : 0,
  );
  const withTruth = ordered.length > 0 && ordered[0]!.properties.truth !== undefined;
  const t = allocate(ordered.length, withTruth);
  ordered.forEach((f, i) => {
    const p = f.properties;
    const [lng, lat] = f.geometry.coordinates as [number, number];
    t.lng[i] = lng;
    t.lat[i] = lat;
    t.sensor[i] = p.sensor === 'MODIS' ? SENSOR_MODIS : SENSOR_VIIRS;
    t.day[i] = isoToDayOffset(p.date);
    t.month[i] = isoToMonthIndex(p.date);
    t.frp[i] = p.frp;
    t.conf[i] = CONFIDENCES.indexOf(p.confidence);
    if (t.truth) t.truth[i] = Math.max(0, TRUTHS.indexOf(p.truth ?? 'fire'));
  });
  return { table: t, ordered };
}

/** First index whose month is ≥ `month` (the table is sorted by day, hence by month). */
export function lowerBoundMonth(table: DetectionTable, month: number): number {
  let lo = 0;
  let hi = table.n;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (table.month[mid]! < month) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Half-open index range [from, to) of detections inside an inclusive month window. */
export function monthWindow(table: DetectionTable, range: readonly [number, number]): [number, number] {
  return [lowerBoundMonth(table, range[0]), lowerBoundMonth(table, range[1] + 1)];
}

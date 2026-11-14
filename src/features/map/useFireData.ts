import { useMemo } from 'react';
import type { FeatureCollection, Point, Polygon } from 'geojson';
import { useDetections } from '@/data/queries';
import type { FireFeature, FireProperties, Sensor } from '@/data/types';
import { buildArchive, hideMaskOf, type FireArchive } from '@/domain/archive';
import { CONFIDENCES, SENSOR_MODIS, tableFromRows, TRUTHS } from '@/domain/detections';
import { aggregateHex } from '@/domain/hexStats';
import { coarsen, hexRing, type CellIndex } from '@/domain/hexgrid';
import { FLAG_LOW_CONFIDENCE, FLAG_STATIC, scoreFilter } from '@/domain/noise';
import { dayOffsetToIso, MONTH_COUNT } from '@/lib/date';
import type { HexProperties } from './layers';
import { useMapStore } from './mapStore';

export interface SensorSeries {
  features: FireFeature[];
  /** Month index of each feature (parallel to `features`, ascending). */
  months: Int16Array;
  /** Detections per month in the sample. */
  histogram: Int32Array;
  /** Prefix sums of `histogram` for O(1) range counts. */
  cumulative: Int32Array;
}

export interface FireIndex {
  MODIS: SensorSeries;
  VIIRS: SensorSeries;
  total: number;
}

/** Map-side properties: the noise class a detection was flagged with (shown when filters are off). */
export interface MapFireProperties extends FireProperties {
  flag?: 'low' | 'static';
}

/**
 * The whole (sampled) archive, loaded once. Indexing it on the H3 grid and flagging the noise runs
 * here, in the browser, in a few tens of milliseconds — so the filters and the 26-year scrubber stay
 * instant. A production backend would precompute the same `FireArchive` (see PROGRESS.md).
 */
export function useArchive() {
  const query = useDetections();
  const archive = useMemo<FireArchive | null>(() => (query.data ? buildArchive(tableFromRows(query.data.rows)) : null), [query.data]);
  return { ...query, archive };
}

/** One GeoJSON feature per detection, in table order (built once per archive). */
function buildFeatures(archive: FireArchive): FireFeature[] {
  const t = archive.table;
  const out: FireFeature[] = new Array(t.n);
  for (let i = 0; i < t.n; i++) {
    const sensor: Sensor = t.sensor[i] === SENSOR_MODIS ? 'MODIS' : 'VIIRS';
    const f = archive.flags[i]!;
    const props: MapFireProperties = {
      id: `${sensor === 'MODIS' ? 'M' : 'V'}${i}`,
      sensor,
      date: dayOffsetToIso(t.day[i]!),
      frp: t.frp[i]!,
      confidence: CONFIDENCES[t.conf[i]!]!,
      ...(t.truth ? { truth: TRUTHS[t.truth[i]!] } : {}),
      ...(f & FLAG_STATIC ? { flag: 'static' as const } : f & FLAG_LOW_CONFIDENCE ? { flag: 'low' as const } : {}),
    };
    out[i] = { type: 'Feature', id: i, geometry: { type: 'Point', coordinates: [t.lng[i]!, t.lat[i]!] }, properties: props };
  }
  return out;
}

function buildSeries(features: FireFeature[], months: number[]): SensorSeries {
  const histogram = new Int32Array(MONTH_COUNT);
  for (const m of months) if (m >= 0 && m < MONTH_COUNT) histogram[m]! += 1;
  const cumulative = new Int32Array(MONTH_COUNT + 1);
  for (let i = 0; i < MONTH_COUNT; i++) cumulative[i + 1] = cumulative[i]! + histogram[i]!;
  return { features, months: Int16Array.from(months), histogram, cumulative };
}

/** Detections per sensor after the noise filter, sorted by date (the table already is). */
export function useFireIndex() {
  const q = useArchive();
  const noise = useMapStore((s) => s.noise);
  const features = useMemo(() => (q.archive ? buildFeatures(q.archive) : null), [q.archive]);
  const index = useMemo<FireIndex | null>(() => {
    const a = q.archive;
    if (!a || !features) return null;
    const hide = hideMaskOf(noise);
    const by: Record<Sensor, { f: FireFeature[]; m: number[] }> = { MODIS: { f: [], m: [] }, VIIRS: { f: [], m: [] } };
    for (let i = 0; i < a.table.n; i++) {
      if (a.flags[i]! & hide) continue;
      const s = a.table.sensor[i] === SENSOR_MODIS ? by.MODIS : by.VIIRS;
      s.f.push(features[i]!);
      s.m.push(a.table.month[i]!);
    }
    return { MODIS: buildSeries(by.MODIS.f, by.MODIS.m), VIIRS: buildSeries(by.VIIRS.f, by.VIIRS.m), total: by.MODIS.f.length + by.VIIRS.f.length };
  }, [q.archive, features, noise]);
  return { ...q, index };
}

/** How the filter does against the synthetic ground truth (null on real data). */
export function useFilterScore(archive: FireArchive | null) {
  const noise = useMapStore((s) => s.noise);
  return useMemo(() => {
    if (!archive) return null;
    const hide = hideMaskOf(noise);
    if (!hide) return null;
    return scoreFilter(archive.table, (i) => (archive.flags[i]! & hide) !== 0);
  }, [archive, noise]);
}

function lowerBound(arr: Int16Array, value: number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid]! < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export function sliceRange(series: SensorSeries, range: readonly [number, number]): FeatureCollection<Point, FireProperties> {
  const a = lowerBound(series.months, range[0]);
  const b = lowerBound(series.months, range[1] + 1);
  return { type: 'FeatureCollection', features: series.features.slice(a, b) };
}

export function countRange(series: SensorSeries, range: readonly [number, number]): number {
  const a = Math.max(0, range[0]);
  const b = Math.min(MONTH_COUNT - 1, range[1]);
  return b < a ? 0 : series.cumulative[b + 1]! - series.cumulative[a]!;
}

/* ------------------------------------------------------------------ hexagons */

const gridCache = new WeakMap<FireArchive, Map<number, CellIndex>>();

/** The archive on an H3 grid of resolution `res` (coarsened from the fine index, cached). */
export function gridAt(archive: FireArchive, res: number): CellIndex {
  let byRes = gridCache.get(archive);
  if (!byRes) {
    byRes = new Map();
    gridCache.set(archive, byRes);
  }
  let g = byRes.get(res);
  if (!g) {
    g = res === archive.base.res ? archive.base : coarsen(archive.base, res);
    byRes.set(res, g);
  }
  return g;
}

/** Burning hexagons for the current window and filters, as polygons for the map. */
/** Share of its size a drawn cell keeps: the rest becomes the dark seam between hexagons. */
const HEX_INSET = 0.86;

/** Pulls a closed ring towards its centroid (cells are small, so lng/lat space is fine). */
function insetRing(ring: [number, number][], k: number): [number, number][] {
  const n = ring.length > 1 && ring[0]![0] === ring[ring.length - 1]![0] && ring[0]![1] === ring[ring.length - 1]![1] ? ring.length - 1 : ring.length;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < n; i++) {
    cx += ring[i]![0];
    cy += ring[i]![1];
  }
  cx /= n;
  cy /= n;
  return ring.map(([x, y]) => [cx + (x - cx) * k, cy + (y - cy) * k]);
}

export function hexFeatures(
  archive: FireArchive,
  res: number,
  range: readonly [number, number],
  sensors: Record<Sensor, boolean>,
  hideMask: number,
): FeatureCollection<Polygon, HexProperties> {
  const grid = gridAt(archive, res);
  const months = archive.table.month;
  // The table is sorted by day: find the index window with two binary searches.
  const lb = (m: number) => {
    let lo = 0;
    let hi = archive.table.n;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (months[mid]! < m) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  const agg = aggregateHex(archive.table, grid, {
    from: lb(range[0]),
    to: lb(range[1] + 1),
    flags: archive.flags,
    hideMask,
    sensors: [sensors.MODIS, sensors.VIIRS],
  });
  const max = Math.max(1, agg.maxDays);
  const features = Array.from(agg.active, (c) => {
    const days = agg.daysAny[c]!;
    return {
      type: 'Feature' as const,
      properties: {
        id: grid.ids[c]!,
        days,
        modis: agg.daysModis[c]!,
        viirs: agg.daysViirs[c]!,
        frpMax: Math.round(agg.frpMax[c]! * 10) / 10,
        v: Math.sqrt(days / max),
      },
      geometry: { type: 'Polygon' as const, coordinates: [insetRing(hexRing(grid.ids[c]!), HEX_INSET)] },
    };
  });
  return { type: 'FeatureCollection', features };
}

import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type { FeatureCollection, MultiPolygon, Point, Polygon } from 'geojson';
import { DEFAULT_API_URL, type BBox } from '@/data';
import { bboxToParam } from '@/lib/geo';

/**
 * Client for the world part of the HELIOS data API (/v1): burning hexagons from EVERY detection of
 * the NASA FIRMS archive (not the browser sample), single detections with their real pixel size,
 * admin-1 regions of all countries and server-side area totals.
 */
const BASE = (import.meta.env.VITE_API_URL || DEFAULT_API_URL).replace(/\/$/, '');
const minute = 60_000;

async function getJson<T>(
  path: string,
  params: Record<string, string | number | undefined>,
  signal?: AbortSignal,
): Promise<T> {
  const url = new URL(`${BASE}/${path}`, window.location.origin);
  for (const [k, v] of Object.entries(params))
    if (v !== undefined && v !== '') url.searchParams.set(k, String(v));
  const res = await fetch(url, { signal, headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${path}`);
  return (await res.json()) as T;
}

const ym = (index: number) => `${2000 + Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}`;

/* ------------------------------------------------------------------ hexagons */

/** [h3 id, burning days, MODIS days, VIIRS days, max FRP MW] */
export type HexCell = [string, number, number, number, number];

export interface HexResponse {
  res: number;
  cells: HexCell[];
  maxDays: number;
  truncated: boolean;
  cellAreaKm2: number;
}

export interface HexQuery {
  bbox: BBox;
  res: number;
  range: readonly [number, number];
  noise: boolean;
  sensors: string;
}

export function useHexCells(q: HexQuery | null, enabled: boolean) {
  return useQuery({
    queryKey: [
      'world',
      'hex',
      q ? [bboxToParam(q.bbox), q.res, q.range[0], q.range[1], q.noise, q.sensors] : null,
    ],
    queryFn: ({ signal }) =>
      getJson<HexResponse>(
        'hex',
        {
          bbox: bboxToParam(q!.bbox),
          res: q!.res,
          start: ym(q!.range[0]),
          end: ym(q!.range[1]),
          noise: q!.noise ? 1 : 0,
          sensors: q!.sensors,
        },
        signal,
      ),
    enabled: enabled && q !== null,
    staleTime: 30 * minute,
    placeholderData: keepPreviousData,
  });
}

/* ------------------------------------------------------------------ single detections */

export interface WorldFireProperties {
  id: string;
  sensor: 'MODIS' | 'VIIRS';
  satellite: string;
  date: string;
  time: string;
  frp: number;
  confidence: 'low' | 'nominal' | 'high';
  truth: 'fire' | 'static' | 'false-alarm';
  /** Pixel size across / along the track, km (grows towards the swath edge). */
  scan: number;
  track: number;
  night: boolean;
}

export interface WorldFires extends FeatureCollection<Point, WorldFireProperties> {
  meta: { total: number; truncated: boolean };
}

export function useViewportFires(
  q: { bbox: BBox; range: readonly [number, number] } | null,
  enabled: boolean,
) {
  return useQuery({
    queryKey: ['world', 'fires', q ? [bboxToParam(q.bbox), q.range[0], q.range[1]] : null],
    queryFn: ({ signal }) => {
      const end = new Date(Date.UTC(2000 + Math.floor(q!.range[1] / 12), (q!.range[1] % 12) + 1, 0));
      return getJson<WorldFires>(
        'fires',
        {
          bbox: bboxToParam(q!.bbox),
          start: `${ym(q!.range[0])}-01`,
          end: end.toISOString().slice(0, 10),
          limit: 40000,
        },
        signal,
      );
    },
    enabled: enabled && q !== null,
    staleTime: 30 * minute,
    placeholderData: keepPreviousData,
  });
}

/* ------------------------------------------------------------------ regions */

export interface RegionProps {
  id: string;
  idx: number;
  name: string;
  names: Partial<Record<'en' | 'ru' | 'zh' | 'de' | 'es' | 'fr' | 'pt', string>>;
  type: string;
}

export type RegionsGeo = FeatureCollection<Polygon | MultiPolygon, RegionProps>;

export function useRegionsGeo(iso2: string | null) {
  return useQuery({
    queryKey: ['world', 'regions-geo', iso2],
    queryFn: ({ signal }) => getJson<RegionsGeo>('regions/geo', { country: iso2! }, signal),
    enabled: iso2 !== null,
    staleTime: Infinity,
    gcTime: 30 * minute,
  });
}

export interface AreaActivity {
  id: string;
  hexdays: number;
  detections: number;
  frp: number;
  /** Burned-area-like share: burning hexagon-days × cell area ÷ area. */
  density: number | null;
}

export interface RegionStats {
  level: 'country' | 'region';
  rows: AreaActivity[];
  maxDensity: number;
}

/** key: 'WORLD' (one row per country) or an ISO2 code (one row per region). */
export function useRegionStats(key: string | null, range: readonly [number, number]) {
  return useQuery({
    queryKey: ['world', 'region-stats', key, range[0], range[1]],
    queryFn: ({ signal }) =>
      getJson<RegionStats>(
        'regions/stats',
        { country: key!, start: ym(range[0]), end: ym(range[1]) },
        signal,
      ),
    enabled: key !== null,
    staleTime: 30 * minute,
    placeholderData: keepPreviousData,
  });
}

/* ------------------------------------------------------------------ area totals */

export interface AreaTotals {
  considered: number;
  removedLowConfidence: number;
  removedStatic: number;
  rawModis: number;
  rawViirs: number;
  cellsAny: number;
  hexDaysAny: number;
  hexDaysModis: number;
  hexDaysViirs: number;
}

export interface AreaStatsResponse {
  totals: AreaTotals;
  overlap: AreaTotals | null;
  grid: number;
  cellAreaKm2: number;
}

export function useAreaStats(
  q: {
    bbox: BBox;
    regionId: string | null;
    range: readonly [number, number];
    lowconf: boolean;
    static: boolean;
    sensors: string;
  } | null,
  enabled: boolean,
) {
  return useQuery({
    queryKey: [
      'world',
      'area-stats',
      q ? [bboxToParam(q.bbox), q.regionId, q.range[0], q.range[1], q.lowconf, q.static, q.sensors] : null,
    ],
    queryFn: ({ signal }) =>
      getJson<AreaStatsResponse>(
        'area/stats',
        {
          bbox: bboxToParam(q!.bbox),
          region: q!.regionId ?? undefined,
          start: ym(q!.range[0]),
          end: ym(q!.range[1]),
          lowconf: q!.lowconf ? 1 : 0,
          static: q!.static ? 1 : 0,
          sensors: q!.sensors,
        },
        signal,
      ),
    enabled: enabled && q !== null,
    staleTime: 30 * minute,
    placeholderData: keepPreviousData,
  });
}

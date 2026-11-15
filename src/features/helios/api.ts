import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type { FeatureCollection, Polygon } from 'geojson';
import { useSyncExternalStore } from 'react';
import { dataMode, DEFAULT_API_URL, heliosLive, onDataMode, onHeliosLive, type BBox } from '@/data';
import { bboxToParam } from '@/lib/geo';

/**
 * Client for the HELIOS-SHIELD extensions of the data API (/v1/helios/*): AI forecasts, live alerts,
 * persistent sources, blind spots, fire spread, satellites, link physics and the mission results.
 * The Python backend lives in the HELIOS repository (api/server.py); the Vite dev server proxies /v1.
 */
const BASE = (import.meta.env.VITE_API_URL || DEFAULT_API_URL).replace(/\/$/, '');

export class HeliosError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HeliosError';
  }
}

async function getJson<T>(
  path: string,
  params: Record<string, string | number | undefined> = {},
  signal?: AbortSignal,
): Promise<T> {
  const url = new URL(`${BASE}/helios/${path}`, window.location.origin);
  for (const [k, v] of Object.entries(params)) if (v !== undefined) url.searchParams.set(k, String(v));
  let res: Response;
  try {
    res = await fetch(url, {
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000),
    });
  } catch (err) {
    if (signal?.aborted) throw err;
    throw new HeliosError(`HELIOS ${path}: network error`);
  }
  if (!res.ok || !(res.headers.get('content-type') ?? '').includes('application/json')) {
    throw new HeliosError(`HELIOS ${path}: HTTP ${res.status}`);
  }
  return (await res.json()) as T;
}

/* ------------------------------------------------------------------ response types */

export interface BinaryMetrics {
  n: number;
  positives: number;
  roc_auc?: number;
  pr_auc?: number;
  brier?: number;
  recall_top10pct?: number;
}

export interface ScenariosResponse {
  latest: string | null;
  history_gap: string | null;
  scenarios: {
    as_of: string;
    horizons: Record<string, { ai: BinaryMetrics; baseline: BinaryMetrics; target_week?: string }>;
  }[];
}

/** [H3 res-5 cell, p_fire, p_climatology, actual (1 burned, 0 not, -1 unknown)] */
export type RiskRow = [string, number, number, number];
export interface RiskResponse {
  as_of: string;
  horizon_weeks: number;
  target_week: string | null;
  rows: RiskRow[];
}

/** [lng, lat, priority, p_real, p_escalation, frp, pixels, stream, acquired ISO, packet hex] */
export type AlertRow = [
  number,
  number,
  'ROUTINE' | 'HIGH' | 'CRITICAL',
  number,
  number,
  number,
  number,
  string,
  string,
  string,
];
/** [lng, lat, static score, detections, night share, first year, last year] */
export type StaticRow = [number, number, number, number, number, number, number];
/** [H3 res-3 cell, blind score, cloud share at overpasses, expected fire probability, message] */
export type BlindRow = [string, number, number, number, string];

export interface RowsResponse<T> {
  rows: T[];
  updated?: string | null;
}

export interface SpreadProperties {
  horizon: '6h' | '12h' | '24h';
  gfdi: number;
  danger: string;
  ros_kmh: number;
  wind_kmh: number;
  to_deg: number;
}

export interface SatellitesResponse {
  time: string;
  satellites: {
    name: string;
    role: string;
    lng: number;
    lat: number;
    alt_km: number;
    track: [number, number][];
  }[];
}

export interface AreaResponse {
  covered: boolean;
  forecast?: {
    as_of_week: string;
    by_horizon: Record<
      string,
      { max: number; mean: number; climatology_mean: number; cells_over_10pct: number }
    >;
  };
  fire_dna?: Record<string, number>;
  season_shift?: { cells: number; median_days_per_decade: number; significant_cells: number };
  season_shift_region?: Record<'start_doy' | 'peak_doy' | 'end_doy', number | null>;
  blind_cells?: number;
  alerts?: Record<string, number>;
  static_sources?: number;
  model_quality?: { roc_auc: number; pr_auc: number; baseline_pr_auc: number };
}

interface StrategyStats {
  median_min: number;
  p90_min: number;
  share_within_15min: number;
  share_within_60min: number;
}

export interface MissionResponse {
  ai1: {
    p_real: { roc_auc: number; baseline_confidence_only_auc: number };
    p_escalation: {
      roc_auc: number;
      pr_auc: number;
      baseline_frp_only_auc: number;
      baseline_frp_only_pr_auc: number;
    };
    critical_precision: number | null;
    model: {
      onnx_int8_kb?: number;
      onnx_fp32_kb: number;
      parameters?: number;
      latency_us_per_detection_cpu: number;
    };
    onboard_table_kb: number;
  } | null;
  ai2: {
    ai: { roc_auc: number; pr_auc: number; early_warning_recall_at_5pct_false_alarms: number };
    baseline_margin_rule: {
      roc_auc: number;
      pr_auc: number;
      early_warning_recall_at_5pct_false_alarms: number;
    };
    model: { onnx_kb: number; parameters: number };
  } | null;
  delivery: {
    replay_day: string;
    alerts: number;
    alerts_by_priority: Record<string, number>;
    strategies: Record<string, { all: StrategyStats; critical: StrategyStats | null }>;
    collaborative_network: {
      critical_alerts: number;
      confirmed_by_other_satellite_12h: number | null;
      median_minutes_to_confirmation: number | null;
    };
  } | null;
  delays: { stream: string; median_latency_min: number; status: string }[] | null;
  /** The onboard AIs compiled to integer-only C99 (helios/onboard/export_c.py). */
  onboard_c?: {
    selftest: { vectors: number; bit_exact_mismatches: number; packet_ok: boolean } | null;
    targets: { target: string; ok: boolean; rom_bytes: number | null }[];
  };
  blackouts: {
    satellite: string;
    minutes_without_any_link: number;
    longest_gap_min: number;
    minutes_without_link_with_real_relays?: number;
    minutes_without_link_with_relay_76E?: number;
    minutes_without_link_with_relay_76e?: number;
  }[];
}

export interface StatusResponse {
  data: { sample: { total_rows: number; sample_rows: number; sample_rate: number } } | null;
  models: {
    ai3_ground: Record<string, { test: { ai: BinaryMetrics; baseline_climatology: BinaryMetrics } }> | null;
  };
  /** World archive in numbers (present when the world aggregates are built). */
  world?: { countries: number; regions: number; detections: number; first_month: number; last_month: number; static_cells: number };
  harmonization: {
    denial_test: { total_error_pct: number; spearman_rho: number; interval_coverage_95: number };
    step_tests: Record<string, { raw_detections: number; harmonized: number; aqua_only: number }>;
  } | null;
}

export interface LinkParams {
  xray_flux: number;
  kp: number;
  rain_mm_h: number;
  cloud_frac: number;
  elevation_deg: number;
  laser_power_w: number;
}

export interface LinkResponse {
  ionosphere: { absorption_db: Record<string, number>; plasma_freq_F2_MHz: number };
  margins_db: Record<string, number>;
  alert_mode_margins_db: Record<string, number>;
  laser_beam: { spot_radius_m: number; divergence_urad: number; optical_received_w: number };
  recommended_channel: string;
  alert_channel: string;
}

/* ------------------------------------------------------------------ hooks */

/** True once the app knows it runs on the real HELIOS backend (not the synthetic demo). */
/** True once the start-up probe has picked the real HELIOS API (an external store, so no update is missed). */
export function useHeliosAvailable(): boolean {
  return useSyncExternalStore(onDataMode, dataMode) === 'http';
}

/** The HELIOS server answers (possibly without the fire archive): enough for the live satellites. */
export function useHeliosLive(): boolean {
  return useSyncExternalStore(onHeliosLive, heliosLive);
}

const minute = 60_000;

export function useHeliosStatus(enabled = true) {
  return useQuery({
    queryKey: ['helios', 'status'],
    queryFn: ({ signal }) => getJson<StatusResponse>('status', {}, signal),
    enabled,
    staleTime: 10 * minute,
  });
}

export function useHeliosScenarios(enabled = true) {
  return useQuery({
    queryKey: ['helios', 'scenarios'],
    queryFn: ({ signal }) => getJson<ScenariosResponse>('scenarios', {}, signal),
    enabled,
    staleTime: 30 * minute,
  });
}

export function useHeliosRisk(horizon: number, asOf: string, enabled: boolean) {
  return useQuery({
    queryKey: ['helios', 'risk', horizon, asOf],
    queryFn: ({ signal }) => getJson<RiskResponse>('risk', { horizon, as_of: asOf }, signal),
    enabled,
    staleTime: 30 * minute,
    placeholderData: keepPreviousData,
  });
}

export function useHeliosAlerts(enabled: boolean) {
  return useQuery({
    queryKey: ['helios', 'alerts'],
    queryFn: ({ signal }) => getJson<RowsResponse<AlertRow>>('alerts', {}, signal),
    enabled,
    refetchInterval: 10 * minute,
  });
}

export function useHeliosStatic(enabled: boolean) {
  return useQuery({
    queryKey: ['helios', 'static'],
    queryFn: ({ signal }) => getJson<RowsResponse<StaticRow>>('static', {}, signal),
    enabled,
    staleTime: Infinity,
  });
}

export function useHeliosBlind(enabled: boolean) {
  return useQuery({
    queryKey: ['helios', 'blind'],
    queryFn: ({ signal }) => getJson<RowsResponse<BlindRow>>('blind', {}, signal),
    enabled,
    refetchInterval: 30 * minute,
  });
}

export function useHeliosSpread(enabled: boolean) {
  return useQuery({
    queryKey: ['helios', 'spread'],
    queryFn: ({ signal }) => getJson<FeatureCollection<Polygon, SpreadProperties>>('spread', {}, signal),
    enabled,
    refetchInterval: 30 * minute,
  });
}

export function useHeliosSatellites(enabled: boolean) {
  return useQuery({
    queryKey: ['helios', 'satellites'],
    queryFn: ({ signal }) => getJson<SatellitesResponse>('satellites', {}, signal),
    enabled,
    refetchInterval: minute,
  });
}

export function useHeliosArea(bbox: BBox | null, regionId: string | null, enabled = true) {
  return useQuery({
    queryKey: ['helios', 'area', bbox ? bboxToParam(bbox) : 'none', regionId ?? ''],
    queryFn: ({ signal }) =>
      getJson<AreaResponse>('area', { bbox: bboxToParam(bbox!), region: regionId ?? undefined }, signal),
    enabled: enabled && bbox !== null,
    staleTime: 10 * minute,
    placeholderData: keepPreviousData,
  });
}

export function useHeliosMission(enabled = true) {
  return useQuery({
    queryKey: ['helios', 'mission'],
    queryFn: ({ signal }) => getJson<MissionResponse>('mission', {}, signal),
    enabled,
    staleTime: 10 * minute,
  });
}

export function useHeliosLink(params: LinkParams, enabled = true) {
  return useQuery({
    queryKey: ['helios', 'link', params],
    queryFn: ({ signal }) => getJson<LinkResponse>('link', { ...params }, signal),
    enabled,
    staleTime: Infinity,
    placeholderData: keepPreviousData,
  });
}

/* ------------------------------------------------------------------ constellation (five real satellites) */

/** Constellation actions: data on board, dump to the satellite's own station (or TDRS), direct broadcast received. */
export const ACTION = { STORE: 0, DOWNLINK: 1, BROADCAST: 5 } as const;

/**
 * [action, station receiving the direct broadcast (-1 none), station of the current link, p(link drop in 5 min),
 * minutes to loss of signal, MB waiting on board, channel ("X" | "Ka" | "TDRS" | "DB" | "")]
 */
export type ConstellationState = [number, number, number, number, number, number, string];

export type DropReason = '' | 'los' | 'weather' | 'margin' | 'outage';
/** [minutes until the link drops (null: not in this window), minutes until the next link, its station, why, p(drop in 5 min)] */
export type ForecastRow = [number | null, number | null, number, DropReason, number];

export type DeliveryPath = '' | 'db' | 'dump' | 'tdrs';
/** [minutes until data taken now are on the ground, path, station, the same without direct-broadcast reception] */
export type DeliveryRow = [number | null, DeliveryPath, number, number | null];

export interface RegionPass {
  sat: number;
  t_start: number;
  t_end: number;
  /** Step when all of this pass's data over the region are on the ground (null: not in this window). */
  ground_t: number | null;
  wait_min: number | null;
  wait_dump_min: number | null;
  path: DeliveryPath;
  station: number;
}

export interface LatencyStats {
  median_min: number | null;
  p90_min: number | null;
  max_min: number | null;
}

export interface ConstellationResponse {
  start: string;
  step_s: number;
  minutes: number;
  storm: string | null;
  outage: string | null;
  db: boolean;
  satellites: {
    name: string;
    track: [number, number, number][];
    sensor: 'MODIS' | 'VIIRS';
    /** Date the operator stopped its data (Suomi NPP: 2026-11-02), else null. */
    retired: string | null;
    broadcast: boolean;
    access: 'TDRS' | string[];
  }[];
  stations: { id: string; name: string; lat: number; lon: number; kind: 'radio' | 'optical' }[];
  states: ConstellationState[][];
  forecast: ForecastRow[][];
  delivery: DeliveryRow[][];
  region: { name: string; bbox: [number, number, number, number]; passes: RegionPass[]; first: { sat: number; t_end: number; ground_t: number } | null };
  summary: { delivered_mb: number; latency: { now: LatencyStats; with_db: LatencyStats | null; beyond_window: number } };
}

export interface ConstellationScenario {
  /** Station id with a storm over it, "auto" (the server picks the one where it matters most) or null. */
  storm: string | null;
  /** Station id under maintenance (e.g. MCMURDO), or null. */
  outage: string | null;
  /** Own direct-broadcast receiving station in Astana (ground equipment; the satellites stay as they are). */
  db: boolean;
}

/** Terra, Aqua, Suomi NPP, NOAA-20 and NOAA-21 on their real orbits with their real ground stations. */
export function useConstellation(enabled: boolean, s: ConstellationScenario) {
  return useQuery({
    queryKey: ['helios', 'constellation', s.storm ?? '', s.outage ?? '', s.db],
    queryFn: ({ signal }) =>
      getJson<ConstellationResponse>(
        'constellation',
        { minutes: 120, storm: s.storm ?? undefined, outage: s.outage ?? undefined, db: s.db ? 'true' : undefined },
        signal,
      ),
    enabled,
    staleTime: 10 * minute,
    refetchInterval: 10 * minute,
    placeholderData: keepPreviousData,
  });
}

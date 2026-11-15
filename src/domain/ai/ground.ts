import type { FireArchive } from '../archive';
import { FLAG_LOW_CONFIDENCE, FLAG_STATIC, scoreFilter, type FilterScore } from '../noise';
import { FLEET, type SensorName } from '../orbit';
import { simulateLinks } from './link';

/**
 * AI #3 — the ground segment (a data centre, not a satellite): the heavy processing the onboard AIs
 * cannot afford.
 *
 *   1. Noise filtering over the whole 26-year archive (src/domain/noise.ts: low confidence + persistent
 *      heat sources), scored against ground truth where it exists.
 *   2. Weather overlay: wind, temperature, humidity, drought, air masses and storm warnings at the fire.
 *      Here the fields are SYNTHETIC (moving pressure systems over a seasonal background); production
 *      would read a numerical weather model (e.g. ERA5 reanalysis, GFS forecasts).
 *   3. Fire-spread forecast: McArthur Mk5 fire-danger indices (forest FFDI, grassland GFDI, as written by
 *      Noble et al. 1980) give the rate of spread; Alexander's (1985) length-to-breadth ratio turns it into
 *      an ellipse downwind for 6, 12 and 24 h, assuming the weather holds.
 *   4. Signal-delay tracking: age of every satellite's data when it reaches the ground, from AI #2's
 *      link plan, against the 3-hour near-real-time target.
 * Flood forecasting is NOT here: it needs rainfall and terrain models that MODIS/VIIRS fire data do not
 * provide; the heavy-rain warning is the only flood-related output.
 */

/* ------------------------------------------------------------------ weather overlay */

export type AirMass = 'polar' | 'maritime' | 'continentalDry' | 'continentalMoist';
export type Warning = 'gale' | 'heavyRain' | 'fireWeather' | 'severeDanger';

export interface Weather {
  /** 10 m wind speed, km/h. */
  windKmh: number;
  /** Direction the wind blows FROM, degrees clockwise from north. */
  windFromDeg: number;
  tempC: number;
  /** Relative humidity, %. */
  rh: number;
  /** McArthur drought factor, 0–10 (10 = fuel fully available). */
  drought: number;
  /** Rain in the last 24 h, mm. */
  rain24h: number;
  pressureHpa: number;
  airMass: AirMass;
}

interface PressureSystem {
  lat: number;
  lng: number;
  /** hPa; negative = low (cyclone), positive = high (anticyclone). */
  amplitude: number;
  radiusKm: number;
  /** Eastward drift, km/h. */
  driftKmh: number;
}

/** A handful of systems over Eurasia drifting east with the westerlies (illustrative, not a forecast). */
const SYSTEMS: readonly PressureSystem[] = [
  { lat: 52, lng: 58, amplitude: -14, radiusKm: 700, driftKmh: 32 },
  { lat: 45, lng: 78, amplitude: 11, radiusKm: 900, driftKmh: 18 },
  { lat: 57, lng: 92, amplitude: -9, radiusKm: 600, driftKmh: 40 },
  { lat: 40, lng: 50, amplitude: 7, radiusKm: 800, driftKmh: 22 },
];

const KM_PER_DEG = 111.32;
const DEG = Math.PI / 180;

function pressureAnomaly(lat: number, lng: number, hours: number): number {
  let p = 0;
  for (const s of SYSTEMS) {
    const cLng = s.lng + (s.driftKmh * hours) / (KM_PER_DEG * Math.cos(s.lat * DEG));
    const dy = (lat - s.lat) * KM_PER_DEG;
    const dx = (lng - cLng) * KM_PER_DEG * Math.cos(lat * DEG);
    p += s.amplitude * Math.exp(-(dx * dx + dy * dy) / (2 * s.radiusKm * s.radiusKm));
  }
  return p;
}

/**
 * Synthetic weather at a point and time (`hours` after 2026-08-01 00:00 UTC). Deterministic. The wind is
 * quasi-geostrophic: it blows along the isobars, anticlockwise round lows in the northern hemisphere.
 */
export function syntheticWeather(lat: number, lng: number, hours = 8): Weather {
  const p = pressureAnomaly(lat, lng, hours);
  const e = 0.25; // degrees, for the gradient
  const dpdx =
    (pressureAnomaly(lat, lng + e, hours) - pressureAnomaly(lat, lng - e, hours)) /
    (2 * e * KM_PER_DEG * Math.cos(lat * DEG));
  const dpdy =
    (pressureAnomaly(lat + e, lng, hours) - pressureAnomaly(lat - e, lng, hours)) / (2 * e * KM_PER_DEG);
  const hemi = lat >= 0 ? 1 : -1;
  // Geostrophic components (east, north), scaled to km/h, plus mid-latitude westerlies.
  const u = -hemi * dpdy * 2000 + 6;
  const v = hemi * dpdx * 2000;
  const windKmh = Math.min(110, Math.hypot(u, v));
  // Meteorological convention: the direction the air comes from.
  const windFromDeg = (Math.atan2(-u, -v) / DEG + 360) % 360;

  const localHour = (((hours + lng / 15) % 24) + 24) % 24;
  const diurnal = 6 * Math.cos(((localHour - 15) / 24) * 2 * Math.PI);
  const tempC = 31 - 0.42 * Math.abs(lat - 30) + diurnal + p * 0.15;
  const lowness = Math.max(0, -p) / 14;
  const rain24h = Math.max(0, lowness * 34 - 6);
  const rh = Math.max(8, Math.min(97, 52 - 1.4 * (tempC - 20) + lowness * 38));
  const drought = Math.max(0, Math.min(10, 10 - rain24h * 0.35 - Math.max(0, rh - 35) / 9));
  const airMass: AirMass =
    tempC < 6 ? 'polar' : rh > 72 ? 'maritime' : rh < 32 ? 'continentalDry' : 'continentalMoist';
  return { windKmh, windFromDeg, tempC, rh, drought, rain24h, pressureHpa: 1013 + p, airMass };
}

/* ------------------------------------------------------------------ fire danger and spread */

export type Fuel = 'grass' | 'forest';
export type DangerClass = 'low' | 'moderate' | 'high' | 'veryHigh' | 'severe' | 'extreme' | 'catastrophic';
const DANGER_CLASSES: DangerClass[] = [
  'low',
  'moderate',
  'high',
  'veryHigh',
  'severe',
  'extreme',
  'catastrophic',
];
/** Upper bounds of the classes (Australian fire-danger rating, pre-2022 scale). */
const DANGER_BOUNDS: Record<Fuel, number[]> = {
  forest: [5, 12, 25, 50, 75, 100],
  grass: [3, 8, 20, 50, 75, 100],
};

export function dangerClass(index: number, fuel: Fuel): DangerClass {
  const b = DANGER_BOUNDS[fuel];
  const i = b.findIndex((ub) => index < ub);
  return DANGER_CLASSES[i < 0 ? b.length : i]!;
}

/**
 * Ceiling of both danger indices: twice the top of the "catastrophic" class. The McArthur fits are
 * exponential in wind and were never calibrated that far; without a ceiling, 90 km/h of wind at 45 °C made a
 * grass fire run at ~50 km/h. With it the grass head fire tops out at 0.13 × 200 = 26 km/h.
 */
export const INDEX_CAP = 200;

/**
 * Below this the grass moisture equation is outside its domain: it has a pole at −6 °C (fuel moisture → ∞,
 * i.e. no fire, when approached from above; a sign flip and an explosion below — −7 °C gave GFDI ≈ 1.7·10⁹).
 * At −5 °C it already gives 0 for any humidity, so returning 0 below keeps it continuous.
 */
export const GFDI_MIN_TEMP_C = -5;

/** McArthur Mk5 forest fire-danger index (Noble et al. 1980). */
export function ffdi(w: Pick<Weather, 'tempC' | 'rh' | 'windKmh' | 'drought'>): number {
  const d = Math.max(0.1, w.drought);
  return Math.min(
    INDEX_CAP,
    2 * Math.exp(-0.45 + 0.987 * Math.log(d) - 0.0345 * w.rh + 0.0338 * w.tempC + 0.0234 * w.windKmh),
  );
}

/**
 * McArthur Mk4/5 grassland fire-danger index (Noble et al. 1980): fuel moisture from temperature and
 * humidity at a given curing (%), then the index from fuel load W (t/ha) and wind.
 */
export function gfdi(w: Pick<Weather, 'tempC' | 'rh' | 'windKmh'>, curingPct = 95, loadTHa = 4.5): number {
  if (w.tempC <= GFDI_MIN_TEMP_C) return 0;
  const c = Math.max(20, Math.min(100, curingPct));
  const m = (97.7 + 4.06 * w.rh) / (w.tempC + 6) - 0.00854 * w.rh + 3000 / c - 30;
  const index =
    m < 18.8
      ? 3.35 * loadTHa * Math.exp(-0.0897 * m + 0.0403 * w.windKmh)
      : Math.max(0, 0.299 * loadTHa * Math.exp(-1.686 + 0.0403 * w.windKmh) * (30 - m));
  return Math.min(INDEX_CAP, index);
}

/** Head-fire rate of spread, km/h: forest 0.0012·FFDI·W (W ≈ 15 t/ha), grass 0.13·GFDI. */
export function rateOfSpreadKmh(index: number, fuel: Fuel, loadTHa = fuel === 'forest' ? 15 : 4.5): number {
  return fuel === 'forest' ? 0.0012 * index * loadTHa : 0.13 * index;
}

/** Length-to-breadth ratio of a wind-driven fire (Alexander 1985), wind in km/h. */
export function lengthToBreadth(windKmh: number): number {
  return 1 + 8.729 * Math.pow(1 - Math.exp(-0.03 * Math.max(0, windKmh)), 2.155);
}

export interface SpreadHorizon {
  hours: number;
  /** Distance the head fire travels, km. */
  headKm: number;
  backKm: number;
  areaHa: number;
  perimeterKm: number;
  /** Closed ring [lng, lat][] of the predicted burnt area. */
  ring: [number, number][];
}

export interface SpreadForecast {
  fuel: Fuel;
  index: number;
  danger: DangerClass;
  rosKmh: number;
  lengthToBreadth: number;
  /** Direction the head fire runs to, degrees from north. */
  headingDeg: number;
  horizons: SpreadHorizon[];
  warnings: Warning[];
}

export function warningsFor(w: Weather, danger: DangerClass): Warning[] {
  const out: Warning[] = [];
  if (w.windKmh >= 62) out.push('gale');
  if (w.rain24h >= 30) out.push('heavyRain');
  if (w.tempC >= 32 && w.rh <= 20 && w.windKmh >= 30) out.push('fireWeather');
  if (danger === 'severe' || danger === 'extreme' || danger === 'catastrophic') out.push('severeDanger');
  return out;
}

/** Daily temperature swing used by the spread integration, °C (peak at 15:00 local). */
const DIURNAL_AMPLITUDE = 6;
const diurnalOffset = (localHour: number) =>
  DIURNAL_AMPLITUDE * Math.cos(((localHour - 15) / 24) * 2 * Math.PI);

/** The same air one hour later: temperature follows the daily cycle, humidity moves the opposite way. */
export function weatherAtHour(now: Weather, nowLocalHour: number, hoursAhead: number): Weather {
  const dT = diurnalOffset(nowLocalHour + hoursAhead) - diurnalOffset(nowLocalHour);
  return { ...now, tempC: now.tempC + dT, rh: Math.max(5, Math.min(100, now.rh - 1.4 * dT)) };
}

export interface SpreadOptions {
  fuel?: Fuel;
  hours?: readonly number[];
  curingPct?: number;
  loadTHa?: number;
  /** Local solar hour of `w` (default: 15). The run is integrated hour by hour through the daily cycle. */
  localHour?: number;
}

function dangerIndex(w: Weather, fuel: Fuel, opts: SpreadOptions): number {
  return fuel === 'forest' ? ffdi(w) : gfdi(w, opts.curingPct, opts.loadTHa);
}

/**
 * Elliptical spread from an ignition point. Wind is held constant (direction and speed); temperature and
 * humidity follow the daily cycle, so the fire slows at night as it does in reality. Still an upper-bound
 * style estimate: no terrain, no fuel breaks, no suppression.
 */
export function forecastSpread(
  ignition: { lat: number; lng: number },
  w: Weather,
  opts: SpreadOptions = {},
): SpreadForecast {
  const fuel = opts.fuel ?? 'grass';
  const localHour = opts.localHour ?? 15;
  const index = dangerIndex(w, fuel, opts);
  const danger = dangerClass(index, fuel);
  const ros = rateOfSpreadKmh(index, fuel, opts.loadTHa);
  const lb = lengthToBreadth(w.windKmh);
  const root = Math.sqrt(Math.max(0, lb * lb - 1));
  const headToBack = root > 0 ? (lb + root) / (lb - root) : 1;
  const heading = (w.windFromDeg + 180) % 360;
  const hd = heading * DEG;
  const cosLat = Math.cos(ignition.lat * DEG);
  const wanted = [...(opts.hours ?? [6, 12, 24])].sort((a, b) => a - b);
  const last = wanted[wanted.length - 1] ?? 0;
  // Head-fire distance after each whole hour, integrating the hourly rate of spread.
  const headAt: number[] = [0];
  for (let h = 0; h < last; h++) {
    const hourly = weatherAtHour(w, localHour, h + 0.5);
    headAt.push(headAt[h]! + rateOfSpreadKmh(dangerIndex(hourly, fuel, opts), fuel, opts.loadTHa));
  }
  const horizons = wanted.map((hours) => {
    const head = headAt[Math.min(headAt.length - 1, Math.round(hours))]!;
    const back = head / headToBack;
    const a = (head + back) / 2;
    const b = a / lb;
    const shift = (head - back) / 2;
    const ring: [number, number][] = [];
    for (let i = 0; i <= 64; i++) {
      const th = (i / 64) * 2 * Math.PI;
      const along = a * Math.cos(th) + shift;
      const across = b * Math.sin(th);
      const east = along * Math.sin(hd) + across * Math.cos(hd);
      const north = along * Math.cos(hd) - across * Math.sin(hd);
      ring.push([ignition.lng + east / (KM_PER_DEG * cosLat), ignition.lat + north / KM_PER_DEG]);
    }
    const perimeter = Math.PI * (3 * (a + b) - Math.sqrt((3 * a + b) * (a + 3 * b)));
    return { hours, headKm: head, backKm: back, areaHa: Math.PI * a * b * 100, perimeterKm: perimeter, ring };
  });
  return {
    fuel,
    index,
    danger,
    rosKmh: ros,
    lengthToBreadth: lb,
    headingDeg: heading,
    horizons,
    warnings: warningsFor(w, danger),
  };
}

/* ------------------------------------------------------------------ noise report */

export interface NoiseReport {
  detections: number;
  lowConfidence: number;
  staticSources: number;
  staticCells: number;
  kept: number;
  /** Against ground truth, when the archive carries it (synthetic demo / HELIOS server classes). */
  score: FilterScore | null;
}

export function noiseReport(archive: FireArchive): NoiseReport {
  const { table, flags, persistence } = archive;
  let low = 0;
  let stat = 0;
  for (let i = 0; i < table.n; i++) {
    if (flags[i]! & FLAG_STATIC) stat += 1;
    else if (flags[i]! & FLAG_LOW_CONFIDENCE) low += 1;
  }
  return {
    detections: table.n,
    lowConfidence: low,
    staticSources: stat,
    staticCells: persistence.staticCells,
    kept: table.n - low - stat,
    score: scoreFilter(table, (i) => flags[i] !== 0),
  };
}

/* ------------------------------------------------------------------ signal delays */

export type StreamStatus = 'fast' | 'nrt' | 'late';

export interface StreamDelay {
  satelliteId: string;
  satellite: string;
  sensor: SensorName;
  meanMin: number | null;
  medianMin: number | null;
  p90Min: number | null;
  maxMin: number | null;
  status: StreamStatus;
}

/** Near-real-time target of NASA LANCE/FIRMS: data within 3 hours of the overpass. */
export const NRT_TARGET_MIN = 180;

export function streamStatus(p90Min: number | null): StreamStatus {
  if (p90Min === null || p90Min > NRT_TARGET_MIN) return 'late';
  return p90Min <= 15 ? 'fast' : 'nrt';
}

/** Age of each stream's data on arrival, from AI #2's link plans over the same window. */
export function trackDelays(
  opts: { minutes?: number; stormStation?: string | null; kp?: number } = {},
): StreamDelay[] {
  return FLEET.map((sat) => {
    const r = simulateLinks({
      satelliteId: sat.id,
      minutes: opts.minutes ?? 180,
      stormStation: opts.stormStation ?? null,
      kp: opts.kp ?? 2,
      policy: 'ai',
    });
    return {
      satelliteId: sat.id,
      satellite: sat.name,
      sensor: sat.sensor,
      meanMin: r.stats.meanDelayMin,
      medianMin: r.stats.medianDelayMin,
      p90Min: r.stats.p90DelayMin,
      maxMin: r.stats.maxDelayMin,
      status: streamStatus(r.stats.p90DelayMin),
    };
  });
}

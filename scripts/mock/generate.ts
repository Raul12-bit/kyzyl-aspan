import { buildCalendar, type ZoneCalendarSeries } from '../../src/data/mock/engine/calendar';
import { TRUNC, zoneWeight, type ZoneRecord, type ZonesFile } from '../../src/data/mock/engine/zones';
import type { BBox, Region } from '../../src/data/types';
import {
  daysInMonth,
  END_MONTH,
  END_YEAR,
  fromMonthIndex,
  isoToDayOffset,
  monthIndex,
  MONTH_COUNT,
  monthStartIso,
  START_YEAR,
  toYearMonth,
  VIIRS_START_INDEX,
} from '../../src/lib/date';
import { clamp, wrapLng } from '../../src/lib/geo';
import { round } from '../../src/lib/stats';
import { FALSE_ALARM, STATIC_DEFS, STATIC_PROFILE } from './noise-defs';
import { buildRegions } from './regions';
import { hashSeed, lognormalFactor, mulberry32, normal, pickIndex, poisson, truncatedNormal } from './rng';
import { DEMO_BBOX, FOCUS_COVERAGE, INJECTED_ANOMALIES, SEASONS, ZONE_DEFS, type ZoneDef } from './zone-defs';

export const DEFAULT_SEED = 20261114;
export const DATA_VERSION = 'mock-2026.11-2';

/** MODIS points in the map sample: the focus region is denser so Kazakhstan reads well up close. */
export const SAMPLE = { focus: 2000, world: 4200 } as const;

/**
 * Synthetic observation model of one fire-day (ASSUMPTIONS, chosen to be plausible, not measured):
 * MODIS detects a large fire-day with probability pM and reports 1 + Poisson(extraM) pixels; VIIRS
 * detects it with pV; small fire-days (smallShare of the large ones) are seen by VIIRS only, with
 * 1 + Poisson(smallExtraV) pixels.
 */
const FIRE_DAY = { pM: 0.9, extraM: 0.3, pV: 0.97, smallShare: 0.35, smallExtraV: 0.5 } as const;

const TRUTH_STATIC = 1;
const TRUTH_FALSE_ALARM = 2;

/** [lng, lat, sensor, day, frp, confidence, truth] */
export type FireRowOut = [number, number, 0 | 1, number, number, 0 | 1 | 2, 0 | 1 | 2];

const YEARS = END_YEAR - START_YEAR + 1;

/** Columnar-ish compact format of fires.json; the data source expands it into GeoJSON. */
export interface FiresFile {
  version: string;
  /** Day 0 of the `day` column. */
  epoch: string;
  fields: ['lng', 'lat', 'sensor', 'day', 'frp', 'confidence', 'truth'];
  sensors: ['MODIS', 'VIIRS'];
  confidence: ['low', 'nominal', 'high'];
  /** Synthetic ground truth (7th column): what the hot pixel really was. Real archives carry no such label. */
  truth: ['fire', 'static', 'false-alarm'];
  rows: FireRowOut[];
}

export interface IntroFile {
  version: string;
  /** [lng, lat, weight 0…1] — aggregated activity for the intro globe. */
  rows: [number, number, number][];
}

export interface Manifest {
  version: string;
  seed: number;
  synthetic: true;
  note: string;
  period: { start: string; end: string };
  counts: {
    zones: number;
    regions: number;
    fires: number;
    firesModis: number;
    firesViirs: number;
    introPoints: number;
    /** Rows that are not vegetation fires (synthetic truth). */
    staticRows: number;
    falseAlarmRows: number;
  };
  demo: { bbox: BBox; ratio: number; anomalies: string[] };
}

export interface GeneratedData {
  zones: ZonesFile;
  fires: FiresFile;
  intro: IntroFile;
  regions: Region[];
  manifest: Manifest;
  demoCalendar: ZoneCalendarSeries;
}

function normalizeSeason(weights: readonly number[]): number[] {
  const m = weights.reduce((a, b) => a + b, 0) / weights.length;
  return weights.map((w) => w / m);
}

/** Latent expected MODIS activity per zone and month (before bursts and Poisson noise). */
function buildLatents(seed: number, defs: readonly ZoneDef[]): number[][] {
  const rng = mulberry32(hashSeed(seed, 1));
  const climateYear = new Map<string, number[]>();
  for (const def of defs) {
    if (!climateYear.has(def.climate)) {
      climateYear.set(
        def.climate,
        Array.from({ length: YEARS }, () => lognormalFactor(rng, 0.2)),
      );
    }
  }
  return defs.map((def, zi) => {
    const zr = mulberry32(hashSeed(seed, 2, zi));
    const season = normalizeSeason(SEASONS[def.regime]);
    const zoneYear = Array.from({ length: YEARS }, () => lognormalFactor(zr, 0.1));
    const climate = climateYear.get(def.climate)!;
    const out: number[] = [];
    for (let t = 0; t < MONTH_COUNT; t++) {
      const { year, month } = fromMonthIndex(t);
      const yi = year - START_YEAR;
      const trend = Math.pow(1 + def.trend, year - 2013);
      const noise = lognormalFactor(zr, 0.16);
      out.push((def.annual / 12) * season[month - 1]! * climate[yi]! * zoneYear[yi]! * trend * noise);
    }
    return out;
  });
}

function realize(
  seed: number,
  defs: readonly ZoneDef[],
  latents: readonly number[][],
  burst: readonly number[],
  affected: readonly boolean[],
): ZoneRecord[] {
  return defs.map((def, zi) => {
    const modis: number[] = [];
    const viirs: number[] = [];
    for (let t = 0; t < MONTH_COUNT; t++) {
      const lambda = latents[zi]![t]! * (affected[zi] ? burst[t]! : 1);
      modis.push(poisson(mulberry32(hashSeed(seed, 3, zi, t)), lambda));
      if (t >= VIIRS_START_INDEX) {
        const r = mulberry32(hashSeed(seed, 4, zi, t));
        viirs.push(poisson(r, lambda * def.k * lognormalFactor(r, 0.07)));
      }
    }
    return { id: def.id, center: def.center, sigma: def.sigma, modis, viirs };
  });
}

function coverageBoxes(defs: readonly ZoneDef[]): BBox[] {
  const boxes: BBox[] = [FOCUS_COVERAGE];
  for (const d of defs) {
    if (d.focus) continue;
    const pad = 1;
    boxes.push([
      round(clamp(d.center[0] - TRUNC * d.sigma[0] - pad, -180, 180), 2),
      round(clamp(d.center[1] - TRUNC * d.sigma[1] - pad, -85, 85), 2),
      round(clamp(d.center[0] + TRUNC * d.sigma[0] + pad, -180, 180), 2),
      round(clamp(d.center[1] + TRUNC * d.sigma[1] + pad, -85, 85), 2),
    ]);
  }
  return boxes;
}

function zonesFile(seed: number, records: ZoneRecord[], coverage: BBox[]): ZonesFile {
  return {
    version: DATA_VERSION,
    seed,
    start: toYearMonth(START_YEAR, 1),
    months: MONTH_COUNT,
    viirsStartIndex: VIIRS_START_INDEX,
    coverage,
    zones: records,
  };
}

/**
 * Generates zone series and tunes the injected bursts until exactly the injected months
 * (3–5 of them) reach anomalyZ ≥ 2 inside the demo box. Fully deterministic for a given seed.
 */
function generateZones(seed: number, defs: readonly ZoneDef[]): { file: ZonesFile; calendar: ZoneCalendarSeries } {
  const latents = buildLatents(seed, defs);
  const affected = defs.map((d) => zoneWeight(d, DEMO_BBOX) > 0.3);
  const injected = new Set(INJECTED_ANOMALIES.map((a) => monthIndex(a.year, a.month)));
  const burst = new Array<number>(MONTH_COUNT).fill(1);
  for (const a of INJECTED_ANOMALIES) burst[monthIndex(a.year, a.month)] = a.factor;
  const coverage = coverageBoxes(defs);

  let file = zonesFile(seed, realize(seed, defs, latents, burst, affected), coverage);
  let calendar = buildCalendar(file, DEMO_BBOX);
  for (let iter = 0; iter < 60; iter++) {
    const hits = new Set(
      calendar.points.flatMap((p, t) => (p.anomalyZ !== null && p.anomalyZ >= 2 ? [t] : [])),
    );
    const extra = [...hits].filter((t) => !injected.has(t));
    const missing = [...injected].filter((t) => !hits.has(t));
    if (!extra.length && !missing.length) break;
    for (const t of extra) burst[t]! *= 0.85;
    for (const t of missing) burst[t]! *= 1.12;
    file = zonesFile(seed, realize(seed, defs, latents, burst, affected), coverage);
    calendar = buildCalendar(file, DEMO_BBOX);
  }
  return { file, calendar };
}

const SENSOR_MEDIAN_FRP = [16, 4] as const;
const SENSOR_FRP_SIGMA = [0.85, 0.9] as const;

function sampleScale(defs: readonly ZoneDef[], records: readonly ZoneRecord[]) {
  const total = (focus: boolean) =>
    records.reduce((acc, z, i) => (defs[i]!.focus === focus ? acc + z.modis.reduce((a, b) => a + b, 0) : acc), 0);
  return { focus: SAMPLE.focus / total(true), world: SAMPLE.world / total(false) };
}

/**
 * Persistent heat sources (flares, steel works, volcanoes): the same spot in every season, year after
 * year, mostly nominal/high confidence — exactly what a confidence threshold alone cannot remove.
 */
function generateStaticSources(seed: number): FireRowOut[] {
  const rows: FireRowOut[] = [];
  STATIC_DEFS.forEach((def, si) => {
    const profile = STATIC_PROFILE[def.kind];
    for (let t = monthIndex(Math.max(START_YEAR, def.since), 1); t < MONTH_COUNT; t++) {
      const r = mulberry32(hashSeed(seed, 7, si, t));
      const { year, month } = fromMonthIndex(t);
      const dim = daysInMonth(year, month);
      const monthOffset = isoToDayOffset(monthStartIso(t));
      const counts = [poisson(r, def.rate), t >= VIIRS_START_INDEX ? poisson(r, def.rate * profile.viirsBoost) : 0];
      for (const sensor of [0, 1] as const) {
        for (let i = 0; i < counts[sensor]!; i++) {
          // A few hundred metres of jitter: the source stays inside one fine grid cell.
          const lat = clamp(def.at[1] + normal(r) * 0.006, -89, 89);
          const lng = wrapLng(def.at[0] + (normal(r) * 0.006) / Math.cos((lat * Math.PI) / 180));
          const frp = Math.max(0.5, round(profile.medianFrp[sensor] * Math.exp(normal(r) * profile.frpSigma), 1));
          const u = r();
          const conf: 0 | 1 | 2 = u < 0.06 ? 0 : u < 0.5 ? 1 : 2;
          rows.push([round(lng, 3), round(lat, 3), sensor, monthOffset + pickIndex(r, dim), frp, conf, TRUTH_STATIC]);
        }
      }
    }
  });
  return rows;
}

/** Sun glint, hot bare ground, cloud edges: scattered, weak and usually flagged low-confidence. */
function generateFalseAlarms(
  seed: number,
  defs: readonly ZoneDef[],
  records: readonly ZoneRecord[],
  scale: { focus: number; world: number },
): FireRowOut[] {
  const rows: FireRowOut[] = [];
  records.forEach((zone, zi) => {
    const s = defs[zi]!.focus ? scale.focus : scale.world;
    const meanModis = (zone.modis.reduce((a, b) => a + b, 0) * s) / MONTH_COUNT;
    const meanViirs = (zone.viirs.reduce((a, b) => a + b, 0) * s) / Math.max(1, MONTH_COUNT - VIIRS_START_INDEX);
    for (let t = 0; t < MONTH_COUNT; t++) {
      const r = mulberry32(hashSeed(seed, 8, zi, t));
      const { year, month } = fromMonthIndex(t);
      const dim = daysInMonth(year, month);
      const monthOffset = isoToDayOffset(monthStartIso(t));
      const counts = [
        poisson(r, meanModis * FALSE_ALARM.share),
        t >= VIIRS_START_INDEX ? poisson(r, meanViirs * FALSE_ALARM.share) : 0,
      ];
      for (const sensor of [0, 1] as const) {
        for (let i = 0; i < counts[sensor]!; i++) {
          const lat = clamp(zone.center[1] + zone.sigma[1] * FALSE_ALARM.sigmaFactor * truncatedNormal(r, TRUNC), -89, 89);
          const lng = wrapLng(zone.center[0] + zone.sigma[0] * FALSE_ALARM.sigmaFactor * truncatedNormal(r, TRUNC));
          const frp = Math.max(0.3, round(FALSE_ALARM.medianFrp[sensor] * Math.exp(normal(r) * FALSE_ALARM.frpSigma), 1));
          const conf: 0 | 1 | 2 = r() < FALSE_ALARM.lowConfidence ? 0 : 1;
          rows.push([round(lng, 3), round(lat, 3), sensor, monthOffset + pickIndex(r, dim), frp, conf, TRUTH_FALSE_ALARM]);
        }
      }
    }
  });
  return rows;
}

function generateFires(seed: number, defs: readonly ZoneDef[], records: readonly ZoneRecord[]): FiresFile {
  // Map sample: SAMPLE.focus MODIS points in the focus region and SAMPLE.world elsewhere; VIIRS follows its
  // own counts, so the ~3.5–4× VIIRS density is visible on the map exactly as in the raw series.
  const scale = sampleScale(defs, records);
  const rows: FireRowOut[] = [];

  records.forEach((zone, zi) => {
    const def = defs[zi]!;
    const s = def.focus ? scale.focus : scale.world;
    // Pixels per fire-day (ASSUMPTIONS of the synthetic model, see FIRE_DAY): MODIS sees a large fire-day
    // with probability pM and then 1 + Poisson(extraM) pixels; VIIRS sees it with pV and 1 + Poisson(mV)
    // pixels, where mV is solved so that the zone's raw VIIRS/MODIS ratio stays def.k.
    const { pM, extraM, pV, smallShare, smallExtraV } = FIRE_DAY;
    const modisPerDay = pM * (1 + extraM);
    const mV = Math.max(0, (def.k * modisPerDay - smallShare * (1 + smallExtraV)) / pV - 1);
    for (let t = 0; t < MONTH_COUNT; t++) {
      const r = mulberry32(hashSeed(seed, 5, zi, t));
      const viirsEra = t >= VIIRS_START_INDEX;
      // Fire-days first, pixels second: both sensors then observe the SAME fires. A fire front lights
      // ~1 MODIS pixel but several 375 m VIIRS pixels on one overpass — that is why raw VIIRS counts are
      // 3–4× higher while the number of burning H3 cells per day differs far less; VIIRS also catches
      // small fire-days MODIS misses (the residual gap the calibration handles).
      const lambda = (zone.modis[t]! * s) / modisPerDay;
      const nLarge = poisson(r, lambda);
      const nSmall = viirsEra ? poisson(r, lambda * smallShare) : 0;
      if (nLarge + nSmall === 0) continue;
      const { year, month } = fromMonthIndex(t);
      const dim = daysInMonth(year, month);
      const monthOffset = isoToDayOffset(monthStartIso(t));
      const nEvents = clamp(Math.round(1 + Math.sqrt(nLarge + nSmall) / 2), 1, 8);
      const events = Array.from({ length: nEvents }, () => ({
        lng: zone.center[0] + zone.sigma[0] * truncatedNormal(r, TRUNC),
        lat: zone.center[1] + zone.sigma[1] * truncatedNormal(r, TRUNC),
      }));
      const fireDays = Array.from({ length: nLarge + nSmall }, (_, k) => {
        const ev = events[k % nEvents]!;
        const large = k < nLarge;
        return {
          day: 1 + pickIndex(r, dim),
          lng: ev.lng + normal(r) * 0.05,
          lat: ev.lat + normal(r) * 0.05,
          modis: large && r() < pM ? 1 + poisson(r, extraM) : 0,
          viirs: !viirsEra ? 0 : large ? (r() < pV ? 1 + poisson(r, mV) : 0) : 1 + poisson(r, smallExtraV),
        };
      });
      const emit = (sensor: 0 | 1) => {
        for (const e of fireDays) {
          const count = sensor === 0 ? e.modis : e.viirs;
          for (let i = 0; i < count; i++) {
          const spread = sensor === 0 ? 0.03 : 0.02;
          const lat = clamp(e.lat + normal(r) * spread, -89, 89);
          const lng = wrapLng(e.lng + (normal(r) * spread) / Math.cos((lat * Math.PI) / 180));
          const day = e.day;
          const frp = Math.max(0.3, round(SENSOR_MEDIAN_FRP[sensor] * Math.exp(normal(r) * SENSOR_FRP_SIGMA[sensor]), 1));
          const score = r() + 0.18 * Math.log(frp / SENSOR_MEDIAN_FRP[sensor]);
          const conf: 0 | 1 | 2 = sensor === 0 ? (score > 0.72 ? 2 : score < 0.14 ? 0 : 1) : score > 0.86 ? 2 : score < 0.1 ? 0 : 1;
          rows.push([round(lng, 3), round(lat, 3), sensor, monthOffset + day - 1, frp, conf, 0]);
          }
        }
      };
      emit(0);
      emit(1);
    }
  });
  rows.push(...generateStaticSources(seed), ...generateFalseAlarms(seed, defs, records, scale));
  rows.sort((a, b) => a[3] - b[3] || a[0] - b[0] || a[1] - b[1] || a[2] - b[2] || a[6] - b[6]);
  return {
    version: DATA_VERSION,
    epoch: `${START_YEAR}-01-01`,
    fields: ['lng', 'lat', 'sensor', 'day', 'frp', 'confidence', 'truth'],
    sensors: ['MODIS', 'VIIRS'],
    confidence: ['low', 'nominal', 'high'],
    truth: ['fire', 'static', 'false-alarm'],
    rows,
  };
}

function generateIntro(seed: number, records: readonly ZoneRecord[]): IntroFile {
  const cells = new Map<string, { lng: number; lat: number; mass: number }>();
  for (const zone of records) {
    const annual = zone.modis.reduce((a, b) => a + b, 0) / YEARS;
    const [cx, cy] = zone.center;
    const [sx, sy] = zone.sigma;
    for (let x = Math.floor((cx - TRUNC * sx) / 2) * 2; x < cx + TRUNC * sx; x += 2) {
      for (let y = Math.floor((cy - TRUNC * sy) / 2) * 2; y < cy + TRUNC * sy; y += 2) {
        const mass = zoneWeight(zone, [x, y, x + 2, y + 2]) * annual;
        if (mass < 1) continue;
        const key = `${x}:${y}`;
        const cell = cells.get(key) ?? { lng: x + 1, lat: y + 1, mass: 0 };
        cell.mass += mass;
        cells.set(key, cell);
      }
    }
  }
  const top = [...cells.values()].sort((a, b) => b.mass - a.mass).slice(0, 320);
  const max = top[0]?.mass ?? 1;
  const r = mulberry32(hashSeed(seed, 6));
  return {
    version: DATA_VERSION,
    rows: top.map((c) => [
      round(wrapLng(c.lng + (r() - 0.5) * 1.2), 2),
      round(clamp(c.lat + (r() - 0.5) * 1.2, -85, 85), 2),
      round(Math.sqrt(c.mass / max), 3),
    ]),
  };
}

export function generateAll(seed = DEFAULT_SEED): GeneratedData {
  const { file: zones, calendar } = generateZones(seed, ZONE_DEFS);
  const fires = generateFires(seed, ZONE_DEFS, zones.zones);
  const intro = generateIntro(seed, zones.zones);
  const regions = buildRegions();
  const firesModis = fires.rows.filter((r) => r[2] === 0).length;
  const anomalies = calendar.points
    .filter((p) => p.anomalyZ !== null && p.anomalyZ >= 2)
    .map((p) => toYearMonth(p.year, p.month));
  const manifest: Manifest = {
    version: DATA_VERSION,
    seed,
    synthetic: true,
    note: 'Synthetic demo data generated by scripts/generate-mock-data.ts. Not real satellite detections.',
    period: { start: toYearMonth(START_YEAR, 1), end: toYearMonth(END_YEAR, END_MONTH) },
    counts: {
      zones: zones.zones.length,
      regions: regions.length,
      fires: fires.rows.length,
      firesModis,
      firesViirs: fires.rows.length - firesModis,
      introPoints: intro.rows.length,
      staticRows: fires.rows.filter((r) => r[6] === TRUTH_STATIC).length,
      falseAlarmRows: fires.rows.filter((r) => r[6] === TRUTH_FALSE_ALARM).length,
    },
    demo: { bbox: DEMO_BBOX, ratio: calendar.meta.ratio.value, anomalies },
  };
  return { zones, fires, intro, regions, manifest, demoCalendar: calendar };
}

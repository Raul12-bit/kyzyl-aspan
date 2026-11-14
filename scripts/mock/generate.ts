import { buildCalendar } from '../../src/data/mock/engine/calendar';
import { round } from '../../src/data/mock/engine/math';
import { TRUNC, zoneWeight, type ZoneRecord, type ZonesFile } from '../../src/data/mock/engine/zones';
import type { BBox, CalendarSeries, Region } from '../../src/data/types';
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
import { buildRegions } from './regions';
import { hashSeed, lognormalFactor, mulberry32, normal, pickIndex, poisson, truncatedNormal } from './rng';
import { DEMO_BBOX, FOCUS_COVERAGE, INJECTED_ANOMALIES, SEASONS, ZONE_DEFS, type ZoneDef } from './zone-defs';

export const DEFAULT_SEED = 20261114;
export const DATA_VERSION = 'mock-2026.11-1';

const YEARS = END_YEAR - START_YEAR + 1;

/** Columnar-ish compact format of fires.json; the data source expands it into GeoJSON. */
export interface FiresFile {
  version: string;
  /** Day 0 of the `day` column. */
  epoch: string;
  fields: ['lng', 'lat', 'sensor', 'day', 'frp', 'confidence'];
  sensors: ['MODIS', 'VIIRS'];
  confidence: ['low', 'nominal', 'high'];
  rows: [number, number, 0 | 1, number, number, 0 | 1 | 2][];
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
  counts: { zones: number; regions: number; fires: number; firesModis: number; firesViirs: number; introPoints: number };
  demo: { bbox: BBox; ratio: number; anomalies: string[] };
}

export interface GeneratedData {
  zones: ZonesFile;
  fires: FiresFile;
  intro: IntroFile;
  regions: Region[];
  manifest: Manifest;
  demoCalendar: CalendarSeries;
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
function generateZones(seed: number, defs: readonly ZoneDef[]): { file: ZonesFile; calendar: CalendarSeries } {
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

function generateFires(seed: number, defs: readonly ZoneDef[], records: readonly ZoneRecord[]): FiresFile {
  const total = (focus: boolean) =>
    records.reduce((acc, z, i) => (defs[i]!.focus === focus ? acc + z.modis.reduce((a, b) => a + b, 0) : acc), 0);
  // Map sample: ~1.3k MODIS points in the focus region and ~0.7k elsewhere; VIIRS follows its own counts,
  // so the ~3.5–4× VIIRS density is visible on the map exactly as in the raw series.
  const scale = { focus: 1300 / total(true), world: 700 / total(false) };
  const rows: FiresFile['rows'] = [];

  records.forEach((zone, zi) => {
    const def = defs[zi]!;
    const s = def.focus ? scale.focus : scale.world;
    for (let t = 0; t < MONTH_COUNT; t++) {
      const r = mulberry32(hashSeed(seed, 5, zi, t));
      const nM = poisson(r, zone.modis[t]! * s);
      const nV = t >= VIIRS_START_INDEX ? poisson(r, zone.viirs[t - VIIRS_START_INDEX]! * s) : 0;
      if (nM + nV === 0) continue;
      const { year, month } = fromMonthIndex(t);
      const dim = daysInMonth(year, month);
      const monthOffset = isoToDayOffset(monthStartIso(t));
      const nEvents = clamp(Math.round(1 + Math.sqrt(nM + nV) / 2), 1, 8);
      const events = Array.from({ length: nEvents }, () => ({
        lng: zone.center[0] + zone.sigma[0] * truncatedNormal(r, TRUNC),
        lat: zone.center[1] + zone.sigma[1] * truncatedNormal(r, TRUNC),
        day: 1 + pickIndex(r, dim),
      }));
      const emit = (sensor: 0 | 1, count: number) => {
        for (let i = 0; i < count; i++) {
          const e = events[pickIndex(r, nEvents)]!;
          const spread = sensor === 0 ? 0.11 : 0.09;
          const lat = clamp(e.lat + normal(r) * spread, -89, 89);
          const lng = wrapLng(e.lng + (normal(r) * spread) / Math.cos((lat * Math.PI) / 180));
          const day = clamp(e.day + Math.round(normal(r) * 3), 1, dim);
          const frp = Math.max(0.3, round(SENSOR_MEDIAN_FRP[sensor] * Math.exp(normal(r) * SENSOR_FRP_SIGMA[sensor]), 1));
          const score = r() + 0.18 * Math.log(frp / SENSOR_MEDIAN_FRP[sensor]);
          const conf: 0 | 1 | 2 = sensor === 0 ? (score > 0.72 ? 2 : score < 0.14 ? 0 : 1) : score > 0.86 ? 2 : score < 0.1 ? 0 : 1;
          rows.push([round(lng, 3), round(lat, 3), sensor, monthOffset + day - 1, frp, conf]);
        }
      };
      emit(0, nM);
      emit(1, nV);
    }
  });
  rows.sort((a, b) => a[3] - b[3] || a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
  return {
    version: DATA_VERSION,
    epoch: `${START_YEAR}-01-01`,
    fields: ['lng', 'lat', 'sensor', 'day', 'frp', 'confidence'],
    sensors: ['MODIS', 'VIIRS'],
    confidence: ['low', 'nominal', 'high'],
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
    },
    demo: { bbox: DEMO_BBOX, ratio: calendar.meta.ratio.value, anomalies },
  };
  return { zones, fires, intro, regions, manifest, demoCalendar: calendar };
}

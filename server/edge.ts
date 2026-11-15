/**
 * AI #1 on real detections: the trained onboard network (artifacts/models/edge_detector_weights.json, 1 482 weights)
 * with the exact features of helios/models/edge_detector.py — solar geometry, scan angle, glint, the overpass
 * context and the 26-year history of each cell (artifacts/models/onboard_history.bin, packed from
 * onboard_history.npz: monthly climatology of res-5 cells, years with fire of res-7 cells, persistent sources of
 * res-8 cells). Output: p(real fire), p(it grows within 72 h), a priority and the 24-byte alert packet that the
 * satellite would send first (helios/comms/packets.py: big-endian, CRC-16/CCITT).
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cellToParent, latLngToCell } from 'h3-js';
import weights from '../artifacts/models/edge_detector_weights.json';
import { config } from './config';

/** [lng, lat, sat, unixSec, frp, conf class, scanKm, trackKm, day, T4 K, T11 K, MODIS conf %] — server/live.ts rows. */
export type EdgeRow = readonly number[];

const DEG = Math.PI / 180;
const R_EARTH_KM = 6378.137;
const MODIS_ORBIT_KM = R_EARTH_KM + 705.0;
const MODIS_SAMPLING_RAD = 0.0014184397;
const VIIRS_ORBIT_KM = R_EARTH_KM + 829.0;
const VIIRS_TRACK_RAD = 0.000434;
const VIIRS_MAX_SCAN_DEG = 56.28;

const isModis = (sat: number) => sat <= 1;

/* ------------------------------------------------------------------ geometry (helios/processing) */

/** Solar zenith and azimuth, degrees (NOAA / Spencer formulas, helios/processing/solar.py). */
export function solarPosition(lat: number, lng: number, unixSec: number): { sza: number; az: number } {
  const d = new Date(unixSec * 1000);
  const start = Date.UTC(d.getUTCFullYear(), 0, 1);
  const doy = Math.floor((d.getTime() - start) / 86_400_000) + 1;
  const hours = d.getUTCHours() + d.getUTCMinutes() / 60 + d.getUTCSeconds() / 3600;
  const g = ((2 * Math.PI) / 365.25) * (doy - 1 + (hours - 12) / 24);
  const eqtime =
    229.18 *
    (0.000075 + 0.001868 * Math.cos(g) - 0.032077 * Math.sin(g) - 0.014615 * Math.cos(2 * g) - 0.040849 * Math.sin(2 * g));
  const decl =
    0.006918 -
    0.399912 * Math.cos(g) +
    0.070257 * Math.sin(g) -
    0.006758 * Math.cos(2 * g) +
    0.000907 * Math.sin(2 * g) -
    0.002697 * Math.cos(3 * g) +
    0.00148 * Math.sin(3 * g);
  const tst = (((hours * 60 + eqtime + 4 * lng) % 1440) + 1440) % 1440;
  const ha = (tst / 4 - 180) * DEG;
  const phi = lat * DEG;
  const cosSza = Math.min(1, Math.max(-1, Math.sin(phi) * Math.sin(decl) + Math.cos(phi) * Math.cos(decl) * Math.cos(ha)));
  const sza = Math.acos(cosSza) / DEG;
  const az = Math.atan2(Math.sin(ha), Math.cos(ha) * Math.sin(phi) - Math.tan(decl) * Math.cos(phi)) / DEG + 180;
  return { sza, az: ((az % 360) + 360) % 360 };
}

function modisScanKm(theta: number): number {
  const ratioSq = (R_EARTH_KM / MODIS_ORBIT_KM) ** 2;
  const root = Math.sqrt(Math.max(1e-9, ratioSq - Math.sin(theta) ** 2));
  return R_EARTH_KM * MODIS_SAMPLING_RAD * (Math.cos(theta) / root - 1);
}

function viirsTrackKm(theta: number): number {
  const ratioSq = (R_EARTH_KM / VIIRS_ORBIT_KM) ** 2;
  const root = Math.sqrt(Math.max(1e-9, ratioSq - Math.sin(theta) ** 2));
  return VIIRS_ORBIT_KM * VIIRS_TRACK_RAD * (Math.cos(theta) - root);
}

function bisect(fn: (x: number) => number, target: number, hi: number): number {
  let lo = 0;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (fn(mid) < target) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/** Scan angle from the pixel size (helios/processing/footprint.py), degrees. */
export function scanAngleDeg(sat: number, scanKm: number, trackKm: number): number {
  if (isModis(sat)) return bisect(modisScanKm, Math.max(scanKm, modisScanKm(0)), 55.5 * DEG) / DEG;
  const t = Math.min(Math.max(trackKm, viirsTrackKm(0)), viirsTrackKm(VIIRS_MAX_SCAN_DEG * DEG));
  return bisect(viirsTrackKm, t, VIIRS_MAX_SCAN_DEG * DEG) / DEG;
}

function viewZenithDeg(sat: number, scanDeg: number): number {
  const r = isModis(sat) ? MODIS_ORBIT_KM : VIIRS_ORBIT_KM;
  return Math.asin(Math.min(1, Math.max(-1, (r / R_EARTH_KM) * Math.sin(scanDeg * DEG)))) / DEG;
}

function trackAzimuthDeg(lat: number, sat: number, day: boolean): number {
  const inc = isModis(sat) ? 98.2 : 98.7;
  const cosLat = Math.max(0.15, Math.cos(lat * DEG));
  const base = Math.asin(Math.min(1, Math.max(-1, Math.cos(inc * DEG) / cosLat))) / DEG;
  // Terra is the morning, descending orbit; the others cross by day going north.
  const ascending = sat === 0 ? !day : day;
  return ascending ? (360 + base) % 360 : (((180 - base) % 360) + 360) % 360;
}

/** Smallest sun-glint angle for either side of the swath, degrees (helios/processing/solar.py). */
function glintAngleDeg(sza: number, sunAz: number, vza: number, trackAz: number): number {
  let out = 180;
  for (const side of [90, -90]) {
    const phi = (sunAz - (trackAz + side)) * DEG;
    const cosG = Math.cos(sza * DEG) * Math.cos(vza * DEG) - Math.sin(sza * DEG) * Math.sin(vza * DEG) * Math.cos(phi);
    out = Math.min(out, Math.acos(Math.min(1, Math.max(-1, cosG))) / DEG);
  }
  return out;
}

/** Unified P(fire) from the FIRMS confidence and the 4–11 µm contrast (helios/processing/filters.py). */
function unifiedProbability(r: EdgeRow, day: boolean): number {
  const dt45 = Math.max(0, (r[9] || 0) - (r[10] || 0));
  if (isModis(r[2]!)) {
    const conf = Math.min(100, Math.max(0, (r[11] ?? -1) >= 0 ? r[11]! : 50));
    const z = (conf - 38) / 19 + 0.015 * Math.min(40, Math.max(-10, dt45 - 18));
    return 1 / (1 + Math.exp(-z));
  }
  const cls = r[5];
  const anchor = cls === 2 ? 0.94 : cls === 1 ? (day ? 0.78 : 0.84) : day ? 0.28 : 0.38;
  return Math.min(0.99, Math.max(0.05, anchor + 0.06 * Math.tanh((dt45 - 20) / 15)));
}

/* ------------------------------------------------------------------ 26-year history table */

interface HistoryTable {
  nYears: number;
  untilYear: number;
  k5: BigUint64Array;
  clim5: Uint8Array;
  k7: BigUint64Array;
  years7: Uint8Array;
  k8: BigUint64Array;
  score8: Uint8Array;
}

let table: HistoryTable | null | undefined;

function tablePath(): string | null {
  const candidates: string[] = [resolve(config.root, 'artifacts', 'models', 'onboard_history.bin')];
  try {
    // Next to the bundled Vercel function (scripts/build-vercel.mjs copies it there).
    candidates.unshift(fileURLToPath(new URL('./onboard_history.bin', import.meta.url)));
  } catch {
    /* no file URL here */
  }
  return candidates.find((c) => existsSync(c)) ?? null;
}

/** The packed onboard history table (null when the file is missing: the history features are then 0). */
export function historyTable(): HistoryTable | null {
  if (table !== undefined) return table;
  const path = tablePath();
  if (!path) return (table = null);
  const buf = readFileSync(path);
  if (buf.toString('ascii', 0, 4) !== 'KAH1') return (table = null);
  const [nYears, untilYear, n5, n7, n8] = [4, 8, 12, 16, 20].map((o) => buf.readUInt32LE(o)) as [number, number, number, number, number];
  let off = 28;
  // Copies keep the 64-bit keys aligned whatever the Buffer's offset in its pool.
  const u64 = (n: number) => {
    const a = new BigUint64Array(buf.buffer.slice(buf.byteOffset + off, buf.byteOffset + off + n * 8));
    off += n * 8;
    return a;
  };
  const u8 = (n: number) => {
    const a = new Uint8Array(buf.buffer.slice(buf.byteOffset + off, buf.byteOffset + off + n));
    off += n;
    return a;
  };
  const k5 = u64(n5);
  const clim5 = u8(n5 * 12);
  const k7 = u64(n7);
  const years7 = u8(n7);
  const k8 = u64(n8);
  const score8 = u8(n8);
  return (table = { nYears, untilYear, k5, clim5, k7, years7, k8, score8 });
}

function find(keys: BigUint64Array, key: bigint): number {
  let lo = 0;
  let hi = keys.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const v = keys[mid]!;
    if (v === key) return mid;
    if (v < key) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}

export interface CellHistory {
  /** Share of the archive's years with fire in this res-5 cell and calendar month (0–1). */
  climMonth: number;
  /** Years with fire in the res-7 cell, of `nYears`. */
  years: number;
  nYears: number;
  untilYear: number;
  /** A persistent heat source (gas flare, plant) within one res-8 ring, and its score 0–1. */
  staticSource: boolean;
  staticScore: number;
}

export function cellHistory(lat: number, lng: number, month: number): CellHistory {
  const t = historyTable();
  if (!t) return { climMonth: 0, years: 0, nYears: 19, untilYear: 2018, staticSource: false, staticScore: 0 };
  // As in training: the res-8 cell of the point, then its parents (not a fresh lookup at res 7 and 5 — H3 cells are
  // not perfectly nested, so the two can differ near cell edges).
  const r8 = latLngToCell(lat, lng, 8);
  const r7 = cellToParent(r8, 7);
  const r5 = cellToParent(r7, 5);
  const big = (h: string) => BigInt(`0x${h}`);
  const i5 = find(t.k5, big(r5));
  const i7 = find(t.k7, big(r7));
  const i8 = find(t.k8, big(r8));
  return {
    climMonth: i5 >= 0 ? t.clim5[i5 * 12 + month - 1]! / 255 : 0,
    years: i7 >= 0 ? t.years7[i7]! : 0,
    nYears: t.nYears,
    untilYear: t.untilYear,
    staticSource: i8 >= 0,
    staticScore: i8 >= 0 ? t.score8[i8]! / 255 : 0,
  };
}

/* ------------------------------------------------------------------ the network */

interface Layer {
  W: number[][];
  b: number[];
  act: string;
}
const NET = weights as unknown as {
  features: string[];
  mean: number[];
  std: number[];
  layers: Layer[];
  thresholds: { critical: number; high: number; real: number };
};

export const EDGE_PARAMETERS = NET.layers.reduce((s, l) => s + l.W.length * l.W[0]!.length + l.b.length, 0);
export const EDGE_THRESHOLDS = NET.thresholds;

function mlp(x: number[]): number[] {
  let z = x.map((v, i) => (v - NET.mean[i]!) / NET.std[i]!);
  for (const layer of NET.layers) {
    z = layer.W.map((w, o) => {
      let s = layer.b[o]!;
      for (let i = 0; i < w.length; i++) s += w[i]! * z[i]!;
      return layer.act === 'relu' ? Math.max(0, s) : 1 / (1 + Math.exp(-s));
    });
  }
  return z;
}

export type Priority = 'SUPPRESS' | 'ROUTINE' | 'HIGH' | 'CRITICAL';

export interface EdgeResult {
  pReal: number;
  pEscalation: number;
  priority: Priority;
  features: Record<string, number>;
  geometry: { sza: number; night: boolean; scanDeg: number; glintDeg: number; pixelKm2: number };
  history: CellHistory;
  context: { neighbours: number; frpSum: number };
}

/**
 * Scores every detection of one overpass. `scene` holds all detections of the same satellite around that moment
 * (for the context features: hot pixels within 5 km and ±5 min, as onboard).
 */
export function scoreDetections(rows: readonly EdgeRow[], scene: readonly EdgeRow[] = rows): EdgeResult[] {
  return rows.map((r) => {
    const [lng, lat, sat, t, frp, , scan, track] = r as [number, number, number, number, number, number, number, number];
    const { sza, az } = solarPosition(lat, lng, t);
    const day = sza < 85;
    const scanDeg = scanAngleDeg(sat, scan, track);
    const glintDeg = day ? glintAngleDeg(sza, az, viewZenithDeg(sat, scanDeg), trackAzimuthDeg(lat, sat, day)) : 180;
    const bt4 = r[9] || 300;
    const bt11 = r[10] || 280;
    // Overpass context: same satellite, |Δ| ≤ 5 km in space-time (1 min ≙ 1 km), as overpass_context().
    let n = 0;
    let frpSum = 0;
    const kx = 6371 * DEG * Math.cos(lat * DEG);
    for (const q of scene) {
      if (q[2] !== sat) continue;
      const dx = (q[0]! - lng) * kx;
      const dy = (q[1]! - lat) * 6371 * DEG;
      const dt = (q[3]! - t) / 60;
      if (dx * dx + dy * dy + dt * dt <= 25) {
        n += 1;
        frpSum += q[4] || 0;
      }
    }
    const month = new Date(t * 1000).getUTCMonth() + 1;
    const history = cellHistory(lat, lng, month);
    const pixelKm2 = scan * track;
    const f: Record<string, number> = {
      is_viirs: isModis(sat) ? 0 : 1,
      is_night: day ? 0 : 1,
      bright_mir: bt4,
      bright_tir: bt11,
      dt45: r[9] && r[10] ? bt4 - bt11 : 15,
      log_frp: Math.log1p(frp || 0),
      log_pixel_km2: Math.log(Math.max(pixelKm2 || 0.2, 0.05)),
      scan_deg: scanDeg,
      p_conf: unifiedProbability(r, day),
      glint_n: Math.min(glintDeg, 90) / 90,
      ctx_log_n: Math.log1p(Math.max(0, n - 1)),
      ctx_log_frp: Math.log1p(frpSum),
      hist_clim_month: history.climMonth,
      hist_static: history.staticSource ? 1 : 0,
      hist_static_score: history.staticScore,
      hist_years_r7: history.years / Math.max(1, history.nYears),
      month_sin: Math.sin((2 * Math.PI * month) / 12),
      month_cos: Math.cos((2 * Math.PI * month) / 12),
      lat_n: (lat - 48) / 5,
    };
    const [pReal, pEscalation] = mlp(NET.features.map((name) => f[name] ?? 0)) as [number, number];
    const th = NET.thresholds;
    const priority: Priority = pReal < th.real ? 'SUPPRESS' : pEscalation >= th.critical ? 'CRITICAL' : pEscalation >= th.high ? 'HIGH' : 'ROUTINE';
    return {
      pReal,
      pEscalation,
      priority,
      features: f,
      geometry: { sza, night: !day, scanDeg, glintDeg, pixelKm2 },
      history,
      context: { neighbours: Math.max(0, n - 1), frpSum },
    };
  });
}

/* ------------------------------------------------------------------ the alert packet */

const PRIORITY_CODE: Record<Priority, number> = { SUPPRESS: 0, ROUTINE: 1, HIGH: 2, CRITICAL: 3 };
/** helios/comms/packets.py SAT_IDS: MODIS_T 1, MODIS_A 2, VIIRS_SNPP 3, VIIRS_NOAA20 4, VIIRS_NOAA21 5. */
const SAT_ID = [1, 2, 3, 4, 5];
export const FLAG = { night: 1, staticNear: 2, glint: 4, confirmed: 8 } as const;

export function crc16ccitt(bytes: Uint8Array, crc = 0xffff): number {
  for (const byte of bytes) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i++) crc = (crc & 0x8000 ? (crc << 1) ^ 0x1021 : crc << 1) & 0xffff;
  }
  return crc;
}

export interface AlertPacket {
  hex: string;
  bytes: number;
  fields: Record<string, number | string>;
}

/** The 24-byte alert of one overpass cluster (big-endian `>BBBBIiiHHBB` + CRC-16, as packets.encode). */
export function encodeAlert(a: {
  priority: Priority;
  sat: number;
  unixSec: number;
  lat: number;
  lng: number;
  frpMw: number;
  clusterN: number;
  pEscalation: number;
  pReal: number;
  flags: number;
}): AlertPacket {
  const body = new DataView(new ArrayBuffer(22));
  body.setUint8(0, 1);
  body.setUint8(1, PRIORITY_CODE[a.priority]);
  body.setUint8(2, SAT_ID[a.sat] ?? 0);
  body.setUint8(3, a.flags & 0xff);
  body.setUint32(4, Math.floor(a.unixSec) >>> 0);
  body.setInt32(8, Math.round(a.lat * 1e5));
  body.setInt32(12, Math.round(a.lng * 1e5));
  body.setUint16(16, Math.min(65535, Math.round(a.frpMw * 10)));
  body.setUint16(18, Math.min(65535, a.clusterN));
  body.setUint8(20, Math.round(Math.max(0, Math.min(1, a.pEscalation)) * 255));
  body.setUint8(21, Math.round(Math.max(0, Math.min(1, a.pReal)) * 255));
  const bytes = new Uint8Array(24);
  bytes.set(new Uint8Array(body.buffer), 0);
  const crc = crc16ccitt(bytes.subarray(0, 22));
  bytes[22] = crc >> 8;
  bytes[23] = crc & 0xff;
  return {
    hex: [...bytes].map((b) => b.toString(16).padStart(2, '0')).join(' '),
    bytes: 24,
    fields: {
      version: 1,
      priority: a.priority,
      sat: SAT_ID[a.sat] ?? 0,
      flags: a.flags,
      time: Math.floor(a.unixSec),
      lat: Math.round(a.lat * 1e5) / 1e5,
      lng: Math.round(a.lng * 1e5) / 1e5,
      frpMw: Math.round(a.frpMw * 10) / 10,
      clusterN: a.clusterN,
      crc: crc.toString(16).padStart(4, '0'),
    },
  };
}

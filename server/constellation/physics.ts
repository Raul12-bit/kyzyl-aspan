/**
 * Link physics and geometry for the five-satellite constellation — a line-by-line port of
 * helios/comms/physics.py and helios/comms/orbits.py (same formulas, same constants), so the hosted site
 * computes what the Python backend computes. Radio only: the satellites are not modified, so there are
 * no laser terminals to model.
 */

const C = 299_792_458;
export const R_E = 6378.137; // WGS-84 equatorial radius, km
const E2 = 6.69437999014e-3; // WGS-84 first eccentricity squared
const DEG = Math.PI / 180;
const GEO_NORTH_POLE: [number, number] = [80.8, -72.8]; // geomagnetic north pole (IGRF, ~2025)

export type Vec3 = [number, number, number];

/* ------------------------------------------------------------------ geometry (orbits.py) */

export function geodeticToEcef(lat: number, lon: number, altKm = 0): Vec3 {
  const phi = lat * DEG;
  const lam = lon * DEG;
  const n = R_E / Math.sqrt(1 - E2 * Math.sin(phi) ** 2);
  return [
    (n + altKm) * Math.cos(phi) * Math.cos(lam),
    (n + altKm) * Math.cos(phi) * Math.sin(lam),
    (n * (1 - E2) + altKm) * Math.sin(phi),
  ];
}

/** ECEF (km) → [lat°, lon°, alt km], iterative like orbits.ecef_to_latlon. */
export function ecefToLatLon([x, y, z]: Vec3): [number, number, number] {
  const lon = Math.atan2(y, x) / DEG;
  const p = Math.hypot(x, y);
  let lat = Math.atan2(z, p * (1 - E2));
  for (let k = 0; k < 3; k++) {
    const n = R_E / Math.sqrt(1 - E2 * Math.sin(lat) ** 2);
    lat = Math.atan2(z + E2 * n * Math.sin(lat), p);
  }
  const n = R_E / Math.sqrt(1 - E2 * Math.sin(lat) ** 2);
  return [lat / DEG, lon, p / Math.cos(lat) - n];
}

/** Dipole geomagnetic latitude (ionospheric scintillation zones). */
export function geomagneticLat(lat: number, lon: number): number {
  const pl = GEO_NORTH_POLE[0] * DEG;
  const pn = GEO_NORTH_POLE[1] * DEG;
  const p = lat * DEG;
  const l = lon * DEG;
  return Math.asin(Math.sin(p) * Math.sin(pl) + Math.cos(p) * Math.cos(pl) * Math.cos(l - pn)) / DEG;
}

export interface Look {
  el: number;
  rangeKm: number;
  /** Unit vector station → satellite, ECEF. */
  los: Vec3;
}

/** Elevation (°), slant range (km) and line-of-sight vector from a station to a satellite (orbits.look_angles). */
export function lookAngles(sat: Vec3, lat: number, lon: number, altKm: number, sta = geodeticToEcef(lat, lon, altKm)): Look {
  const rho: Vec3 = [sat[0] - sta[0], sat[1] - sta[1], sat[2] - sta[2]];
  const phi = lat * DEG;
  const lam = lon * DEG;
  const e = -Math.sin(lam) * rho[0] + Math.cos(lam) * rho[1];
  const n = -Math.sin(phi) * Math.cos(lam) * rho[0] - Math.sin(phi) * Math.sin(lam) * rho[1] + Math.cos(phi) * rho[2];
  const u = Math.cos(phi) * Math.cos(lam) * rho[0] + Math.cos(phi) * Math.sin(lam) * rho[1] + Math.sin(phi) * rho[2];
  const rangeKm = Math.hypot(e, n, u);
  return { el: Math.atan2(u, Math.hypot(e, n)) / DEG, rangeKm, los: [rho[0] / rangeKm, rho[1] / rangeKm, rho[2] / rangeKm] };
}

/** Whether the segment a→b clears the Earth plus `grazingKm` of atmosphere (orbits.line_of_sight). */
export function lineOfSight(a: Vec3, b: Vec3, grazingKm = 100): boolean {
  const d: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const dd = d[0] * d[0] + d[1] * d[1] + d[2] * d[2];
  const t = Math.min(1, Math.max(0, -(a[0] * d[0] + a[1] * d[1] + a[2] * d[2]) / Math.max(dd, 1e-9)));
  return Math.hypot(a[0] + d[0] * t, a[1] + d[1] * t, a[2] + d[2] * t) > R_E + grazingKm;
}

/** Sun direction in ECEF (Astronomical Almanac, ~0.01°), rotated with the same sidereal angle as the satellites. */
export function sunEcefUnit(date: Date, gmstRad: number): Vec3 {
  const n = date.getTime() / 86_400_000 + 2_440_587.5 - 2_451_545.0;
  const L = (((280.46 + 0.9856474 * n) % 360) + 360) % 360;
  const g = ((((357.528 + 0.9856003 * n) % 360) + 360) % 360) * DEG;
  const lam = (L + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * DEG;
  const eps = (23.439 - 4e-7 * n) * DEG;
  const eci: Vec3 = [Math.cos(lam), Math.cos(eps) * Math.sin(lam), Math.sin(eps) * Math.sin(lam)];
  const c = Math.cos(gmstRad);
  const s = Math.sin(gmstRad);
  return [c * eci[0] + s * eci[1], -s * eci[0] + c * eci[1], eci[2]];
}

/** Great-circle distance, km. */
export function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const p1 = lat1 * DEG;
  const p2 = lat2 * DEG;
  const a = Math.sin((p2 - p1) / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(((lon2 - lon1) * DEG) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(Math.min(1, Math.max(0, a))));
}

/* ------------------------------------------------------------------ radio link (physics.py) */

// ITU-R P.838-3, horizontal polarisation: f (GHz), k_H, α_H
const P838: readonly (readonly [number, number, number])[] = [
  [1, 0.0000259, 0.9691], [2, 0.0000847, 1.0664], [4, 0.0001071, 1.6009], [6, 0.0007056, 1.59],
  [8, 0.004115, 1.3905], [10, 0.01217, 1.2571], [12, 0.02386, 1.1825], [15, 0.04481, 1.1233],
  [20, 0.09164, 1.0568], [25, 0.1571, 0.9991], [30, 0.2403, 0.9485], [35, 0.3374, 0.9047],
  [40, 0.4431, 0.8673],
];

/** numpy.interp: linear, clamped at both ends. */
export function interp(x: number, xs: readonly number[], ys: readonly number[]): number {
  if (x <= xs[0]!) return ys[0]!;
  if (x >= xs[xs.length - 1]!) return ys[ys.length - 1]!;
  let i = 1;
  while (xs[i]! < x) i++;
  const w = (x - xs[i - 1]!) / (xs[i]! - xs[i - 1]!);
  return ys[i - 1]! + w * (ys[i]! - ys[i - 1]!);
}

const LOG_F = P838.map((r) => Math.log(r[0]));
const LOG_K = P838.map((r) => Math.log(r[1]));
const ALPHA = P838.map((r) => r[2]);

export function rainCoeffs(fGhz: number): [number, number] {
  return [Math.exp(interp(Math.log(fGhz), LOG_F, LOG_K)), interp(Math.log(fGhz), LOG_F, ALPHA)];
}

const fsplDb = (fHz: number, dM: number) => 20 * Math.log10((4 * Math.PI * dM * fHz) / C);

/** ITU-R P.618 (simplified): γ = kR^α along the slant path up to the rain height, horizontal reduction. */
export function rainAttenuationDb(fGhz: number, rainMmH: number, elDeg: number, lat: number, altKm: number): number {
  const [k, a] = rainCoeffs(fGhz);
  const rain = Math.max(rainMmH, 0);
  const el = Math.max(elDeg, 5) * DEG;
  const hRain = 5 - 0.075 * Math.max(Math.abs(lat) - 23, 0) + 0.36; // P.839 (old form)
  const ls = Math.max(hRain - altKm, 0) / Math.sin(el);
  const gamma = k * rain ** a;
  const lg = ls * Math.cos(el);
  const r = 1 / (1 + 0.78 * Math.sqrt(Math.max(lg * gamma, 0) / fGhz) - 0.38 * (1 - Math.exp(-2 * lg)));
  return gamma * ls * Math.min(1.5, Math.max(0.1, r));
}

const cloudAttenuationDb = (fGhz: number, lwcMm: number, elDeg: number) =>
  (6e-4 * fGhz ** 2 * lwcMm) / Math.sin(Math.max(elDeg, 5) * DEG);

function gasAttenuationDb(fGhz: number, elDeg: number, rh: number): number {
  const zenith = 0.035 + 0.0025 * fGhz + (0.25 * Math.exp(-(((fGhz - 22.2) / 6) ** 2)) + 0.004 * fGhz) * (rh / 100);
  return zenith / Math.sin(Math.max(elDeg, 5) * DEG);
}

function scintillationS4(fGhz: number, kp: number, geomagLat: number): number {
  const gm = Math.abs(geomagLat);
  const zone = gm >= 60 ? 1 : gm >= 50 ? 0.35 : gm <= 20 ? 0.6 : 0.15;
  const s4L = zone * (0.05 + 0.55 / (1 + Math.exp(-(kp - 6) * 1.2)));
  return s4L * (1.575 / fGhz) ** 1.5;
}

/** 99 % Nakagami-m fade depth without randomness (the forecast is deterministic). */
const scintillationFadeDb = (s4: number) => (27.5 * Math.min(1, Math.max(1e-3, s4)) ** 1.26) / 2;

function solarNoiseIncreaseDb(fGhz: number, sepDeg: number, dishM: number, f107: number, xray: number, tSysK: number): number {
  const lam = C / (fGhz * 1e9);
  const bw = (70 * lam) / dishM; // half-power beamwidth, °
  const tQuiet = 6000 + 1.2e5 * (2.8 / fGhz) ** 1.8 * (f107 / 100);
  const burst = 1 + 200 * Math.max(xray / 1e-4, 0) * (2.8 / fGhz) ** 1.5;
  const fill = Math.min(1, (0.53 / bw) ** 2);
  const gain = Math.exp(-4 * Math.LN2 * (sepDeg / bw) ** 2);
  return 10 * Math.log10(1 + (tQuiet * burst * fill * gain) / tSysK);
}

function gOverTDb(fGhz: number, dishM: number, tSysK: number, eff = 0.6): number {
  const lam = C / (fGhz * 1e9);
  return 10 * Math.log10(eff * ((Math.PI * dishM) / lam) ** 2) - 10 * Math.log10(tSysK);
}

/** Bulk-data channels: frequency, satellite EIRP, rate, required Eb/N0, receiver system temperature. */
export const RF_CHANNELS = {
  X: { fGhz: 8.2, eirpDbw: 10, rateBps: 150e6, ebn0ReqDb: 4.5, tSysK: 150 },
  Ka: { fGhz: 26.5, eirpDbw: 19, rateBps: 600e6, ebn0ReqDb: 5, tSysK: 250 },
} as const;
export type Band = keyof typeof RF_CHANNELS;

export interface LinkEnv {
  rainMmH: number;
  /** Cloud liquid water, mm (link_sim: 0.25 · cloud cover + 0.08 · rain). */
  lwcMm: number;
  rh: number;
  kp: number;
  f107: number;
  xray: number;
}

/** Radio link margin (dB) = received Eb/N0 − required Eb/N0 (physics.rf_margin_db, no randomness). */
export function rfMarginDb(
  band: Band,
  rangeKm: number,
  elDeg: number,
  station: { dishM: number; lat: number; altKm: number; geomagLat: number },
  sunSepDeg: number,
  env: LinkEnv,
): number {
  const ch = RF_CHANNELS[band];
  const f = ch.fGhz;
  const losses =
    fsplDb(f * 1e9, rangeKm * 1000) +
    rainAttenuationDb(f, env.rainMmH, elDeg, station.lat, station.altKm) +
    cloudAttenuationDb(f, env.lwcMm, elDeg) +
    gasAttenuationDb(f, elDeg, env.rh) +
    scintillationFadeDb(scintillationS4(f, env.kp, station.geomagLat)) +
    1.5; // polarisation, pointing, implementation
  const noiseRise = solarNoiseIncreaseDb(f, sunSepDeg, station.dishM, env.f107, env.xray, ch.tSysK);
  const cn0 = ch.eirpDbw - losses + gOverTDb(f, station.dishM, ch.tSysK) - noiseRise + 228.6;
  return cn0 - 10 * Math.log10(ch.rateBps) - ch.ebn0ReqDb;
}

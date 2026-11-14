/**
 * Minimal orbital mechanics for the concept simulations (downlink planning, cross-satellite cueing)
 * and for the 3D intro globe.
 *
 * Model: circular orbits, two-body motion, spherical Earth, no perturbations (no J2 precession, drag
 * or manoeuvres). Good to a few minutes over a day — enough to *illustrate* pass geometry. A real
 * planner propagates operational TLEs/ephemerides (e.g. SGP4) instead.
 */

export const EARTH_RADIUS_KM = 6371;
/** Earth's gravitational parameter, km³/s². */
export const MU_EARTH = 398_600.4418;
/** Sidereal rotation rate, rad/s. */
export const EARTH_ROTATION = 7.2921159e-5;

const DEG = Math.PI / 180;

export type SensorName = 'MODIS' | 'VIIRS';

export interface Satellite {
  id: string;
  /** Platform name, e.g. "Terra". */
  name: string;
  sensor: SensorName;
  altitudeKm: number;
  inclinationDeg: number;
  /** Right ascension of the ascending node at t = 0, degrees. Illustrative, not an operational epoch. */
  raanDeg: number;
  /** Argument of latitude at t = 0, degrees. */
  phaseDeg: number;
  /** Cross-track swath width of the sensor, km. */
  swathKm: number;
}

/**
 * The fleet carrying the two sensors. Altitudes, inclinations and swaths are public mission values
 * (rounded); RAAN and phase are chosen only to spread the orbits plausibly at t = 0.
 */
export const FLEET: readonly Satellite[] = [
  { id: 'terra', name: 'Terra', sensor: 'MODIS', altitudeKm: 705, inclinationDeg: 98.2, raanDeg: 0, phaseDeg: 0, swathKm: 2330 },
  { id: 'aqua', name: 'Aqua', sensor: 'MODIS', altitudeKm: 705, inclinationDeg: 98.2, raanDeg: 45, phaseDeg: 140, swathKm: 2330 },
  { id: 'snpp', name: 'Suomi NPP', sensor: 'VIIRS', altitudeKm: 824, inclinationDeg: 98.7, raanDeg: 47, phaseDeg: 260, swathKm: 3060 },
  { id: 'noaa20', name: 'NOAA-20', sensor: 'VIIRS', altitudeKm: 824, inclinationDeg: 98.7, raanDeg: 47, phaseDeg: 80, swathKm: 3060 },
];

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface GeoPoint {
  lat: number;
  lng: number;
}

/** Orbital period, s. */
export function periodSec(sat: Pick<Satellite, 'altitudeKm'>): number {
  const a = EARTH_RADIUS_KM + sat.altitudeKm;
  return 2 * Math.PI * Math.sqrt((a * a * a) / MU_EARTH);
}

/** Earth-centred inertial position, km, at `t` seconds after the simulation epoch. */
export function positionEci(sat: Satellite, t: number): Vec3 {
  const a = EARTH_RADIUS_KM + sat.altitudeKm;
  const u = sat.phaseDeg * DEG + ((2 * Math.PI) / periodSec(sat)) * t;
  const i = sat.inclinationDeg * DEG;
  const raan = sat.raanDeg * DEG;
  const xo = a * Math.cos(u);
  const yo = a * Math.sin(u);
  return {
    x: xo * Math.cos(raan) - yo * Math.cos(i) * Math.sin(raan),
    y: xo * Math.sin(raan) + yo * Math.cos(i) * Math.cos(raan),
    z: yo * Math.sin(i),
  };
}

/** Earth-fixed position (the Earth has turned by ω·t since the epoch; Greenwich at x at t = 0). */
export function positionEcef(sat: Satellite, t: number): Vec3 {
  const p = positionEci(sat, t);
  const th = -EARTH_ROTATION * t;
  return { x: p.x * Math.cos(th) - p.y * Math.sin(th), y: p.x * Math.sin(th) + p.y * Math.cos(th), z: p.z };
}

export function toGeo(p: Vec3): GeoPoint {
  const r = Math.hypot(p.x, p.y, p.z);
  return { lat: Math.asin(p.z / r) / DEG, lng: Math.atan2(p.y, p.x) / DEG };
}

export function geoToEcef(g: GeoPoint, altitudeKm = 0): Vec3 {
  const r = EARTH_RADIUS_KM + altitudeKm;
  const lat = g.lat * DEG;
  const lng = g.lng * DEG;
  return { x: r * Math.cos(lat) * Math.cos(lng), y: r * Math.cos(lat) * Math.sin(lng), z: r * Math.sin(lat) };
}

export function subSatellitePoint(sat: Satellite, t: number): GeoPoint {
  return toGeo(positionEcef(sat, t));
}

/** Great-circle distance, km. */
export function groundDistanceKm(a: GeoPoint, b: GeoPoint): number {
  const h =
    Math.sin(((b.lat - a.lat) * DEG) / 2) ** 2 +
    Math.cos(a.lat * DEG) * Math.cos(b.lat * DEG) * Math.sin(((b.lng - a.lng) * DEG) / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Elevation of the satellite above the local horizon of `site`, degrees. */
export function elevationDeg(sat: Satellite, t: number, site: GeoPoint): number {
  const s = positionEcef(sat, t);
  const g = geoToEcef(site);
  const d = { x: s.x - g.x, y: s.y - g.y, z: s.z - g.z };
  const up = Math.hypot(g.x, g.y, g.z);
  const dist = Math.hypot(d.x, d.y, d.z);
  const sinEl = (d.x * g.x + d.y * g.y + d.z * g.z) / (up * dist);
  return Math.asin(Math.max(-1, Math.min(1, sinEl))) / DEG;
}

export interface Pass {
  /** Acquisition / loss of signal, s since epoch. */
  aos: number;
  los: number;
  maxElevationDeg: number;
  /** Time of the highest elevation, s. */
  tca: number;
}

/**
 * Visibility windows of a ground site above `minElevationDeg`, sampled every `stepSec` and refined to
 * ±1 s at both edges.
 */
export function findPasses(sat: Satellite, site: GeoPoint, from: number, to: number, minElevationDeg = 5, stepSec = 20): Pass[] {
  const passes: Pass[] = [];
  const above = (t: number) => elevationDeg(sat, t, site) >= minElevationDeg;
  const refine = (lo: number, hi: number, rising: boolean) => {
    // Invariant: the visibility state changes inside (lo, hi].
    while (hi - lo > 1) {
      const mid = (lo + hi) / 2;
      if (above(mid) === rising) hi = mid;
      else lo = mid;
    }
    return hi;
  };
  let prev = above(from);
  let current: Pass | null = prev ? { aos: from, los: from, maxElevationDeg: -90, tca: from } : null;
  for (let t = from; t <= to; t += stepSec) {
    const el = elevationDeg(sat, t, site);
    const now = el >= minElevationDeg;
    if (now && !prev) current = { aos: refine(t - stepSec, t, true), los: t, maxElevationDeg: el, tca: t };
    if (now && current && el > current.maxElevationDeg) {
      current.maxElevationDeg = el;
      current.tca = t;
    }
    if (!now && prev && current) {
      current.los = refine(t - stepSec, t, false);
      passes.push(current);
      current = null;
    }
    prev = now;
  }
  if (current) {
    current.los = to;
    passes.push(current);
  }
  return passes;
}

/**
 * First time after `from` at which `site` lies inside the sensor swath (cross-track distance from the
 * ground track ≤ half swath), or null within `horizonSec`. Daylight, clouds and viewing-angle limits
 * are ignored here and handled by the caller's probabilities.
 */
export function nextCoverage(sat: Satellite, site: GeoPoint, from: number, horizonSec = 2 * 86_400, stepSec = 15): number | null {
  const half = sat.swathKm / 2;
  for (let t = from; t <= from + horizonSec; t += stepSec) {
    if (groundDistanceKm(subSatellitePoint(sat, t), site) <= half) return t;
  }
  return null;
}

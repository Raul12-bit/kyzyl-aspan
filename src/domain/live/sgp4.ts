import { eciToEcf, eciToGeodetic, gstime, propagate, twoline2satrec, type SatRec } from '@/lib/sgp4Lite';
import type { Vec3 } from '../orbit';
import { haversineKm, LIVE_SATS, localSolarHour, type BBox4 } from './satellites';

/**
 * Real orbits for the live views: SGP4 (satellite.js) from CelesTrak elements, sampled into ground tracks once
 * per window, then cheap geometry on the samples — where each satellite is now, when its swath covers a region or
 * a point. The swath test is cross-track distance from the ground track ≤ half the swath (MODIS 2 330 km,
 * VIIRS 3 060 km); viewing-angle and daylight limits are left to the caller.
 */

/** CelesTrak name → [line 1, line 2]. */
export type TleSet = Record<string, [string, string]>;

const DEG = 180 / Math.PI;

/** Satellite code → its SGP4 record (only the satellites the set has elements for). */
export function satrecsByCode(tle: TleSet): Map<number, SatRec> {
  const out = new Map<number, SatRec>();
  for (const s of LIVE_SATS) {
    const l = tle[s.tle];
    if (!l) continue;
    try {
      out.set(s.code, twoline2satrec(l[0], l[1]));
    } catch {
      /* malformed elements: that satellite is simply left out */
    }
  }
  return out;
}

export interface SubPoint {
  lat: number;
  lng: number;
  altKm: number;
}

export function subPoint(rec: SatRec, date: Date): SubPoint | null {
  const pv = propagate(rec, date);
  const pos = pv?.position;
  if (!pos || typeof pos !== 'object') return null;
  const g = eciToGeodetic(pos, gstime(date));
  return {
    lat: g.latitude * DEG,
    lng: ((((g.longitude * DEG + 180) % 360) + 360) % 360) - 180,
    altKm: g.height,
  };
}

/** Earth-fixed position in km, x towards Greenwich (same frame as src/domain/orbit.ts). */
export function ecef(rec: SatRec, date: Date): Vec3 | null {
  const pv = propagate(rec, date);
  const pos = pv?.position;
  if (!pos || typeof pos !== 'object') return null;
  const p = eciToEcf(pos, gstime(date));
  return { x: p.x, y: p.y, z: p.z };
}

export interface Track {
  code: number;
  /** First sample, unix seconds, and the sampling step. */
  t0: number;
  step: number;
  lat: Float32Array;
  lng: Float32Array;
}

/** Ground track sampled every `step` seconds over [from, to] (unix seconds). ~1 ms per 1 000 samples. */
export function groundTrack(rec: SatRec, code: number, from: number, to: number, step = 30): Track {
  const n = Math.max(1, Math.floor((to - from) / step) + 1);
  const lat = new Float32Array(n);
  const lng = new Float32Array(n);
  for (let k = 0; k < n; k++) {
    const p = subPoint(rec, new Date((from + k * step) * 1000));
    lat[k] = p ? p.lat : Number.NaN;
    lng[k] = p ? p.lng : Number.NaN;
  }
  return { code, t0: from, step, lat, lng };
}

/** Distance from a point to the nearest point of a lng/lat box (0 inside), km. */
export function distanceToBoxKm(lat: number, lng: number, box: BBox4): number {
  const cLat = Math.max(box[1], Math.min(box[3], lat));
  const cLng = Math.max(box[0], Math.min(box[2], lng));
  return cLat === lat && cLng === lng ? 0 : haversineKm(lat, lng, cLat, cLng);
}

export interface Pass {
  code: number;
  tStart: number;
  tEnd: number;
  /** Time of the closest approach to the target. */
  tMid: number;
  /** Closest approach of the ground track to the target, km (0 = right overhead / inside the box). */
  minKm: number;
  /** Daytime pass (local solar 06–18 h under the satellite at the closest approach). */
  day: boolean;
}

/** Passes during which `near(k)` (distance of sample k to the target, km) is within the half swath. */
function passesFrom(
  track: Track,
  halfSwathKm: number,
  near: (k: number) => number,
  lngAt: (k: number) => number,
): Pass[] {
  const out: Pass[] = [];
  let cur: Pass | null = null;
  for (let k = 0; k < track.lat.length; k++) {
    const t = track.t0 + k * track.step;
    const d = Number.isNaN(track.lat[k]!) ? Infinity : near(k);
    if (d <= halfSwathKm) {
      if (!cur) cur = { code: track.code, tStart: t, tEnd: t, tMid: t, minKm: d, day: true };
      cur.tEnd = t;
      if (d < cur.minKm) {
        cur.minKm = d;
        cur.tMid = t;
      }
    } else if (cur) {
      out.push(cur);
      cur = null;
    }
  }
  if (cur) out.push(cur);
  for (const p of out) {
    const k = Math.round((p.tMid - track.t0) / track.step);
    const h = localSolarHour(p.tMid, lngAt(k));
    p.day = h >= 6 && h < 18;
  }
  return out;
}

const halfSwath = (code: number) => (LIVE_SATS[code]?.swathKm ?? 2330) / 2;

/** Passes whose swath reaches the box. */
export function regionPasses(track: Track, box: BBox4): Pass[] {
  return passesFrom(
    track,
    halfSwath(track.code),
    (k) => distanceToBoxKm(track.lat[k]!, track.lng[k]!, box),
    (k) => track.lng[k]!,
  );
}

/** Passes whose swath covers one point. */
export function pointPasses(track: Track, lat: number, lng: number, from = -Infinity, to = Infinity): Pass[] {
  const k0 = Math.max(0, Math.floor((from - track.t0) / track.step));
  const k1 = Math.min(track.lat.length - 1, Math.ceil((to - track.t0) / track.step));
  if (k1 < k0) return [];
  const sub: Track = {
    code: track.code,
    t0: track.t0 + k0 * track.step,
    step: track.step,
    lat: track.lat.subarray(k0, k1 + 1),
    lng: track.lng.subarray(k0, k1 + 1),
  };
  const half = halfSwath(track.code);
  return passesFrom(
    sub,
    half,
    // Cheap reject first: a latitude gap alone already wider than the half swath.
    (k) =>
      Math.abs(sub.lat[k]! - lat) * 111.2 > half ? Infinity : haversineKm(sub.lat[k]!, sub.lng[k]!, lat, lng),
    (k) => sub.lng[k]!,
  );
}

/** Position of every satellite of the set at one moment. */
export function positionsAt(recs: Map<number, SatRec>, date: Date): { code: number; p: SubPoint }[] {
  const out: { code: number; p: SubPoint }[] = [];
  for (const [code, rec] of recs) {
    const p = subPoint(rec, date);
    if (p) out.push({ code, p });
  }
  return out;
}

/**
 * Earth-fixed positions for the AI #2 link simulation: `(fleetId, tSec)` with tSec counted from `epochMs`.
 * Returns null for a satellite the set has no elements for (the simulation then keeps its circular orbit).
 */
export function ecefPropagator(tle: TleSet, epochMs: number): (id: string, tSec: number) => Vec3 | null {
  const recs = satrecsByCode(tle);
  const byId = new Map<string, SatRec>();
  for (const s of LIVE_SATS) {
    const r = recs.get(s.code);
    if (r) byId.set(s.id, r);
  }
  return (id, tSec) => {
    const rec = byId.get(id);
    return rec ? ecef(rec, new Date(epochMs + tSec * 1000)) : null;
  };
}

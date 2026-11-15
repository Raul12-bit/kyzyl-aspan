import { isModis, KM_PER_DEG, offsetKm, type LiveRow } from '../live/satellites';
import { pixelKm } from './temporal';

/**
 * Noise filter by mutual confirmation (AI #3 on the ground): a hot spot is believed when ANOTHER satellite sees
 * heat at the same place within a few hours — allowing for the fire having moved downwind in between. When the
 * other satellite did fly over soon after (≤ 4 h) and saw nothing, a weak DAYTIME hot spot is treated as noise —
 * the signature of sun glint off a roof or a salt flat, or of a sun-heated surface. Strong or night-time lone hot
 * spots stay "unconfirmed": small fires die out within hours, and smoke or cloud can hide a fire from one pass.
 *
 * "Flew over" comes from the real orbits (SGP4): the point lay inside that satellite's swath. A pass counts only
 * once its data can have reached FIRMS (≈3 h near-real-time latency); younger passes leave the hot spot pending.
 */

export type CheckStatus = 'confirmed' | 'noise' | 'unconfirmed' | 'pending';

export interface CheckResult {
  status: CheckStatus;
  /** Confirmed by the other instrument family (MODIS ↔ VIIRS), not just a sister satellite. */
  cross: boolean;
  /** Satellite that confirmed it, or that looked and saw nothing. */
  other: number | null;
  /** Minutes between the two looks. */
  dtMin: number | null;
  /** Next pass that can settle a pending hot spot (unix s), when known. */
  nextPass: number | null;
}

export interface Wind {
  windKmh: number;
  windFromDeg: number;
}

export interface CrossCheckOptions {
  /** Unix seconds "now". */
  now: number;
  /** How far apart the two looks may be, hours (default 6). */
  windowH?: number;
  /** A miss counts against a hot spot only when the other look came this soon, hours (default 4). */
  lookH?: number;
  /** FIRMS near-real-time latency, hours (default 3). */
  latencyH?: number;
  /** Times (unix s) when satellite `code` covered the point in [from, to]; absent → orbit-free fallback. */
  coverage?: (code: number, lat: number, lng: number, from: number, to: number) => number[];
  /** Satellites that may confirm (default: codes present in the rows). */
  satellites?: readonly number[];
  /** Wind at a place and time (unix s). */
  wind?: (lat: number, lng: number, t: number) => Wind | null;
}

/** Plausible top spread speed for the wind, km/h (grass fires: McArthur order of magnitude). */
export const spreadReachKmh = (wind: Wind | null) => (wind ? 0.6 + 0.09 * wind.windKmh : 1.2);

/**
 * Does a later hot spot `b` fit an earlier `a`, given the wind? The tolerance is the pixel footprint plus the
 * distance the fire could have travelled: up to v·Δt downwind, much less upwind or sideways.
 */
export function fitsDrift(a: LiveRow, b: LiveRow, wind: Wind | null): boolean {
  const [early, late] = a[3] <= b[3] ? [a, b] : [b, a];
  const dt = (late[3] - early[3]) / 3600;
  const pix = 0.5 * (pixelKm(early) + pixelKm(late)) + 0.75;
  const reach = Math.min(spreadReachKmh(wind) * dt, 15);
  const [dx, dy] = offsetKm(early[1], early[0], late[1], late[0]);
  if (!wind || wind.windKmh < 5) return Math.hypot(dx, dy) <= pix + reach;
  const th = (((wind.windFromDeg + 180) % 360) * Math.PI) / 180;
  const ux = Math.sin(th);
  const uy = Math.cos(th);
  const along = dx * ux + dy * uy;
  const cross = Math.abs(-dx * uy + dy * ux);
  return along >= -(pix + 0.25 * reach) && along <= pix + reach && cross <= pix + 0.5 * reach;
}

const WEAK_FRP = 10;

/** Checks every hot spot of a live window against the other satellites. Rows must be sorted by time. */
export function crossCheck(rows: readonly LiveRow[], opts: CrossCheckOptions): CheckResult[] {
  const windowS = (opts.windowH ?? 6) * 3600;
  const lookS = (opts.lookH ?? 4) * 3600;
  const latencyS = (opts.latencyH ?? 3) * 3600;
  const sats = opts.satellites ?? [...new Set(rows.map((r) => r[2]))];
  // Spatial grid (0.25°) so each hot spot only meets its neighbours.
  const cellDeg = 25 / KM_PER_DEG;
  const grid = new Map<string, number[]>();
  const key = (lng: number, lat: number) => `${Math.floor(lng / cellDeg)}:${Math.floor(lat / cellDeg)}`;
  rows.forEach((r, i) => {
    const k = key(r[0], r[1]);
    const list = grid.get(k);
    if (list) list.push(i);
    else grid.set(k, [i]);
  });

  return rows.map((a, i) => {
    const wind = opts.wind?.(a[1], a[0], a[3]) ?? null;
    let best: { j: number; dt: number; cross: boolean } | null = null;
    const cx = Math.floor(a[0] / cellDeg);
    const cy = Math.floor(a[1] / cellDeg);
    for (let gx = -1; gx <= 1; gx++) {
      for (let gy = -1; gy <= 1; gy++) {
        for (const j of grid.get(`${cx + gx}:${cy + gy}`) ?? []) {
          if (j === i) continue;
          const b = rows[j]!;
          if (b[2] === a[2]) continue; // the same satellite cannot confirm itself
          const dt = Math.abs(b[3] - a[3]);
          if (dt > windowS || !fitsDrift(a, b, wind)) continue;
          const cross = isModis(a[2]) !== isModis(b[2]);
          // Prefer the other family, then the closest in time.
          if (!best || (cross && !best.cross) || (cross === best.cross && dt < best.dt))
            best = { j, dt, cross };
        }
      }
    }
    if (best) {
      return {
        status: 'confirmed',
        cross: best.cross,
        other: rows[best.j]![2],
        dtMin: Math.round(best.dt / 60),
        nextPass: null,
      };
    }
    if (!opts.coverage) {
      // No orbits: young hot spots wait, old ones stay unconfirmed.
      return {
        status: opts.now - a[3] < windowS + latencyS ? 'pending' : 'unconfirmed',
        cross: false,
        other: null,
        dtMin: null,
        nextPass: null,
      };
    }
    let looked: { code: number; t: number } | null = null;
    let next: number | null = null;
    for (const code of sats) {
      if (code === a[2]) continue;
      for (const t of opts.coverage(code, a[1], a[0], a[3] - lookS, a[3] + lookS)) {
        if (Math.abs(t - a[3]) < 600) continue; // the same moment: a twin pass, not a second look
        if (t <= opts.now - latencyS) {
          if (!looked || Math.abs(t - a[3]) < Math.abs(looked.t - a[3])) looked = { code, t };
        } else if (next === null || t < next) {
          next = t;
        }
      }
    }
    if (looked) {
      // Glint and hot surfaces need the Sun: a night-time or a strong lone hot spot is not called noise.
      const glintLike = a[8] === 1 && a[5] < 2 && a[4] < WEAK_FRP;
      return {
        status: glintLike ? 'noise' : 'unconfirmed',
        cross: isModis(looked.code) !== isModis(a[2]),
        other: looked.code,
        dtMin: Math.round(Math.abs(looked.t - a[3]) / 60),
        nextPass: null,
      };
    }
    return { status: 'pending', cross: false, other: null, dtMin: null, nextPass: next };
  });
}

export interface CheckSummary {
  total: number;
  confirmed: number;
  cross: number;
  noise: number;
  unconfirmed: number;
  pending: number;
}

export function summarizeChecks(results: readonly CheckResult[]): CheckSummary {
  const s: CheckSummary = {
    total: results.length,
    confirmed: 0,
    cross: 0,
    noise: 0,
    unconfirmed: 0,
    pending: 0,
  };
  for (const r of results) {
    s[r.status] += 1;
    if (r.status === 'confirmed' && r.cross) s.cross += 1;
  }
  return s;
}

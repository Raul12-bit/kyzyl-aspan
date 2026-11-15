import { VIIRS_START_INDEX } from '../../lib/date';
import type { FireArchive } from '../archive';
import { SENSOR_MODIS } from '../detections';
import { FLAG_ALL_NOISE } from '../noise';
import type { FireCluster } from './contextual';

/**
 * How Kyzyl Aspan combines the two detection systems — at two levels.
 *
 * Event level (this module): after the noise filter, every detection is snapped to its H3 cell
 * (res 6, ≈36 km²) and day. A cell-day seen by both MODIS and VIIRS is one fire event confirmed by two
 * independent instruments; seen by one only, it is a single-sensor event. Confirmation raises confidence:
 * p = 1 − (1 − p_MODIS)(1 − p_VIIRS), which assumes the two sensors err independently (an approximation —
 * clouds and smoke hide a fire from both). The location comes from VIIRS when it has one (375 m beats 1 km).
 * FRP is never added across sensors: each sensor's FRP is a different measurement of the same fire.
 *
 * Series level (src/domain/harmonize.ts + hexCalendar.ts): burning hexagon-days per sensor, the residual
 * VIIRS/MODIS ratio calibrated on the 2012+ overlap, VIIRS rescaled to the MODIS scale and blended by
 * inverse-variance weighting with a 90% interval. Rescaled and blended — never summed.
 */

/** Detection probability behind each FIRMS confidence class (ASSUMPTION used for fusing). */
export const CLASS_PROBABILITY = [0.3, 0.65, 0.9] as const;

export function fuseProbability(pModis: number | null, pViirs: number | null): number {
  const a = pModis ?? 0;
  const b = pViirs ?? 0;
  return 1 - (1 - a) * (1 - b);
}

export interface FusionStats {
  /** Cell-days (H3 res 6 × day) with fire after the noise filter, 2012 onwards. */
  events: number;
  both: number;
  modisOnly: number;
  viirsOnly: number;
  /** Of MODIS fire cell-days, the share VIIRS confirmed the same day. */
  modisConfirmedByViirs: number;
  /** Of VIIRS fire cell-days, the share MODIS saw too. */
  viirsSeenByModis: number;
  /** Mean fused confidence by event type. */
  meanConfidence: { both: number; modisOnly: number; viirsOnly: number };
  /** On events both saw: mean hot pixels per sensor. */
  pixelsPerEvent: { modis: number; viirs: number } | null;
}

interface Acc {
  m: number;
  v: number;
  pm: number;
  pv: number;
}

/** Event-level fusion over the archive's overlap era (optionally inside an area mask). ~5–20 ms for the demo sample. */
export function fuseArchive(archive: FireArchive, mask: Uint8Array | null = null): FusionStats {
  const { table, base, flags } = archive;
  const events = new Map<number, Acc>();
  for (let i = 0; i < table.n; i++) {
    if (mask && !mask[i]) continue;
    if (table.month[i]! < VIIRS_START_INDEX || flags[i]! & FLAG_ALL_NOISE) continue;
    const key = base.cellOf[i]! * 16384 + table.day[i]!;
    let e = events.get(key);
    if (!e) {
      e = { m: 0, v: 0, pm: 0, pv: 0 };
      events.set(key, e);
    }
    const p = CLASS_PROBABILITY[table.conf[i] as 0 | 1 | 2] ?? 0.65;
    if (table.sensor[i] === SENSOR_MODIS) {
      e.m += 1;
      e.pm = Math.max(e.pm, p);
    } else {
      e.v += 1;
      e.pv = Math.max(e.pv, p);
    }
  }
  let both = 0;
  let mOnly = 0;
  let vOnly = 0;
  let cBoth = 0;
  let cM = 0;
  let cV = 0;
  let pxM = 0;
  let pxV = 0;
  for (const e of events.values()) {
    if (e.m && e.v) {
      both += 1;
      cBoth += fuseProbability(e.pm, e.pv);
      pxM += e.m;
      pxV += e.v;
    } else if (e.m) {
      mOnly += 1;
      cM += e.pm;
    } else {
      vOnly += 1;
      cV += e.pv;
    }
  }
  const safe = (a: number, b: number) => (b > 0 ? a / b : 0);
  return {
    events: events.size,
    both,
    modisOnly: mOnly,
    viirsOnly: vOnly,
    modisConfirmedByViirs: safe(both, both + mOnly),
    viirsSeenByModis: safe(both, both + vOnly),
    meanConfidence: { both: safe(cBoth, both), modisOnly: safe(cM, mOnly), viirsOnly: safe(cV, vOnly) },
    pixelsPerEvent: both ? { modis: pxM / both, viirs: pxV / both } : null,
  };
}

/* ------------------------------------------------------------------ spatial matching (one fire, two sensors) */

/** One hot pixel: centre, FRP and its footprint on the ground (scan = across track, track = along track). */
export interface Footprint {
  lng: number;
  lat: number;
  frp: number;
  scanKm: number;
  trackKm: number;
}

export interface RefinedPixel {
  lng: number;
  lat: number;
  /** Share of the enclosing MODIS pixel's FRP, MW (or the VIIRS FRP when no MODIS pixel encloses it). */
  frp: number;
  scanKm: number;
  trackKm: number;
  /** Inside a MODIS footprint (true) or a VIIRS-only pixel (false: new front, or MODIS missed it). */
  matched: boolean;
}

export interface FootprintFusion {
  modis: { n: number; frp: number; areaKm2: number };
  viirs: { n: number; frp: number; areaKm2: number };
  refined: RefinedPixel[];
  /** MODIS pixels with no VIIRS pixel inside (kept at 1 km). */
  modisOnly: Footprint[];
  /** Fused fire outline: convex hull of the VIIRS pixel corners ([lng, lat], closed). */
  hull: [number, number][];
  /** Mean MODIS pixel area ÷ mean VIIRS pixel area: how much finer the fused outline is drawn. */
  sharpen: number;
}

const KM_DEG = 111.32;

function corners(p: Footprint): [number, number][] {
  const kx = KM_DEG * Math.cos((p.lat * Math.PI) / 180);
  const hx = p.scanKm / 2 / kx;
  const hy = p.trackKm / 2 / KM_DEG;
  return [
    [p.lng - hx, p.lat - hy],
    [p.lng + hx, p.lat - hy],
    [p.lng + hx, p.lat + hy],
    [p.lng - hx, p.lat + hy],
  ];
}

/** Convex hull (Andrew's monotone chain), closed ring. */
export function convexHull(points: [number, number][]): [number, number][] {
  const pts = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (pts.length < 3) return pts.length ? [...pts, pts[0]!] : [];
  const cross = (o: [number, number], a: [number, number], b: [number, number]) =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: [number, number][] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2]!, lower[lower.length - 1]!, p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: [number, number][] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i]!;
    while (upper.length >= 2 && cross(upper[upper.length - 2]!, upper[upper.length - 1]!, p) <= 0) upper.pop();
    upper.push(p);
  }
  const hull = lower.slice(0, -1).concat(upper.slice(0, -1));
  return [...hull, hull[0]!];
}

/**
 * Spatial MODIS × VIIRS matching of one fire seen by both within a short time: the wide MODIS pixels (1 km at
 * nadir) carry the radiative power (FRP); the fine VIIRS pixels (375 m) inside each MODIS footprint split that
 * power between them in proportion to their own signal, and their outline becomes the fire front. `driftKm`
 * widens the footprints for the distance the fire may have moved between the two looks.
 */
export function fuseFootprints(modis: readonly Footprint[], viirs: readonly Footprint[], driftKm = 0): FootprintFusion {
  const owner = viirs.map((v) => {
    let best = -1;
    let bestD = Infinity;
    modis.forEach((m, j) => {
      const kx = KM_DEG * Math.cos((m.lat * Math.PI) / 180);
      const dx = Math.abs(v.lng - m.lng) * kx;
      const dy = Math.abs(v.lat - m.lat) * KM_DEG;
      if (dx <= m.scanKm / 2 + driftKm && dy <= m.trackKm / 2 + driftKm) {
        const d = Math.hypot(dx, dy);
        if (d < bestD) {
          bestD = d;
          best = j;
        }
      }
    });
    return best;
  });
  const weight = viirs.map((v) => Math.max(0.1, v.frp));
  const sumW = new Map<number, number>();
  owner.forEach((j, i) => {
    if (j >= 0) sumW.set(j, (sumW.get(j) ?? 0) + weight[i]!);
  });
  const refined: RefinedPixel[] = viirs.map((v, i) => {
    const j = owner[i]!;
    const share = j >= 0 ? (modis[j]!.frp * weight[i]!) / sumW.get(j)! : v.frp;
    return { lng: v.lng, lat: v.lat, frp: Math.round(share * 10) / 10, scanKm: v.scanKm, trackKm: v.trackKm, matched: j >= 0 };
  });
  const modisOnly = modis.filter((_, j) => !sumW.has(j));
  const area = (list: readonly Footprint[]) => list.reduce((s, p) => s + p.scanKm * p.trackKm, 0);
  const frp = (list: readonly Footprint[]) => Math.round(list.reduce((s, p) => s + p.frp, 0) * 10) / 10;
  const modisArea = area(modis);
  const viirsArea = area(viirs);
  const hullSource = viirs.length ? viirs : modis;
  return {
    modis: { n: modis.length, frp: frp(modis), areaKm2: modisArea },
    viirs: { n: viirs.length, frp: frp(viirs), areaKm2: viirsArea },
    refined,
    modisOnly,
    hull: convexHull(hullSource.flatMap(corners)),
    sharpen: viirs.length && modis.length && viirsArea > 0 ? modisArea / modis.length / (viirsArea / viirs.length) : 1,
  };
}

export type FusedStatus = 'both' | 'modisOnly' | 'viirsOnly' | 'none';

export interface FusedObservation {
  status: FusedStatus;
  /** Confidence after fusion (0 when neither sensor saw a fire). */
  p: number;
  /** Which sensor the reported location comes from. */
  locatedBy: 'VIIRS' | 'MODIS' | null;
}

/** Fuses the two sensors' views of one scene (the AI #1 lab shows both side by side). */
export function fuseObservations(modis: FireCluster | null, viirs: FireCluster | null): FusedObservation {
  const pm = modis ? CLASS_PROBABILITY[modis.confidenceClass] : null;
  const pv = viirs ? CLASS_PROBABILITY[viirs.confidenceClass] : null;
  const status: FusedStatus = modis && viirs ? 'both' : modis ? 'modisOnly' : viirs ? 'viirsOnly' : 'none';
  return {
    status,
    p: status === 'none' ? 0 : fuseProbability(pm, pv),
    locatedBy: viirs ? 'VIIRS' : modis ? 'MODIS' : null,
  };
}

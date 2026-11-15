import { isModis, KM_PER_DEG, liveSat, offsetKm, type LiveRow } from '../live/satellites';

/**
 * Temporal Bridge — one satellite sees a place a couple of times a day; four (five) satellites together see it
 * every few hours. Terra's morning MODIS pass, then NOAA-20 / NOAA-21 (VIIRS) and Aqua (MODIS) in the early
 * afternoon, then the night passes: each pass is a snapshot of the same fire at another time.
 *
 *   1. Detections are grouped into passes (one satellite, one overpass: a few minutes apart).
 *   2. Detections are linked into fire events across passes — single linkage with a time-aware radius (a fire
 *      may have moved between passes: 1.5 km + pixel sizes + 1.5 km/h × Δt, at most 8 km, looks ≤ 20 h apart).
 *   3. Each pass of an event gets an FRP-weighted centre and an uncertainty from its pixel sizes (MODIS 1 km,
 *      VIIRS 375 m at nadir, both growing towards the swath edge) — that is the MODIS↔VIIRS harmonization here:
 *      a VIIRS centre counts ~7× more than a MODIS one.
 *   4. Weighted least squares of position against time gives the spread vector (km/h, bearing) and its error;
 *      the leading edge (farthest pixel along the bearing) gives the front's advance.
 *   5. With the wind at the fire, the vector is checked against it: steppe and forest fires run downwind.
 *
 * Honest limits: FRP-weighted centres also move when one flank flares up or dies down, and two passes 50 minutes
 * apart (NOAA-21 → NOAA-20) resolve only fast fires. A vector is called significant only above twice its error
 * and when the leading edge advanced the same way.
 */

export interface EventPass {
  sat: number;
  t: number;
  n: number;
  frp: number;
  lat: number;
  lng: number;
  /** 1-σ uncertainty of the pass centre, km. */
  sigmaKm: number;
  /** Detection indices (into the input rows). */
  rows: number[];
}

export interface SpreadVector {
  /** km/h towards `bearingDeg` (clockwise from north). */
  speedKmh: number;
  bearingDeg: number;
  sigmaKmh: number;
  significant: boolean;
  /** Displacement of the centre from the first to the last pass, km. */
  distKm: number;
  /** Advance of the leading edge along the bearing, first → last pass, km. */
  frontKm: number;
  /** East / north velocity, km/h. */
  ve: number;
  vn: number;
}

export type WindFit = 'with' | 'cross' | 'against' | 'calm';

export interface FireEvent {
  id: number;
  /** Centre of the latest pass. */
  lat: number;
  lng: number;
  passes: EventPass[];
  detections: number;
  frpSum: number;
  frpMax: number;
  /** 1 MODIS, 2 VIIRS, 3 both. */
  sensors: number;
  /** Hours from the first to the last pass. */
  spanH: number;
  vector: SpreadVector | null;
  /** Hot for a day or more without moving: likely a flare or a plant (AI #3's persistent-source registry). */
  persistent: boolean;
}

export interface BridgeOptions {
  /** Same satellite, detections at most this far apart in time belong to one pass (s). */
  passGapSec?: number;
  /** Shortest first→last span for a vector, h. */
  minSpanH?: number;
}

const LINK_R0 = 1.5;
const LINK_V = 1.5;
const LINK_MAX = 8;
/** Looks further apart than this are not linked: after a day the same place usually burns anew. */
const LINK_MAX_H = 20;

/** Pixel size of a detection, km (geometric mean of scan × track). */
export const pixelKm = (r: LiveRow) => Math.sqrt(Math.max(0.05, r[6]) * Math.max(0.05, r[7]));

/** Union-find with path halving. */
function makeSets(n: number) {
  const parent = Int32Array.from({ length: n }, (_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]!]!;
      i = parent[i]!;
    }
    return i;
  };
  return {
    find,
    union: (a: number, b: number) => {
      const ra = find(a);
      const rb = find(b);
      if (ra !== rb) parent[rb] = ra;
    },
  };
}

/** Links detections into fire events (space + time). Returns groups of row indices. */
export function linkEvents(rows: readonly LiveRow[]): number[][] {
  const n = rows.length;
  const sets = makeSets(n);
  // Grid of ~0.1° cells: any pair closer than LINK_MAX (+ pixels) sits in neighbouring cells.
  const cellDeg = (LINK_MAX + 6) / KM_PER_DEG;
  const grid = new Map<string, number[]>();
  const keyOf = (lng: number, lat: number) => `${Math.floor(lng / cellDeg)}:${Math.floor(lat / cellDeg)}`;
  rows.forEach((r, i) => {
    const k = keyOf(r[0], r[1]);
    const list = grid.get(k);
    if (list) list.push(i);
    else grid.set(k, [i]);
  });
  for (let i = 0; i < n; i++) {
    const a = rows[i]!;
    const cx = Math.floor(a[0] / cellDeg);
    const cy = Math.floor(a[1] / cellDeg);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const list = grid.get(`${cx + dx}:${cy + dy}`);
        if (!list) continue;
        for (const j of list) {
          if (j <= i) continue;
          const b = rows[j]!;
          const [ex, ny] = offsetKm(a[1], a[0], b[1], b[0]);
          const dt = Math.abs(b[3] - a[3]) / 3600;
          if (dt > LINK_MAX_H) continue;
          const r = LINK_R0 + 0.5 * (pixelKm(a) + pixelKm(b)) + Math.min(LINK_V * dt, LINK_MAX);
          if (ex * ex + ny * ny <= r * r) sets.union(i, j);
        }
      }
    }
  }
  const groups = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const root = sets.find(i);
    const g = groups.get(root);
    if (g) g.push(i);
    else groups.set(root, [i]);
  }
  return [...groups.values()];
}

/** Splits an event's detections into passes: one satellite, consecutive detections ≤ `gap` s apart. */
export function splitPasses(rows: readonly LiveRow[], idx: readonly number[], gap = 900): EventPass[] {
  const bySat = new Map<number, number[]>();
  for (const i of idx) {
    const s = rows[i]![2];
    const list = bySat.get(s);
    if (list) list.push(i);
    else bySat.set(s, [i]);
  }
  const out: EventPass[] = [];
  for (const [sat, list] of bySat) {
    list.sort((a, b) => rows[a]![3] - rows[b]![3]);
    let cur: number[] = [];
    const flush = () => {
      if (cur.length) out.push(passOf(rows, sat, cur));
      cur = [];
    };
    for (const i of list) {
      if (cur.length && rows[i]![3] - rows[cur[cur.length - 1]!]![3] > gap) flush();
      cur.push(i);
    }
    flush();
  }
  return out.sort((a, b) => a.t - b.t);
}

function passOf(rows: readonly LiveRow[], sat: number, idx: number[]): EventPass {
  let w = 0;
  let lat = 0;
  let lng = 0;
  let frp = 0;
  let pix = 0;
  let t = 0;
  for (const i of idx) {
    const r = rows[i]!;
    const wi = Math.max(0.5, r[4]);
    w += wi;
    lat += r[1] * wi;
    lng += r[0] * wi;
    frp += r[4];
    pix += pixelKm(r);
    t += r[3];
  }
  const n = idx.length;
  // Centre uncertainty: half a pixel over √n, plus ~0.3 km of geolocation and sub-pixel ambiguity.
  const sigmaKm = Math.hypot((0.5 * (pix / n)) / Math.sqrt(n), 0.3);
  return {
    sat,
    t: Math.round(t / n),
    n,
    frp: Math.round(frp * 10) / 10,
    lat: lat / w,
    lng: lng / w,
    sigmaKm,
    rows: idx,
  };
}

/** Weighted least-squares velocity of the pass centres (km/h), with the leading-edge advance. */
export function spreadVector(
  rows: readonly LiveRow[],
  passes: readonly EventPass[],
  minSpanH = 0.5,
): SpreadVector | null {
  if (passes.length < 2) return null;
  const first = passes[0]!;
  const last = passes[passes.length - 1]!;
  const spanH = (last.t - first.t) / 3600;
  if (spanH < minSpanH) return null;
  const pts = passes.map((p) => {
    const [x, y] = offsetKm(first.lat, first.lng, p.lat, p.lng);
    return { x, y, h: (p.t - first.t) / 3600, w: 1 / (p.sigmaKm * p.sigmaKm) };
  });
  const W = pts.reduce((s, p) => s + p.w, 0);
  const hm = pts.reduce((s, p) => s + p.w * p.h, 0) / W;
  const xm = pts.reduce((s, p) => s + p.w * p.x, 0) / W;
  const ym = pts.reduce((s, p) => s + p.w * p.y, 0) / W;
  const shh = pts.reduce((s, p) => s + p.w * (p.h - hm) ** 2, 0);
  if (shh <= 0) return null;
  const ve = pts.reduce((s, p) => s + p.w * (p.h - hm) * (p.x - xm), 0) / shh;
  const vn = pts.reduce((s, p) => s + p.w * (p.h - hm) * (p.y - ym), 0) / shh;
  // Error of each component from the centre uncertainties, inflated by the scatter when more than two passes
  // disagree with a straight line (reduced χ² > 1).
  let chi = 1;
  if (pts.length > 2) {
    const res = pts.reduce((s, p) => {
      const rx = p.x - (xm + ve * (p.h - hm));
      const ry = p.y - (ym + vn * (p.h - hm));
      return s + p.w * (rx * rx + ry * ry);
    }, 0);
    chi = Math.max(1, res / (2 * (pts.length - 2)));
  }
  const sigmaKmh = Math.sqrt(chi / shh);
  const speedKmh = Math.hypot(ve, vn);
  const bearingDeg = ((Math.atan2(ve, vn) * 180) / Math.PI + 360) % 360;
  const [dx, dy] = offsetKm(first.lat, first.lng, last.lat, last.lng);
  const distKm = Math.hypot(dx, dy);
  // Leading edge: the farthest pixel along the bearing in the first and in the last pass.
  const ux = speedKmh > 0 ? ve / speedKmh : 0;
  const uy = speedKmh > 0 ? vn / speedKmh : 0;
  const edge = (p: EventPass) =>
    Math.max(
      ...p.rows.map((i) => {
        const [x, y] = offsetKm(first.lat, first.lng, rows[i]![1], rows[i]![0]);
        return x * ux + y * uy;
      }),
    );
  const frontKm = edge(last) - edge(first);
  return {
    speedKmh,
    bearingDeg,
    sigmaKmh,
    // Significant: above twice its error, and the leading edge moved the same way (a centre that shifts while
    // the front stands still is a flank flaring up or dying down, not spread).
    significant: speedKmh > 2 * sigmaKmh && distKm >= 0.5 && frontKm > 0.25 * distKm,
    distKm,
    frontKm,
    ve,
    vn,
  };
}

/** Builds the fire events of a live window, most informative first (moving, more passes, more energy). */
export function temporalBridge(rows: readonly LiveRow[], opts: BridgeOptions = {}): FireEvent[] {
  const events: FireEvent[] = linkEvents(rows).map((idx, id) => {
    const passes = splitPasses(rows, idx, opts.passGapSec ?? 900);
    const last = passes[passes.length - 1]!;
    let frpSum = 0;
    let frpMax = 0;
    let sensors = 0;
    for (const i of idx) {
      const r = rows[i]!;
      frpSum += r[4];
      frpMax = Math.max(frpMax, r[4]);
      sensors |= isModis(r[2]) ? 1 : 2;
    }
    return {
      id,
      lat: last.lat,
      lng: last.lng,
      passes,
      detections: idx.length,
      frpSum: Math.round(frpSum * 10) / 10,
      frpMax,
      sensors,
      spanH: (last.t - passes[0]!.t) / 3600,
      vector: spreadVector(rows, passes, opts.minSpanH ?? 0.5),
      persistent: false,
    };
  });
  for (const e of events) e.persistent = e.spanH >= 20 && e.passes.length >= 4 && !e.vector?.significant;
  const score = (e: FireEvent) =>
    (e.persistent ? -1e7 : 0) +
    (e.vector?.significant ? 1e6 : 0) +
    (new Set(e.passes.map((p) => p.sat)).size > 1 ? 1e5 : 0) +
    e.passes.length * 1e3 +
    e.frpSum;
  return events.sort((a, b) => score(b) - score(a)).map((e, i) => ({ ...e, id: i + 1 }));
}

/** Smallest angle between two bearings, degrees (0–180). */
export function angleBetween(a: number, b: number): number {
  const d = Math.abs(((((a - b) % 360) + 540) % 360) - 180);
  return d;
}

/** Is the spread vector downwind? `windFromDeg` is where the wind blows FROM (meteorological convention). */
export function windFit(
  v: SpreadVector | null,
  wind: { windKmh: number; windFromDeg: number } | null,
): WindFit | null {
  if (!v || !v.significant || !wind) return null;
  if (wind.windKmh < 5) return 'calm';
  const d = angleBetween(v.bearingDeg, (wind.windFromDeg + 180) % 360);
  return d <= 45 ? 'with' : d <= 120 ? 'cross' : 'against';
}

/** Where the centre will be after `hours`, if the vector holds. */
export function projectAhead(e: FireEvent, hours: number): { lat: number; lng: number } | null {
  if (!e.vector?.significant) return null;
  const dLat = (e.vector.vn * hours) / KM_PER_DEG;
  const dLng = (e.vector.ve * hours) / (KM_PER_DEG * Math.cos((e.lat * Math.PI) / 180));
  return { lat: e.lat + dLat, lng: e.lng + dLng };
}

/** 16-point compass label index (N, NNE, NE …) for a bearing. */
export const compassIndex = (deg: number) => Math.round((((deg % 360) + 360) % 360) / 22.5) % 16;

/** Sensor family of a pass, for display. */
export const passSensor = (p: EventPass) => liveSat(p.sat).sensor;

import type { Feature, Polygon } from 'geojson';
import type { BBox } from '../data/types';

export const WORLD_BBOX: BBox = [-180, -85, 180, 85];
const EARTH_RADIUS_KM = 6371.0088;

export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** Wraps a longitude into [-180, 180]. */
export function wrapLng(lng: number): number {
  if (lng >= -180 && lng <= 180) return lng;
  const w = ((((lng + 180) % 360) + 360) % 360) - 180;
  return w === -180 && lng > 0 ? 180 : w;
}

/**
 * Normalises a box drawn on a (possibly world-copied) map:
 * sorts south/north, wraps longitudes and keeps antimeridian crossings as west > east.
 */
export function normalizeBBox(a: readonly [number, number], b: readonly [number, number]): BBox {
  const south = clamp(Math.min(a[1], b[1]), -90, 90);
  const north = clamp(Math.max(a[1], b[1]), -90, 90);
  const rawWest = Math.min(a[0], b[0]);
  const rawEast = Math.max(a[0], b[0]);
  if (rawEast - rawWest >= 360) return [-180, south, 180, north];
  return [wrapLng(rawWest), south, wrapLng(rawEast), north];
}

export function isValidBBox(b: readonly number[]): b is BBox {
  if (b.length !== 4 || b.some((v) => !Number.isFinite(v))) return false;
  const [w, s, e, n] = b as unknown as BBox;
  return w >= -180 && w <= 180 && e >= -180 && e <= 180 && s >= -90 && n <= 90 && s < n && w !== e;
}

/** Splits a box crossing the antimeridian into two boxes that do not. */
export function splitAntimeridian(b: BBox): BBox[] {
  const [w, s, e, n] = b;
  if (w <= e) return [b];
  return [
    [w, s, 180, n],
    [-180, s, e, n],
  ];
}

export function bboxWidth(b: BBox): number {
  return b[0] <= b[2] ? b[2] - b[0] : 360 - b[0] + b[2];
}

/** Spherical area of a lon/lat box in km². */
export function bboxAreaKm2(b: BBox): number {
  const toRad = Math.PI / 180;
  const width = bboxWidth(b) * toRad;
  return EARTH_RADIUS_KM ** 2 * width * Math.abs(Math.sin(b[3] * toRad) - Math.sin(b[1] * toRad));
}

/**
 * Spherical area of one ring given as a flat [lng, lat, lng, lat, …] array, in km² (Chamberlain & Duquette
 * 2007, "Some algorithms for polygons on a sphere" — the formula behind d3-geo and Turf). Orientation-free.
 */
export function ringAreaKm2(flat: ArrayLike<number>): number {
  const toRad = Math.PI / 180;
  const n = Math.floor(flat.length / 2);
  if (n < 3) return 0;
  let s = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    s +=
      (flat[2 * j]! - flat[2 * i]!) *
      toRad *
      (2 + Math.sin(flat[2 * i + 1]! * toRad) + Math.sin(flat[2 * j + 1]! * toRad));
  }
  return Math.abs((s * EARTH_RADIUS_KM ** 2) / 2);
}

/** Area of a multipolygon of flat rings ([outer, hole, hole…][]), holes subtracted, in km². */
export function polygonsAreaKm2(polys: readonly (readonly ArrayLike<number>[])[]): number {
  let total = 0;
  for (const rings of polys) {
    rings.forEach((ring, i) => {
      total += (i === 0 ? 1 : -1) * ringAreaKm2(ring);
    });
  }
  return total;
}

export function bboxContains(b: BBox, lng: number, lat: number): boolean {
  if (lat < b[1] || lat > b[3]) return false;
  return b[0] <= b[2] ? lng >= b[0] && lng <= b[2] : lng >= b[0] || lng <= b[2];
}

/** Intersection of two non-crossing boxes, or null. */
export function intersectSimple(a: BBox, b: BBox): BBox | null {
  const w = Math.max(a[0], b[0]);
  const s = Math.max(a[1], b[1]);
  const e = Math.min(a[2], b[2]);
  const n = Math.min(a[3], b[3]);
  return w < e && s < n ? [w, s, e, n] : null;
}

export function bboxCenter(b: BBox): [number, number] {
  const width = bboxWidth(b);
  return [wrapLng(b[0] + width / 2), (b[1] + b[3]) / 2];
}

/** Rounds coordinates for URLs and cache keys (≈100 m at 3 decimals). */
export function roundBBox(b: BBox, decimals = 3): BBox {
  const f = 10 ** decimals;
  const r = (v: number) => Math.round(v * f) / f;
  return [r(b[0]), r(b[1]), r(b[2]), r(b[3])];
}

export function bboxToParam(b: BBox): string {
  return roundBBox(b, 3).join(',');
}

export function parseBBoxParam(value: string | null | undefined): BBox | null {
  if (!value) return null;
  const parts = value.split(',').map((p) => Number(p.trim()));
  return isValidBBox(parts) ? (parts as unknown as BBox) : null;
}

export function bboxEquals(a: BBox | null, b: BBox | null, eps = 1e-6): boolean {
  if (!a || !b) return a === b;
  return a.every((v, i) => Math.abs(v - b[i]!) < eps);
}

/** GeoJSON polygon ring for a box (used for map outlines). */
export function bboxToPolygon(b: BBox): Feature<Polygon> {
  const [w, s, , n] = b;
  const e = b[0] <= b[2] ? b[2] : b[2] + 360;
  return {
    type: 'Feature',
    properties: {},
    geometry: {
      type: 'Polygon',
      coordinates: [
        [
          [w, s],
          [e, s],
          [e, n],
          [w, n],
          [w, s],
        ],
      ],
    },
  };
}

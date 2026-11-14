import type { BBox } from '../data/types';
import { bboxContains } from '../lib/geo';
import type { DetectionTable } from './detections';

/**
 * Country outline as shipped in public/data/countries.json:
 * polygons → rings → flat [lng, lat, lng, lat, …]. Longitudes are "unwrapped" (a polygon crossing
 * the antimeridian continues past 180°), so every test is done for lng and lng + 360.
 */
export type FlatPolygons = readonly (readonly (readonly number[])[])[];

function inRing(ring: readonly number[], x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 2; i < ring.length; j = i, i += 2) {
    const xi = ring[i]!;
    const yi = ring[i + 1]!;
    const xj = ring[j]!;
    const yj = ring[j + 1]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function inPolygon(rings: readonly (readonly number[])[], x: number, y: number): boolean {
  if (!rings[0] || !inRing(rings[0], x, y)) return false;
  for (let h = 1; h < rings.length; h++) if (inRing(rings[h]!, x, y)) return false;
  return true;
}

export function pointInPolygons(polys: FlatPolygons, lng: number, lat: number): boolean {
  for (const rings of polys) {
    if (inPolygon(rings, lng, lat) || inPolygon(rings, lng + 360, lat)) return true;
  }
  return false;
}

/** Per-detection mask for a box (handles boxes crossing the antimeridian). */
export function bboxMask(table: DetectionTable, bbox: BBox): Uint8Array {
  const mask = new Uint8Array(table.n);
  for (let i = 0; i < table.n; i++) if (bboxContains(bbox, table.lng[i]!, table.lat[i]!)) mask[i] = 1;
  return mask;
}

/** Per-detection mask for a country outline; `bbox` is a cheap pre-filter. */
export function polygonMask(table: DetectionTable, polys: FlatPolygons, bbox?: BBox): Uint8Array {
  const mask = new Uint8Array(table.n);
  for (let i = 0; i < table.n; i++) {
    const lng = table.lng[i]!;
    const lat = table.lat[i]!;
    if (bbox && !bboxContains(bbox, lng, lat)) continue;
    if (pointInPolygons(polys, lng, lat)) mask[i] = 1;
  }
  return mask;
}

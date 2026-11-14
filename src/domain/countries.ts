import type { BBox } from '../data/types';
import { bboxContains } from '../lib/geo';
import { pointInPolygons, type FlatPolygons } from './area';

/** One country of public/data/countries.json (Natural Earth 1:110m, built by scripts/generate-geo-data.ts). */
export interface CountryShape {
  /** ISO 3166-1 alpha-2. */
  id: string;
  /** English common name (UI names come from Intl.DisplayNames). */
  name: string;
  /** Main territory; west > east when it crosses the antimeridian. */
  bbox: BBox;
  /** Interface locales spoken there, most likely first. */
  langs: string[];
  polys: FlatPolygons;
}

export interface CountriesFile {
  version: string;
  attribution: string;
  countries: CountryShape[];
}

/** Box of every polygon (not just the main territory), unwrapped longitudes allowed. */
function fullBox(polys: FlatPolygons): BBox {
  let w = Infinity;
  let s = Infinity;
  let e = -Infinity;
  let n = -Infinity;
  for (const rings of polys) {
    const outer = rings[0];
    if (!outer) continue;
    for (let i = 0; i < outer.length; i += 2) {
      const x = outer[i]!;
      const y = outer[i + 1]!;
      if (x < w) w = x;
      if (x > e) e = x;
      if (y < s) s = y;
      if (y > n) n = y;
    }
  }
  return [w, s, e, n];
}

const boxCache = new WeakMap<CountryShape, BBox>();

function quickReject(c: CountryShape, lng: number, lat: number): boolean {
  let box = boxCache.get(c);
  if (!box) {
    box = fullBox(c.polys);
    boxCache.set(c, box);
  }
  if (lat < box[1] || lat > box[3]) return true;
  // Unwrapped longitudes may run past 180°: test lng and lng + 360 like pointInPolygons does.
  return !((lng >= box[0] && lng <= box[2]) || (lng + 360 >= box[0] && lng + 360 <= box[2]));
}

/**
 * Offline reverse geocoding: which country contains this point? Runs entirely in the browser, so a
 * visitor's coordinates never leave the device. Returns null over the ocean or on a coastline the
 * 1:110m outlines simplify away.
 */
export function countryAt(countries: readonly CountryShape[], lng: number, lat: number): CountryShape | null {
  for (const c of countries) {
    if (quickReject(c, lng, lat)) continue;
    if (pointInPolygons(c.polys, lng, lat)) return c;
  }
  return null;
}

/** Nearest country by box centre within `maxDeg` — for points on a simplified coastline. */
export function nearestCountry(countries: readonly CountryShape[], lng: number, lat: number, maxDeg = 1.5): CountryShape | null {
  const exact = countryAt(countries, lng, lat);
  if (exact) return exact;
  let best: CountryShape | null = null;
  let bestD = maxDeg;
  for (const c of countries) {
    if (!bboxContains([c.bbox[0] - maxDeg, c.bbox[1] - maxDeg, c.bbox[2] + maxDeg, c.bbox[3] + maxDeg], lng, lat)) continue;
    // Distance to the polygon's vertices: coarse but enough for a 1–2° tolerance.
    for (const rings of c.polys) {
      const outer = rings[0]!;
      for (let i = 0; i < outer.length; i += 2) {
        const d = Math.hypot((outer[i]! - lng) * Math.cos((lat * Math.PI) / 180), outer[i + 1]! - lat);
        if (d < bestD) {
          bestD = d;
          best = c;
        }
      }
    }
  }
  return best;
}

import { intersectSimple, splitAntimeridian } from '../../../lib/geo';
import type { BBox } from '../../types';
import { normalCdf } from './math';

/**
 * The synthetic archive is a set of "fire zones": axis-aligned Gaussian blobs, each with its own
 * monthly MODIS and VIIRS counts. Any box query is answered by integrating every blob over the box,
 * which is exact, cheap and consistent with the sampled fire points shown on the map.
 */
export interface ZoneRecord {
  id: string;
  /** [lng, lat] */
  center: [number, number];
  /** Standard deviation in degrees, [lng, lat]. */
  sigma: [number, number];
  /** Raw MODIS detections per month index (length = months). */
  modis: number[];
  /** Raw VIIRS detections from `viirsStartIndex` (length = months − viirsStartIndex). */
  viirs: number[];
}

export interface ZonesFile {
  version: string;
  seed: number;
  /** 'YYYY-MM' of index 0. */
  start: string;
  months: number;
  viirsStartIndex: number;
  /** Boxes where the synthetic archive has data at all. Outside of them a query returns "no data". */
  coverage: BBox[];
  zones: ZoneRecord[];
}

/** Zones are truncated at ±TRUNC σ, both when sampling points and when integrating. */
export const TRUNC = 2.5;
/** Probability mass of a 1-D standard normal inside ±TRUNC. */
const MASS_1D = 2 * normalCdf(TRUNC) - 1;

function axisShare(lo: number, hi: number, c: number, s: number): number {
  const a = Math.max(-TRUNC, (lo - c) / s);
  const b = Math.min(TRUNC, (hi - c) / s);
  return b > a ? (normalCdf(b) - normalCdf(a)) / MASS_1D : 0;
}

/** Share (0…1) of a zone's mass that falls inside the box. */
export function zoneWeight(zone: Pick<ZoneRecord, 'center' | 'sigma'>, bbox: BBox): number {
  let w = 0;
  for (const part of splitAntimeridian(bbox)) {
    const lat = axisShare(part[1], part[3], zone.center[1], zone.sigma[1]);
    if (lat === 0) continue;
    // A zone near ±180° spills over the antimeridian: integrate the box at its ±360° copies too.
    let lng = 0;
    for (const shift of [-360, 0, 360]) {
      lng += axisShare(part[0] + shift, part[2] + shift, zone.center[0], zone.sigma[0]);
    }
    w += lng * lat;
  }
  return Math.min(1, w);
}

/** Share (0…1) of the box area covered by the archive, estimated on a 24×24 lattice. */
export function coverageShare(coverage: readonly BBox[], bbox: BBox): number {
  const N = 24;
  let inside = 0;
  const parts = splitAntimeridian(bbox);
  const totalWidth = parts.reduce((acc, p) => acc + (p[2] - p[0]), 0);
  for (const part of parts) {
    const share = (part[2] - part[0]) / totalWidth;
    const cols = Math.max(1, Math.round(N * share));
    for (let i = 0; i < cols; i++) {
      const lng = part[0] + ((i + 0.5) / cols) * (part[2] - part[0]);
      for (let j = 0; j < N; j++) {
        const lat = part[1] + ((j + 0.5) / N) * (part[3] - part[1]);
        if (coverage.some((c) => lng >= c[0] && lng <= c[2] && lat >= c[1] && lat <= c[3])) inside += 1;
      }
    }
  }
  const total = parts.reduce((acc, p) => acc + Math.max(1, Math.round(N * ((p[2] - p[0]) / totalWidth))) * N, 0);
  return inside / total;
}

/** True when at least part of the box touches the archive coverage. */
export function touchesCoverage(coverage: readonly BBox[], bbox: BBox): boolean {
  return splitAntimeridian(bbox).some((part) => coverage.some((c) => intersectSimple(part, c) !== null));
}

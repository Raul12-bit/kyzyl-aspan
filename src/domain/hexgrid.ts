import {
  cellToBoundary,
  cellToLatLng,
  cellToParent,
  getHexagonAreaAvg,
  getHexagonEdgeLengthAvg,
  latLngToCell,
  UNITS,
} from 'h3-js';

/**
 * H3 (Uber's hexagonal grid) is the common ruler for sensors with different pixel sizes:
 * a 1 km MODIS pixel and a 375 m VIIRS pixel both fall into the same fixed hexagon, and we count
 * burning hexagons instead of raw pixels.
 *
 * Detections are indexed once at BASE_RES; coarser grids are derived by walking up the hierarchy.
 */
export const BASE_RES = 6;
/** Grid used for statistics and the calendar (≈ 250 km², ≈ 17 km across). */
export const HARMONIZATION_RES = 5;
export const MIN_RES = 1;

export interface CellIndex {
  res: number;
  /** Unique H3 cell ids. */
  ids: string[];
  /** Per detection: index into `ids`. */
  cellOf: Int32Array;
}

export function indexCells(lng: ArrayLike<number>, lat: ArrayLike<number>, n: number, res = BASE_RES): CellIndex {
  const lookup = new Map<string, number>();
  const ids: string[] = [];
  const cellOf = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    const id = latLngToCell(lat[i]!, lng[i]!, res);
    let k = lookup.get(id);
    if (k === undefined) {
      k = ids.length;
      ids.push(id);
      lookup.set(id, k);
    }
    cellOf[i] = k;
  }
  return { res, ids, cellOf };
}

/** Same detections on a coarser grid; only the unique cells are sent through H3. */
export function coarsen(base: CellIndex, res: number): CellIndex {
  if (res === base.res) return base;
  if (res > base.res) throw new RangeError(`Cannot refine H3 index from ${base.res} to ${res}`);
  const lookup = new Map<string, number>();
  const ids: string[] = [];
  const parentOf = new Int32Array(base.ids.length);
  base.ids.forEach((id, i) => {
    const parent = cellToParent(id, res);
    let k = lookup.get(parent);
    if (k === undefined) {
      k = ids.length;
      ids.push(parent);
      lookup.set(parent, k);
    }
    parentOf[i] = k;
  });
  const cellOf = new Int32Array(base.cellOf.length);
  for (let i = 0; i < cellOf.length; i++) cellOf[i] = parentOf[base.cellOf[i]!]!;
  return { res, ids, cellOf };
}

/** Closed [lng, lat] ring of a cell. Cells straddling the antimeridian are unwrapped past 180°. */
export function hexRing(id: string): [number, number][] {
  const ring = cellToBoundary(id, true) as [number, number][];
  let min = Infinity;
  let max = -Infinity;
  for (const p of ring) {
    if (p[0] < min) min = p[0];
    if (p[0] > max) max = p[0];
  }
  if (max - min > 180) for (const p of ring) if (p[0] < 0) p[0] += 360;
  return ring;
}

/** [lng, lat] of a cell centre. */
export function hexCenter(id: string): [number, number] {
  const [lat, lng] = cellToLatLng(id);
  return [lng, lat];
}

export interface GridInfo {
  res: number;
  areaKm2: number;
  edgeKm: number;
}

export function gridInfo(res: number): GridInfo {
  return { res, areaKm2: getHexagonAreaAvg(res, UNITS.km2), edgeKm: getHexagonEdgeLengthAvg(res, UNITS.km) };
}

/**
 * Grid resolution for a web-mercator zoom, chosen so hexagons stay roughly 15–40 px wide:
 * each H3 level is ~2.6× finer, i.e. ~1.4 zoom levels.
 */
export function resolutionForZoom(zoom: number): number {
  return Math.max(MIN_RES, Math.min(BASE_RES, Math.floor((zoom - 1.8) / 1.4) + 2));
}

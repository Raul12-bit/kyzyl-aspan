import type { DetectionTable } from './detections';
import { BASE_RES, coarsen, HARMONIZATION_RES, indexCells, type CellIndex } from './hexgrid';
import { cellPersistence, noiseFlags, type CellPersistence } from './noise';

export { DEFAULT_NOISE, hideMaskOf, type NoiseSettings } from './noiseSettings';

/**
 * Everything the pipeline derives once per archive, independent of the area or time window:
 * detections on the fine H3 grid (persistence is judged there), the same detections on the coarser
 * harmonization grid (statistics are counted there) and the per-detection noise flags.
 *
 * Built in ~20–60 ms for the demo sample; a production backend would precompute and store it.
 */
export interface FireArchive {
  table: DetectionTable;
  /** Fine grid (res 6, ≈36 km²): static-source detection. */
  base: CellIndex;
  /** Harmonization grid (res 5, ≈250 km²): burning hexagon-days. */
  grid: CellIndex;
  persistence: CellPersistence;
  /** Bit 0 = low confidence, bit 1 = persistent static source. */
  flags: Uint8Array;
}

export function buildArchive(table: DetectionTable): FireArchive {
  const base = indexCells(table.lng, table.lat, table.n, BASE_RES);
  const grid = coarsen(base, HARMONIZATION_RES);
  const persistence = cellPersistence(table, base);
  const flags = noiseFlags(table, base, persistence);
  return { table, base, grid, persistence, flags };
}


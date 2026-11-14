import type { BBox } from '@/data/types';

/**
 * Free, token-less basemap. CARTO Dark Matter is used under CARTO's free basemap terms with
 * OpenStreetMap attribution. Override with VITE_BASEMAP_STYLE_URL (e.g. an OpenFreeMap style).
 */
export const BASEMAP_STYLE_URL =
  import.meta.env.VITE_BASEMAP_STYLE_URL || 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json';

/** Give up on the basemap after this long and use the plain fallback style. */
export const BASEMAP_TIMEOUT_MS = 6000;
/** Tile errors tolerated before the "basemap unavailable" banner appears. */
export const BASEMAP_ERROR_BUDGET = 6;

export const WORLD: BBox = [-180, -85, 180, 85];

/** Points are aggregated (clustered) below this zoom. */
export const CLUSTER = { radius: 44, maxZoom: 6 } as const;

export const SOURCES = {
  MODIS: 'el-fires-modis',
  VIIRS: 'el-fires-viirs',
  aoi: 'el-aoi',
  hex: 'el-hex',
} as const;

export const LAYERS = {
  aoiFill: 'el-aoi-fill',
  aoiLine: 'el-aoi-line',
  hexFill: 'el-hex-fill',
  MODIS: {
    cluster: 'el-modis-cluster',
    point: 'el-modis-point',
  },
  VIIRS: {
    cluster: 'el-viirs-cluster',
    point: 'el-viirs-point',
  },
} as const;

/** SDF hexagon used for every detection and cluster mark. */
export const HEX_IMAGE = 'el-hex';

export interface Padding {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

/** Room taken by the floating UI, so fitBounds centres areas in the visible part of the map. */
export function uiPadding(width = window.innerWidth, height = window.innerHeight): Padding {
  if (width < 768) return { top: 80, bottom: Math.min(190, height * 0.3), left: 24, right: 24 };
  // Desktop: one panel at most, on the left; zoom controls on the right.
  return { top: 104, bottom: 150, left: 420, right: 88 };
}

const mercY = (lat: number) => {
  const phi = (Math.max(-85, Math.min(85, lat)) * Math.PI) / 180;
  return (1 - Math.log(Math.tan(Math.PI / 4 + phi / 2)) / Math.PI) / 2;
};

/** Web-Mercator zoom (512 px tiles) that fits `bounds` inside the padded viewport. */
export function fitZoom(bounds: readonly [number, number, number, number], width: number, height: number, padding: Padding): number {
  const availW = Math.max(64, width - padding.left - padding.right);
  const availH = Math.max(64, height - padding.top - padding.bottom);
  const dx = Math.max(1e-6, (bounds[2] - bounds[0]) / 360);
  const dy = Math.max(1e-6, mercY(bounds[1]) - mercY(bounds[3]));
  return Math.log2(Math.min(availW / (dx * 512), availH / (dy * 512)));
}

/** The whole archive as an ISO date range. */
export const FULL_DATES = { start: '2000-01-01', end: '2026-10-31' } as const;

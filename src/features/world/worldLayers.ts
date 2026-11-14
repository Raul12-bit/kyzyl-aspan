import type { ExpressionSpecification, GeoJSONSource, Map as MLMap } from 'maplibre-gl';
import type { Feature, FeatureCollection, MultiPolygon, Point, Polygon } from 'geojson';
import type { FlatPolygons } from '@/domain/area';
import { LAYERS } from '@/features/map/map.config';
import { rampColors, token, withAlpha } from '@/styles/tokens';
import type { WorldFireProperties } from './api';

/**
 * World layers: admin-1 regions and countries as a choropleth (precise borders instead of blobs),
 * and every detection drawn at its real pixel size (VIIRS ≈ 375 m, MODIS ≈ 1 km, larger off-nadir).
 */
export const W_SOURCES = {
  countries: 'el-world-countries',
  regions: 'el-world-regions',
  footprints: 'el-world-footprints',
} as const;

export const W_LAYERS = {
  countriesFill: 'el-world-countries-fill',
  countriesLine: 'el-world-countries-line',
  regionsFill: 'el-world-regions-fill',
  regionsLine: 'el-world-regions-line',
  regionsLabel: 'el-world-regions-label',
  footFill: 'el-world-foot-fill',
  footLine: 'el-world-foot-line',
} as const;

/** Layers whose features open a tooltip / can be clicked. */
export const WORLD_INTERACTIVE: string[] = [W_LAYERS.footFill, W_LAYERS.regionsFill, W_LAYERS.countriesFill];

const EMPTY: FeatureCollection = { type: 'FeatureCollection', features: [] };

function firstSymbolLayer(map: MLMap): string | undefined {
  return map.getStyle().layers.find((l) => l.type === 'symbol')?.id;
}

function basemapFont(map: MLMap): string[] | undefined {
  for (const l of map.getStyle().layers) {
    const font =
      l.type === 'symbol' ? (l.layout as Record<string, unknown> | undefined)?.['text-font'] : undefined;
    if (Array.isArray(font) && font.every((f) => typeof f === 'string')) return font as string[];
  }
  return undefined;
}

/** Choropleth ramp over `v` = √(density / max) in 0…1; `v` < 0 means "no fires" (outline only). */
function choroplethPaint(hover: boolean) {
  const ramp = rampColors();
  const color: ExpressionSpecification = [
    'interpolate',
    ['linear'],
    ['get', 'v'],
    0,
    ramp[1]!,
    0.2,
    ramp[2]!,
    0.45,
    ramp[3]!,
    0.7,
    ramp[4]!,
    0.9,
    ramp[5]!,
    1,
    ramp[6]!,
  ];
  return {
    fill: {
      'fill-color': ['case', ['<', ['get', 'v'], 0], 'rgba(0,0,0,0)', color] as ExpressionSpecification,
      'fill-opacity': [
        'case',
        ['boolean', ['feature-state', 'hover'], false],
        hover ? 0.92 : 0.8,
        ['boolean', ['feature-state', 'selected'], false],
        0.9,
        ['interpolate', ['linear'], ['get', 'v'], 0, 0.42, 1, 0.82],
      ] as ExpressionSpecification,
    },
    line: {
      'line-color': [
        'case',
        ['boolean', ['feature-state', 'selected'], false],
        token('--el-orange'),
        withAlpha(token('--el-ink'), 0.34),
      ] as ExpressionSpecification,
      'line-width': [
        'case',
        ['boolean', ['feature-state', 'selected'], false],
        2,
        ['interpolate', ['linear'], ['zoom'], 3, 0.5, 8, 1.2],
      ] as ExpressionSpecification,
    },
  };
}

function footprintPaint() {
  const modis = token('--el-modis');
  const viirs = token('--el-viirs');
  return {
    fill: {
      'fill-color': [
        'case',
        ['==', ['get', 'sensor'], 'MODIS'],
        withAlpha(modis, 0.16),
        viirs,
      ] as ExpressionSpecification,
      'fill-opacity': [
        'case',
        ['!=', ['get', 'truth'], 'fire'],
        0.25,
        ['==', ['get', 'sensor'], 'MODIS'],
        1,
        ['interpolate', ['linear'], ['ln', ['+', 1, ['get', 'frp']]], 0, 0.45, 5, 0.95],
      ] as ExpressionSpecification,
    },
    line: {
      'line-color': [
        'case',
        ['==', ['get', 'sensor'], 'MODIS'],
        modis,
        withAlpha(token('--el-bg'), 0.55),
      ] as ExpressionSpecification,
      'line-width': ['case', ['==', ['get', 'sensor'], 'MODIS'], 1.3, 0.5] as ExpressionSpecification,
    },
  };
}

export function addWorldLayers(map: MLMap) {
  if (map.getSource(W_SOURCES.regions)) return;
  // Under the burning hexagons and detections, above the basemap.
  const below = map.getLayer(LAYERS.hexFill) ? LAYERS.hexFill : firstSymbolLayer(map);
  const hidden = { visibility: 'none' as const };
  map.addSource(W_SOURCES.countries, { type: 'geojson', data: EMPTY, promoteId: 'id' });
  map.addSource(W_SOURCES.regions, { type: 'geojson', data: EMPTY, promoteId: 'idx' });
  map.addSource(W_SOURCES.footprints, { type: 'geojson', data: EMPTY });
  const c = choroplethPaint(true);
  map.addLayer(
    { id: W_LAYERS.countriesFill, type: 'fill', source: W_SOURCES.countries, layout: hidden, paint: c.fill },
    below,
  );
  map.addLayer(
    { id: W_LAYERS.countriesLine, type: 'line', source: W_SOURCES.countries, layout: hidden, paint: c.line },
    below,
  );
  map.addLayer(
    { id: W_LAYERS.regionsFill, type: 'fill', source: W_SOURCES.regions, layout: hidden, paint: c.fill },
    below,
  );
  map.addLayer(
    { id: W_LAYERS.regionsLine, type: 'line', source: W_SOURCES.regions, layout: hidden, paint: c.line },
    below,
  );
  const font = basemapFont(map);
  map.addLayer({
    id: W_LAYERS.regionsLabel,
    type: 'symbol',
    source: W_SOURCES.regions,
    minzoom: 4.2,
    layout: {
      ...hidden,
      'text-field': ['get', 'label'],
      'text-size': ['interpolate', ['linear'], ['zoom'], 4, 10, 8, 13],
      'text-max-width': 8,
      'symbol-placement': 'point',
      ...(font ? { 'text-font': font } : {}),
    },
    paint: {
      'text-color': withAlpha(token('--el-ink'), 0.86),
      'text-halo-color': withAlpha(token('--el-bg'), 0.85),
      'text-halo-width': 1.2,
    },
  });
  const f = footprintPaint();
  map.addLayer({
    id: W_LAYERS.footFill,
    type: 'fill',
    source: W_SOURCES.footprints,
    minzoom: 7,
    layout: hidden,
    paint: f.fill,
  });
  map.addLayer({
    id: W_LAYERS.footLine,
    type: 'line',
    source: W_SOURCES.footprints,
    minzoom: 9,
    layout: hidden,
    paint: f.line,
  });
}

/** Regions stay queryable (hover, click to select) even when not shaded: opacity 0 instead of hidden. */
export function shadeRegions(map: MLMap, on: boolean) {
  if (!map.getLayer(W_LAYERS.regionsFill)) return;
  map.setPaintProperty(
    W_LAYERS.regionsFill,
    'fill-opacity',
    on ? choroplethPaint(true).fill['fill-opacity'] : 0,
  );
}

export function retintWorldLayers(map: MLMap) {
  const set = (id: string, paint: Record<string, unknown>) => {
    if (!map.getLayer(id)) return;
    for (const [k, v] of Object.entries(paint)) map.setPaintProperty(id, k, v);
  };
  const c = choroplethPaint(true);
  set(W_LAYERS.countriesFill, c.fill);
  set(W_LAYERS.countriesLine, c.line);
  set(W_LAYERS.regionsFill, c.fill);
  set(W_LAYERS.regionsLine, c.line);
  const f = footprintPaint();
  set(W_LAYERS.footFill, f.fill);
  set(W_LAYERS.footLine, f.line);
  set(W_LAYERS.regionsLabel, {
    'text-color': withAlpha(token('--el-ink'), 0.86),
    'text-halo-color': withAlpha(token('--el-bg'), 0.85),
  });
}

export function setWorldVisible(map: MLMap, layer: keyof typeof W_LAYERS, on: boolean) {
  const id = W_LAYERS[layer];
  if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
}

export function setSourceData(map: MLMap, source: keyof typeof W_SOURCES, fc: FeatureCollection) {
  (map.getSource(W_SOURCES[source]) as GeoJSONSource | undefined)?.setData(fc);
}

/* ------------------------------------------------------------------ geometry helpers */

/** Country outlines (flat rings) → GeoJSON, so the world view can be shaded per country. */
export function flatToMultiPolygon(polys: FlatPolygons): MultiPolygon {
  return {
    type: 'MultiPolygon',
    coordinates: polys.map((rings) =>
      rings.map((ring) => {
        const out: [number, number][] = [];
        for (let i = 0; i < ring.length; i += 2) out.push([ring[i]!, ring[i + 1]!]);
        return out;
      }),
    ),
  };
}

/** GeoJSON (Multi)Polygon → the flat-ring format the selection outline uses. */
export function toFlatPolygons(g: Polygon | MultiPolygon): FlatPolygons {
  const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
  return polys.map((rings) => rings.map((ring) => ring.flatMap(([x, y]) => [x!, y!])));
}

/** A detection as the ground footprint of its pixel: scan (across track, ≈E–W) × track (≈N–S). */
export function footprints(
  fc: FeatureCollection<Point, WorldFireProperties>,
): FeatureCollection<Polygon, WorldFireProperties> {
  const features: Feature<Polygon, WorldFireProperties>[] = fc.features.map((f) => {
    const [lng, lat] = f.geometry.coordinates as [number, number];
    const p = f.properties;
    const dx = p.scan / 2 / (111.32 * Math.max(0.05, Math.cos((lat * Math.PI) / 180)));
    const dy = p.track / 2 / 110.57;
    return {
      type: 'Feature',
      properties: p,
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [lng - dx, lat - dy],
            [lng + dx, lat - dy],
            [lng + dx, lat + dy],
            [lng - dx, lat + dy],
            [lng - dx, lat - dy],
          ],
        ],
      },
    };
  });
  return { type: 'FeatureCollection', features };
}

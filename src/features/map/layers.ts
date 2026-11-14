import type { ExpressionSpecification, GeoJSONSource, Map as MLMap } from 'maplibre-gl';
import type { Feature, FeatureCollection, MultiPolygon, Point, Polygon } from 'geojson';
import type { BBox, FireProperties, Sensor } from '@/data/types';
import type { FlatPolygons } from '@/domain/area';
import { bboxToPolygon } from '@/lib/geo';
import { rampColors, token, withAlpha } from '@/styles/tokens';
import { CLUSTER, LAYERS, MODIS_SQUARE_IMAGE, SOURCES } from './map.config';

const EMPTY: FeatureCollection = { type: 'FeatureCollection', features: [] };

function firstSymbolLayer(map: MLMap): string | undefined {
  return map.getStyle().layers.find((l) => l.type === 'symbol')?.id;
}

/* ------------------------------------------------------------------ fire detections */

/** MODIS is drawn as small squares (shape + colour survive colour blindness). */
function ensureSquareImage(map: MLMap) {
  if (map.hasImage(MODIS_SQUARE_IMAGE)) return;
  const size = 14; // device px at pixelRatio 2 → 7 css px
  const data = new Uint8ClampedArray(size * size * 4);
  const hex = token('--el-modis').replace('#', '');
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const edge = x < 2 || y < 2 || x >= size - 2 || y >= size - 2;
      // dark 1px outline keeps squares legible over glows; premultiplied-safe opaque pixels
      data[i] = edge ? 5 : r;
      data[i + 1] = edge ? 7 : g;
      data[i + 2] = edge ? 13 : b;
      data[i + 3] = edge ? 200 : 255;
    }
  }
  map.addImage(MODIS_SQUARE_IMAGE, { width: size, height: size, data }, { pixelRatio: 2 });
}

const frpScale = (lo: number, hi: number): ExpressionSpecification => [
  '+',
  lo,
  ['*', hi, ['ln', ['+', 1, ['coalesce', ['get', 'frp'], 1]]]],
];

const clusterRadius = (k: number): ExpressionSpecification => [
  'interpolate',
  ['linear'],
  ['sqrt', ['get', 'point_count']],
  1,
  9 * k,
  6,
  18 * k,
  20,
  34 * k,
  45,
  52 * k,
];

export function addFireLayers(map: MLMap) {
  ensureSquareImage(map);
  const before = firstSymbolLayer(map);
  const order: Sensor[] = ['VIIRS', 'MODIS']; // MODIS (sparser, squares) on top
  for (const sensor of order) {
    const src = SOURCES[sensor];
    if (map.getSource(src)) continue;
    const color = token(sensor === 'MODIS' ? '--el-modis' : '--el-viirs');
    const ids = LAYERS[sensor];
    map.addSource(src, {
      type: 'geojson',
      data: EMPTY,
      cluster: true,
      clusterRadius: CLUSTER.radius,
      clusterMaxZoom: CLUSTER.maxZoom,
      clusterProperties: { frp: ['+', ['coalesce', ['get', 'frp'], 0]] },
    });
    // Aggregates: a soft halo + (MODIS) hollow ring / (VIIRS) filled disc.
    map.addLayer(
      {
        id: ids.halo,
        type: 'circle',
        source: src,
        filter: ['has', 'point_count'],
        paint: {
          'circle-radius': clusterRadius(1.35),
          'circle-color': color,
          'circle-opacity': 0.14,
          'circle-blur': 0.9,
        },
      },
      before,
    );
    map.addLayer(
      {
        id: ids.cluster,
        type: 'circle',
        source: src,
        filter: ['has', 'point_count'],
        paint: {
          'circle-radius': clusterRadius(sensor === 'MODIS' ? 0.62 : 0.5),
          'circle-color': sensor === 'MODIS' ? withAlpha(color, 0.06) : withAlpha(color, 0.38),
          'circle-stroke-color': color,
          'circle-stroke-width': sensor === 'MODIS' ? 1.4 : 0,
          'circle-stroke-opacity': 0.95,
        },
      },
      before,
    );
    // Individual detections: glow underneath, crisp mark on top.
    map.addLayer(
      {
        id: ids.glow,
        type: 'circle',
        source: src,
        filter: ['!', ['has', 'point_count']],
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 3, frpScale(3, 1.4), 9, frpScale(7, 3.2)],
          'circle-color': color,
          'circle-opacity': 0.32,
          'circle-blur': 1,
        },
      },
      before,
    );
    if (sensor === 'MODIS') {
      map.addLayer(
        {
          id: ids.point,
          type: 'symbol',
          source: src,
          filter: ['!', ['has', 'point_count']],
          layout: {
            'icon-image': MODIS_SQUARE_IMAGE,
            'icon-size': ['interpolate', ['linear'], ['zoom'], 3, 0.75, 7, 1.15, 11, 1.7],
            'icon-allow-overlap': true,
            'icon-ignore-placement': true,
          },
        },
        before,
      );
    } else {
      map.addLayer(
        {
          id: ids.point,
          type: 'circle',
          source: src,
          filter: ['!', ['has', 'point_count']],
          paint: {
            'circle-radius': ['interpolate', ['linear'], ['zoom'], 3, 1.8, 7, 2.6, 11, 4],
            'circle-color': color,
            'circle-stroke-color': token('--el-bg'),
            'circle-stroke-width': 0.6,
            'circle-stroke-opacity': 0.8,
          },
        },
        before,
      );
    }
  }
}

export function setFireData(map: MLMap, sensor: Sensor, fc: FeatureCollection<Point, FireProperties>) {
  (map.getSource(SOURCES[sensor]) as GeoJSONSource | undefined)?.setData(fc);
}

export function setSensorVisible(map: MLMap, sensor: Sensor, visible: boolean) {
  for (const id of Object.values(LAYERS[sensor])) {
    if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', visible ? 'visible' : 'none');
  }
}

export const interactiveFireLayers = (): string[] => [
  LAYERS.MODIS.point,
  LAYERS.VIIRS.point,
  LAYERS.MODIS.cluster,
  LAYERS.VIIRS.cluster,
];

/* ------------------------------------------------------------------ H3 hexagons */

/** Properties of one hexagon feature (see useHexData). */
export interface HexProperties {
  id: string;
  /** Burning hexagon-days (any sensor) in the window. */
  days: number;
  modis: number;
  viirs: number;
  frpMax: number;
  /** days / max days, 0…1 — drives the colour ramp (√-scaled by the caller). */
  v: number;
}

export function addHexLayers(map: MLMap) {
  if (map.getSource(SOURCES.hex)) return;
  const ramp = rampColors();
  map.addSource(SOURCES.hex, { type: 'geojson', data: EMPTY });
  const before = firstSymbolLayer(map);
  map.addLayer(
    {
      id: LAYERS.hexFill,
      type: 'fill',
      source: SOURCES.hex,
      layout: { visibility: 'none' },
      paint: {
        'fill-color': [
          'interpolate',
          ['linear'],
          ['get', 'v'],
          0,
          ramp[2]!,
          0.25,
          ramp[3]!,
          0.5,
          ramp[4]!,
          0.75,
          ramp[5]!,
          1,
          ramp[6]!,
        ],
        'fill-opacity': ['interpolate', ['linear'], ['get', 'v'], 0, 0.42, 1, 0.86],
      },
    },
    before,
  );
  map.addLayer(
    {
      id: LAYERS.hexLine,
      type: 'line',
      source: SOURCES.hex,
      layout: { visibility: 'none' },
      paint: {
        'line-color': withAlpha(token('--el-bg'), 0.9),
        'line-width': ['interpolate', ['linear'], ['zoom'], 2, 0.3, 8, 1.1],
      },
    },
    before,
  );
}

export function setHexData(map: MLMap, fc: FeatureCollection<Polygon, HexProperties>) {
  (map.getSource(SOURCES.hex) as GeoJSONSource | undefined)?.setData(fc);
}

export function setHexVisible(map: MLMap, visible: boolean) {
  for (const id of [LAYERS.hexFill, LAYERS.hexLine]) {
    if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', visible ? 'visible' : 'none');
  }
}

/* ------------------------------------------------------------------ area of interest */

export function addSelectionLayers(map: MLMap) {
  if (map.getSource(SOURCES.aoi)) return;
  const red = token('--el-kyzyl');
  map.addSource(SOURCES.aoi, { type: 'geojson', data: EMPTY });
  const before = firstSymbolLayer(map);
  map.addLayer(
    { id: LAYERS.aoiFill, type: 'fill', source: SOURCES.aoi, paint: { 'fill-color': red, 'fill-opacity': 0.05 } },
    before,
  );
  map.addLayer({
    id: LAYERS.aoiGlow,
    type: 'line',
    source: SOURCES.aoi,
    paint: { 'line-color': red, 'line-width': 8, 'line-blur': 7, 'line-opacity': 0.3 },
  });
  map.addLayer({
    id: LAYERS.aoiLine,
    type: 'line',
    source: SOURCES.aoi,
    paint: { 'line-color': token('--el-amber-soft'), 'line-width': 1.4, 'line-dasharray': [3, 2] },
  });
}

/** Draws the selected area: the country outline when one is known, else the box. */
export function setSelection(map: MLMap, bbox: BBox | null, outline?: FlatPolygons | null) {
  const src = map.getSource(SOURCES.aoi) as GeoJSONSource | undefined;
  if (!src) return;
  if (!bbox) {
    src.setData(EMPTY);
    return;
  }
  if (outline && outline.length) {
    const feature: Feature<MultiPolygon> = {
      type: 'Feature',
      properties: {},
      geometry: {
        type: 'MultiPolygon',
        coordinates: outline.map((rings) =>
          rings.map((ring) => {
            const out: [number, number][] = [];
            for (let i = 0; i < ring.length; i += 2) out.push([ring[i]!, ring[i + 1]!]);
            return out;
          }),
        ),
      },
    };
    src.setData({ type: 'FeatureCollection', features: [feature] });
    return;
  }
  src.setData({ type: 'FeatureCollection', features: [bboxToPolygon(bbox)] });
}

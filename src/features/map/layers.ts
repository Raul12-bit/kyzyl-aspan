import type { ExpressionSpecification, GeoJSONSource, Map as MLMap } from 'maplibre-gl';
import type { FeatureCollection, Point } from 'geojson';
import type { BBox, FireProperties, Sensor } from '@/data/types';
import { bboxToPolygon } from '@/lib/geo';
import { token, withAlpha } from '@/styles/tokens';
import { CLUSTER, LAYERS, MODIS_SQUARE_IMAGE, SOURCES } from './map.config';

const EMPTY: FeatureCollection = { type: 'FeatureCollection', features: [] };

function firstSymbolLayer(map: MLMap): string | undefined {
  return map.getStyle().layers.find((l) => l.type === 'symbol')?.id;
}

/* ------------------------------------------------------------------ intro aggregates (globe) */

export function addIntroLayers(map: MLMap, points: [number, number, number][]) {
  if (map.getSource(SOURCES.intro)) return;
  map.addSource(SOURCES.intro, {
    type: 'geojson',
    data: {
      type: 'FeatureCollection',
      features: points.map(([lng, lat, w]) => ({ type: 'Feature', properties: { w }, geometry: { type: 'Point', coordinates: [lng, lat] } })),
    },
  });
  const orange = token('--el-orange');
  const amber = token('--el-amber-soft');
  map.addLayer({
    id: LAYERS.introGlow,
    type: 'circle',
    source: SOURCES.intro,
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['get', 'w'], 0, 5, 1, 26],
      'circle-color': orange,
      'circle-opacity': ['interpolate', ['linear'], ['get', 'w'], 0, 0.12, 1, 0.42],
      'circle-blur': 1,
      'circle-pitch-alignment': 'map',
    },
  });
  map.addLayer({
    id: LAYERS.introCore,
    type: 'circle',
    source: SOURCES.intro,
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['get', 'w'], 0, 1.1, 1, 3.6],
      'circle-color': amber,
      'circle-opacity': ['interpolate', ['linear'], ['get', 'w'], 0, 0.55, 1, 1],
      'circle-blur': 0.35,
      'circle-pitch-alignment': 'map',
    },
  });
}

export function setIntroLayersVisible(map: MLMap, visible: boolean) {
  for (const id of [LAYERS.introGlow, LAYERS.introCore]) {
    if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', visible ? 'visible' : 'none');
  }
}

/** Basemap labels are hidden on the intro globe (it reads as a planet, not an atlas). */
export function setBasemapLabelsVisible(map: MLMap, visible: boolean) {
  for (const layer of map.getStyle().layers) {
    if (layer.type === 'symbol' && !layer.id.startsWith('el-')) {
      map.setLayoutProperty(layer.id, 'visibility', visible ? 'visible' : 'none');
    }
  }
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

/* ------------------------------------------------------------------ area of interest */

export function addSelectionLayers(map: MLMap) {
  if (map.getSource(SOURCES.aoi)) return;
  const amber = token('--el-amber-soft');
  map.addSource(SOURCES.aoi, { type: 'geojson', data: EMPTY });
  const before = firstSymbolLayer(map);
  map.addLayer(
    { id: LAYERS.aoiFill, type: 'fill', source: SOURCES.aoi, paint: { 'fill-color': amber, 'fill-opacity': 0.045 } },
    before,
  );
  map.addLayer({
    id: LAYERS.aoiGlow,
    type: 'line',
    source: SOURCES.aoi,
    paint: { 'line-color': amber, 'line-width': 7, 'line-blur': 6, 'line-opacity': 0.28 },
  });
  map.addLayer({
    id: LAYERS.aoiLine,
    type: 'line',
    source: SOURCES.aoi,
    paint: { 'line-color': amber, 'line-width': 1.5, 'line-dasharray': [3, 2] },
  });
}

export function setSelection(map: MLMap, bbox: BBox | null) {
  const src = map.getSource(SOURCES.aoi) as GeoJSONSource | undefined;
  src?.setData(bbox ? { type: 'FeatureCollection', features: [bboxToPolygon(bbox)] } : EMPTY);
}

import type { ExpressionSpecification, GeoJSONSource, Map as MLMap } from 'maplibre-gl';
import type { Feature, FeatureCollection, MultiPolygon, Point, Polygon } from 'geojson';
import type { BBox, FireProperties, Sensor } from '@/data/types';
import type { FlatPolygons } from '@/domain/area';
import { bboxToPolygon } from '@/lib/geo';
import { rampColors, token, withAlpha } from '@/styles/tokens';
import { CLUSTER, HEX_IMAGE, LAYERS, SOURCES } from './map.config';

const EMPTY: FeatureCollection = { type: 'FeatureCollection', features: [] };

function firstSymbolLayer(map: MLMap): string | undefined {
  return map.getStyle().layers.find((l) => l.type === 'symbol')?.id;
}

/* ------------------------------------------------------------------ fire detections */

/**
 * One hexagon icon, as a signed-distance field, so MapLibre can colour it per sensor (icon-color)
 * and outline it (icon-halo) without extra images. Pointy-top, like every hexagon in the product.
 */
function ensureHexImage(map: MLMap) {
  if (map.hasImage(HEX_IMAGE)) return;
  const size = 64;
  const c = size / 2;
  const inradius = 22;
  const spread = 8; // SDF spread in px (MapLibre convention: the edge sits at alpha 0.75)
  const data = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const px = Math.abs(x + 0.5 - c);
      const py = Math.abs(y + 0.5 - c);
      // Pointy-top hexagon: flat sides left/right, edge normals at 0° and ±60°.
      const d = Math.max(px, px * 0.5 + py * 0.8660254) - inradius;
      const a = Math.max(0, Math.min(255, Math.round(255 * (1 - (d / spread + 0.25)))));
      const k = (y * size + x) * 4;
      data[k] = 255;
      data[k + 1] = 255;
      data[k + 2] = 255;
      data[k + 3] = a;
    }
  }
  map.addImage(HEX_IMAGE, { width: size, height: size, data }, { sdf: true, pixelRatio: 2 });
}

/** Cluster hexagon size grows with √count. */
const clusterSize = (k: number): ExpressionSpecification => [
  'interpolate',
  ['linear'],
  ['sqrt', ['get', 'point_count']],
  1,
  0.42 * k,
  6,
  0.8 * k,
  20,
  1.35 * k,
  45,
  1.9 * k,
];

/** Paint for one sensor's layers from the tokens. */
function firePaint(sensor: Sensor) {
  const color = token(sensor === 'MODIS' ? '--el-modis' : '--el-viirs');
  const filled = sensor === 'VIIRS';
  // MODIS = outline hexagons (steel), VIIRS = filled hexagons (amber): shape + colour.
  return {
    cluster: {
      'icon-color': filled ? withAlpha(color, 0.78) : withAlpha(color, 0),
      'icon-halo-color': filled ? withAlpha(token('--el-bg'), 0.6) : color,
      'icon-halo-width': filled ? 0.6 : 1.3,
    },
    point: {
      'icon-color': filled ? color : withAlpha(color, 0),
      'icon-halo-color': filled ? withAlpha(token('--el-bg'), 0.7) : color,
      'icon-halo-width': filled ? 0.4 : 1.1,
    },
  };
}

export function addFireLayers(map: MLMap) {
  ensureHexImage(map);
  const before = firstSymbolLayer(map);
  const order: Sensor[] = ['VIIRS', 'MODIS']; // MODIS outlines on top of VIIRS fills
  for (const sensor of order) {
    const src = SOURCES[sensor];
    if (map.getSource(src)) continue;
    const ids = LAYERS[sensor];
    const paint = firePaint(sensor);
    map.addSource(src, {
      type: 'geojson',
      data: EMPTY,
      cluster: true,
      clusterRadius: CLUSTER.radius,
      clusterMaxZoom: CLUSTER.maxZoom,
      clusterProperties: { frp: ['+', ['coalesce', ['get', 'frp'], 0]] },
    });
    map.addLayer(
      {
        id: ids.cluster,
        type: 'symbol',
        source: src,
        filter: ['has', 'point_count'],
        layout: {
          'icon-image': HEX_IMAGE,
          'icon-size': clusterSize(sensor === 'MODIS' ? 1.08 : 1),
          'icon-allow-overlap': true,
          'icon-ignore-placement': true,
        },
        paint: paint.cluster,
      },
      before,
    );
    map.addLayer(
      {
        id: ids.point,
        type: 'symbol',
        source: src,
        filter: ['!', ['has', 'point_count']],
        layout: {
          'icon-image': HEX_IMAGE,
          'icon-size': ['interpolate', ['linear'], ['zoom'], 3, 0.24, 7, 0.34, 11, 0.5],
          'icon-allow-overlap': true,
          'icon-ignore-placement': true,
        },
        paint: paint.point,
      },
      before,
    );
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

/** Heat ramp for H3 cells: embers for a few burning days, amber for the hottest cells. */
function hexPaint() {
  const ramp = rampColors();
  return {
    'fill-color': ['interpolate', ['linear'], ['get', 'v'], 0, ramp[2]!, 0.25, ramp[3]!, 0.5, ramp[4]!, 0.75, ramp[5]!, 1, ramp[6]!] as ExpressionSpecification,
    'fill-opacity': ['interpolate', ['linear'], ['get', 'v'], 0, 0.62, 1, 0.96] as ExpressionSpecification,
  };
}

/**
 * Burning hexagons. Cells arrive already shrunk towards their centres (see hexFeatures), so the gaps
 * between them are real geometry — crisp at every zoom, no outline layer needed.
 */
export function addHexLayers(map: MLMap) {
  if (map.getSource(SOURCES.hex)) return;
  map.addSource(SOURCES.hex, { type: 'geojson', data: EMPTY });
  map.addLayer(
    { id: LAYERS.hexFill, type: 'fill', source: SOURCES.hex, layout: { visibility: 'none' }, paint: hexPaint() },
    firstSymbolLayer(map),
  );
}

export function setHexData(map: MLMap, fc: FeatureCollection<Polygon, HexProperties>) {
  (map.getSource(SOURCES.hex) as GeoJSONSource | undefined)?.setData(fc);
}

export function setHexVisible(map: MLMap, visible: boolean) {
  for (const id of [LAYERS.hexFill]) {
    if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', visible ? 'visible' : 'none');
  }
}

/* ------------------------------------------------------------------ live hot spots (NASA FIRMS, last 24 h) */

/** Properties of a live feature: detections, FRP and hours since the latest one. */
export interface LiveProperties {
  n: number;
  frp: number;
  age: number;
}

/** Fresh = brightest: < 3 h amber, < 12 h orange, older embers. */
function liveColor(): ExpressionSpecification {
  const ramp = rampColors();
  return ['step', ['get', 'age'], ramp[6]!, 3, ramp[5]!, 12, ramp[3]!];
}

/**
 * Real-time layer on top of the archive: the world's last 24 h on a 0.5° grid (soft glow sized by detections,
 * a small hexagon at the centre) and every single hot spot over Central Asia. Labels stay above.
 */
export function addLiveLayers(map: MLMap) {
  if (map.getSource(SOURCES.liveCells)) return;
  ensureHexImage(map);
  const before = firstSymbolLayer(map);
  const color = liveColor();
  map.addSource(SOURCES.liveCells, { type: 'geojson', data: EMPTY });
  map.addSource(SOURCES.livePoints, { type: 'geojson', data: EMPTY });
  map.addLayer(
    {
      id: LAYERS.liveCellGlow,
      type: 'circle',
      source: SOURCES.liveCells,
      paint: {
        'circle-color': color,
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 1, ['+', 1.5, ['*', 0.7, ['sqrt', ['get', 'n']]]], 4, ['+', 3, ['*', 1.3, ['sqrt', ['get', 'n']]]], 8, ['+', 18, ['*', 2.5, ['sqrt', ['get', 'n']]]]],
        'circle-blur': 1,
        'circle-opacity': ['step', ['get', 'age'], 0.55, 3, 0.4, 12, 0.25],
      },
    },
    before,
  );
  map.addLayer(
    {
      id: LAYERS.liveCellCore,
      type: 'symbol',
      source: SOURCES.liveCells,
      layout: {
        'icon-image': HEX_IMAGE,
        'icon-size': ['interpolate', ['linear'], ['zoom'], 1, 0.12, 4, 0.17, 8, 0.24],
        'icon-allow-overlap': true,
        'icon-ignore-placement': true,
      },
      paint: { 'icon-color': color },
    },
    before,
  );
  map.addLayer(
    {
      id: LAYERS.livePointGlow,
      type: 'circle',
      source: SOURCES.livePoints,
      filter: ['<', ['get', 'age'], 6],
      paint: {
        'circle-color': color,
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 2, 2.5, 6, 6, 10, 12],
        'circle-blur': 1,
        'circle-opacity': 0.5,
      },
    },
    before,
  );
  map.addLayer(
    {
      id: LAYERS.livePointCore,
      type: 'symbol',
      source: SOURCES.livePoints,
      layout: {
        'icon-image': HEX_IMAGE,
        'icon-size': ['interpolate', ['linear'], ['zoom'], 2, 0.1, 6, 0.18, 10, 0.32],
        'icon-allow-overlap': true,
        'icon-ignore-placement': true,
      },
      paint: { 'icon-color': color },
    },
    before,
  );
}

export function setLiveData(map: MLMap, cells: FeatureCollection<Point, LiveProperties>, points: FeatureCollection<Point, LiveProperties>) {
  (map.getSource(SOURCES.liveCells) as GeoJSONSource | undefined)?.setData(cells);
  (map.getSource(SOURCES.livePoints) as GeoJSONSource | undefined)?.setData(points);
}

export function setLiveVisible(map: MLMap, visible: boolean) {
  for (const id of [LAYERS.liveCellGlow, LAYERS.liveCellCore, LAYERS.livePointGlow, LAYERS.livePointCore]) {
    if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', visible ? 'visible' : 'none');
  }
}

/* ------------------------------------------------------------------ area of interest */

function selectionPaint() {
  const accent = token('--el-orange');
  return {
    fill: { 'fill-color': accent, 'fill-opacity': 0.045 },
    line: { 'line-color': accent, 'line-width': 1.4, 'line-opacity': 0.95 },
  };
}

export function addSelectionLayers(map: MLMap) {
  if (map.getSource(SOURCES.aoi)) return;
  const paint = selectionPaint();
  map.addSource(SOURCES.aoi, { type: 'geojson', data: EMPTY });
  map.addLayer({ id: LAYERS.aoiFill, type: 'fill', source: SOURCES.aoi, paint: paint.fill }, firstSymbolLayer(map));
  map.addLayer({ id: LAYERS.aoiLine, type: 'line', source: SOURCES.aoi, paint: paint.line });
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

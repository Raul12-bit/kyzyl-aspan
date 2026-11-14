import type { Feature, FeatureCollection, LineString, Point, Polygon } from 'geojson';
import type { GeoJSONSource, Map as MLMap } from 'maplibre-gl';
import { hexRing } from '@/domain/hexgrid';
import { LAYERS } from '@/features/map/map.config';
import { rampColors, token, withAlpha } from '@/styles/tokens';
import type { AlertRow, BlindRow, RiskRow, SatellitesResponse, StaticRow } from './api';
import type { HeliosLayer } from './heliosStore';

/** Source/layer ids start with "el-" so MapStage treats their errors as data errors, not basemap failures. */
export const H_SOURCES = {
  risk: 'el-helios-risk',
  blind: 'el-helios-blind',
  spread: 'el-helios-spread',
  static: 'el-helios-static',
  alerts: 'el-helios-alerts',
  sats: 'el-helios-sats',
  tracks: 'el-helios-tracks',
} as const;

export const H_LAYERS = {
  riskFill: 'el-helios-risk-fill',
  riskLine: 'el-helios-risk-line',
  riskBurned: 'el-helios-risk-burned',
  blindFill: 'el-helios-blind-fill',
  blindLine: 'el-helios-blind-line',
  spreadFill: 'el-helios-spread-fill',
  spreadLine: 'el-helios-spread-line',
  staticPoint: 'el-helios-static-point',
  alertsHalo: 'el-helios-alerts-halo',
  alertsPoint: 'el-helios-alerts-point',
  tracks: 'el-helios-tracks',
  satsPoint: 'el-helios-sats-point',
  satsLabel: 'el-helios-sats-label',
} as const;

const GROUPS: Record<HeliosLayer, string[]> = {
  risk: [H_LAYERS.riskFill, H_LAYERS.riskLine, H_LAYERS.riskBurned],
  blind: [H_LAYERS.blindFill, H_LAYERS.blindLine],
  spread: [H_LAYERS.spreadFill, H_LAYERS.spreadLine],
  static: [H_LAYERS.staticPoint],
  alerts: [H_LAYERS.alertsHalo, H_LAYERS.alertsPoint],
  satellites: [H_LAYERS.tracks, H_LAYERS.satsPoint, H_LAYERS.satsLabel],
};

/** Hover/click targets, top-most first. */
export const HELIOS_INTERACTIVE = [
  H_LAYERS.satsPoint,
  H_LAYERS.alertsPoint,
  H_LAYERS.staticPoint,
  H_LAYERS.blindFill,
  H_LAYERS.riskFill,
];

const HATCH = 'el-helios-hatch';
const EMPTY: FeatureCollection = { type: 'FeatureCollection', features: [] };

export const PRIORITY_COLOR = {
  CRITICAL: () => token('--el-kyzyl'),
  HIGH: () => token('--el-orange'),
  ROUTINE: () => token('--el-amber'),
} as const;

export const STATIC_COLOR = '#b9c6e4';
export const BURNED_COLOR = '#f4fff9';

function ensureHatch(map: MLMap) {
  if (map.hasImage(HATCH)) return;
  const size = 12;
  const data = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const on = (x + y) % size < 2; // diagonal stripes
      const i = (y * size + x) * 4;
      data[i] = 170;
      data[i + 1] = 182;
      data[i + 2] = 206;
      data[i + 3] = on ? 150 : 0;
    }
  }
  map.addImage(HATCH, { width: size, height: size, data }, { pixelRatio: 2 });
}

/** Adds every HELIOS source and layer once (hidden); polygons go under the fire points, markers above. */
export function addHeliosLayers(map: MLMap) {
  if (map.getSource(H_SOURCES.risk)) return;
  ensureHatch(map);
  const ramp = rampColors();
  // Polygons sit above the burning-hexagon fill and below the detection marks.
  const below = map.getLayer(LAYERS.VIIRS.cluster) ? LAYERS.VIIRS.cluster : undefined;
  const hidden = { visibility: 'none' as const };
  for (const id of Object.values(H_SOURCES)) map.addSource(id, { type: 'geojson', data: EMPTY });

  map.addLayer(
    {
      id: H_LAYERS.riskFill,
      type: 'fill',
      source: H_SOURCES.risk,
      layout: hidden,
      paint: {
        'fill-color': [
          'interpolate',
          ['linear'],
          ['get', 'p'],
          0,
          ramp[1]!,
          0.02,
          ramp[2]!,
          0.08,
          ramp[3]!,
          0.2,
          ramp[4]!,
          0.4,
          ramp[5]!,
          0.7,
          ramp[6]!,
        ],
        'fill-opacity': ['interpolate', ['linear'], ['get', 'p'], 0, 0.18, 0.05, 0.42, 0.3, 0.72],
      },
    },
    below,
  );
  map.addLayer(
    {
      id: H_LAYERS.riskLine,
      type: 'line',
      source: H_SOURCES.risk,
      layout: hidden,
      paint: {
        'line-color': withAlpha(token('--el-bg'), 0.85),
        'line-width': ['interpolate', ['linear'], ['zoom'], 3, 0.2, 8, 0.9],
      },
    },
    below,
  );
  map.addLayer(
    {
      id: H_LAYERS.riskBurned,
      type: 'line',
      source: H_SOURCES.risk,
      layout: hidden,
      filter: ['==', ['get', 'actual'], 1],
      paint: {
        'line-color': BURNED_COLOR,
        'line-width': ['interpolate', ['linear'], ['zoom'], 3, 1, 8, 2.2],
        'line-opacity': 0.9,
      },
    },
    below,
  );
  map.addLayer(
    {
      id: H_LAYERS.blindFill,
      type: 'fill',
      source: H_SOURCES.blind,
      layout: hidden,
      paint: { 'fill-pattern': HATCH, 'fill-opacity': ['case', ['==', ['get', 'flag'], 1], 0.95, 0.4] },
    },
    below,
  );
  map.addLayer(
    {
      id: H_LAYERS.blindLine,
      type: 'line',
      source: H_SOURCES.blind,
      layout: hidden,
      filter: ['==', ['get', 'flag'], 1],
      paint: { 'line-color': '#c9d4ec', 'line-width': 1.2, 'line-dasharray': [2, 2] },
    },
    below,
  );
  map.addLayer(
    {
      id: H_LAYERS.spreadFill,
      type: 'fill',
      source: H_SOURCES.spread,
      layout: hidden,
      paint: {
        'fill-color': token('--el-orange'),
        'fill-opacity': ['match', ['get', 'horizon'], '6h', 0.34, '12h', 0.2, 0.1],
      },
    },
    below,
  );
  map.addLayer(
    {
      id: H_LAYERS.spreadLine,
      type: 'line',
      source: H_SOURCES.spread,
      layout: hidden,
      paint: {
        'line-color': token('--el-amber-soft'),
        'line-width': 1,
        'line-dasharray': [3, 2],
        'line-opacity': 0.8,
      },
    },
    below,
  );

  // Markers on top of the fire layers.
  map.addLayer({
    id: H_LAYERS.staticPoint,
    type: 'circle',
    source: H_SOURCES.static,
    layout: hidden,
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 3, 2.6, 8, 5.5],
      'circle-color': STATIC_COLOR,
      'circle-stroke-color': token('--el-bg'),
      'circle-stroke-width': 1,
      'circle-opacity': 0.9,
    },
  });
  const prio: [string, string][] = [
    ['CRITICAL', PRIORITY_COLOR.CRITICAL()],
    ['HIGH', PRIORITY_COLOR.HIGH()],
  ];
  const prioColor = [
    'match',
    ['get', 'priority'],
    ...prio.flat(),
    PRIORITY_COLOR.ROUTINE(),
  ] as unknown as string;
  map.addLayer({
    id: H_LAYERS.alertsHalo,
    type: 'circle',
    source: H_SOURCES.alerts,
    layout: hidden,
    paint: {
      'circle-radius': ['+', 9, ['*', 22, ['get', 'pe']]],
      'circle-color': prioColor,
      'circle-opacity': 0.22,
      'circle-blur': 0.85,
    },
  });
  map.addLayer({
    id: H_LAYERS.alertsPoint,
    type: 'circle',
    source: H_SOURCES.alerts,
    layout: hidden,
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 3, 3.5, 8, 6.5],
      'circle-color': prioColor,
      'circle-stroke-color': '#fff6e8',
      'circle-stroke-width': 1.4,
    },
  });
  map.addLayer({
    id: H_LAYERS.tracks,
    type: 'line',
    source: H_SOURCES.tracks,
    layout: { ...hidden, 'line-cap': 'round' },
    paint: { 'line-color': 'rgba(232,236,244,0.45)', 'line-width': 1.2, 'line-dasharray': [1, 2.5] },
  });
  map.addLayer({
    id: H_LAYERS.satsPoint,
    type: 'circle',
    source: H_SOURCES.sats,
    layout: hidden,
    paint: {
      'circle-radius': 5,
      'circle-color': ['match', ['get', 'role'], 'observer', '#e8ecf4', '#7ee6c4'],
      'circle-stroke-color': token('--el-bg'),
      'circle-stroke-width': 1.5,
    },
  });
  try {
    map.addLayer({
      id: H_LAYERS.satsLabel,
      type: 'symbol',
      source: H_SOURCES.sats,
      layout: {
        ...hidden,
        'text-field': ['get', 'name'],
        'text-size': 11,
        'text-offset': [0, 1.2],
        'text-anchor': 'top',
      },
      paint: { 'text-color': '#e8ecf4', 'text-halo-color': token('--el-bg'), 'text-halo-width': 1.4 },
    });
  } catch {
    /* a basemap without glyphs: markers stay, labels are skipped */
  }
}

export function setHeliosVisible(map: MLMap, layer: HeliosLayer, visible: boolean) {
  for (const id of GROUPS[layer])
    if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', visible ? 'visible' : 'none');
}

function setData(map: MLMap, source: string, fc: FeatureCollection) {
  (map.getSource(source) as GeoJSONSource | undefined)?.setData(fc);
}

/* ------------------------------------------------------------------ converters */

export function setRisk(map: MLMap, rows: RiskRow[]) {
  const features: Feature<Polygon>[] = rows.map(([cell, p, clim, actual]) => ({
    type: 'Feature',
    properties: { cell, p, clim, actual },
    geometry: { type: 'Polygon', coordinates: [hexRing(cell)] },
  }));
  setData(map, H_SOURCES.risk, { type: 'FeatureCollection', features });
}

export function setBlind(map: MLMap, rows: BlindRow[]) {
  const features: Feature<Polygon>[] = rows
    .filter(([, score, , , msg]) => score >= 0.02 || msg)
    .map(([cell, score, cloud, expected, msg]) => ({
      type: 'Feature',
      properties: { cell, score, cloud, expected, flag: msg ? 1 : 0 },
      geometry: { type: 'Polygon', coordinates: [hexRing(cell)] },
    }));
  setData(map, H_SOURCES.blind, { type: 'FeatureCollection', features });
}

export function setSpread(map: MLMap, fc: FeatureCollection) {
  setData(map, H_SOURCES.spread, fc);
}

export function setStatic(map: MLMap, rows: StaticRow[]) {
  const features: Feature<Point>[] = rows.map(([lng, lat, score, n, night, first, last]) => ({
    type: 'Feature',
    properties: { score, n, night, first, last },
    geometry: { type: 'Point', coordinates: [lng, lat] },
  }));
  setData(map, H_SOURCES.static, { type: 'FeatureCollection', features });
}

export function setAlerts(map: MLMap, rows: AlertRow[]) {
  // Draw the routine ones first so critical alerts end up on top.
  const order = { ROUTINE: 0, HIGH: 1, CRITICAL: 2 };
  const features: Feature<Point>[] = [...rows]
    .sort((a, b) => order[a[2]] - order[b[2]])
    .map(([lng, lat, priority, pr, pe, frp, pixels, stream, acq]) => ({
      type: 'Feature',
      properties: { priority, pr, pe, frp, pixels, stream, acq },
      geometry: { type: 'Point', coordinates: [lng, lat] },
    }));
  setData(map, H_SOURCES.alerts, { type: 'FeatureCollection', features });
}

/** Splits a ground track where it crosses the antimeridian. */
function trackLines(track: [number, number][]): [number, number][][] {
  const out: [number, number][][] = [];
  let cur: [number, number][] = [];
  for (const p of track) {
    const prev = cur[cur.length - 1];
    if (prev && Math.abs(p[0] - prev[0]) > 180) {
      out.push(cur);
      cur = [];
    }
    cur.push(p);
  }
  if (cur.length > 1) out.push(cur);
  return out;
}

export function setSatellites(map: MLMap, data: SatellitesResponse) {
  const points: Feature<Point>[] = data.satellites.map((s) => ({
    type: 'Feature',
    properties: { name: s.name.replace(' (LCRD)', ''), role: s.role, alt: s.alt_km },
    geometry: { type: 'Point', coordinates: [s.lng, s.lat] },
  }));
  const lines: Feature<LineString>[] = data.satellites.flatMap((s) =>
    trackLines(s.track).map((coords) => ({
      type: 'Feature' as const,
      properties: { name: s.name },
      geometry: { type: 'LineString' as const, coordinates: coords },
    })),
  );
  setData(map, H_SOURCES.sats, { type: 'FeatureCollection', features: points });
  setData(map, H_SOURCES.tracks, { type: 'FeatureCollection', features: lines });
}

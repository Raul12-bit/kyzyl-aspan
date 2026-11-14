import type { MapGeoJSONFeature } from 'maplibre-gl';
import type { BBox } from '@/data/types';
import { W_LAYERS } from './worldLayers';

export type WorldHoverInfo =
  | {
      kind: 'region';
      id: string;
      name: string;
      hexdays: number;
      detections: number;
      density: number | null;
      bbox: BBox;
    }
  | { kind: 'country'; iso2: string; hexdays: number; detections: number; density: number | null }
  | {
      kind: 'foot';
      sensor: 'MODIS' | 'VIIRS';
      satellite: string;
      date: string;
      time: string;
      frp: number;
      confidence: 'low' | 'nominal' | 'high';
      truth: 'fire' | 'static' | 'false-alarm';
      scan: number;
      track: number;
    };

const WORLD_IDS = new Set<string>(Object.values(W_LAYERS));

export function isWorldFeature(f: MapGeoJSONFeature): boolean {
  return WORLD_IDS.has(f.layer.id);
}

/** Region and country polygons let clicks through to selection; footprints behave like points. */
export function isWorldPolygon(f: MapGeoJSONFeature): boolean {
  return f.layer.id === W_LAYERS.regionsFill || f.layer.id === W_LAYERS.countriesFill;
}

export function toWorldInfo(f: MapGeoJSONFeature): WorldHoverInfo | null {
  const p = f.properties as Record<string, unknown>;
  const n = (k: string) => Number(p[k] ?? 0);
  const dens =
    p.density === null || p.density === undefined || p.density === 'null' ? null : Number(p.density);
  if (f.layer.id === W_LAYERS.regionsFill) {
    return {
      kind: 'region',
      id: String(p.id),
      name: String(p.label ?? p.name ?? p.id),
      hexdays: n('hexdays'),
      detections: n('detections'),
      density: dens,
      bbox: [n('bw'), n('bs'), n('be'), n('bn')],
    };
  }
  if (f.layer.id === W_LAYERS.countriesFill) {
    return {
      kind: 'country',
      iso2: String(p.id),
      hexdays: n('hexdays'),
      detections: n('detections'),
      density: dens,
    };
  }
  if (f.layer.id === W_LAYERS.footFill) {
    return {
      kind: 'foot',
      sensor: p.sensor === 'MODIS' ? 'MODIS' : 'VIIRS',
      satellite: String(p.satellite ?? ''),
      date: String(p.date ?? ''),
      time: String(p.time ?? ''),
      frp: n('frp'),
      confidence: (p.confidence as 'low' | 'nominal' | 'high') ?? 'nominal',
      truth: (p.truth as 'fire' | 'static' | 'false-alarm') ?? 'fire',
      scan: n('scan'),
      track: n('track'),
    };
  }
  return null;
}

import type { MapGeoJSONFeature } from 'maplibre-gl';
import { H_LAYERS } from './heliosLayers';

/** What the map tooltip shows for a HELIOS feature (kept apart from the component for fast refresh). */
export type HeliosHoverInfo =
  | { kind: 'risk'; p: number; clim: number; actual: number }
  | {
      kind: 'alert';
      priority: 'CRITICAL' | 'HIGH' | 'ROUTINE';
      pr: number;
      pe: number;
      frp: number;
      pixels: number;
      stream: string;
      acq: string;
    }
  | { kind: 'static'; score: number; n: number; night: number; first: number; last: number }
  | { kind: 'blind'; cloud: number; expected: number; flag: number }
  | { kind: 'sat'; name: string; alt: number };

/** Markers react to clicks (touch has no hover); polygons let clicks through to the country picker. */
export const HELIOS_CLICKABLE: ReadonlySet<string> = new Set([
  H_LAYERS.alertsPoint,
  H_LAYERS.staticPoint,
  H_LAYERS.satsPoint,
]);

export function isHeliosFeature(f: MapGeoJSONFeature): boolean {
  return f.layer.id.startsWith('el-helios-');
}

export function toHeliosInfo(f: MapGeoJSONFeature): HeliosHoverInfo | null {
  const p = f.properties as Record<string, unknown>;
  const n = (k: string) => Number(p[k]);
  switch (f.layer.id) {
    case H_LAYERS.riskFill:
      return { kind: 'risk', p: n('p'), clim: n('clim'), actual: n('actual') };
    case H_LAYERS.alertsPoint:
      return {
        kind: 'alert',
        priority: (p.priority as 'CRITICAL' | 'HIGH' | 'ROUTINE') ?? 'ROUTINE',
        pr: n('pr'),
        pe: n('pe'),
        frp: n('frp'),
        pixels: n('pixels'),
        stream: String(p.stream ?? ''),
        acq: String(p.acq ?? ''),
      };
    case H_LAYERS.staticPoint:
      return {
        kind: 'static',
        score: n('score'),
        n: n('n'),
        night: n('night'),
        first: n('first'),
        last: n('last'),
      };
    case H_LAYERS.blindFill:
      return { kind: 'blind', cloud: n('cloud'), expected: n('expected'), flag: n('flag') };
    case H_LAYERS.satsPoint:
      return { kind: 'sat', name: String(p.name ?? ''), alt: n('alt') };
    default:
      return null;
  }
}

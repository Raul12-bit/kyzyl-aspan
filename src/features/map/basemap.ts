import type { LayerSpecification, Map as MLMap, StyleSpecification } from 'maplibre-gl';
import { token, withAlpha } from '@/styles/tokens';
import { BASEMAP_TIMEOUT_MS } from './map.config';

/** Minimal offline style: page-coloured background only. Data layers still render on top. */
export function fallbackStyle(): StyleSpecification {
  return {
    version: 8,
    name: 'kyzyl-aspan-fallback',
    sources: {},
    layers: [{ id: 'background', type: 'background', paint: { 'background-color': token('--el-land') } }],
  };
}

const HIDE = /(poi|building|housenum|road_label|roadname|highway_name|transit|rail|aeroway|airport|ferry|tunnel|bridge)/i;

/**
 * The paint a third-party basemap layer gets in our theme, or null to drop the layer. Pure function of
 * the layer id/type and the current tokens, so the same rules tint a fresh style and re-tint a live map.
 * Look: quiet land a step above the page, water in the page colour, hairline borders in warm ink.
 */
export function basemapPaint(id: string, type: string, hasText: boolean): Record<string, unknown> | null {
  const key = id.toLowerCase();
  if (HIDE.test(key)) return null;
  const land = token('--el-land');
  const water = token('--el-water');
  const ink = token('--el-ink');
  const dim = token('--el-ink-dim');
  const bg = token('--el-bg');
  switch (type) {
    case 'background':
      return { 'background-color': land };
    case 'fill':
      if (key.includes('water')) return { 'fill-color': water };
      if (/landcover|landuse|park|wood|grass|ice|glacier|sand/.test(key)) return { 'fill-color': withAlpha(ink, 0.012) };
      return { 'fill-color': land };
    case 'line':
      if (/boundary|admin|border/.test(key)) {
        const country = /country|admin_0|admin0|level_2|boundary_country/.test(key);
        return { 'line-color': withAlpha(ink, country ? 0.2 : 0.07) };
      }
      if (/water|river|stream/.test(key)) return { 'line-color': water };
      if (/road|street|highway|path|motorway|trunk|primary|secondary|tertiary|minor|service|track/.test(key)) {
        return { 'line-color': withAlpha(ink, 0.035) };
      }
      return { 'line-color': withAlpha(ink, 0.05) };
    case 'symbol': {
      if (!hasText) return null;
      const major = /country|continent|state|place_city|city|capital|ocean|sea|lake/.test(key);
      if (!major) return null;
      return {
        'text-color': /ocean|sea|lake/.test(key) ? withAlpha(dim, 0.6) : dim,
        'text-halo-color': withAlpha(bg, 0.85),
        'text-halo-width': 1.2,
      };
    }
    default:
      return {};
  }
}

/** Re-tints a third-party style to our tokens and drops the layers we never show (POIs, roads labels…). */
export function tintStyle(style: StyleSpecification): StyleSpecification {
  const layers: LayerSpecification[] = [];
  for (const layer of style.layers) {
    const l = { ...layer, paint: { ...(layer as { paint?: object }).paint }, layout: { ...(layer as { layout?: object }).layout } } as LayerSpecification & {
      paint: Record<string, unknown>;
      layout: Record<string, unknown>;
    };
    const paint = basemapPaint(l.id, l.type, l.layout['text-field'] !== undefined);
    if (paint === null) continue;
    Object.assign(l.paint, paint);
    delete l.paint['fill-pattern'];
    delete l.paint['line-pattern'];
    if (l.type === 'symbol') delete l.layout['icon-image'];
    layers.push(l);
  }
  return { ...style, layers };
}

/** Theme switch on a live map: repaint every basemap layer (our own `el-*` layers repaint themselves). */
export function retintBasemap(map: MLMap) {
  for (const layer of map.getStyle().layers) {
    if (layer.id.startsWith('el-')) continue;
    const hasText = layer.type === 'symbol' && map.getLayoutProperty(layer.id, 'text-field') !== undefined;
    const paint = basemapPaint(layer.id, layer.type, hasText);
    if (!paint) continue;
    for (const [prop, value] of Object.entries(paint)) map.setPaintProperty(layer.id, prop, value);
  }
}

export async function loadBasemapStyle(url: string): Promise<{ style: StyleSpecification; ok: boolean }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), BASEMAP_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`Basemap style HTTP ${res.status}`);
    const style = (await res.json()) as StyleSpecification;
    if (!style || style.version !== 8 || !Array.isArray(style.layers)) throw new Error('Invalid basemap style');
    return { style: tintStyle(style), ok: true };
  } catch (err) {
    console.warn('[kyzyl-aspan] basemap unavailable, using fallback style:', err);
    return { style: fallbackStyle(), ok: false };
  } finally {
    clearTimeout(timer);
  }
}

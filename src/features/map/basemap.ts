import type { LayerSpecification, StyleSpecification } from 'maplibre-gl';
import { token, withAlpha } from '@/styles/tokens';
import { BASEMAP_TIMEOUT_MS } from './map.config';

/** Minimal offline style: page-coloured background only. Data layers still render on top. */
export function fallbackStyle(): StyleSpecification {
  return {
    version: 8,
    name: 'emberline-fallback',
    sources: {},
    layers: [{ id: 'background', type: 'background', paint: { 'background-color': token('--el-land') } }],
  };
}

const HIDE = /(poi|building|housenum|road_label|roadname|highway_name|transit|rail|aeroway|airport|ferry|tunnel|bridge)/i;

/**
 * Re-tints a third-party dark style to Emberline tokens so the basemap reads as part of the product:
 * deep-space water, ink-blue land, faint borders, quiet labels, no POIs.
 */
export function tintStyle(style: StyleSpecification): StyleSpecification {
  const land = token('--el-land');
  const water = token('--el-water');
  const ink = token('--el-ink-dim');
  const bg = token('--el-bg');
  const layers: LayerSpecification[] = [];
  for (const layer of style.layers) {
    const id = layer.id.toLowerCase();
    if (HIDE.test(id)) continue;
    const l = { ...layer, paint: { ...(layer as { paint?: object }).paint }, layout: { ...(layer as { layout?: object }).layout } } as LayerSpecification & {
      paint: Record<string, unknown>;
      layout: Record<string, unknown>;
    };
    switch (l.type) {
      case 'background':
        l.paint['background-color'] = land;
        break;
      case 'fill':
        if (id.includes('water')) l.paint['fill-color'] = water;
        else if (/landcover|landuse|park|wood|grass|ice|glacier|sand/.test(id)) {
          l.paint['fill-color'] = withAlpha('#ffffff', 0.012);
        } else l.paint['fill-color'] = land;
        delete l.paint['fill-pattern'];
        break;
      case 'line':
        if (/boundary|admin|border/.test(id)) {
          const country = /country|admin_0|admin0|level_2|boundary_country/.test(id);
          l.paint['line-color'] = country ? 'rgba(160,180,220,0.34)' : 'rgba(160,180,220,0.14)';
        } else if (/water|river|stream/.test(id)) {
          l.paint['line-color'] = withAlpha(water, 1);
        } else if (/road|street|highway|path|motorway|trunk|primary|secondary|tertiary|minor|service|track/.test(id)) {
          l.paint['line-color'] = 'rgba(160,180,220,0.06)';
        } else {
          l.paint['line-color'] = 'rgba(160,180,220,0.08)';
        }
        delete l.paint['line-pattern'];
        break;
      case 'symbol':
        if ('text-field' in l.layout || l.layout['text-field'] !== undefined) {
          const major = /country|continent|state|place_city|city|capital|ocean|sea|lake/.test(id);
          if (!major) continue;
          l.paint['text-color'] = /ocean|sea|lake/.test(id) ? 'rgba(125,136,156,0.55)' : ink;
          l.paint['text-halo-color'] = withAlpha(bg, 0.85);
          l.paint['text-halo-width'] = 1.2;
          delete l.layout['icon-image'];
        } else continue;
        break;
      default:
        break;
    }
    layers.push(l);
  }
  return { ...style, layers };
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
    console.warn('[emberline] basemap unavailable, using fallback style:', err);
    return { style: fallbackStyle(), ok: false };
  } finally {
    clearTimeout(timer);
  }
}

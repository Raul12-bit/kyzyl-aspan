import type { Point } from 'geojson';
import type { GeoJSONSource, MapGeoJSONFeature, MapMouseEvent } from 'maplibre-gl';
import { useEffect, useRef, useState } from 'react';
import type { Confidence, Sensor } from '@/data/types';
import { prefersReducedMotion } from '@/features/intro/introStore';
import { LOCALE_INFO, useI18n } from '@/i18n';
import { SensorMark } from '@/ui';
import { interactiveFireLayers } from './layers';
import { LAYERS, SOURCES } from './map.config';
import { useMapStore } from './mapStore';

type HoverInfo =
  | {
      kind: 'point';
      x: number;
      y: number;
      sensor: Sensor;
      cluster: number | null;
      date?: string;
      frp?: number;
      confidence?: Confidence;
      flag?: 'low' | 'static';
    }
  | { kind: 'hex'; x: number; y: number; days: number; modis: number; viirs: number; frpMax: number };

function toInfo(f: MapGeoJSONFeature, x: number, y: number): HoverInfo {
  const p = f.properties as Record<string, unknown>;
  if (f.source === SOURCES.hex) {
    return { kind: 'hex', x, y, days: Number(p.days), modis: Number(p.modis), viirs: Number(p.viirs), frpMax: Number(p.frpMax) };
  }
  const sensor: Sensor = f.source === SOURCES.MODIS ? 'MODIS' : 'VIIRS';
  if (p.cluster) return { kind: 'point', x, y, sensor, cluster: Number(p.point_count) };
  return {
    kind: 'point',
    x,
    y,
    sensor,
    cluster: null,
    date: String(p.date),
    frp: Number(p.frp),
    confidence: p.confidence as Confidence,
    flag: p.flag === 'low' || p.flag === 'static' ? p.flag : undefined,
  };
}

/**
 * Hover (and tap) details for detections and hexagons, click-to-zoom for aggregates, and
 * click-anywhere-else to select the country under the pointer.
 */
export function MapHover({ onPickCountry }: { onPickCountry?: (lng: number, lat: number) => void }) {
  const { m, fmt, locale } = useI18n();
  const map = useMapStore((s) => s.map);
  const mapMode = useMapStore((s) => s.mapMode);
  const [info, setInfo] = useState<HoverInfo | null>(null);
  const pickRef = useRef(onPickCountry);
  pickRef.current = onPickCountry;

  useEffect(() => {
    if (!map || !mapMode) return;
    const canvas = map.getCanvas();
    const visible = (id: string) => map.getLayer(id) && map.getLayoutProperty(id, 'visibility') !== 'none';
    const pick = (e: MapMouseEvent) => {
      const layers = [...interactiveFireLayers(), LAYERS.hexFill].filter(visible);
      if (!layers.length) return undefined;
      return map.queryRenderedFeatures(e.point, { layers })[0];
    };
    const onMove = (e: MapMouseEvent) => {
      if (useMapStore.getState().drawing) {
        setInfo(null);
        return;
      }
      const f = pick(e);
      canvas.style.cursor = f && f.source !== SOURCES.hex ? 'pointer' : '';
      setInfo(f ? toInfo(f, e.point.x, e.point.y) : null);
    };
    const onLeave = () => {
      setInfo(null);
      if (!useMapStore.getState().drawing) canvas.style.cursor = '';
    };
    const onClick = (e: MapMouseEvent) => {
      if (useMapStore.getState().drawing) return;
      const f = pick(e);
      const p = (f?.properties ?? {}) as Record<string, unknown>;
      if (f && p.cluster) {
        const source = map.getSource(f.source) as GeoJSONSource;
        void source.getClusterExpansionZoom(Number(p.cluster_id)).then((zoom) => {
          const coords = (f.geometry as Point).coordinates as [number, number];
          map.easeTo({ center: coords, zoom: zoom + 0.3, duration: prefersReducedMotion() ? 0 : 600 });
        });
        return;
      }
      if (f && f.source !== SOURCES.hex) {
        setInfo(toInfo(f, e.point.x, e.point.y)); // touch devices have no hover
        return;
      }
      pickRef.current?.(e.lngLat.wrap().lng, e.lngLat.lat);
    };
    map.on('mousemove', onMove);
    map.on('mouseout', onLeave);
    map.on('click', onClick);
    map.on('movestart', onLeave);
    return () => {
      map.off('mousemove', onMove);
      map.off('mouseout', onLeave);
      map.off('click', onClick);
      map.off('movestart', onLeave);
    };
  }, [map, mapMode]);

  if (!info) return null;
  const left = Math.min(info.x + 14, window.innerWidth - 250);
  const style = { left, top: info.y + 14, borderRadius: 12, zIndex: 'var(--el-z-popover)' as unknown as number };

  if (info.kind === 'hex') {
    return (
      <div role="status" className="glass pointer-events-none fixed min-w-[190px] px-3.5 py-2.5 text-[13px]" style={style}>
        <div className="flex items-center gap-2 font-medium text-ink">
          <span aria-hidden className="h-3 w-3" style={{ background: 'var(--el-ramp-4)', clipPath: 'polygon(25% 5%,75% 5%,100% 50%,75% 95%,25% 95%,0 50%)' }} />
          H3 · {m.map.tooltip.hexDays}: <span className="num">{fmt.int(info.days)}</span>
        </div>
        <dl className="m-0 mt-1.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[12px]">
          <dt className="text-ink-dim">{m.map.tooltip.hexModis}</dt>
          <dd className="num m-0 text-modis">{fmt.int(info.modis)}</dd>
          <dt className="text-ink-dim">{m.map.tooltip.hexViirs}</dt>
          <dd className="num m-0 text-viirs">{fmt.int(info.viirs)}</dd>
          <dt className="text-ink-dim">{m.map.tooltip.frpMax}</dt>
          <dd className="num m-0 text-ink-muted">{fmt.dec(info.frpMax, 1)} MW</dd>
        </dl>
        <p className="m-0 mt-1.5 text-[11.5px] text-ink-dim">{m.map.tooltip.clickCountry}</p>
      </div>
    );
  }

  const dateText = info.date
    ? new Intl.DateTimeFormat(LOCALE_INFO[locale].tag, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(
        new Date(`${info.date}T00:00:00Z`),
      )
    : '';
  return (
    <div role="status" className="glass pointer-events-none fixed min-w-[180px] px-3.5 py-2.5 text-[13px]" style={style}>
      <div className="flex items-center gap-2 font-medium text-ink">
        <SensorMark kind={info.sensor} size={9} />
        {info.cluster !== null ? m.map.tooltip.group(fmt.int(info.cluster)) : `${info.sensor} · ${dateText}`}
      </div>
      {info.cluster !== null ? (
        <p className="m-0 mt-1 text-[12px] text-ink-dim">{m.map.tooltip.zoomHint}</p>
      ) : (
        <>
          <dl className="m-0 mt-1.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[12px]">
            <dt className="text-ink-dim">{m.map.tooltip.frp}</dt>
            <dd className="num m-0 text-ink-muted">{fmt.dec(info.frp ?? 0, 1)} MW</dd>
            <dt className="text-ink-dim">{m.map.tooltip.confidence}</dt>
            <dd className="m-0 text-ink-muted">{m.map.tooltip.conf[info.confidence ?? 'nominal']}</dd>
          </dl>
          {info.flag ? (
            <p className="m-0 mt-1.5 text-[11.5px] text-trust-low">
              {info.flag === 'static' ? m.map.noise.static : m.map.noise.lowConf}
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}

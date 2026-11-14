import type { Point } from 'geojson';
import type { GeoJSONSource, MapGeoJSONFeature, MapMouseEvent } from 'maplibre-gl';
import { useEffect, useState } from 'react';
import type { Confidence, Sensor } from '@/data/types';
import { prefersReducedMotion } from '@/features/intro/introStore';
import { useI18n } from '@/i18n';
import { SensorMark } from '@/ui';
import { interactiveFireLayers } from './layers';
import { SOURCES } from './map.config';
import { useMapStore } from './mapStore';

interface HoverInfo {
  x: number;
  y: number;
  sensor: Sensor;
  cluster: number | null;
  date?: string;
  frp?: number;
  confidence?: Confidence;
}

function toInfo(f: MapGeoJSONFeature, x: number, y: number): HoverInfo {
  const sensor: Sensor = f.source === SOURCES.MODIS ? 'MODIS' : 'VIIRS';
  const p = f.properties as Record<string, unknown>;
  if (p.cluster) return { x, y, sensor, cluster: Number(p.point_count) };
  return { x, y, sensor, cluster: null, date: String(p.date), frp: Number(p.frp), confidence: p.confidence as Confidence };
}

/** Hover (and tap) details for detections, click-to-zoom for aggregates. */
export function MapHover() {
  const { m, fmt, locale } = useI18n();
  const map = useMapStore((s) => s.map);
  const mapMode = useMapStore((s) => s.mapMode);
  const [info, setInfo] = useState<HoverInfo | null>(null);

  useEffect(() => {
    if (!map || !mapMode) return;
    const canvas = map.getCanvas();
    const pick = (e: MapMouseEvent) => {
      const layers = interactiveFireLayers().filter((id) => map.getLayer(id) && map.getLayoutProperty(id, 'visibility') !== 'none');
      if (!layers.length) return undefined;
      return map.queryRenderedFeatures(e.point, { layers })[0];
    };
    const onMove = (e: MapMouseEvent) => {
      if (useMapStore.getState().drawing) {
        setInfo(null);
        return;
      }
      const f = pick(e);
      canvas.style.cursor = f ? 'pointer' : '';
      setInfo(f ? toInfo(f, e.point.x, e.point.y) : null);
    };
    const onLeave = () => {
      setInfo(null);
      if (!useMapStore.getState().drawing) canvas.style.cursor = '';
    };
    const onClick = (e: MapMouseEvent) => {
      if (useMapStore.getState().drawing) return;
      const f = pick(e);
      if (!f) {
        setInfo(null);
        return;
      }
      const p = f.properties as Record<string, unknown>;
      if (p.cluster) {
        const source = map.getSource(f.source) as GeoJSONSource;
        void source.getClusterExpansionZoom(Number(p.cluster_id)).then((zoom) => {
          const coords = (f.geometry as Point).coordinates as [number, number];
          map.easeTo({ center: coords, zoom: zoom + 0.3, duration: prefersReducedMotion() ? 0 : 600 });
        });
      } else {
        setInfo(toInfo(f, e.point.x, e.point.y)); // touch devices have no hover
      }
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
  const dateText = info.date
    ? new Intl.DateTimeFormat(locale === 'ru' ? 'ru-RU' : 'en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(
        new Date(`${info.date}T00:00:00Z`),
      )
    : '';
  const left = Math.min(info.x + 14, window.innerWidth - 240);
  return (
    <div
      role="status"
      className="glass pointer-events-none fixed min-w-[180px] px-3.5 py-2.5 text-[13px]"
      style={{ left, top: info.y + 14, borderRadius: 12, zIndex: 'var(--el-z-popover)' as unknown as number }}
    >
      <div className="flex items-center gap-2 font-medium text-ink">
        <SensorMark kind={info.sensor} size={9} />
        {info.cluster !== null ? m.map.tooltip.group(fmt.int(info.cluster)) : `${info.sensor} · ${dateText}`}
      </div>
      {info.cluster !== null ? (
        <p className="m-0 mt-1 text-[12px] text-ink-dim">{m.map.tooltip.zoomHint}</p>
      ) : (
        <dl className="m-0 mt-1.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[12px]">
          <dt className="text-ink-dim">{m.map.tooltip.frp}</dt>
          <dd className="num m-0 text-ink-muted">{fmt.dec(info.frp ?? 0, 1)} MW</dd>
          <dt className="text-ink-dim">{m.map.tooltip.confidence}</dt>
          <dd className="m-0 text-ink-muted">{m.map.tooltip.conf[info.confidence ?? 'nominal']}</dd>
        </dl>
      )}
    </div>
  );
}

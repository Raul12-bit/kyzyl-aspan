import { useEffect, useMemo } from 'react';
import { publishFact } from '@/features/assistant/assistantStore';
import type { FeatureCollection, Point } from 'geojson';
import { CA_BBOX } from '@/domain/live/satellites';
import { feedUpdated, useLiveFires, useNow } from '@/features/live/api';
import { useI18n } from '@/i18n';
import { setLiveData, setLiveVisible, type LiveProperties } from './layers';
import { useMapStore } from './mapStore';

const inCA = (lng: number, lat: number) =>
  lng >= CA_BBOX[0] && lng <= CA_BBOX[2] && lat >= CA_BBOX[1] && lat <= CA_BBOX[3];

/** Live hot spots for the map: world cells outside Central Asia + every Central Asian hot spot, last 24 h. */
function useLiveMapData() {
  const world = useLiveFires('world', 24);
  const ca = useLiveFires('ca', 24);
  const nowMin = Math.floor(useNow(60_000) / 60_000);
  return useMemo(() => {
    const now = nowMin * 60;
    const cells: FeatureCollection<Point, LiveProperties> = { type: 'FeatureCollection', features: [] };
    const points: FeatureCollection<Point, LiveProperties> = { type: 'FeatureCollection', features: [] };
    let count = 0;
    const haveCa = Boolean(ca.data?.rows);
    for (const c of world.data?.cells ?? []) {
      if (haveCa && inCA(c[0], c[1])) continue;
      count += c[2];
      cells.features.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [c[0], c[1]] },
        properties: { n: c[2], frp: c[3], age: Math.max(0, (now - c[5]) / 3600) },
      });
    }
    for (const r of ca.data?.rows ?? []) {
      if (now - r[3] > 24 * 3600) continue;
      count += 1;
      points.features.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [r[0], r[1]] },
        properties: { n: 1, frp: r[4], age: Math.max(0, (now - r[3]) / 3600) },
      });
    }
    const updated = Math.max(feedUpdated(world.data) ?? 0, feedUpdated(ca.data) ?? 0) || null;
    return {
      cells,
      points,
      count,
      updated,
      ready: Boolean(world.data || ca.data),
      error: world.isError && ca.isError,
    };
  }, [world.data, ca.data, world.isError, ca.isError, nowMin]);
}

/** Pushes the live hot spots into the map (refreshed with the feeds every 5 minutes). Renders nothing. */
export function LiveSync() {
  const map = useMapStore((s) => s.map);
  const mapMode = useMapStore((s) => s.mapMode);
  const status = useMapStore((s) => s.status);
  const live = useMapStore((s) => s.live);
  const data = useLiveMapData();
  useEffect(() => {
    if (!map || !mapMode || status !== 'ready') return;
    setLiveVisible(map, live);
    if (live) setLiveData(map, data.cells, data.points);
  }, [map, mapMode, status, live, data]);
  return null;
}

/** "● LIVE · 12 345 · 6 min ago" under the data badge; a click switches the live layer. */
export function LiveChip() {
  const { m, fmt } = useI18n();
  const t = m.map.live;
  const live = useMapStore((s) => s.live);
  const setLive = useMapStore((s) => s.setLive);
  const data = useLiveMapData();
  const nowMs = useNow(30_000);
  const mins = data.updated ? Math.max(0, Math.round((nowMs - data.updated) / 60_000)) : null;
  const fact = data.ready
    ? `Live map layer: ${data.count} NASA FIRMS hot spots worldwide in the last 24 h (MODIS Terra/Aqua, VIIRS NOAA-20/21)${mins !== null ? `, newest file ${mins} min old` : ''}; layer ${live ? 'on' : 'off'}.`
    : null;
  useEffect(() => publishFact('liveMap', fact), [fact]);
  useEffect(() => () => publishFact('liveMap', null), []);
  if (!data.ready) return null;
  return (
    <button
      type="button"
      className="map-live pointer-events-auto"
      aria-pressed={live}
      onClick={() => setLive(!live)}
      title={`${t.title} · ${live ? t.off : t.on}`}
    >
      <span className="map-live__dot" aria-hidden />
      <b>{t.label}</b>
      <span className="num">{t.count(fmt.int(data.count))}</span>
      {mins !== null ? <span className="map-live__age">· {t.updated(fmt.int(mins))}</span> : null}
    </button>
  );
}

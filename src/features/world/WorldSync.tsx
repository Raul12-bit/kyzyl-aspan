import type { Feature, FeatureCollection, MultiPolygon, Point, Polygon } from 'geojson';
import type { Map as MLMap } from 'maplibre-gl';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useAppParams } from '@/app/useAppParams';
import { useThemeStore } from '@/app/theme';
import type { BBox, FireProperties } from '@/data/types';
import { countryAt } from '@/domain/countries';
import { hexRing } from '@/domain/hexgrid';
import { useCountries } from '@/features/geo/countries';
import { useHeliosAvailable } from '@/features/helios/api';
import type { HexProperties } from '@/features/map/layers';
import {
  setFireData,
  setHexData,
  setHexVisible,
  setSelection,
  setSensorVisible,
} from '@/features/map/layers';
import { useMapStore } from '@/features/map/mapStore';
import { useEffectiveRange } from '@/features/map/timeStore';
import { useRegion } from '@/features/map/useRegion';
import { useI18n, type Locale } from '@/i18n';
import { POINTS_ZOOM, REGION_ZOOM, serverResForZoom } from './zoom';
import {
  useHexCells,
  useRegionsGeo,
  useRegionStats,
  useViewportFires,
  type HexResponse,
  type RegionsGeo,
  type WorldFireProperties,
} from './api';
import {
  addWorldLayers,
  flatToMultiPolygon,
  footprints,
  retintWorldLayers,
  setSourceData,
  setWorldVisible,
  shadeRegions,
  toFlatPolygons,
  W_LAYERS,
} from './worldLayers';

const HEX_INSET = 0.86;

function insetRing(ring: [number, number][], k: number): [number, number][] {
  const n = ring.length - 1;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < n; i++) {
    cx += ring[i]![0];
    cy += ring[i]![1];
  }
  cx /= n;
  cy /= n;
  return ring.map(([x, y]) => [cx + (x - cx) * k, cy + (y - cy) * k]);
}

function hexFeatures(data: HexResponse): FeatureCollection<Polygon, HexProperties> {
  const max = Math.max(1, data.maxDays);
  return {
    type: 'FeatureCollection',
    features: data.cells.map(([id, days, modis, viirs, frp]) => ({
      type: 'Feature',
      properties: { id, days, modis, viirs, frpMax: frp, v: Math.sqrt(days / max) },
      geometry: { type: 'Polygon', coordinates: [insetRing(hexRing(id), HEX_INSET)] },
    })),
  };
}

function viewportOf(map: MLMap): { bbox: BBox; zoom: number; center: [number, number] } {
  const zoom = map.getZoom();
  const b = map.getBounds();
  let w = b.getWest();
  let e = b.getEast();
  const pad = (e - w) * 0.15;
  const q = zoom < 4 ? 2 : zoom < 6 ? 0.5 : zoom < 8 ? 0.1 : 0.02;
  const s = Math.max(-85, Math.floor((b.getSouth() - pad) / q) * q);
  const n = Math.min(85, Math.ceil((b.getNorth() + pad) / q) * q);
  if (e - w + 2 * pad >= 340) {
    w = -180;
    e = 180;
  } else {
    w = Math.floor((w - pad) / q) * q;
    e = Math.ceil((e + pad) / q) * q;
    const wrap = (x: number) => ((((x + 180) % 360) + 360) % 360) - 180;
    w = wrap(w);
    e = wrap(e);
  }
  const c = map.getCenter().wrap();
  return { bbox: [round(w), round(s), round(e), round(n)], zoom, center: [c.lng, c.lat] };
}

const round = (x: number) => Math.round(x * 1000) / 1000;

function geomBBox(g: Polygon | MultiPolygon): BBox {
  let w = Infinity;
  let s = Infinity;
  let e = -Infinity;
  let n = -Infinity;
  const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
  for (const p of polys)
    for (const [x, y] of p[0] ?? []) {
      if (x! < w) w = x!;
      if (x! > e) e = x!;
      if (y! < s) s = y!;
      if (y! > n) n = y!;
    }
  return [w, s, e, n];
}

function regionLabel(
  names: RegionsGeo['features'][number]['properties']['names'],
  fallback: string,
  locale: Locale,
): string {
  const key = locale === 'kk' ? 'ru' : locale;
  return (names as Record<string, string | undefined>)[key] ?? names.en ?? fallback;
}

/**
 * Pushes the world data into the map when the HELIOS API is live: server hexagons sized to the zoom,
 * every detection at its real pixel size, and countries / regions shaded by fire activity. The
 * synthetic demo keeps using MapSync's in-browser layers.
 */
export function WorldSync() {
  const available = useHeliosAvailable();
  const { locale } = useI18n();
  const map = useMapStore((s) => s.map);
  const mapMode = useMapStore((s) => s.mapMode);
  const status = useMapStore((s) => s.status);
  const view = useMapStore((s) => s.view);
  const sensors = useMapStore((s) => s.sensors);
  const noise = useMapStore((s) => s.noise);
  const theme = useThemeStore((s) => s.theme);
  const range = useEffectiveRange();
  const { bbox, regionId } = useAppParams();
  const countries = useCountries();
  const region = useRegion(regionId && !/^[A-Z]{2}$/.test(regionId) ? regionId : null);
  const [vp, setVp] = useState<ReturnType<typeof viewportOf> | null>(null);
  const ready = available && map !== null && status === 'ready';

  useEffect(() => {
    if (ready) addWorldLayers(map);
  }, [ready, map]);

  useEffect(() => {
    if (ready) retintWorldLayers(map);
  }, [ready, map, theme]);

  useEffect(() => {
    if (!ready || !mapMode) return;
    const update = () => setVp(viewportOf(map));
    update();
    map.on('moveend', update);
    return () => {
      map.off('moveend', update);
    };
  }, [ready, map, mapMode]);

  const zoom = vp?.zoom ?? 0;
  const pointsMode = ready && view === 'points' && zoom >= POINTS_ZOOM;
  const hexMode = ready && (view === 'hex' || (view === 'points' && zoom < POINTS_ZOOM));
  const regionsMode = ready && view === 'regions';
  const sensorKey = sensors.MODIS && sensors.VIIRS ? 'MV' : sensors.MODIS ? 'M' : sensors.VIIRS ? 'V' : '';
  const anyNoise = noise.lowConfidence || noise.staticSources;
  const res = serverResForZoom(zoom);
  useEffect(() => {
    if (hexMode && useMapStore.getState().hexRes !== res) useMapStore.getState().setHexRes(res);
  }, [hexMode, res]);

  /* ---------------------------------------------------------------- hexagons */
  const hexQ =
    hexMode && vp && sensorKey ? { bbox: vp.bbox, res, range, noise: anyNoise, sensors: sensorKey } : null;
  const hex = useHexCells(hexQ, hexMode);
  useEffect(() => {
    if (!ready) return;
    setHexVisible(map, hexMode && sensorKey !== '');
    if (hexMode && hex.data) setHexData(map, hexFeatures(hex.data));
  }, [ready, map, hexMode, hex.data, sensorKey]);

  /* ---------------------------------------------------------------- single detections */
  const firesQ = pointsMode && vp ? { bbox: vp.bbox, range } : null;
  const fires = useViewportFires(firesQ, pointsMode);
  const shown = useMemo(() => {
    if (!fires.data) return null;
    const keep = fires.data.features.filter((f) => {
      const p = f.properties;
      if (!sensors[p.sensor]) return false;
      if (noise.lowConfidence && p.truth === 'false-alarm') return false;
      if (noise.staticSources && p.truth === 'static') return false;
      return true;
    });
    return { type: 'FeatureCollection', features: keep } as FeatureCollection<Point, WorldFireProperties>;
  }, [fires.data, sensors, noise]);
  useEffect(() => {
    if (!ready) return;
    for (const sensor of ['MODIS', 'VIIRS'] as const)
      setSensorVisible(map, sensor, pointsMode && sensors[sensor]);
    setWorldVisible(map, 'footFill', pointsMode);
    setWorldVisible(map, 'footLine', pointsMode);
    if (!pointsMode || !shown) return;
    for (const sensor of ['MODIS', 'VIIRS'] as const) {
      const fc: FeatureCollection<Point, FireProperties> = {
        type: 'FeatureCollection',
        features: shown.features
          .filter((f) => f.properties.sensor === sensor)
          .map((f) => ({
            ...f,
            properties: {
              id: f.properties.id,
              sensor,
              date: f.properties.date,
              frp: f.properties.frp,
              confidence: f.properties.confidence,
              ...(f.properties.truth === 'static'
                ? { flag: 'static' }
                : f.properties.truth === 'false-alarm'
                  ? { flag: 'low' }
                  : {}),
            } as FireProperties,
          })),
      };
      setFireData(map, sensor, fc);
    }
    setSourceData(map, 'footprints', footprints(shown));
  }, [ready, map, pointsMode, shown, sensors]);

  /* ---------------------------------------------------------------- regions & countries */
  const centerCountry = useMemo(() => {
    if (!vp || zoom < REGION_ZOOM || !countries.data) return null;
    return countryAt(countries.data.countries, vp.center[0], vp.center[1])?.id ?? null;
  }, [vp, zoom, countries.data]);
  const focusIso = regionId && /^[A-Z]{2}$/.test(regionId) ? regionId : (region?.iso2 ?? centerCountry);
  const showRegions = ready && focusIso !== null && (regionsMode || zoom >= REGION_ZOOM);
  const geo = useRegionsGeo(showRegions ? focusIso : null);
  const regionStats = useRegionStats(showRegions ? focusIso : null, range);
  const worldStats = useRegionStats(regionsMode ? 'WORLD' : null, range);

  const regionFc = useMemo(() => {
    if (!geo.data) return null;
    const stats = new Map((regionStats.data?.rows ?? []).map((r) => [r.id, r]));
    const max = regionStats.data?.maxDensity ?? 0;
    const features = geo.data.features.map((f) => {
      const s = stats.get(f.properties.id);
      const v =
        s && s.hexdays > 0
          ? s.density !== null && max > 0
            ? Math.max(0.04, Math.sqrt(s.density / max))
            : 0.04
          : -1;
      const [bw, bs, be, bn] = geomBBox(f.geometry);
      return {
        ...f,
        properties: {
          ...f.properties,
          label: regionLabel(f.properties.names, f.properties.name, locale),
          v,
          hexdays: s?.hexdays ?? 0,
          detections: s?.detections ?? 0,
          density: s?.density ?? null,
          bw,
          bs,
          be,
          bn,
        },
      } as Feature;
    });
    return { type: 'FeatureCollection', features } as FeatureCollection;
  }, [geo.data, regionStats.data, locale]);

  useEffect(() => {
    if (!ready) return;
    setWorldVisible(map, 'regionsFill', showRegions);
    shadeRegions(map, regionsMode);
    setWorldVisible(map, 'regionsLine', showRegions);
    setWorldVisible(map, 'regionsLabel', showRegions);
    if (showRegions && regionFc) setSourceData(map, 'regions', regionFc);
  }, [ready, map, regionsMode, showRegions, regionFc, theme]);

  const countryFc = useMemo(() => {
    if (!regionsMode || !countries.data) return null;
    const stats = new Map((worldStats.data?.rows ?? []).map((r) => [r.id, r]));
    const max = worldStats.data?.maxDensity ?? 0;
    const features = countries.data.countries.map((c) => {
      const s = stats.get(c.id);
      const v =
        s && s.hexdays > 0
          ? s.density !== null && max > 0
            ? Math.max(0.04, Math.sqrt(s.density / max))
            : 0.04
          : -1;
      return {
        type: 'Feature',
        properties: {
          id: c.id,
          v,
          hexdays: s?.hexdays ?? 0,
          detections: s?.detections ?? 0,
          density: s?.density ?? null,
        },
        geometry: flatToMultiPolygon(c.polys),
      } as Feature;
    });
    return { type: 'FeatureCollection', features } as FeatureCollection;
  }, [regionsMode, countries.data, worldStats.data]);

  useEffect(() => {
    if (!ready) return;
    setWorldVisible(map, 'countriesFill', regionsMode);
    setWorldVisible(map, 'countriesLine', regionsMode);
    if (!regionsMode) return;
    if (countryFc) setSourceData(map, 'countries', countryFc);
    const hide = showRegions && focusIso ? (['!=', ['get', 'id'], focusIso] as const) : null;
    if (map.getLayer(W_LAYERS.countriesFill)) map.setFilter(W_LAYERS.countriesFill, hide as never);
  }, [ready, map, regionsMode, countryFc, showRegions, focusIso]);

  /* ---------------------------------------------------------------- selected region outline */
  const selectedIdx = useRef<number | null>(null);
  useEffect(() => {
    if (!ready || !region || !geo.data || !bbox) return;
    const f = geo.data.features.find((x) => x.properties.id === region.id);
    if (!f) return;
    setSelection(map, bbox, toFlatPolygons(f.geometry));
    const src = 'el-world-regions';
    if (selectedIdx.current !== null)
      map.setFeatureState({ source: src, id: selectedIdx.current }, { selected: false });
    map.setFeatureState({ source: src, id: f.properties.idx }, { selected: true });
    selectedIdx.current = f.properties.idx;
  }, [ready, map, region, geo.data, bbox, regionFc]);

  useEffect(() => {
    if (!ready || region || selectedIdx.current === null) return;
    map.setFeatureState({ source: 'el-world-regions', id: selectedIdx.current }, { selected: false });
    selectedIdx.current = null;
  }, [ready, map, region]);

  return null;
}

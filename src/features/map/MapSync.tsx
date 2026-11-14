import { useEffect, useRef } from 'react';
import { useAppParams } from '@/app/useAppParams';
import type { Sensor } from '@/data/types';
import { hideMaskOf, type FireArchive } from '@/domain/archive';
import { resolutionForZoom } from '@/domain/hexgrid';
import { findCountry, useCountries } from '@/features/geo/countries';
import { setFireData, setHexData, setHexVisible, setSelection, setSensorVisible } from './layers';
import { useMapStore } from './mapStore';
import { useEffectiveRange } from './timeStore';
import { hexFeatures, sliceRange, type FireIndex } from './useFireData';

const SENSORS: Sensor[] = ['MODIS', 'VIIRS'];

/**
 * Pushes React state into the map: filtered detections or burning hexagons, layer visibility and
 * the selected area outline. Renders nothing. Updates are coalesced into one per animation frame.
 */
export function MapSync({ index, archive }: { index: FireIndex | null; archive: FireArchive | null }) {
  const map = useMapStore((s) => s.map);
  const mapMode = useMapStore((s) => s.mapMode);
  const sensors = useMapStore((s) => s.sensors);
  const view = useMapStore((s) => s.view);
  const noise = useMapStore((s) => s.noise);
  const hexRes = useMapStore((s) => s.hexRes);
  const range = useEffectiveRange();
  const { bbox, regionId } = useAppParams();
  const countries = useCountries();
  const frame = useRef(0);

  // Hexagon size follows the zoom (≈15–40 px per cell).
  useEffect(() => {
    if (!map || !mapMode) return;
    const update = () => {
      const res = resolutionForZoom(map.getZoom());
      if (res !== useMapStore.getState().hexRes) useMapStore.getState().setHexRes(res);
    };
    update();
    map.on('zoomend', update);
    return () => {
      map.off('zoomend', update);
    };
  }, [map, mapMode]);

  useEffect(() => {
    if (!map || !mapMode || !index) return;
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => {
      const points = view === 'points';
      for (const sensor of SENSORS) {
        setSensorVisible(map, sensor, points && sensors[sensor]);
        if (points && sensors[sensor]) setFireData(map, sensor, sliceRange(index[sensor], range));
      }
      setHexVisible(map, !points);
      if (!points && archive) setHexData(map, hexFeatures(archive, hexRes, range, sensors, hideMaskOf(noise)));
    });
    return () => cancelAnimationFrame(frame.current);
  }, [map, mapMode, index, archive, sensors, range, view, hexRes, noise]);

  useEffect(() => {
    if (!map || !mapMode) return;
    const country = regionId && /^[A-Z]{2}$/.test(regionId) ? findCountry(countries.data, regionId) : null;
    setSelection(map, bbox, country?.polys ?? null);
  }, [map, mapMode, bbox, regionId, countries.data]);

  return null;
}

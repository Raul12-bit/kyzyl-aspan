import { useEffect, useRef } from 'react';
import { useAppParams } from '@/app/useAppParams';
import type { Sensor } from '@/data/types';
import { hideMaskOf, type FireArchive } from '@/domain/archive';
import { resolutionForZoom } from '@/domain/hexgrid';
import { findCountry, useCountries } from '@/features/geo/countries';
import { useHeliosAvailable } from '@/features/helios/api';
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
  // With the HELIOS API live, WorldSync draws hexagons and detections from the full archive.
  const world = useHeliosAvailable();

  // Hexagon size follows the zoom (≈15–40 px per cell).
  useEffect(() => {
    if (!map || !mapMode || world) return;
    const update = () => {
      const res = resolutionForZoom(map.getZoom());
      if (res !== useMapStore.getState().hexRes) useMapStore.getState().setHexRes(res);
    };
    update();
    map.on('zoomend', update);
    return () => {
      map.off('zoomend', update);
    };
  }, [map, mapMode, world]);

  useEffect(() => {
    if (!map || !mapMode || !index || world) return;
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
  }, [map, mapMode, index, archive, sensors, range, view, hexRes, noise, world]);

  useEffect(() => {
    if (!map || !mapMode) return;
    const country = regionId && /^[A-Z]{2}$/.test(regionId) ? findCountry(countries.data, regionId) : null;
    // A region (admin-1) outline comes from WorldSync once its borders are loaded.
    if (world && regionId && !country) return;
    setSelection(map, bbox, country?.polys ?? null);
  }, [map, mapMode, bbox, regionId, countries.data, world]);

  return null;
}

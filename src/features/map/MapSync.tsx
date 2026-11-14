import { useEffect, useRef } from 'react';
import { useAppParams } from '@/app/useAppParams';
import type { Sensor } from '@/data/types';
import { setFireData, setSelection, setSensorVisible } from './layers';
import { useMapStore } from './mapStore';
import { useEffectiveRange } from './timeStore';
import { sliceRange, type FireIndex } from './useFireData';

const SENSORS: Sensor[] = ['MODIS', 'VIIRS'];

/**
 * Pushes React state into the map: filtered detections per sensor, layer visibility and the
 * selected area outline. Renders nothing. Updates are coalesced into one per animation frame.
 */
export function MapSync({ index }: { index: FireIndex | null }) {
  const map = useMapStore((s) => s.map);
  const mapMode = useMapStore((s) => s.mapMode);
  const sensors = useMapStore((s) => s.sensors);
  const range = useEffectiveRange();
  const { bbox } = useAppParams();
  const frame = useRef(0);

  useEffect(() => {
    if (!map || !mapMode || !index) return;
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => {
      for (const sensor of SENSORS) {
        setSensorVisible(map, sensor, sensors[sensor]);
        if (sensors[sensor]) setFireData(map, sensor, sliceRange(index[sensor], range));
      }
    });
    return () => cancelAnimationFrame(frame.current);
  }, [map, mapMode, index, sensors, range]);

  useEffect(() => {
    if (map && mapMode) setSelection(map, bbox);
  }, [map, mapMode, bbox]);

  return null;
}

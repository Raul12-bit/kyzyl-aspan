import type { Map as MLMap } from 'maplibre-gl';
import { create } from 'zustand';
import type { Sensor } from '@/data/types';

export type MapStatus = 'idle' | 'loading' | 'ready' | 'unsupported' | 'error';

interface MapStore {
  map: MLMap | null;
  status: MapStatus;
  /** False when the basemap style failed and the plain fallback is shown. */
  basemapOk: boolean;
  /** Projection swapped to mercator and data layers mounted. */
  mapMode: boolean;
  sensors: Record<Sensor, boolean>;
  drawing: boolean;
  setSensor: (sensor: Sensor, on: boolean) => void;
  setDrawing: (on: boolean) => void;
}

export const useMapStore = create<MapStore>((set) => ({
  map: null,
  status: 'idle',
  basemapOk: true,
  mapMode: false,
  sensors: { MODIS: true, VIIRS: true },
  drawing: false,
  setSensor: (sensor, on) => set((s) => ({ sensors: { ...s.sensors, [sensor]: on } })),
  setDrawing: (drawing) => set({ drawing }),
}));

export function hasWebGL(): boolean {
  try {
    const canvas = document.createElement('canvas');
    return Boolean(canvas.getContext('webgl2') ?? canvas.getContext('webgl'));
  } catch {
    return false;
  }
}

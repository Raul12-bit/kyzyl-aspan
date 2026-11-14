import type { Map as MLMap } from 'maplibre-gl';
import { create } from 'zustand';
import type { Sensor } from '@/data/types';
import { DEFAULT_NOISE, type NoiseSettings } from '@/domain/noiseSettings';

export type MapStatus = 'idle' | 'loading' | 'ready' | 'unsupported' | 'error';
/** Raw detections, burning H3 hexagons, or countries / regions shaded by activity (real data only). */
export type MapView = 'points' | 'hex' | 'regions';

interface MapStore {
  map: MLMap | null;
  status: MapStatus;
  /** False when the basemap style failed and the plain fallback is shown. */
  basemapOk: boolean;
  /** Camera on target and data layers live (after the intro swap). */
  mapMode: boolean;
  sensors: Record<Sensor, boolean>;
  drawing: boolean;
  view: MapView;
  noise: NoiseSettings;
  /** H3 resolution for the current zoom (hexagon view). */
  hexRes: number;
  setSensor: (sensor: Sensor, on: boolean) => void;
  setDrawing: (on: boolean) => void;
  setView: (view: MapView) => void;
  setNoise: (patch: Partial<NoiseSettings>) => void;
  setHexRes: (res: number) => void;
}

export const useMapStore = create<MapStore>((set) => ({
  map: null,
  status: 'idle',
  basemapOk: true,
  mapMode: false,
  sensors: { MODIS: true, VIIRS: true },
  drawing: false,
  // Burning H3 hexagons first: the comparable, de-noised view. Raw detections are one click away.
  view: 'hex',
  noise: DEFAULT_NOISE,
  hexRes: 3,
  setSensor: (sensor, on) => set((s) => ({ sensors: { ...s.sensors, [sensor]: on } })),
  setDrawing: (drawing) => set({ drawing }),
  setView: (view) => set({ view }),
  setNoise: (patch) => set((s) => ({ noise: { ...s.noise, ...patch } })),
  setHexRes: (hexRes) => set({ hexRes }),
}));

export function hasWebGL(): boolean {
  try {
    const canvas = document.createElement('canvas');
    return Boolean(canvas.getContext('webgl2') ?? canvas.getContext('webgl'));
  } catch {
    return false;
  }
}

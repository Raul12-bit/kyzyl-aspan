import { create } from 'zustand';

export const HELIOS_LAYERS = ['risk', 'alerts', 'static', 'blind', 'spread', 'satellites'] as const;
export type HeliosLayer = (typeof HELIOS_LAYERS)[number];
export type Horizon = 1 | 2 | 3 | 4;

interface HeliosStore {
  layers: Record<HeliosLayer, boolean>;
  /** Weeks ahead for the AI #3 forecast. */
  horizon: Horizon;
  /** 'latest' or a Time Machine date 'YYYY-MM-DD' (the model only knows what happened before it). */
  scenario: string;
  setLayer: (layer: HeliosLayer, on: boolean) => void;
  setHorizon: (h: Horizon) => void;
  setScenario: (s: string) => void;
}

export const useHeliosStore = create<HeliosStore>((set) => ({
  layers: { risk: true, alerts: true, static: false, blind: false, spread: false, satellites: false },
  horizon: 1,
  scenario: 'latest',
  setLayer: (layer, on) => set((s) => ({ layers: { ...s.layers, [layer]: on } })),
  setHorizon: (horizon) => set({ horizon }),
  setScenario: (scenario) => set({ scenario }),
}));

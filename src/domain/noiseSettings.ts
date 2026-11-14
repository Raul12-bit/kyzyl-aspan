/**
 * Noise-filter settings and their bit mask. Kept apart from archive.ts (which pulls in the H3
 * library) so the UI store can import them without loading h3-js on the first screen.
 */
export const FLAG_LOW_CONFIDENCE = 1;
export const FLAG_STATIC = 2;

/** Which noise classes the user wants hidden. */
export interface NoiseSettings {
  lowConfidence: boolean;
  staticSources: boolean;
}

export const DEFAULT_NOISE: NoiseSettings = { lowConfidence: true, staticSources: true };

export function hideMaskOf(settings: NoiseSettings): number {
  return (settings.lowConfidence ? FLAG_LOW_CONFIDENCE : 0) | (settings.staticSources ? FLAG_STATIC : 0);
}

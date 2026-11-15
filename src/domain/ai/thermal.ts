/**
 * Radiometry for the onboard fire detector (AI #1): Planck's law, brightness temperatures and fire
 * radiative power. SI units; wavelengths in metres, temperatures in kelvin.
 *
 * Why the middle infrared: at ~4 µm a 1000 K flame emits thousands of times more than 300 K ground,
 * so a fire covering 0.1% of a pixel still lifts the pixel's 4 µm brightness temperature by tens of
 * kelvin, while the 11 µm channel barely moves. Every active-fire product (MODIS MOD14, VIIRS VNP14)
 * is built on that contrast; this module reproduces it from first principles.
 */

const H = 6.62607015e-34; // Planck constant, J·s
const C = 299_792_458; // speed of light, m/s
const KB = 1.380649e-23; // Boltzmann constant, J/K
/** First radiation constant for spectral radiance, W·m²/sr. */
const C1 = 2 * H * C * C;
/** Second radiation constant, m·K. */
const C2 = (H * C) / KB;

/** Spectral radiance of a black body, W·m⁻²·sr⁻¹·m⁻¹. */
export function planck(lambda: number, kelvin: number): number {
  return C1 / (lambda ** 5 * Math.expm1(C2 / (lambda * kelvin)));
}

/** Brightness temperature, K, of a spectral radiance at wavelength `lambda` (inverse of planck()). */
export function brightnessTemp(lambda: number, radiance: number): number {
  if (!(radiance > 0)) return 0;
  return C2 / (lambda * Math.log1p(C1 / (lambda ** 5 * radiance)));
}

export type SensorId = 'MODIS' | 'VIIRS';

export interface SensorSpec {
  id: SensorId;
  /** Middle-infrared fire channel, m (MODIS band 21/22, VIIRS I4). */
  mir: number;
  /** Thermal-infrared channel, m (MODIS band 31, VIIRS I5). */
  tir: number;
  /** Nadir pixel side, m. */
  pixelM: number;
  /** The middle-infrared channel saturates above this brightness temperature, K. */
  saturationK: number;
}

/** Public band centres and nadir pixel sizes; saturation values are approximate. */
export const SENSORS: Record<SensorId, SensorSpec> = {
  MODIS: { id: 'MODIS', mir: 3.959e-6, tir: 11.03e-6, pixelM: 1000, saturationK: 500 },
  VIIRS: { id: 'VIIRS', mir: 3.74e-6, tir: 11.45e-6, pixelM: 375, saturationK: 367 },
};

/** Pixel area at nadir, km². */
export function pixelAreaKm2(sensor: SensorSpec): number {
  return (sensor.pixelM / 1000) ** 2;
}

/** One emitting part of a pixel: `fraction` of its area at `kelvin`. */
export interface Component {
  fraction: number;
  kelvin: number;
}

/**
 * Brightness temperature of a mixed pixel. Radiances mix linearly with area; temperatures do not —
 * that is the whole reason a tiny fire shows up at 4 µm.
 */
export function mixedBrightness(lambda: number, backgroundK: number, parts: readonly Component[]): number {
  let hot = 0;
  let radiance = 0;
  for (const p of parts) {
    hot += p.fraction;
    radiance += p.fraction * planck(lambda, p.kelvin);
  }
  radiance += Math.max(0, 1 - hot) * planck(lambda, backgroundK);
  return brightnessTemp(lambda, radiance);
}

/**
 * Fire radiative power, MW — the MODIS approximation (Kaufman et al., 1998):
 * FRP = 4.34·10⁻¹⁹ · (T4⁸ − T4b⁸) · A, with A the pixel area in km².
 */
export function frpMW(t4: number, t4Background: number, areaKm2: number): number {
  return Math.max(0, 4.34e-19 * (t4 ** 8 - t4Background ** 8) * areaKm2);
}

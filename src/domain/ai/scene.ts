import { type Component, mixedBrightness, planck, brightnessTemp, SENSORS, type SensorId } from './thermal';

/**
 * Synthetic thermal scenes for the AI #1 lab — what a fire channel would see over ~10 × 10 km.
 *
 * The ground truth lives on a fine grid of 375 m pixels (VIIRS I-band size). VIIRS observes it pixel
 * for pixel; MODIS observes 3 × 3 blocks (≈1.1 km), mixing their radiances — exactly why a 100 m² stubble
 * fire that VIIRS sees clearly can vanish inside a MODIS pixel. Temperatures are plausible, not measured:
 * the scenes are made to illustrate the physics, not to reproduce a real overpass.
 */

export type SceneKind = 'wildfire' | 'smallBurn' | 'gasFlare' | 'hotGround';
export const SCENE_KINDS: readonly SceneKind[] = ['wildfire', 'smallBurn', 'gasFlare', 'hotGround'];

/** Fine pixels per side (375 m each). */
export const FINE = 27;
/** Fine pixels per MODIS pixel side. */
export const MODIS_BLOCK = 3;

export interface FinePixel {
  /** Ground (11 µm) temperature without fire, K. */
  ground: number;
  /** Extra 4 µm brightness from reflected sunlight, K (zero at night). */
  solar: number;
  water: boolean;
  cloud: boolean;
  fire: Component[];
}

/** What the 26-year archive remembers about the hot spot's cell (input of the triage model). */
export interface CellHistory {
  /** Distinct years with detections. */
  years: number;
  /** Distinct calendar months with detections. */
  months: number;
  /** Detections ever seen in the cell. */
  count: number;
}

export interface ThermalScene {
  kind: SceneKind;
  day: boolean;
  /** Scene centre, degrees. */
  lat: number;
  lng: number;
  /** Observation time, seconds since 2000-01-01T00:00Z. */
  timeSec: number;
  /** FINE × FINE, row-major (y down, north up). */
  pixels: FinePixel[];
  history: CellHistory;
}

export interface SensorImage {
  sensor: SensorId;
  /** Pixels per side. */
  size: number;
  /** Pixel side, m. */
  pixelM: number;
  /** Middle-infrared (≈4 µm) brightness temperature, K. */
  t4: Float32Array;
  /** Thermal-infrared (≈11 µm) brightness temperature, K. */
  t11: Float32Array;
  /** 0 = land, 1 = water, 2 = cloud. Masked pixels are never classified. */
  mask: Uint8Array;
}

const EPOCH_2000 = Date.UTC(2000, 0, 1) / 1000;

/** Deterministic PRNG (mulberry32). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Smooth value noise in [-1, 1] on the fine grid: a 5 × 5 lattice, bilinearly interpolated. */
function smoothField(next: () => number): Float32Array {
  const L = 5;
  const lattice = Array.from({ length: L * L }, () => next() * 2 - 1);
  const out = new Float32Array(FINE * FINE);
  for (let y = 0; y < FINE; y++) {
    for (let x = 0; x < FINE; x++) {
      const gx = (x / (FINE - 1)) * (L - 1);
      const gy = (y / (FINE - 1)) * (L - 1);
      const x0 = Math.min(L - 2, Math.floor(gx));
      const y0 = Math.min(L - 2, Math.floor(gy));
      const fx = gx - x0;
      const fy = gy - y0;
      const a = lattice[y0 * L + x0]!;
      const b = lattice[y0 * L + x0 + 1]!;
      const c = lattice[(y0 + 1) * L + x0]!;
      const d = lattice[(y0 + 1) * L + x0 + 1]!;
      out[y * FINE + x] = (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
    }
  }
  return out;
}

interface Preset {
  lat: number;
  lng: number;
  history: CellHistory;
  seed: number;
  cloud: boolean;
}

/** Where each scene is set (plausible places in Kazakhstan) and what the archive knows about the cell. */
const PRESETS: Record<SceneKind, Preset> = {
  // Pine forest near Semey: a fresh fire, the cell never burned before.
  wildfire: { lat: 50.42, lng: 80.25, history: { years: 1, months: 1, count: 2 }, seed: 11, cloud: true },
  // Crop-residue burning in the north: small, occasionally repeated.
  smallBurn: { lat: 53.28, lng: 69.39, history: { years: 2, months: 2, count: 3 }, seed: 23, cloud: false },
  // Oil-field flare in the west: hot every season for two decades.
  gasFlare: {
    lat: 46.15,
    lng: 53.38,
    history: { years: 21, months: 12, count: 420 },
    seed: 37,
    cloud: false,
  },
  // Sun-baked bare rock on the Ustyurt plateau: warm, but not a fire.
  hotGround: { lat: 44.2, lng: 56.1, history: { years: 0, months: 0, count: 0 }, seed: 53, cloud: false },
};

/** Afternoon (≈13:30 local, the Aqua / Suomi NPP overpass) or night (≈01:30) over Kazakhstan. */
function sceneTime(day: boolean): number {
  const t = day ? Date.UTC(2026, 7, 1, 7, 30) : Date.UTC(2026, 7, 1, 19, 40);
  return t / 1000 - EPOCH_2000;
}

export function buildScene(kind: SceneKind, day: boolean): ThermalScene {
  const preset = PRESETS[kind];
  const next = rng(preset.seed * 7919 + (day ? 1 : 2));
  const field = smoothField(next);
  const baseGround = day ? 303 : 288;
  const pixels: FinePixel[] = [];
  for (let y = 0; y < FINE; y++) {
    for (let x = 0; x < FINE; x++) {
      const i = y * FINE + x;
      const water = (x - 3) ** 2 + (y - 4) ** 2 < 9;
      const cloud = preset.cloud && (x - 21) ** 2 + (y - 21) ** 2 < 7;
      const ground = water ? (day ? 293 : 291) : baseGround + field[i]! * 1.3 + (next() - 0.5) * 0.4;
      const solar = day ? (water ? 1 : 6 + field[(i * 7) % (FINE * FINE)]! * 0.8) : 0;
      pixels.push({ ground, solar, water, cloud, fire: [] });
    }
  }
  const at = (x: number, y: number) => pixels[y * FINE + x]!;

  switch (kind) {
    case 'wildfire': {
      // A curved flaming front with smouldering ground behind it.
      for (let k = -4; k <= 4; k++) {
        const x = 13 + k;
        const y = 11 - Math.round(0.12 * k * k);
        at(x, y).fire.push({ fraction: 0.002 + 0.006 * (1 - Math.abs(k) / 6), kelvin: 1050 });
        if (Math.abs(k) <= 3) at(x, y + 1).fire.push({ fraction: 0.02, kelvin: 650 });
      }
      break;
    }
    case 'smallBurn':
      at(15, 14).fire.push({ fraction: 0.0008, kelvin: 900 });
      break;
    case 'gasFlare':
      at(12, 15).fire.push({ fraction: 0.0004, kelvin: 1700 });
      break;
    case 'hotGround':
      for (let y = 10; y <= 14; y++) {
        for (let x = 9; x <= 15; x++) {
          const p = at(x, y);
          if (day) {
            p.ground += 11;
            p.solar += 8;
          } else {
            p.ground -= 2;
          }
        }
      }
      break;
  }
  return {
    kind,
    day,
    lat: preset.lat,
    lng: preset.lng,
    timeSec: sceneTime(day),
    pixels,
    history: preset.history,
  };
}

/** Fine-pixel radiances at one sensor's bands (fire mixed in), before any resampling. */
function fineRadiance(p: FinePixel, sensorId: SensorId, day: boolean): { l4: number; l11: number } {
  const s = SENSORS[sensorId];
  if (p.cloud) {
    // Cloud tops are cold at 11 µm but reflect sunlight at 4 µm.
    return { l4: planck(s.mir, day ? 285 : 252), l11: planck(s.tir, 255) };
  }
  const t4 = mixedBrightness(s.mir, p.ground + p.solar, p.fire);
  const t11 = mixedBrightness(s.tir, p.ground, p.fire);
  return { l4: planck(s.mir, t4), l11: planck(s.tir, t11) };
}

/** Small deterministic sensor noise, K. */
function noise(sensorId: SensorId, x: number, y: number, band: number, day: boolean): number {
  let h =
    (x * 73856093) ^
    (y * 19349663) ^
    (band * 83492791) ^
    (sensorId === 'MODIS' ? 0x51ed : 0x2b8f) ^
    (day ? 7 : 13);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  const u = ((h ^ (h >>> 15)) >>> 0) / 4294967296;
  return (u - 0.5) * (sensorId === 'MODIS' ? 0.35 : 0.5);
}

/**
 * What one sensor records over the scene. VIIRS: one pixel per fine pixel. MODIS: radiance-averaged
 * 3 × 3 blocks — a pixel is cloud when 3+ of its nine parts are cloudy, water when 5+ are water.
 */
export function observe(scene: ThermalScene, sensorId: SensorId): SensorImage {
  const s = SENSORS[sensorId];
  const block = sensorId === 'MODIS' ? MODIS_BLOCK : 1;
  const size = FINE / block;
  const t4 = new Float32Array(size * size);
  const t11 = new Float32Array(size * size);
  const mask = new Uint8Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let l4 = 0;
      let l11 = 0;
      let clouds = 0;
      let waters = 0;
      for (let dy = 0; dy < block; dy++) {
        for (let dx = 0; dx < block; dx++) {
          const p = scene.pixels[(y * block + dy) * FINE + x * block + dx]!;
          const r = fineRadiance(p, sensorId, scene.day);
          l4 += r.l4;
          l11 += r.l11;
          if (p.cloud) clouds += 1;
          if (p.water) waters += 1;
        }
      }
      const n = block * block;
      const i = y * size + x;
      const b4 = brightnessTemp(s.mir, l4 / n) + noise(sensorId, x, y, 4, scene.day);
      t4[i] = Math.min(s.saturationK, b4);
      t11[i] = brightnessTemp(s.tir, l11 / n) + noise(sensorId, x, y, 11, scene.day);
      mask[i] = clouds >= Math.ceil(n / 3) ? 2 : waters * 2 > n ? 1 : 0;
    }
  }
  // The fine grid is 375 m, so a MODIS pixel here is 1125 m — close to MODIS's nominal 1 km.
  return { sensor: sensorId, size, pixelM: 375 * block, t4, t11, mask };
}

/** Latitude/longitude of a pixel centre (north up, equirectangular offsets — fine at 10 km). */
export function pixelLatLng(
  scene: ThermalScene,
  image: SensorImage,
  x: number,
  y: number,
): { lat: number; lng: number } {
  const half = (image.size - 1) / 2;
  const dyKm = ((half - y) * image.pixelM) / 1000;
  const dxKm = ((x - half) * image.pixelM) / 1000;
  const lat = scene.lat + dyKm / 111.32;
  const lng = scene.lng + dxKm / (111.32 * Math.cos((scene.lat * Math.PI) / 180));
  return { lat, lng };
}

import type { SensorImage } from './scene';
import { frpMW } from './thermal';

/**
 * AI #1, stage A — contextual fire detection on a thermal image (runs per scan on board).
 *
 * A simplified version of the contextual algorithm behind the MODIS and VIIRS active-fire products
 * (after Giglio et al. 2003/2016 and Schroeder et al. 2014): a pixel is a fire when it is hot in
 * absolute terms, or clearly hotter than its own neighbourhood at 4 µm and in the 4 − 11 µm difference.
 * The neighbourhood window grows until it holds enough valid (clear, non-fire) pixels. Thresholds are
 * the published day/night values rounded; the background-fire spread test and the sun-glint / desert
 * boundary tests of the operational code are omitted. Illustrative, not the operational product.
 */
export const CONTEXT = {
  /** A pixel is examined only if T4 and ΔT = T4 − T11 exceed these (K). */
  potential: { day: { t4: 310, dT: 10 }, night: { t4: 305, dT: 10 } },
  /** Hot enough to be a fire with no context needed (K). */
  absolute: { day: 360, night: 320 },
  /** Neighbours this hot are fires themselves and are kept out of the background (K). */
  backgroundFire: { day: { t4: 325, dT: 20 }, night: { t4: 310, dT: 10 } },
  minValid: 8,
  minValidShare: 0.25,
  /** Largest half-window: 10 → 21 × 21 pixels. */
  maxRadius: 10,
  /** Mean absolute deviations below this are raised to it, so a very flat background cannot fire on noise (K). */
  deviationFloor: 2,
  tests: { dTDeviations: 3.5, dTOffset: 6, t4Deviations: 3, t11Offset: 4 },
} as const;

export interface Background {
  /** Valid background pixels used. */
  n: number;
  /** Half-window that first held enough of them. */
  radius: number;
  mean4: number;
  mad4: number;
  mean11: number;
  mad11: number;
  meanDT: number;
  madDT: number;
}

export interface PixelTests {
  /** T4 above the absolute threshold. */
  absolute: boolean;
  /** ΔT > mean ΔT + 3.5 δΔT */
  dT: boolean;
  /** ΔT > mean ΔT + 6 K */
  dTOffset: boolean;
  /** T4 > mean T4 + 3 δ4 */
  t4: boolean;
  /** T11 > mean T11 + δ11 − 4 K (day only: rules out cold, sunlit cloud edges) */
  t11: boolean;
}

export type ConfidenceClass = 0 | 1 | 2;

export interface PixelVerdict {
  x: number;
  y: number;
  t4: number;
  t11: number;
  dT: number;
  background: Background | null;
  tests: PixelTests;
  fire: boolean;
  /** 0…1, like the FIRMS confidence percentage. */
  confidence: number;
  /** 0 low (< 30%), 1 nominal, 2 high (≥ 80%). */
  confidenceClass: ConfidenceClass;
  /** Fire radiative power, MW (0 for non-fires). */
  frpMW: number;
}

export interface FireCluster {
  pixels: PixelVerdict[];
  /** Pixel-coordinate centroid, weighted by FRP. */
  x: number;
  y: number;
  frpMW: number;
  maxT4: number;
  confidence: number;
  confidenceClass: ConfidenceClass;
}

/** Per-pixel outcome, for drawing. */
export const PIXEL = { clear: 0, masked: 1, rejected: 2, fire: 3, unknown: 4 } as const;

export interface DetectionResult {
  classes: Uint8Array;
  /** Every pixel that passed the potential-fire screen, fire or not. */
  examined: PixelVerdict[];
  fires: PixelVerdict[];
  clusters: FireCluster[];
}

const ramp = (v: number, lo: number, hi: number) => Math.max(0, Math.min(1, (v - lo) / (hi - lo)));

export function confidenceClass(c: number): ConfidenceClass {
  return c >= 0.8 ? 2 : c >= 0.3 ? 1 : 0;
}

function backgroundOf(img: SensorImage, x0: number, y0: number, bgFire: Uint8Array): Background | null {
  const { size, t4, t11, mask } = img;
  for (let r = 1; r <= CONTEXT.maxRadius; r++) {
    let window = 0;
    const v4: number[] = [];
    const v11: number[] = [];
    for (let y = Math.max(0, y0 - r); y <= Math.min(size - 1, y0 + r); y++) {
      for (let x = Math.max(0, x0 - r); x <= Math.min(size - 1, x0 + r); x++) {
        if (x === x0 && y === y0) continue;
        window += 1;
        const i = y * size + x;
        if (mask[i] !== 0 || bgFire[i]) continue;
        v4.push(t4[i]!);
        v11.push(t11[i]!);
      }
    }
    if (v4.length >= CONTEXT.minValid && v4.length >= CONTEXT.minValidShare * window) {
      const n = v4.length;
      const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / n;
      const mad = (a: number[], m: number) =>
        Math.max(CONTEXT.deviationFloor, a.reduce((s, v) => s + Math.abs(v - m), 0) / n);
      const vdT = v4.map((v, k) => v - v11[k]!);
      const mean4 = mean(v4);
      const mean11 = mean(v11);
      const meanDT = mean(vdT);
      return {
        n,
        radius: r,
        mean4,
        mad4: mad(v4, mean4),
        mean11,
        mad11: mad(v11, mean11),
        meanDT,
        madDT: mad(vdT, meanDT),
      };
    }
  }
  return null;
}

/** Runs the contextual detector on one image. Pure and deterministic; ~0.1–1 ms for the lab's images. */
export function detectFires(img: SensorImage, day: boolean): DetectionResult {
  const { size, t4, t11, mask } = img;
  const n = size * size;
  const pot = day ? CONTEXT.potential.day : CONTEXT.potential.night;
  const bgf = day ? CONTEXT.backgroundFire.day : CONTEXT.backgroundFire.night;
  const absolute = day ? CONTEXT.absolute.day : CONTEXT.absolute.night;
  const area = (img.pixelM / 1000) ** 2;

  const classes = new Uint8Array(n);
  const bgFire = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (mask[i] !== 0) {
      classes[i] = PIXEL.masked;
      continue;
    }
    const dT = t4[i]! - t11[i]!;
    if (t4[i]! > bgf.t4 && dT > bgf.dT) bgFire[i] = 1;
  }

  const examined: PixelVerdict[] = [];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      if (mask[i] !== 0) continue;
      const T4 = t4[i]!;
      const T11 = t11[i]!;
      const dT = T4 - T11;
      if (!(T4 > pot.t4 && dT > pot.dT)) continue;

      const bg = backgroundOf(img, x, y, bgFire);
      const isAbsolute = T4 > absolute;
      const t = CONTEXT.tests;
      const tests: PixelTests = {
        absolute: isAbsolute,
        dT: bg !== null && dT > bg.meanDT + t.dTDeviations * bg.madDT,
        dTOffset: bg !== null && dT > bg.meanDT + t.dTOffset,
        t4: bg !== null && T4 > bg.mean4 + t.t4Deviations * bg.mad4,
        t11: bg !== null && T11 > bg.mean11 + bg.mad11 - t.t11Offset,
      };
      const contextual = tests.dT && tests.dTOffset && tests.t4 && (!day || tests.t11);
      const fire = isAbsolute || contextual;

      let confidence = 0;
      if (fire) {
        if (isAbsolute) confidence = 1;
        else if (bg) {
          const c1 = day ? ramp(T4, 310, 340) : ramp(T4, 305, 320);
          const c2 = ramp((T4 - bg.mean4) / bg.mad4, 2.5, 6);
          const c3 = ramp((dT - bg.meanDT) / bg.madDT, 3, 6);
          confidence = Math.cbrt(c1 * c2 * c3);
        }
      }
      const verdict: PixelVerdict = {
        x,
        y,
        t4: T4,
        t11: T11,
        dT,
        background: bg,
        tests,
        fire,
        confidence,
        confidenceClass: confidenceClass(confidence),
        frpMW: fire ? frpMW(T4, bg?.mean4 ?? T11 + 5, area) : 0,
      };
      examined.push(verdict);
      classes[i] = fire ? PIXEL.fire : bg ? PIXEL.rejected : PIXEL.unknown;
    }
  }
  const fires = examined.filter((v) => v.fire);
  return { classes, examined, fires, clusters: clusterFires(fires) };
}

/** Groups touching fire pixels (8-neighbourhood) into hot spots — the unit AI #1 reports. */
export function clusterFires(fires: readonly PixelVerdict[]): FireCluster[] {
  const left = new Set(fires);
  const out: FireCluster[] = [];
  for (const seed of fires) {
    if (!left.has(seed)) continue;
    left.delete(seed);
    const members: PixelVerdict[] = [seed];
    for (let k = 0; k < members.length; k++) {
      const a = members[k]!;
      for (const b of [...left]) {
        if (Math.abs(a.x - b.x) <= 1 && Math.abs(a.y - b.y) <= 1) {
          left.delete(b);
          members.push(b);
        }
      }
    }
    const frp = members.reduce((s, p) => s + p.frpMW, 0);
    const w = (p: PixelVerdict) => (frp > 0 ? p.frpMW / frp : 1 / members.length);
    const confidence = Math.max(...members.map((p) => p.confidence));
    out.push({
      pixels: members,
      x: members.reduce((s, p) => s + p.x * w(p), 0),
      y: members.reduce((s, p) => s + p.y * w(p), 0),
      frpMW: frp,
      maxT4: Math.max(...members.map((p) => p.t4)),
      confidence,
      confidenceClass: confidenceClass(confidence),
    });
  }
  return out.sort((a, b) => b.frpMW - a.frpMW);
}

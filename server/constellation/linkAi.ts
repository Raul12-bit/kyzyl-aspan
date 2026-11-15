/**
 * AI #2 on the ground: the trained link-outage network (artifacts/models/link_ai_weights.json, the same
 * weights as link_ai.onnx) evaluated in plain TypeScript, plus the monotonic physics correction from
 * helios/comms/constellation.py. The network alone lowers the risk in heavy rain (it saw almost none in
 * training); the correction raises it whenever the forecast link margin heads towards zero.
 */
import weights from '../../artifacts/models/link_ai_weights.json';

interface Layer {
  W: number[][];
  b: number[];
  act: string;
}
const W = weights as unknown as { features: string[]; mean: number[]; std: number[]; layers: Layer[] };

export const LINK_AI_FEATURES: readonly string[] = W.features;

/** P(the link drops within 5 minutes) from one feature row (named like LINK_AI_FEATURES). */
export function linkAi(row: Record<string, number>): number {
  let z = W.features.map((name, i) => ((row[name] ?? 0) - W.mean[i]!) / W.std[i]!);
  for (const layer of W.layers) {
    z = layer.W.map((w, o) => {
      let s = layer.b[o]!;
      for (let i = 0; i < w.length; i++) s += w[i]! * z[i]!;
      return layer.act === 'relu' ? Math.max(0, s) : 1 / (1 + Math.exp(-s));
    });
  }
  return z[0]!;
}

/** Minimum of x over the next h steps (t+1 … t+h); at the end, the last value. */
export function forwardMin(x: readonly number[], h: number): number[] {
  const n = x.length;
  return x.map((_, t) => {
    let m = Infinity;
    for (let k = t + 1; k <= t + h; k++) m = Math.min(m, x[Math.min(k, n - 1)]!);
    return n === 1 ? x[0]! : m;
  });
}

/** Risk of a drop within `horizonMin`: network + physics on the forecast margin (never below the physics). */
export function outageRisk(pAi: readonly number[], marginDb: readonly number[], stepS: number, horizonMin = 5): number[] {
  const h = Math.max(1, Math.round((horizonMin * 60) / stepS));
  const fut = forwardMin(marginDb, h);
  return pAi.map((p, i) => {
    const pPhys = 1 / (1 + Math.exp((fut[i]! - 1) / 0.7));
    return 1 - (1 - p) * (1 - pPhys);
  });
}

/** numpy.gradient for evenly spaced samples (one-sided at the ends). */
export function gradient(x: readonly number[]): number[] {
  const n = x.length;
  if (n < 2) return x.map(() => 0);
  return x.map((_, i) => (i === 0 ? x[1]! - x[0]! : i === n - 1 ? x[n - 1]! - x[n - 2]! : (x[i + 1]! - x[i - 1]!) / 2));
}

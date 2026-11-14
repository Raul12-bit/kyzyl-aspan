/** Deterministic pseudo-random helpers for the mock generator (no Math.random anywhere). */

export type Rng = () => number;

/** mulberry32 — tiny, fast, good enough for synthetic data. Returns [0, 1). */
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Mixes several integers into one 32-bit seed (for independent per-cell streams). */
export function hashSeed(...parts: number[]): number {
  let h = 0x811c9dc5;
  for (const p of parts) {
    h ^= p >>> 0;
    h = Math.imul(h, 0x01000193) >>> 0;
    h ^= h >>> 13;
    h = Math.imul(h, 0x5bd1e995) >>> 0;
    h ^= h >>> 15;
  }
  return h >>> 0;
}

export function normal(rng: Rng): number {
  let u = 0;
  while (u === 0) u = rng();
  const v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** Mean-preserving log-normal multiplier with log-sd `sigma`. */
export function lognormalFactor(rng: Rng, sigma: number): number {
  return Math.exp(normal(rng) * sigma - (sigma * sigma) / 2);
}

export function poisson(rng: Rng, lambda: number): number {
  if (lambda <= 0) return 0;
  if (lambda > 60) return Math.max(0, Math.round(lambda + Math.sqrt(lambda) * normal(rng)));
  const L = Math.exp(-lambda);
  let k = 0;
  let p = 1;
  do {
    k += 1;
    p *= rng();
  } while (p > L);
  return k - 1;
}

/** Standard normal truncated to ±limit (rejection). */
export function truncatedNormal(rng: Rng, limit: number): number {
  for (let i = 0; i < 64; i++) {
    const z = normal(rng);
    if (Math.abs(z) <= limit) return z;
  }
  return 0;
}

export function pickIndex(rng: Rng, n: number): number {
  return Math.min(n - 1, Math.floor(rng() * n));
}

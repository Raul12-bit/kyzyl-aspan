/** Small numeric helpers shared by the mock engine and the analysis view. No dependencies. */

/** Abramowitz & Stegun 7.1.26, |error| < 1.5e-7. */
export function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y =
    1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-ax * ax);
  return sign * y;
}

export function normalCdf(z: number): number {
  return 0.5 * (1 + erf(z / Math.SQRT2));
}

/** z for a central 90% interval. */
export const Z90 = 1.6448536269514722;

const T95 = [
  6.314, 2.92, 2.353, 2.132, 2.015, 1.943, 1.895, 1.86, 1.833, 1.812, 1.796, 1.782, 1.771, 1.761, 1.753, 1.746, 1.74,
  1.734, 1.729, 1.725, 1.721, 1.717, 1.714, 1.711, 1.708, 1.706, 1.703, 1.701, 1.699, 1.697,
];

/** One-sided 0.95 quantile of Student's t (two-sided 90% interval). */
export function tQuantile95(df: number): number {
  if (df < 1) return Number.POSITIVE_INFINITY;
  return T95[Math.min(df, T95.length) - 1] ?? 1.645;
}

export function sum(values: readonly number[]): number {
  let s = 0;
  for (const v of values) s += v;
  return s;
}

export function mean(values: readonly number[]): number {
  return values.length ? sum(values) / values.length : Number.NaN;
}

/** Sample standard deviation (n − 1). */
export function sd(values: readonly number[]): number {
  if (values.length < 2) return Number.NaN;
  const m = mean(values);
  let acc = 0;
  for (const v of values) acc += (v - m) ** 2;
  return Math.sqrt(acc / (values.length - 1));
}

export function quantile(sorted: readonly number[], q: number): number {
  if (!sorted.length) return Number.NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  const a = sorted[lo]!;
  const b = sorted[hi]!;
  return a + (b - a) * (pos - lo);
}

export function round(value: number, decimals = 0): number {
  const f = 10 ** decimals;
  return Math.round(value * f) / f;
}

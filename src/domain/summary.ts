import type { CalendarSeries } from '../data/types';
import { toYearMonth } from '../lib/date';
import { mean, round } from '../lib/stats';

/**
 * The statistical brief of one area — the ONLY thing sent to the language model. It holds aggregates
 * and no coordinates finer than the area's bounding box, no raw detections and nothing about the
 * visitor. Built from the harmonized calendar (CalendarSeries) plus a few map-side totals.
 */
export interface AreaSummary {
  area: { name: string; iso2: string | null; bbox: [number, number, number, number] };
  period: { from: string; to: string };
  unit: 'MODIS-equivalent burning hexagon-days per month (H3 res 5, ≈250 km²)';
  synthetic: boolean;
  totals: {
    detectionsConsidered: number;
    removedLowConfidence: number;
    removedStaticSources: number;
    staticCells: number;
  };
  sensors: { rawViirsToModis: number | null; hexViirsToModis: number; calibrated: boolean };
  /** Harmonized total per calendar year (complete years only). */
  annual: { year: number; value: number; lo: number; hi: number }[];
  /** Mean harmonized activity per calendar month (Jan…Dec). */
  climatology: number[];
  peakMonths: number[];
  /** Linear trend of annual totals, % of the mean per year. */
  trendPctPerYear: number;
  /** Most unusual months, z ≥ 2, strongest first (max 6). */
  anomalies: { month: string; z: number }[];
  /** Last 12 months against the same months' climatology (1 = typical). */
  recentVsTypical: number | null;
  /** Mean relative width of the calendar interval since 2012. */
  relativeUncertainty: number;
  /** Central probability of the calendar intervals (0.9 in the synthetic demo, 0.95 from the HELIOS API). */
  interval?: number;
  /** Climatological share of activity in the next three calendar months after the series ends. */
  seasonAhead: { months: number[]; share: number };
}

export type RiskLevel = 'low' | 'moderate' | 'elevated' | 'high';

/** Least-squares slope of y over x. */
function slope(xs: readonly number[], ys: readonly number[]): number {
  const mx = mean(xs);
  const my = mean(ys);
  let num = 0;
  let den = 0;
  for (let i = 0; i < xs.length; i++) {
    num += (xs[i]! - mx) * (ys[i]! - my);
    den += (xs[i]! - mx) ** 2;
  }
  return den > 0 ? num / den : 0;
}

export function buildAreaSummary(
  calendar: CalendarSeries,
  area: { name: string; iso2: string | null; bbox: readonly [number, number, number, number] },
): AreaSummary | null {
  const pts = calendar.points;
  if (!pts.length) return null;
  const first = pts[0]!;
  const last = pts[pts.length - 1]!;

  const years = new Map<number, { value: number; lo: number; hi: number; n: number }>();
  for (const p of pts) {
    const y = years.get(p.year) ?? { value: 0, lo: 0, hi: 0, n: 0 };
    y.value += p.harmonized;
    y.lo += p.lo;
    y.hi += p.hi;
    y.n += 1;
    years.set(p.year, y);
  }
  const annual = [...years.entries()]
    .filter(([, v]) => v.n === 12)
    .map(([year, v]) => ({ year, value: round(v.value, 1), lo: round(v.lo, 1), hi: round(v.hi, 1) }));

  const byMonth: number[][] = Array.from({ length: 12 }, () => []);
  for (const p of pts) byMonth[p.month - 1]!.push(p.harmonized);
  const climatology = byMonth.map((xs) => round(mean(xs), 2));
  const total = climatology.reduce((a, b) => a + b, 0);
  const peakMonths = climatology
    .map((v, i) => [v, i + 1] as const)
    .sort((a, b) => b[0] - a[0])
    .filter(([v], i) => i < 3 && total > 0 && v >= 0.12 * total)
    .map(([, m]) => m)
    .sort((a, b) => a - b);

  const annualMean = mean(annual.map((a) => a.value));
  const trendPctPerYear =
    annual.length >= 5 && annualMean > 0 ? round((slope(annual.map((a) => a.year), annual.map((a) => a.value)) / annualMean) * 100, 2) : 0;

  const anomalies = pts
    .filter((p) => p.anomalyZ !== null && p.anomalyZ >= 2)
    .sort((a, b) => b.anomalyZ! - a.anomalyZ!)
    .slice(0, 6)
    .map((p) => ({ month: toYearMonth(p.year, p.month), z: p.anomalyZ! }));

  const recent = pts.slice(-12);
  const recentSum = recent.reduce((a, p) => a + p.harmonized, 0);
  const typicalSum = recent.reduce((a, p) => a + climatology[p.month - 1]!, 0);
  const recentVsTypical = typicalSum > 0 ? round(recentSum / typicalSum, 2) : null;

  const dual = pts.filter((p) => p.viirsHex !== null && p.harmonized > 0);
  const relativeUncertainty = dual.length ? round(mean(dual.map((p) => (p.hi - p.lo) / p.harmonized)), 3) : 1;

  const ahead = [1, 2, 3].map((k) => ((last.month - 1 + k) % 12) + 1);
  const share = total > 0 ? round(ahead.reduce((a, m) => a + climatology[m - 1]!, 0) / total, 3) : 0;

  const meta = calendar.meta;
  return {
    area: { name: area.name, iso2: area.iso2, bbox: [...area.bbox] as [number, number, number, number] },
    period: { from: toYearMonth(first.year, first.month), to: toYearMonth(last.year, last.month) },
    unit: 'MODIS-equivalent burning hexagon-days per month (H3 res 5, ≈250 km²)',
    synthetic: meta.synthetic,
    totals: {
      detectionsConsidered: meta.noise.considered,
      removedLowConfidence: meta.noise.lowConfidence,
      removedStaticSources: meta.noise.staticSources,
      staticCells: meta.noise.staticCells,
    },
    sensors: { rawViirsToModis: meta.rawRatio, hexViirsToModis: meta.ratio.value, calibrated: meta.ratio.calibrated },
    annual,
    climatology,
    peakMonths,
    trendPctPerYear,
    anomalies,
    recentVsTypical,
    relativeUncertainty,
    interval: meta.interval,
    seasonAhead: { months: ahead, share },
  };
}

/** A transparent heuristic, shown when no language model is configured — never presented as AI. */
export function riskLevel(s: AreaSummary): RiskLevel {
  // Three months ahead hold `share` of the year; 0.25 is "average". Recent activity scales it.
  const season = s.seasonAhead.share / 0.25;
  const recent = s.recentVsTypical ?? 1;
  const score = season * (0.6 + 0.4 * Math.min(2.5, recent)) * (1 + Math.max(0, s.trendPctPerYear) / 20);
  if (score >= 1.8) return 'high';
  if (score >= 1.2) return 'elevated';
  if (score >= 0.7) return 'moderate';
  return 'low';
}

export type Finding =
  | { kind: 'risk'; level: RiskLevel; months: number[]; share: number }
  | { kind: 'season'; months: number[] }
  | { kind: 'trend'; pctPerYear: number }
  | { kind: 'recent'; ratio: number }
  | { kind: 'anomalies'; months: string[] }
  | { kind: 'noise'; removedShare: number; staticCells: number }
  | { kind: 'sensors'; raw: number | null; hex: number }
  | { kind: 'uncertainty'; relative: number; interval?: number }
  /** Added by the server from the HELIOS API: AI #3 chance of fire next week in the area. */
  | { kind: 'forecast'; max: number; mean: number; typical: number };

/** Rule-based findings, rendered by the client in the interface language. */
export function ruleFindings(s: AreaSummary): Finding[] {
  const out: Finding[] = [{ kind: 'risk', level: riskLevel(s), months: s.seasonAhead.months, share: s.seasonAhead.share }];
  if (s.peakMonths.length) out.push({ kind: 'season', months: s.peakMonths });
  out.push({ kind: 'trend', pctPerYear: s.trendPctPerYear });
  if (s.recentVsTypical !== null) out.push({ kind: 'recent', ratio: s.recentVsTypical });
  if (s.anomalies.length) out.push({ kind: 'anomalies', months: s.anomalies.slice(0, 4).map((a) => a.month) });
  const removed = s.totals.removedLowConfidence + s.totals.removedStaticSources;
  if (s.totals.detectionsConsidered > 0) {
    out.push({ kind: 'noise', removedShare: round(removed / s.totals.detectionsConsidered, 3), staticCells: s.totals.staticCells });
  }
  out.push({ kind: 'sensors', raw: s.sensors.rawViirsToModis, hex: s.sensors.hexViirsToModis });
  out.push({ kind: 'uncertainty', relative: s.relativeUncertainty, interval: s.interval });
  return out;
}


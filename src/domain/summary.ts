import type { CalendarSeries } from '../data/types';
import { monthIndex, toYearMonth } from '../lib/date';
import { mean, round } from '../lib/stats';

/**
 * The statistical brief of one area and one period — the ONLY thing sent to the language model. It holds
 * aggregates and no coordinates finer than the area's bounding box, no raw detections and nothing about the
 * visitor. Every period-dependent number is computed from the months the visitor selected on the map, so
 * "What is sent" always matches the time bar.
 */
export interface AreaSummary {
  area: { name: string; iso2: string | null; bbox: [number, number, number, number] };
  /** The selected period (inclusive months) — every number below describes it. */
  period: { from: string; to: string; months: number };
  /** The whole harmonized record of the area, for context only. */
  record: { from: string; to: string };
  /** Unit of the harmonized values, with the H3 grid they were counted on. */
  unit: string;
  synthetic: boolean;
  /** Detections of the period inside the area, with the standard noise filter (both sensors). */
  totals: {
    detectionsConsidered: number;
    removedLowConfidence: number;
    removedStaticSources: number;
    /** Persistent heat-source cells in the area — judged over the whole record, not the period. */
    staticCells: number;
  };
  /** Calibration constants of the area (overlap of both sensors, 2012 on). */
  sensors: { rawViirsToModis: number | null; hexViirsToModis: number; calibrated: boolean };
  /** Harmonized total per calendar year — only the complete years inside the period. */
  annual: { year: number; value: number; lo: number; hi: number }[];
  /** Mean harmonized activity per calendar month (Jan…Dec); empty when the period is shorter than a year. */
  climatology: number[];
  peakMonths: number[];
  /** Linear trend of annual totals, % of the mean per year; null with fewer than five complete years. */
  trendPctPerYear: number | null;
  /** Most unusual months of the period, z ≥ 2, strongest first (max 6). */
  anomalies: { month: string; z: number }[];
  /** Last 12 months of the period against the period's typical months (1 = typical); null under two years. */
  recentVsTypical: number | null;
  /** Relative width of the interval of the period total, (Σhi − Σlo) / Σvalue; null without activity. */
  relativeUncertainty: number | null;
  /** Harmonized total of the period with its interval (asymmetric: activity is never negative). */
  periodTotal: { value: number; lo: number; hi: number };
  /** Central probability of the calendar intervals (0.9 in the synthetic demo, 0.95 from the HELIOS API). */
  interval?: number;
  /**
   * Climatological share of activity in the three months after the period. Only for real data, a period
   * that ends with the latest data and covers at least a year — otherwise null and nothing is forecast.
   */
  seasonAhead: { months: number[]; share: number } | null;
}

/** Period-specific detection counts, measured on the map with the standard filter and both sensors. */
export interface PeriodTotals {
  considered: number;
  removedLowConfidence: number;
  removedStatic: number;
}

export interface SummaryOptions {
  /** Inclusive month indices (0 = 2000-01) of the selected period; the whole record when omitted. */
  range?: readonly [number, number];
  /** Detection counts of the period; the whole-record counts of the calendar are used when omitted. */
  totals?: PeriodTotals;
}

export type RiskLevel = 'low' | 'moderate' | 'elevated' | 'high';

/** A period needs this many complete years for a trend, and this many months for "recent vs typical". */
export const MIN_TREND_YEARS = 5;
export const MIN_RECENT_MONTHS = 24;

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
  options: SummaryOptions = {},
): AreaSummary | null {
  const all = calendar.points;
  if (!all.length) return null;
  const [from, to] = options.range ?? [Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY];
  const pts = all.filter((p) => {
    const i = monthIndex(p.year, p.month);
    return i >= from && i <= to;
  });
  if (!pts.length) return null;
  const first = pts[0]!;
  const last = pts[pts.length - 1]!;
  const meta = calendar.meta;

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

  // A seasonal profile needs every calendar month at least once.
  let climatology: number[] = [];
  let peakMonths: number[] = [];
  if (pts.length >= 12) {
    const byMonth: number[][] = Array.from({ length: 12 }, () => []);
    for (const p of pts) byMonth[p.month - 1]!.push(p.harmonized);
    climatology = byMonth.map((xs) => round(mean(xs), 2));
    const total = climatology.reduce((a, b) => a + b, 0);
    peakMonths = climatology
      .map((v, i) => [v, i + 1] as const)
      .sort((a, b) => b[0] - a[0])
      .filter(([v], i) => i < 3 && total > 0 && v >= 0.12 * total)
      .map(([, m]) => m)
      .sort((a, b) => a - b);
  }

  const annualMean = mean(annual.map((a) => a.value));
  const trendPctPerYear =
    annual.length >= MIN_TREND_YEARS && annualMean > 0
      ? round((slope(annual.map((a) => a.year), annual.map((a) => a.value)) / annualMean) * 100, 2)
      : null;

  const anomalies = pts
    .filter((p) => p.anomalyZ !== null && p.anomalyZ >= 2)
    .sort((a, b) => b.anomalyZ! - a.anomalyZ!)
    .slice(0, 6)
    .map((p) => ({ month: toYearMonth(p.year, p.month), z: p.anomalyZ! }));

  let recentVsTypical: number | null = null;
  if (pts.length >= MIN_RECENT_MONTHS && climatology.length === 12) {
    const recent = pts.slice(-12);
    const recentSum = recent.reduce((a, p) => a + p.harmonized, 0);
    const typicalSum = recent.reduce((a, p) => a + climatology[p.month - 1]!, 0);
    recentVsTypical = typicalSum > 0 ? round(recentSum / typicalSum, 2) : null;
  }

  // Errors of the harmonized months are dominated by the shared calibration ratio, so the month intervals
  // add up (a conservative interval of the period total).
  let sumH = 0;
  let sumLo = 0;
  let sumHi = 0;
  for (const p of pts) {
    sumH += p.harmonized;
    sumLo += p.lo;
    sumHi += p.hi;
  }
  const relativeUncertainty = sumH > 0 ? round((sumHi - sumLo) / sumH, 3) : null;

  // "The next three months" exists only when the period ends with the latest data — and never on the demo.
  const endsAtLatest = last === all[all.length - 1];
  let seasonAhead: AreaSummary['seasonAhead'] = null;
  const climTotal = climatology.reduce((a, b) => a + b, 0);
  if (!meta.synthetic && endsAtLatest && climatology.length === 12 && climTotal > 0) {
    const ahead = [1, 2, 3].map((k) => ((last.month - 1 + k) % 12) + 1);
    seasonAhead = { months: ahead, share: round(ahead.reduce((a, m) => a + climatology[m - 1]!, 0) / climTotal, 3) };
  }

  const totals = options.totals
    ? {
        detectionsConsidered: options.totals.considered,
        removedLowConfidence: options.totals.removedLowConfidence,
        removedStaticSources: options.totals.removedStatic,
        staticCells: meta.noise.staticCells,
      }
    : {
        detectionsConsidered: meta.noise.considered,
        removedLowConfidence: meta.noise.lowConfidence,
        removedStaticSources: meta.noise.staticSources,
        staticCells: meta.noise.staticCells,
      };

  const recordFirst = all[0]!;
  const recordLast = all[all.length - 1]!;
  return {
    area: { name: area.name, iso2: area.iso2, bbox: [...area.bbox] as [number, number, number, number] },
    period: { from: toYearMonth(first.year, first.month), to: toYearMonth(last.year, last.month), months: pts.length },
    record: { from: toYearMonth(recordFirst.year, recordFirst.month), to: toYearMonth(recordLast.year, recordLast.month) },
    unit: `MODIS-equivalent burning hexagon-days per month (H3 res ${meta.grid.resolution}, ≈${Math.round(meta.grid.cellAreaKm2)} km² cells)`,
    synthetic: meta.synthetic,
    totals,
    sensors: { rawViirsToModis: meta.rawRatio, hexViirsToModis: meta.ratio.value, calibrated: meta.ratio.calibrated },
    annual,
    climatology,
    peakMonths,
    trendPctPerYear,
    anomalies,
    recentVsTypical,
    relativeUncertainty,
    periodTotal: { value: round(sumH, 1), lo: round(sumLo, 1), hi: round(sumHi, 1) },
    interval: meta.interval,
    seasonAhead,
  };
}

/**
 * A transparent heuristic, shown when no language model is configured — never presented as AI. Null when
 * there is nothing to forecast: synthetic data, or a period that does not end with the latest data.
 */
export function riskLevel(s: AreaSummary): RiskLevel | null {
  if (s.synthetic || !s.seasonAhead) return null;
  // Three months ahead hold `share` of the year; 0.25 is "average". Recent activity scales it.
  const season = s.seasonAhead.share / 0.25;
  const recent = s.recentVsTypical ?? 1;
  const score = season * (0.6 + 0.4 * Math.min(2.5, recent)) * (1 + Math.max(0, s.trendPctPerYear ?? 0) / 20);
  if (score >= 1.8) return 'high';
  if (score >= 1.2) return 'elevated';
  if (score >= 0.7) return 'moderate';
  return 'low';
}

export type Finding =
  /** First line on synthetic data: these are generated numbers, not a place and not a forecast. */
  | { kind: 'demo' }
  | { kind: 'risk'; level: RiskLevel; months: number[]; share: number }
  | { kind: 'season'; months: number[] }
  | { kind: 'trend'; pctPerYear: number; fromYear: number; toYear: number }
  | { kind: 'recent'; ratio: number }
  | { kind: 'anomalies'; months: string[] }
  | { kind: 'noise'; removedShare: number; staticCells: number }
  | { kind: 'sensors'; raw: number | null; hex: number }
  | { kind: 'uncertainty'; value: number; lo: number; hi: number; interval?: number }
  /** What the period is too short for (seasonal profile, trend). */
  | { kind: 'limits'; months: number; noSeason: boolean; noTrend: boolean }
  /** Added by the server from the HELIOS API: AI #3 chance of fire next week in the area. */
  | { kind: 'forecast'; max: number; mean: number; typical: number };

/**
 * Rule-based findings, rendered by the client in the interface language. `demo` (synthetic data, or a server
 * that only has the demo) replaces the risk line with a plain "synthetic demo" line.
 */
export function ruleFindings(s: AreaSummary, opts: { demo?: boolean } = {}): Finding[] {
  const demo = opts.demo ?? s.synthetic;
  const out: Finding[] = [];
  if (demo) out.push({ kind: 'demo' });
  else {
    const level = riskLevel(s);
    if (level && s.seasonAhead) out.push({ kind: 'risk', level, months: s.seasonAhead.months, share: s.seasonAhead.share });
  }
  if (s.peakMonths.length) out.push({ kind: 'season', months: s.peakMonths });
  if (s.trendPctPerYear !== null && s.annual.length) {
    out.push({ kind: 'trend', pctPerYear: s.trendPctPerYear, fromYear: s.annual[0]!.year, toYear: s.annual[s.annual.length - 1]!.year });
  }
  if (s.recentVsTypical !== null) out.push({ kind: 'recent', ratio: s.recentVsTypical });
  if (s.anomalies.length) out.push({ kind: 'anomalies', months: s.anomalies.slice(0, 4).map((a) => a.month) });
  const removed = s.totals.removedLowConfidence + s.totals.removedStaticSources;
  if (s.totals.detectionsConsidered > 0) {
    out.push({ kind: 'noise', removedShare: round(removed / s.totals.detectionsConsidered, 3), staticCells: s.totals.staticCells });
  }
  out.push({ kind: 'sensors', raw: s.sensors.rawViirsToModis, hex: s.sensors.hexViirsToModis });
  if (s.relativeUncertainty !== null) out.push({ kind: 'uncertainty', ...s.periodTotal, interval: s.interval });
  const noSeason = s.climatology.length === 0;
  const noTrend = s.trendPctPerYear === null;
  if (noSeason || noTrend) out.push({ kind: 'limits', months: s.period.months, noSeason, noTrend });
  return out;
}

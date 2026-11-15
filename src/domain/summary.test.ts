import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MockDataSource } from '../data/MockDataSource';
import type { CalendarSeries } from '../data/types';
import { monthIndex } from '../lib/date';
import { buildAreaSummary, riskLevel, ruleFindings } from './summary';

const loadJson = async (path: string) => JSON.parse(await readFile(resolve(process.cwd(), 'public', path), 'utf8'));
const ds = new MockDataSource({ baseUrl: 'data', latencyMs: 0, loadJson });
const KZ = [46.47, 40.66, 87.36, 55.39] as const;
const area = { name: 'Kazakhstan', iso2: 'KZ', bbox: KZ };
/** The same series presented as real data (the HELIOS API sends `synthetic: false`). */
const asReal = (c: CalendarSeries): CalendarSeries => ({ ...c, meta: { ...c.meta, synthetic: false } });

describe('area summary for the language model', () => {
  it('holds aggregates only — no detection-level data', async () => {
    const cal = await ds.getCalendar({ bbox: KZ, regionId: 'KZ' });
    const s = buildAreaSummary(cal, area)!;
    expect(s).not.toBeNull();
    expect(s.annual.length).toBe(26); // 2000–2025 complete; 2026 ends in October
    expect(s.climatology).toHaveLength(12);
    expect(s.peakMonths.length).toBeGreaterThan(0);
    expect(s.period).toEqual({ from: '2000-01', to: '2026-10', months: 322 });
    expect(s.unit).toMatch(/H3 res 5/);
    const json = JSON.stringify(s);
    expect(json.length).toBeLessThan(6000);
    expect(json).not.toMatch(/"lng"|"lat"|"rows"|"points"/);
  });

  it('describes exactly the selected period — "What is sent" matches the time bar', async () => {
    const cal = await ds.getCalendar({ bbox: KZ, regionId: 'KZ' });
    const jan2000 = monthIndex(2000, 1);
    const totals = { considered: 2, removedLowConfidence: 0, removedStatic: 0 };
    const s = buildAreaSummary(cal, area, { range: [jan2000, jan2000], totals })!;
    expect(s.period).toEqual({ from: '2000-01', to: '2000-01', months: 1 });
    expect(s.record).toEqual({ from: '2000-01', to: '2026-10' });
    // Too short for a season, a trend or a "recent vs typical" comparison: not computed, not faked.
    expect(s.annual).toEqual([]);
    expect(s.climatology).toEqual([]);
    expect(s.peakMonths).toEqual([]);
    expect(s.trendPctPerYear).toBeNull();
    expect(s.recentVsTypical).toBeNull();
    expect(s.seasonAhead).toBeNull();
    expect(s.totals.detectionsConsidered).toBe(2);
    expect(s.anomalies.every((a) => a.month === '2000-01')).toBe(true);
    const f = ruleFindings(s);
    expect(f.find((x) => x.kind === 'limits')).toMatchObject({ months: 1, noSeason: true, noTrend: true });
  });

  it('keeps every number inside a multi-year period', async () => {
    const cal = await ds.getCalendar({ bbox: KZ, regionId: 'KZ' });
    const s = buildAreaSummary(cal, area, { range: [monthIndex(2010, 1), monthIndex(2015, 12)] })!;
    expect(s.period).toMatchObject({ from: '2010-01', to: '2015-12', months: 72 });
    expect(s.annual.map((a) => a.year)).toEqual([2010, 2011, 2012, 2013, 2014, 2015]);
    expect(s.trendPctPerYear).not.toBeNull();
    expect(s.climatology).toHaveLength(12);
    expect(s.recentVsTypical).not.toBeNull();
    expect(s.anomalies.every((a) => a.month >= '2010-01' && a.month <= '2015-12')).toBe(true);
  });

  it('never forecasts on synthetic data: no season ahead, no risk level, a demo line instead', async () => {
    const cal = await ds.getCalendar({ bbox: KZ });
    const s = buildAreaSummary(cal, { name: 'Box', iso2: null, bbox: KZ })!;
    expect(s.synthetic).toBe(true);
    expect(s.seasonAhead).toBeNull();
    expect(riskLevel(s)).toBeNull();
    const f = ruleFindings(s);
    expect(f[0]!.kind).toBe('demo');
    expect(f.some((x) => x.kind === 'risk')).toBe(false);
    const noise = f.find((x) => x.kind === 'noise');
    expect(noise && noise.kind === 'noise' && noise.removedShare).toBeGreaterThan(0);
  });

  it('forecasts on real data only when the period ends with the latest data', async () => {
    const cal = asReal(await ds.getCalendar({ bbox: KZ, regionId: 'KZ' }));
    const latest = buildAreaSummary(cal, area)!;
    expect(latest.seasonAhead?.months).toEqual([11, 12, 1]);
    expect(['low', 'moderate', 'elevated', 'high']).toContain(riskLevel(latest));
    expect(ruleFindings(latest)[0]!.kind).toBe('risk');
    const past = buildAreaSummary(cal, area, { range: [monthIndex(2005, 1), monthIndex(2015, 12)] })!;
    expect(past.seasonAhead).toBeNull();
    expect(riskLevel(past)).toBeNull();
    expect(ruleFindings(past).some((x) => x.kind === 'risk')).toBe(false);
    // A server that only has the demo forces the demo brief even for a "real" summary.
    expect(ruleFindings(latest, { demo: true })[0]!.kind).toBe('demo');
  });

  it('returns null for an empty area or a period outside the record', async () => {
    const cal = await ds.getCalendar({ bbox: [-40, -40, -30, -30] });
    expect(buildAreaSummary(cal, { name: 'Ocean', iso2: null, bbox: [-40, -40, -30, -30] })).toBeNull();
    const kz = await ds.getCalendar({ bbox: KZ });
    expect(buildAreaSummary(kz, area, { range: [monthIndex(2030, 1), monthIndex(2030, 12)] })).toBeNull();
  });
});

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MockDataSource } from '../data/MockDataSource';
import { buildAreaSummary, riskLevel, ruleFindings } from './summary';

const loadJson = async (path: string) => JSON.parse(await readFile(resolve(process.cwd(), 'public', path), 'utf8'));
const ds = new MockDataSource({ baseUrl: 'data', latencyMs: 0, loadJson });
const KZ = [46.47, 40.66, 87.36, 55.39] as const;

describe('area summary for the language model', () => {
  it('holds aggregates only — no detection-level data', async () => {
    const cal = await ds.getCalendar({ bbox: KZ, regionId: 'KZ' });
    const s = buildAreaSummary(cal, { name: 'Kazakhstan', iso2: 'KZ', bbox: KZ })!;
    expect(s).not.toBeNull();
    expect(s.annual.length).toBe(26); // 2000–2025 complete; 2026 ends in October
    expect(s.climatology).toHaveLength(12);
    expect(s.peakMonths.length).toBeGreaterThan(0);
    expect(s.seasonAhead.months).toEqual([11, 12, 1]);
    const json = JSON.stringify(s);
    expect(json.length).toBeLessThan(6000);
    expect(json).not.toMatch(/"lng"|"lat"|"rows"|"points"/);
  });

  it('produces findings and a bounded risk level', async () => {
    const cal = await ds.getCalendar({ bbox: KZ });
    const s = buildAreaSummary(cal, { name: 'Box', iso2: null, bbox: KZ })!;
    const f = ruleFindings(s);
    expect(f[0]!.kind).toBe('risk');
    expect(['low', 'moderate', 'elevated', 'high']).toContain(riskLevel(s));
    const noise = f.find((x) => x.kind === 'noise');
    expect(noise && noise.kind === 'noise' && noise.removedShare).toBeGreaterThan(0);
  });

  it('returns null for an empty area', async () => {
    const cal = await ds.getCalendar({ bbox: [-40, -40, -30, -30] });
    expect(buildAreaSummary(cal, { name: 'Ocean', iso2: null, bbox: [-40, -40, -30, -30] })).toBeNull();
  });
});

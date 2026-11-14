import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { VIIRS_START_INDEX, MONTH_COUNT, AQUA_START_INDEX } from '../../src/lib/date';
import { isValidBBox } from '../../src/lib/geo';
import { generateAll } from './generate';
import { DEMO_BBOX } from './zone-defs';

const data = generateAll();
const cal = data.demoCalendar.points;

const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');

describe('mock generator', () => {
  it('is deterministic for a fixed seed and changes with the seed', () => {
    const again = generateAll();
    expect(hash(again.zones)).toBe(hash(data.zones));
    expect(hash(again.fires)).toBe(hash(data.fires));
    expect(hash(again.intro)).toBe(hash(data.intro));
    expect(hash(generateAll(7).zones)).not.toBe(hash(data.zones));
  });

  it('covers 2000-01 … 2026-10 with VIIRS only from 2012', () => {
    expect(cal).toHaveLength(MONTH_COUNT);
    expect(cal[0]).toMatchObject({ year: 2000, month: 1 });
    expect(cal.at(-1)).toMatchObject({ year: 2026, month: 10 });
    cal.forEach((p, t) => {
      if (t < VIIRS_START_INDEX) expect(p.viirsRaw).toBeNull();
      else expect(p.viirsRaw).not.toBeNull();
    });
  });

  it('peaks in spring (Mar–May) and autumn (Sep–Oct) in the demo region', () => {
    const byMonth = Array.from({ length: 12 }, (_, m) =>
      cal.filter((p) => p.month === m + 1).reduce((a, p) => a + p.harmonized, 0),
    );
    const ranked = byMonth.map((v, i) => [v, i + 1] as const).sort((a, b) => b[0] - a[0]);
    const top4 = ranked.slice(0, 4).map(([, m]) => m);
    expect(top4.every((m) => [3, 4, 5, 9, 10].includes(m))).toBe(true);
    expect(top4.some((m) => m <= 5)).toBe(true);
    expect(top4.some((m) => m >= 9)).toBe(true);
  });

  it('raw VIIRS is 3.5–4× MODIS after 2012 (the false jump is in the raw data)', () => {
    const overlap = cal.slice(VIIRS_START_INDEX);
    const ratio = overlap.reduce((a, p) => a + (p.viirsRaw ?? 0), 0) / overlap.reduce((a, p) => a + p.modis, 0);
    expect(ratio).toBeGreaterThanOrEqual(3.5);
    expect(ratio).toBeLessThanOrEqual(4);
    expect(data.demoCalendar.meta.ratio.value).toBeCloseTo(ratio, 2);
  });

  it('harmonized series has no step at 2012', () => {
    const annual = (y: number) => cal.filter((p) => p.year === y).reduce((a, p) => a + p.harmonized, 0);
    const before = (annual(2009) + annual(2010) + annual(2011)) / 3;
    const after = (annual(2012) + annual(2013) + annual(2014)) / 3;
    // naive "MODIS then VIIRS" would jump ~3.8×; harmonized stays within normal interannual spread
    expect(after / before).toBeGreaterThan(0.7);
    expect(after / before).toBeLessThan(1.4);
  });

  it('the 90% interval is relatively wider before 2012 than after, and widest before Aqua', () => {
    const relWidth = (from: number, to: number) => {
      const xs = cal.slice(from, to).filter((p) => p.harmonized > 200);
      return xs.reduce((a, p) => a + (p.hi - p.lo) / p.harmonized, 0) / xs.length;
    };
    const terra = relWidth(0, AQUA_START_INDEX);
    const terraAqua = relWidth(AQUA_START_INDEX, VIIRS_START_INDEX);
    const dual = relWidth(VIIRS_START_INDEX, MONTH_COUNT);
    expect(terra).toBeGreaterThan(terraAqua);
    expect(terraAqua).toBeGreaterThan(dual);
    cal.forEach((p) => {
      expect(p.lo).toBeLessThanOrEqual(p.harmonized);
      expect(p.hi).toBeGreaterThanOrEqual(p.harmonized);
      expect(p.lo).toBeGreaterThanOrEqual(0);
    });
  });

  it('has 3–5 months with anomalyZ ≥ 2 in the demo region', () => {
    const n = cal.filter((p) => p.anomalyZ !== null && p.anomalyZ >= 2).length;
    expect(n).toBeGreaterThanOrEqual(3);
    expect(n).toBeLessThanOrEqual(5);
  });

  it('produces several thousand well-formed fire points clustered in the focus region', () => {
    const rows = data.fires.rows;
    expect(rows.length).toBeGreaterThan(3000);
    expect(rows.length).toBeLessThan(12000);
    for (const [lng, lat, sensor, day, frp, conf] of rows) {
      expect(lng).toBeGreaterThanOrEqual(-180);
      expect(lng).toBeLessThanOrEqual(180);
      expect(Math.abs(lat)).toBeLessThanOrEqual(90);
      expect([0, 1]).toContain(sensor);
      expect(day).toBeGreaterThanOrEqual(0);
      expect(frp).toBeGreaterThan(0);
      expect([0, 1, 2]).toContain(conf);
    }
    const viirsBefore2012 = rows.filter((r) => r[2] === 1 && r[3] < 4383); // 2012-01-01 = day 4383
    expect(viirsBefore2012).toHaveLength(0);
    const [w, s, e, n] = DEMO_BBOX;
    const inDemo = rows.filter((r) => r[0] >= w && r[0] <= e && r[1] >= s && r[1] <= n).length;
    expect(inDemo / rows.length).toBeGreaterThan(0.4);
  });

  it('keeps the intro globe light: at most a few hundred aggregates', () => {
    expect(data.intro.rows.length).toBeGreaterThan(100);
    expect(data.intro.rows.length).toBeLessThanOrEqual(400);
    expect(Math.max(...data.intro.rows.map((r) => r[2]))).toBe(1);
  });

  it('ships at least 30 countries with valid boxes, focused on Central Asia', () => {
    const countries = data.regions.filter((r) => r.kind === 'country');
    expect(countries.length).toBeGreaterThanOrEqual(30);
    expect(new Set(data.regions.map((r) => r.id)).size).toBe(data.regions.length);
    for (const r of data.regions) expect(isValidBBox(r.bbox)).toBe(true);
    for (const id of ['KZ', 'UZ', 'KG', 'TJ', 'TM']) expect(countries.some((c) => c.id === id)).toBe(true);
  });
});

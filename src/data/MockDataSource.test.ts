import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MockDataSource } from './MockDataSource';
import { DataSourceError } from './types';

const loadJson = async (path: string) => JSON.parse(await readFile(resolve(process.cwd(), 'public', path), 'utf8'));
const make = (mode?: 'normal' | 'error' | 'empty') => new MockDataSource({ baseUrl: 'data', latencyMs: 0, mode, loadJson });

const KZ = [46.47, 40.66, 87.36, 55.39] as const;

describe('MockDataSource', () => {
  it('filters fire points by box and inclusive date range', async () => {
    const ds = make();
    const fc = await ds.getFirePoints(KZ, { start: '2015-01-01', end: '2015-12-31' });
    expect(fc.features.length).toBeGreaterThan(50);
    for (const f of fc.features) {
      expect(f.properties.date >= '2015-01-01' && f.properties.date <= '2015-12-31').toBe(true);
      const [lng, lat] = f.geometry.coordinates as [number, number];
      expect(lng >= KZ[0] && lng <= KZ[2] && lat >= KZ[1] && lat <= KZ[3]).toBe(true);
    }
    const sensors = new Set(fc.features.map((f) => f.properties.sensor));
    expect(sensors).toEqual(new Set(['MODIS', 'VIIRS']));
  });

  it('returns only MODIS before 2012', async () => {
    const fc = await make().getFirePoints(KZ, { start: '2005-01-01', end: '2011-12-31' });
    expect(fc.features.every((f) => f.properties.sensor === 'MODIS')).toBe(true);
  });

  it('builds a calendar for any box and reports no coverage over the ocean', async () => {
    const ds = make();
    const cal = await ds.getCalendar({ bbox: KZ });
    expect(cal.points).toHaveLength(322);
    expect(cal.meta.coverage).toBe(1);
    const ocean = await ds.getCalendar({ bbox: [-40, -40, -30, -30] });
    expect(ocean.points).toHaveLength(0);
    expect(ocean.meta.coverage).toBe(0);
  });

  it('narrows a box to the country outline when a country id is given', async () => {
    const ds = make();
    const box = await ds.getCalendar({ bbox: KZ });
    const country = await ds.getCalendar({ bbox: KZ, regionId: 'KZ' });
    expect(country.meta.noise.considered).toBeGreaterThan(0);
    // The KZ box also covers parts of Russia, Uzbekistan and China: the outline must keep fewer detections.
    expect(country.meta.noise.considered).toBeLessThan(box.meta.noise.considered);
  });

  it('removes low-confidence pixels and persistent static sources', async () => {
    const cal = await make().getCalendar({ bbox: KZ });
    expect(cal.meta.noise.lowConfidence).toBeGreaterThan(0);
    expect(cal.meta.noise.staticSources).toBeGreaterThan(0);
    expect(cal.meta.noise.staticCells).toBeGreaterThan(3);
    expect(cal.meta.grid.system).toBe('h3');
  });

  it('counting H3 hexagon-days shrinks the raw VIIRS/MODIS pixel ratio', async () => {
    const meta = (await make().getCalendar({ bbox: KZ })).meta;
    expect(meta.rawRatio!).toBeGreaterThan(3);
    // One fire front lights several 375 m pixels on one overpass but one hexagon: the gap must shrink a lot.
    expect(meta.ratio.value).toBeLessThan(meta.rawRatio! * 0.6);
    expect(meta.ratio.value).toBeGreaterThan(1);
  });

  it('serves compact detection rows and the onboard model', async () => {
    const ds = make();
    const det = await ds.getDetections();
    expect(det.rows.length).toBeGreaterThan(10_000);
    expect(det.rows[0]).toHaveLength(7);
    const model = await ds.getOnboardModel();
    expect(model.weights).toHaveLength(model.features.length);
    expect(model.trainedOn.synthetic).toBe(true);
  });

  it('searches regions in EN and RU, ranked, with featured on empty query', async () => {
    const ds = make();
    expect((await ds.searchRegions('kaz'))[0]!.id).toBe('KZ');
    expect((await ds.searchRegions('Казах'))[0]!.id).toBe('KZ');
    expect((await ds.searchRegions('костанай'))[0]!.id).toBe('KZ-KUS');
    expect((await ds.searchRegions('uz'))[0]!.id).toBe('UZ');
    const featured = await ds.searchRegions('');
    expect(featured.length).toBeGreaterThan(2);
    expect(featured.every((r) => r.featured)).toBe(true);
    expect(await ds.searchRegions('zzzzzz')).toEqual([]);
  });

  it('can simulate failures and empty responses', async () => {
    await expect(make('error').getCalendar({ bbox: KZ })).rejects.toBeInstanceOf(DataSourceError);
    const empty = await make('empty').getCalendar({ bbox: KZ });
    expect(empty.points).toHaveLength(0);
  });

  it('retries a failed load instead of caching the error', async () => {
    let calls = 0;
    const flaky = new MockDataSource({
      baseUrl: 'data',
      latencyMs: 0,
      loadJson: async (path) => {
        calls += 1;
        if (calls === 1) throw new DataSourceError('network', 'offline');
        return loadJson(path);
      },
    });
    await expect(flaky.getCalendar({ bbox: KZ })).rejects.toThrow('offline');
    await expect(flaky.getCalendar({ bbox: KZ })).resolves.toMatchObject({ bbox: KZ });
  });
});

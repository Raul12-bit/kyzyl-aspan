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
    const cal = await ds.getCalendar(KZ);
    expect(cal.points).toHaveLength(322);
    expect(cal.meta.coverage).toBe(1);
    const ocean = await ds.getCalendar([-40, -40, -30, -30]);
    expect(ocean.points).toHaveLength(0);
    expect(ocean.meta.coverage).toBe(0);
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
    await expect(make('error').getCalendar(KZ)).rejects.toBeInstanceOf(DataSourceError);
    const empty = await make('empty').getCalendar(KZ);
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
    await expect(flaky.getCalendar(KZ)).rejects.toThrow('offline');
    await expect(flaky.getCalendar(KZ)).resolves.toMatchObject({ bbox: KZ });
  });
});

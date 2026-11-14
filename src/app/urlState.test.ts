import { describe, expect, it } from 'vitest';
import { FULL_RANGE, parseAppParams, writeAppParams } from './urlState';

describe('url state', () => {
  it('parses a shared link', () => {
    const p = parseAppParams(new URLSearchParams('bbox=46.47,40.66,87.36,55.39&region=KZ&from=2012-01&to=2020-12'));
    expect(p.bbox).toEqual([46.47, 40.66, 87.36, 55.39]);
    expect(p.regionId).toBe('KZ');
    expect(p.range).toEqual([144, 251]);
  });

  it('ignores invalid or hostile values', () => {
    const p = parseAppParams(new URLSearchParams('bbox=1,2,3&region=<script>&from=2050-01&to=abc'));
    expect(p).toEqual({ bbox: null, regionId: null, range: FULL_RANGE });
  });

  it('drops the region hint when there is no box and swaps reversed ranges', () => {
    const p = parseAppParams(new URLSearchParams('region=KZ&from=2020-01&to=2010-01'));
    expect(p.regionId).toBeNull();
    expect(p.range[0]).toBeLessThan(p.range[1]);
  });

  it('round-trips and keeps unrelated params', () => {
    const base = new URLSearchParams('mock=slow');
    const written = writeAppParams(base, { bbox: [60, 40, 70, 50], regionId: null, range: [12, 23] });
    expect(written.get('mock')).toBe('slow');
    expect(written.get('from')).toBe('2001-01');
    expect(written.get('to')).toBe('2001-12');
    expect(parseAppParams(written)).toEqual({ bbox: [60, 40, 70, 50], regionId: null, range: [12, 23] });
  });

  it('omits the time window when it is the full archive', () => {
    const written = writeAppParams(new URLSearchParams(), { bbox: null, regionId: null, range: FULL_RANGE });
    expect(written.toString()).toBe('');
  });
});

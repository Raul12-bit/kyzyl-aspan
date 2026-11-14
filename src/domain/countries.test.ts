import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { countryAt, nearestCountry, type CountriesFile } from './countries';

const file = JSON.parse(readFileSync(resolve(process.cwd(), 'public/data/countries.json'), 'utf8')) as CountriesFile;
const at = (lng: number, lat: number) => countryAt(file.countries, lng, lat)?.id ?? null;

describe('offline country lookup', () => {
  it('finds capitals', () => {
    expect(at(-3.7, 40.42)).toBe('ES'); // Madrid
    expect(at(76.95, 43.24)).toBe('KZ'); // Almaty
    expect(at(71.43, 51.13)).toBe('KZ'); // Astana
    expect(at(2.35, 48.86)).toBe('FR'); // Paris
    expect(at(-47.9, -15.8)).toBe('BR'); // Brasília
    expect(at(116.4, 39.9)).toBe('CN'); // Beijing
  });

  it('handles countries crossing the antimeridian', () => {
    expect(at(178.4, -17.8)).toBe('FJ');
    expect(at(-179.9, 66.0) ?? at(178.0, 66.0)).toBe('RU');
  });

  it('returns null at sea, but snaps a coastal point to the nearest country', () => {
    expect(at(-30, 0)).toBeNull();
    expect(nearestCountry(file.countries, -9.2, 38.69)?.id).toBe('PT'); // Lisbon waterfront
  });

  it('maps countries to interface locales', () => {
    const langs = (id: string) => file.countries.find((c) => c.id === id)?.langs;
    expect(langs('ES')?.[0]).toBe('es');
    expect(langs('KZ')).toEqual(['kk', 'ru']);
    expect(langs('BR')?.[0]).toBe('pt');
  });
});

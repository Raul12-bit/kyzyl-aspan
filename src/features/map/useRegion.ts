import { useRegionSearch } from '@/data/queries';
import type { Region } from '@/data/types';
import { findCountry, useCountries } from '@/features/geo/countries';
import { useI18n, type Locale } from '@/i18n';

/** Resolves a region id from the URL into a Region (searching by its id). */
export function useRegion(regionId: string | null): Region | null {
  const q = useRegionSearch(regionId ?? '');
  if (!regionId) return null;
  return q.data?.find((r) => r.id === regionId) ?? null;
}

/** Region names ship in EN and RU; other languages use the browser's localized country names. */
export function regionName(r: Region, locale: Locale, country: (iso2: string, fallback?: string) => string): string {
  if (locale === 'en' || locale === 'ru') return r.name[locale];
  if (r.kind === 'country' && r.iso2) return country(r.iso2, r.name.en);
  return r.name.en;
}

/**
 * Display name of the current area: the region's name, any country by ISO code (all 175 outlines
 * can be clicked on the map, not only the curated regions), or "Custom area".
 */
export function useAreaName(regionId: string | null): string {
  const { m, locale, fmt } = useI18n();
  const region = useRegion(regionId);
  const countries = useCountries();
  if (region) return regionName(region, locale, fmt.country);
  const c = findCountry(countries.data, regionId);
  if (c) return fmt.country(c.id, c.name);
  return m.map.area.customArea;
}

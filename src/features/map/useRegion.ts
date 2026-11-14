import { useRegionSearch } from '@/data/queries';
import type { Region } from '@/data/types';
import { useI18n } from '@/i18n';

/** Resolves a region id from the URL into a Region (searching by its id). */
export function useRegion(regionId: string | null): Region | null {
  const q = useRegionSearch(regionId ?? '');
  if (!regionId) return null;
  return q.data?.find((r) => r.id === regionId) ?? null;
}

/** Display name of the current area: region name in the current language, or "Custom area". */
export function useAreaName(regionId: string | null): string {
  const { m, locale } = useI18n();
  const region = useRegion(regionId);
  return region ? region.name[locale] : m.map.area.customArea;
}

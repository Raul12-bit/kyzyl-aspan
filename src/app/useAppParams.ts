import { useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { BBox } from '@/data/types';
import { parseAppParams, writeAppParams, type AppParams } from './urlState';

/** URL-backed app state (area + time window). Writes replace history entries to avoid spam. */
export function useAppParams() {
  const [search, setSearch] = useSearchParams();
  const params = useMemo(() => parseAppParams(search), [search]);

  const update = useCallback(
    (patch: Partial<AppParams>) => {
      setSearch(
        (prev) => {
          const current = parseAppParams(prev);
          return writeAppParams(prev, { ...current, ...patch });
        },
        { replace: true },
      );
    },
    [setSearch],
  );

  const setArea = useCallback(
    (bbox: BBox | null, regionId: string | null = null) => update({ bbox, regionId }),
    [update],
  );
  const setRange = useCallback((range: [number, number]) => update({ range }), [update]);

  return { ...params, search: search.toString(), setArea, setRange };
}

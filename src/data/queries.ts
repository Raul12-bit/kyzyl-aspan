import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { bboxToParam } from '@/lib/geo';
import { useDataSource } from './DataSourceContext';
import type { BBox, DateRange } from './types';

export const queryKeys = {
  fires: (bbox: BBox, range: DateRange) => ['fires', bboxToParam(bbox), range.start, range.end] as const,
  calendar: (bbox: BBox) => ['calendar', bboxToParam(bbox)] as const,
  regions: (query: string) => ['regions', query.trim().toLowerCase()] as const,
  overview: ['overview'] as const,
};

export function useFirePoints(bbox: BBox, range: DateRange, enabled = true) {
  const ds = useDataSource();
  return useQuery({
    queryKey: queryKeys.fires(bbox, range),
    queryFn: ({ signal }) => ds.getFirePoints(bbox, range, { signal }),
    enabled,
    staleTime: Number.POSITIVE_INFINITY,
    placeholderData: keepPreviousData,
  });
}

export function useCalendar(bbox: BBox | null) {
  const ds = useDataSource();
  return useQuery({
    queryKey: bbox ? queryKeys.calendar(bbox) : ['calendar', 'none'],
    queryFn: ({ signal }) => ds.getCalendar(bbox!, { signal }),
    enabled: bbox !== null,
    staleTime: Number.POSITIVE_INFINITY,
  });
}

export function useRegionSearch(query: string) {
  const ds = useDataSource();
  return useQuery({
    queryKey: queryKeys.regions(query),
    queryFn: ({ signal }) => ds.searchRegions(query, { signal }),
    staleTime: Number.POSITIVE_INFINITY,
    placeholderData: keepPreviousData,
  });
}

export function useOverview() {
  const ds = useDataSource();
  return useQuery({
    queryKey: queryKeys.overview,
    queryFn: ({ signal }) => ds.getOverview({ signal }),
    staleTime: Number.POSITIVE_INFINITY,
  });
}

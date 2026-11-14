import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { bboxToParam } from '@/lib/geo';
import { useDataSource } from './DataSourceContext';
import type { AreaQuery, BBox, DateRange } from './types';

export const queryKeys = {
  fires: (bbox: BBox, range: DateRange) => ['fires', bboxToParam(bbox), range.start, range.end] as const,
  calendar: (area: AreaQuery) => ['calendar', bboxToParam(area.bbox), area.regionId ?? ''] as const,
  detections: ['detections'] as const,
  onboardModel: ['onboard-model'] as const,
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

export function useCalendar(area: AreaQuery | null) {
  const ds = useDataSource();
  return useQuery({
    queryKey: area ? queryKeys.calendar(area) : ['calendar', 'none'],
    queryFn: ({ signal }) => ds.getCalendar(area!, { signal }),
    enabled: area !== null,
    staleTime: Number.POSITIVE_INFINITY,
    placeholderData: keepPreviousData,
  });
}

export function useDetections() {
  const ds = useDataSource();
  return useQuery({
    queryKey: queryKeys.detections,
    queryFn: ({ signal }) => ds.getDetections({ signal }),
    staleTime: Number.POSITIVE_INFINITY,
  });
}

export function useOnboardModel() {
  const ds = useDataSource();
  return useQuery({
    queryKey: queryKeys.onboardModel,
    queryFn: ({ signal }) => ds.getOnboardModel({ signal }),
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

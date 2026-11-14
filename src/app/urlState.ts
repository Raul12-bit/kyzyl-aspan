import type { BBox } from '@/data/types';
import { MONTH_COUNT, monthIndex, parseYearMonth, fromMonthIndex, toYearMonth } from '@/lib/date';
import { bboxToParam, parseBBoxParam } from '@/lib/geo';

/** Everything shareable lives in the query string: area, region name hint and time window. */
export interface AppParams {
  bbox: BBox | null;
  regionId: string | null;
  /** Inclusive month indices. */
  range: [number, number];
}

export const FULL_RANGE: [number, number] = [0, MONTH_COUNT - 1];

const REGION_ID = /^[A-Z]{2}(-[A-Z]{2,3})?$/;

export function parseAppParams(search: URLSearchParams): AppParams {
  const bbox = parseBBoxParam(search.get('bbox'));
  const regionRaw = search.get('region');
  const regionId = bbox && regionRaw && REGION_ID.test(regionRaw) ? regionRaw : null;
  const from = parseYearMonth(search.get('from'));
  const to = parseYearMonth(search.get('to'));
  let start = from ? monthIndex(from.year, from.month) : FULL_RANGE[0];
  let end = to ? monthIndex(to.year, to.month) : FULL_RANGE[1];
  if (start > end) [start, end] = [end, start];
  return { bbox, regionId, range: [start, end] };
}

/** Writes params into a copy of `base`, keeping unrelated params (e.g. ?mock=slow). */
export function writeAppParams(base: URLSearchParams, params: AppParams): URLSearchParams {
  const next = new URLSearchParams(base);
  if (params.bbox) next.set('bbox', bboxToParam(params.bbox));
  else next.delete('bbox');
  if (params.bbox && params.regionId) next.set('region', params.regionId);
  else next.delete('region');
  const [start, end] = params.range;
  if (start === FULL_RANGE[0] && end === FULL_RANGE[1]) {
    next.delete('from');
    next.delete('to');
  } else {
    const a = fromMonthIndex(start);
    const b = fromMonthIndex(end);
    next.set('from', toYearMonth(a.year, a.month));
    next.set('to', toYearMonth(b.year, b.month));
  }
  return next;
}

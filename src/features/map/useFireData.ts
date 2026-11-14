import { useMemo } from 'react';
import type { FeatureCollection, Point } from 'geojson';
import { useFirePoints } from '@/data/queries';
import type { FireFeature, FireProperties, Sensor } from '@/data/types';
import { isoToMonthIndex, MONTH_COUNT } from '@/lib/date';
import { FULL_DATES, WORLD } from './map.config';

export interface SensorSeries {
  features: FireFeature[];
  /** Month index of each feature (parallel to `features`, ascending). */
  months: Int16Array;
  /** Detections per month in the sample. */
  histogram: Int32Array;
  /** Prefix sums of `histogram` for O(1) range counts. */
  cumulative: Int32Array;
}

export interface FireIndex {
  MODIS: SensorSeries;
  VIIRS: SensorSeries;
  total: number;
}

function buildSeries(features: FireFeature[]): SensorSeries {
  const sorted = [...features].sort((a, b) => (a.properties.date < b.properties.date ? -1 : a.properties.date > b.properties.date ? 1 : 0));
  const months = new Int16Array(sorted.length);
  const histogram = new Int32Array(MONTH_COUNT);
  sorted.forEach((f, i) => {
    const m = isoToMonthIndex(f.properties.date);
    months[i] = m;
    if (m >= 0 && m < MONTH_COUNT) histogram[m]! += 1;
  });
  const cumulative = new Int32Array(MONTH_COUNT + 1);
  for (let i = 0; i < MONTH_COUNT; i++) cumulative[i + 1] = cumulative[i]! + histogram[i]!;
  return { features: sorted, months, histogram, cumulative };
}

/**
 * The map loads the whole (sampled) archive once and filters by time on the client, so the time
 * slider and the 26-year playback stay instant. A real API would serve bbox/time tiles instead.
 */
export function useFireIndex() {
  const query = useFirePoints(WORLD, FULL_DATES);
  const index = useMemo<FireIndex | null>(() => {
    if (!query.data) return null;
    const by: Record<Sensor, FireFeature[]> = { MODIS: [], VIIRS: [] };
    for (const f of query.data.features) by[f.properties.sensor].push(f);
    return { MODIS: buildSeries(by.MODIS), VIIRS: buildSeries(by.VIIRS), total: query.data.features.length };
  }, [query.data]);
  return { ...query, index };
}

function lowerBound(arr: Int16Array, value: number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid]! < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export function sliceRange(series: SensorSeries, range: readonly [number, number]): FeatureCollection<Point, FireProperties> {
  const a = lowerBound(series.months, range[0]);
  const b = lowerBound(series.months, range[1] + 1);
  return { type: 'FeatureCollection', features: series.features.slice(a, b) };
}

export function countRange(series: SensorSeries, range: readonly [number, number]): number {
  const a = Math.max(0, range[0]);
  const b = Math.min(MONTH_COUNT - 1, range[1]);
  return b < a ? 0 : series.cumulative[b + 1]! - series.cumulative[a]!;
}

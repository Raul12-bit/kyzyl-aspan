import type { BBox, CalendarSeries, DateRange, FireCollection, Region } from './types';

export interface RequestOptions {
  signal?: AbortSignal;
}

/** Aggregated activity for the intro globe: a few hundred weighted points. */
export interface ActivityOverview {
  /** [lng, lat, weight 0…1] */
  points: [number, number, number][];
  synthetic: boolean;
}

/**
 * The only door between the UI and fire data. Swap implementations in `src/data/index.ts`.
 * All methods must be safe to call concurrently and honour `signal` for cancellation.
 */
export interface DataSource {
  readonly id: 'mock' | 'http';
  getFirePoints(bbox: BBox, range: DateRange, options?: RequestOptions): Promise<FireCollection>;
  getCalendar(bbox: BBox, options?: RequestOptions): Promise<CalendarSeries>;
  /** Empty query returns featured regions. */
  searchRegions(query: string, options?: RequestOptions): Promise<Region[]>;
  /** Not in the original brief: the intro globe needs a light, pre-aggregated overview. */
  getOverview(options?: RequestOptions): Promise<ActivityOverview>;
}

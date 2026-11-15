import type { OnboardModel } from '@/domain/onboard';
import type { AreaQuery, BBox, CalendarSeries, DateRange, DetectionArchive, FireCollection, Region } from './types';

export interface RequestOptions {
  signal?: AbortSignal;
}

/** Aggregated activity for the intro globe: a few hundred weighted points. */
export interface ActivityOverview {
  /** [lng, lat, weight 0…1] */
  points: [number, number, number][];
  synthetic: boolean;
  /** Real backend only: which NASA FIRMS feeds and window the points come from. */
  source?: string;
  from?: string;
  to?: string;
  /** Raw detections behind the points (before aggregation to cells). */
  detections?: number;
  cells?: number;
}

/**
 * The only door between the UI and fire data. Swap implementations in `src/data/index.ts`.
 * All methods must be safe to call concurrently and honour `signal` for cancellation.
 * The HTTP contract for the backend is documented in HttpDataSource.ts and PROGRESS.md.
 */
export interface DataSource {
  readonly id: 'mock' | 'http';
  getFirePoints(bbox: BBox, range: DateRange, options?: RequestOptions): Promise<FireCollection>;
  /**
   * Compact detection rows for the whole (sampled) archive. The client runs the noise filter and the
   * H3 aggregation on them (src/domain), so the map can re-filter instantly while scrubbing time.
   */
  getDetections(options?: RequestOptions): Promise<DetectionArchive>;
  /** Harmonized burn calendar of an area; `regionId` (ISO 3166-1 alpha-2) narrows a box to a country outline. */
  getCalendar(area: AreaQuery, options?: RequestOptions): Promise<CalendarSeries>;
  /** Empty query returns featured regions. */
  searchRegions(query: string, options?: RequestOptions): Promise<Region[]>;
  /** The intro globe needs a light, pre-aggregated overview. */
  getOverview(options?: RequestOptions): Promise<ActivityOverview>;
  /** Weights of the tiny onboard triage classifier (see src/domain/onboard.ts). */
  getOnboardModel(options?: RequestOptions): Promise<OnboardModel>;
}

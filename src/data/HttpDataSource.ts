import type { OnboardModel } from '@/domain/onboard';
import { bboxToParam } from '@/lib/geo';
import type { ActivityOverview, DataSource, RequestOptions } from './DataSource';
import {
  DataSourceError,
  type AreaQuery,
  type BBox,
  type CalendarSeries,
  type DetectionArchive,
  type DateRange,
  type FireCollection,
  type Region,
} from './types';

/**
 * Client for the real Kyzyl Aspan API (enable with VITE_DATA_SOURCE=http + VITE_API_URL).
 *
 * Expected contract (JSON, UTF-8, CORS enabled) — see PROGRESS.md, section "API contract":
 *   GET {base}/fires?bbox=w,s,e,n&start=YYYY-MM-DD&end=YYYY-MM-DD → FireCollection
 *   GET {base}/detections                                          → DetectionArchive (compact rows)
 *   GET {base}/calendar?bbox=w,s,e,n[&region=KZ]                   → CalendarSeries
 *   GET {base}/regions?q=text                                      → Region[]
 *   GET {base}/overview                                            → ActivityOverview
 *   GET {base}/onboard-model                                       → OnboardModel
 */
export class HttpDataSource implements DataSource {
  readonly id = 'http' as const;

  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs = 15_000,
  ) {}

  private async get<T>(path: string, params: Record<string, string>, guard: (v: unknown) => v is T, options?: RequestOptions): Promise<T> {
    const url = new URL(`${this.baseUrl.replace(/\/$/, '')}/${path}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const signal = options?.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    let res: Response;
    try {
      res = await fetch(url, { signal, headers: { Accept: 'application/json' } });
    } catch (cause) {
      if (options?.signal?.aborted) throw cause;
      if (timeout.aborted) throw new DataSourceError('timeout', `${path} timed out after ${this.timeoutMs} ms`, { cause });
      throw new DataSourceError('network', `Network error while requesting ${path}`, { cause });
    }
    if (!res.ok) {
      throw new DataSourceError(res.status === 404 ? 'not-found' : 'server', `${path} → HTTP ${res.status}`);
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch (cause) {
      throw new DataSourceError('invalid-response', `${path} returned invalid JSON`, { cause });
    }
    if (!guard(body)) throw new DataSourceError('invalid-response', `${path} returned an unexpected shape`);
    return body;
  }

  getFirePoints(bbox: BBox, range: DateRange, options?: RequestOptions): Promise<FireCollection> {
    return this.get('fires', { bbox: bboxToParam(bbox), start: range.start, end: range.end }, isFireCollection, options);
  }

  getDetections(options?: RequestOptions): Promise<DetectionArchive> {
    return this.get('detections', {}, isDetectionArchive, options);
  }

  getCalendar(area: AreaQuery, options?: RequestOptions): Promise<CalendarSeries> {
    const params: Record<string, string> = { bbox: bboxToParam(area.bbox) };
    if (area.regionId) params.region = area.regionId;
    return this.get('calendar', params, isCalendarSeries, options);
  }

  getOnboardModel(options?: RequestOptions): Promise<OnboardModel> {
    return this.get('onboard-model', {}, isOnboardModel, options);
  }

  searchRegions(query: string, options?: RequestOptions): Promise<Region[]> {
    return this.get('regions', { q: query }, isRegionList, options);
  }

  getOverview(options?: RequestOptions): Promise<ActivityOverview> {
    return this.get('overview', {}, isOverview, options);
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

function isFireCollection(v: unknown): v is FireCollection {
  return isObj(v) && v.type === 'FeatureCollection' && Array.isArray(v.features) && isObj(v.meta);
}

function isCalendarSeries(v: unknown): v is CalendarSeries {
  if (!isObj(v) || !Array.isArray(v.points) || !isObj(v.meta)) return false;
  const p = v.points[0];
  return p === undefined || (isObj(p) && typeof p.harmonized === 'number' && typeof p.lo === 'number' && typeof p.hi === 'number');
}

function isDetectionArchive(v: unknown): v is DetectionArchive {
  return isObj(v) && Array.isArray(v.rows) && (v.rows.length === 0 || (Array.isArray(v.rows[0]) && v.rows[0].length >= 6));
}

function isOnboardModel(v: unknown): v is OnboardModel {
  return isObj(v) && Array.isArray(v.weights) && Array.isArray(v.mean) && Array.isArray(v.scale) && typeof v.bias === 'number';
}

function isRegionList(v: unknown): v is Region[] {
  return Array.isArray(v) && v.every((r) => isObj(r) && typeof r.id === 'string' && Array.isArray(r.bbox));
}

function isOverview(v: unknown): v is ActivityOverview {
  return isObj(v) && Array.isArray(v.points);
}

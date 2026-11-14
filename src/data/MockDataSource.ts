import { dayOffsetToIso } from '@/lib/date';
import { bboxContains } from '@/lib/geo';
import type { ActivityOverview, DataSource, RequestOptions } from './DataSource';
import { buildCalendar } from './mock/engine/calendar';
import type { ZonesFile } from './mock/engine/zones';
import { searchRegionList } from './regionSearch';
import {
  DataSourceError,
  type BBox,
  type CalendarSeries,
  type Confidence,
  type DateRange,
  type FireCollection,
  type FireFeature,
  type Region,
  type Sensor,
} from './types';

export type MockMode = 'normal' | 'slow' | 'error' | 'empty';

export interface MockOptions {
  /** Base URL of the JSON files (default `${import.meta.env.BASE_URL}data`). */
  baseUrl: string;
  /** Simulated server latency, ms. */
  latencyMs?: number;
  /** Failure injection for demos and manual QA (`?mock=slow|error|empty`). */
  mode?: MockMode;
  /** Injected loader (tests read files from disk). */
  loadJson?: (path: string, signal?: AbortSignal) => Promise<unknown>;
  /** Max features returned by getFirePoints. */
  maxFeatures?: number;
}

interface FiresFile {
  rows: [number, number, 0 | 1, number, number, 0 | 1 | 2][];
  sensors: Sensor[];
  confidence: Confidence[];
}

interface IntroFile {
  rows: [number, number, number][];
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const id = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(id);
        reject(signal.reason instanceof Error ? signal.reason : new DOMException('Aborted', 'AbortError'));
      },
      { once: true },
    );
  });
}

async function defaultLoad(path: string, signal?: AbortSignal): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(path, { signal });
  } catch (cause) {
    if ((cause as Error).name === 'AbortError') throw cause;
    throw new DataSourceError('network', `Could not load ${path}`, { cause });
  }
  if (!res.ok) {
    throw new DataSourceError(
      res.status === 404 ? 'not-found' : 'server',
      `${path} → HTTP ${res.status}. Did you run "pnpm data:mock"?`,
    );
  }
  try {
    return await res.json();
  } catch (cause) {
    throw new DataSourceError('invalid-response', `${path} is not valid JSON`, { cause });
  }
}

/**
 * Simulates the future Emberline API on top of static JSON produced by `pnpm data:mock`.
 * The harmonization itself runs here (src/data/mock/engine), exactly where a server would run it.
 */
export class MockDataSource implements DataSource {
  readonly id = 'mock' as const;
  private readonly opts: Required<Omit<MockOptions, 'loadJson'>> & Pick<MockOptions, 'loadJson'>;
  private readonly cache = new Map<string, Promise<unknown>>();

  constructor(options: MockOptions) {
    this.opts = { latencyMs: 280, mode: 'normal', maxFeatures: 50_000, ...options };
  }

  private load<T>(file: string, signal?: AbortSignal): Promise<T> {
    const loader = this.opts.loadJson ?? defaultLoad;
    return loader(`${this.opts.baseUrl.replace(/\/$/, '')}/${file}`, signal) as Promise<T>;
  }

  /** Cache successful loads only, so a retry after a network error actually refetches. */
  private memo<T>(key: string, make: () => Promise<T>): Promise<T> {
    const existing = this.cache.get(key) as Promise<T> | undefined;
    if (existing) return existing;
    const p = make().catch((err: unknown) => {
      this.cache.delete(key);
      throw err;
    });
    this.cache.set(key, p);
    return p;
  }

  private async simulate(signal?: AbortSignal): Promise<void> {
    const { mode, latencyMs } = this.opts;
    await delay(mode === 'slow' ? 2400 : latencyMs, signal);
    if (mode === 'error') throw new DataSourceError('server', 'Simulated server error (mock=error)');
  }

  private getZones(): Promise<ZonesFile> {
    return this.memo('zones', () => this.load<ZonesFile>('zones.json'));
  }

  private getAllFires(): Promise<FireFeature[]> {
    return this.memo('fires', async () => {
      const file = await this.load<FiresFile>('fires.json');
      return file.rows.map(([lng, lat, s, day, frp, c], i): FireFeature => {
        const sensor = file.sensors[s]!;
        return {
          type: 'Feature',
          id: i,
          geometry: { type: 'Point', coordinates: [lng, lat] },
          properties: {
            id: `${sensor === 'MODIS' ? 'M' : 'V'}${i}`,
            sensor,
            date: dayOffsetToIso(day),
            frp,
            confidence: file.confidence[c]!,
          },
        };
      });
    });
  }

  async getFirePoints(bbox: BBox, range: DateRange, options?: RequestOptions): Promise<FireCollection> {
    const [all] = await Promise.all([this.getAllFires(), this.simulate(options?.signal)]);
    const matched =
      this.opts.mode === 'empty'
        ? []
        : all.filter((f) => {
            const d = f.properties.date;
            if (d < range.start || d > range.end) return false;
            const [lng, lat] = f.geometry.coordinates as [number, number];
            return bboxContains(bbox, lng, lat);
          });
    const features = matched.slice(0, this.opts.maxFeatures);
    return {
      type: 'FeatureCollection',
      features,
      meta: { total: matched.length, truncated: features.length < matched.length, synthetic: true },
    };
  }

  async getCalendar(bbox: BBox, options?: RequestOptions): Promise<CalendarSeries> {
    const [zones] = await Promise.all([this.getZones(), this.simulate(options?.signal)]);
    if (this.opts.mode === 'empty') {
      const { meta } = buildCalendar({ ...zones, coverage: [] }, bbox);
      return { bbox, points: [], meta };
    }
    return buildCalendar(zones, bbox);
  }

  async searchRegions(query: string, options?: RequestOptions): Promise<Region[]> {
    const regions = await this.memo('regions', () => this.load<Region[]>('regions.json'));
    // Search should feel instant; only failures are simulated here.
    await delay(Math.min(this.opts.latencyMs, 60), options?.signal);
    if (this.opts.mode === 'error') throw new DataSourceError('server', 'Simulated server error (mock=error)');
    return searchRegionList(regions, query);
  }

  async getOverview(options?: RequestOptions): Promise<ActivityOverview> {
    const file = await this.memo('overview', async () => {
      const intro = await this.load<IntroFile>('intro.json', options?.signal);
      return { points: intro.rows, synthetic: true } satisfies ActivityOverview;
    });
    return file;
  }
}

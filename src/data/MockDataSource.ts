import type { FireArchive } from '@/domain/archive';
import type { CountriesFile } from '@/domain/countries';
import type { OnboardModel } from '@/domain/onboard';
import { dayOffsetToIso } from '@/lib/date';
import { bboxContains } from '@/lib/geo';
import type { ActivityOverview, DataSource, RequestOptions } from './DataSource';
import { searchRegionList } from './regionSearch';
import {
  DataSourceError,
  type AreaQuery,
  type CalendarSeries,
  type Confidence,
  type DateRange,
  type DetectionArchive,
  type DetectionRow,
  type FireCollection,
  type FireFeature,
  type BBox,
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
  version: string;
  rows: DetectionRow[];
  sensors: Sensor[];
  confidence: Confidence[];
  truth?: ('fire' | 'static' | 'false-alarm')[];
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
 * Simulates the future Kyzyl Aspan API on top of static JSON produced by `pnpm data:mock`.
 * The harmonization itself runs here through src/domain — exactly the code a backend would run.
 */
export class MockDataSource implements DataSource {
  readonly id = 'mock' as const;
  private readonly opts: Required<Omit<MockOptions, 'loadJson'>> & Pick<MockOptions, 'loadJson'>;
  private readonly cache = new Map<string, Promise<unknown>>();

  constructor(options: MockOptions) {
    this.opts = { latencyMs: 280, mode: 'normal', maxFeatures: 60_000, ...options };
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

  private getFiresFile(): Promise<FiresFile> {
    return this.memo('fires-file', () => this.load<FiresFile>('fires.json'));
  }

  /** The H3 pipeline (and h3-js) is loaded on first use, keeping it off the intro's critical path. */
  private getArchive(): Promise<FireArchive> {
    return this.memo('archive', async () => {
      const [file, { buildArchive }, { tableFromRows }] = await Promise.all([
        this.getFiresFile(),
        import('@/domain/archive'),
        import('@/domain/detections'),
      ]);
      return buildArchive(tableFromRows(file.rows));
    });
  }

  private getCountries(): Promise<CountriesFile> {
    return this.memo('countries', () => this.load<CountriesFile>('countries.json'));
  }

  private getAllFires(): Promise<FireFeature[]> {
    return this.memo('fires', async () => {
      const file = await this.getFiresFile();
      const truth = file.truth ?? ['fire', 'static', 'false-alarm'];
      return file.rows.map(([lng, lat, s, day, frp, c, t], i): FireFeature => {
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
            ...(t !== undefined ? { truth: truth[t] } : {}),
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

  async getDetections(options?: RequestOptions): Promise<DetectionArchive> {
    const [file] = await Promise.all([this.getFiresFile(), this.simulate(options?.signal)]);
    return { version: file.version, rows: this.opts.mode === 'empty' ? [] : file.rows, synthetic: true };
  }

  async getCalendar(area: AreaQuery, options?: RequestOptions): Promise<CalendarSeries> {
    const [archive, { bboxMask, polygonMask }, { buildHexCalendar }] = await Promise.all([
      this.getArchive(),
      import('@/domain/area'),
      import('@/domain/hexCalendar'),
      this.simulate(options?.signal),
    ]);
    const { bbox } = area;
    let mask: Uint8Array;
    const country = area.regionId && /^[A-Z]{2}$/.test(area.regionId) ? area.regionId : null;
    if (country) {
      const shape = (await this.getCountries()).countries.find((c) => c.id === country);
      mask = shape ? polygonMask(archive.table, shape.polys, bbox) : bboxMask(archive.table, bbox);
    } else {
      mask = bboxMask(archive.table, bbox);
    }
    if (this.opts.mode === 'empty') mask = new Uint8Array(archive.table.n);
    return buildHexCalendar({
      table: archive.table,
      grid: archive.grid,
      flags: archive.flags,
      persistence: archive.persistence,
      base: archive.base,
      area: mask,
      bbox,
      synthetic: true,
    });
  }

  async searchRegions(query: string, options?: RequestOptions): Promise<Region[]> {
    const regions = await this.memo('regions', () => this.load<Region[]>('regions.json'));
    // Search should feel instant; only failures are simulated here.
    await delay(Math.min(this.opts.latencyMs, 60), options?.signal);
    if (this.opts.mode === 'error') throw new DataSourceError('server', 'Simulated server error (mock=error)');
    return searchRegionList(regions, query);
  }

  async getOverview(options?: RequestOptions): Promise<ActivityOverview> {
    return this.memo('overview', async () => {
      const intro = await this.load<IntroFile>('intro.json', options?.signal);
      return { points: intro.rows, synthetic: true } satisfies ActivityOverview;
    });
  }

  async getOnboardModel(options?: RequestOptions): Promise<OnboardModel> {
    return this.memo('model', () => this.load<OnboardModel>('model.json', options?.signal));
  }
}

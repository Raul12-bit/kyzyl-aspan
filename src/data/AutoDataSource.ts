import type { OnboardModel } from '@/domain/onboard';
import type { ActivityOverview, DataSource, RequestOptions } from './DataSource';
import { HttpDataSource } from './HttpDataSource';
import { MockDataSource } from './MockDataSource';
import type {
  AreaQuery,
  BBox,
  CalendarSeries,
  DateRange,
  DetectionArchive,
  FireCollection,
  Region,
} from './types';

export type DataMode = 'pending' | 'http' | 'mock';

type Listener = (mode: DataMode) => void;
let currentMode: DataMode = 'pending';
const listeners = new Set<Listener>();

/** Which source the app ended up using (for the "real data / demo data" chip). */
export function dataMode(): DataMode {
  return currentMode;
}

export function onDataMode(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function setDataMode(mode: DataMode) {
  currentMode = mode;
  for (const fn of listeners) fn(mode);
}
const setMode = setDataMode;

/**
 * Real HELIOS data when the API answers, the static demo otherwise — decided ONCE at start-up, so
 * the session never mixes real and synthetic numbers. Used when VITE_DATA_SOURCE is "auto" (default).
 */
export class AutoDataSource implements DataSource {
  readonly id = 'http' as const;
  private readonly ready: Promise<DataSource>;

  constructor(apiUrl: string, mockBaseUrl: string, probeTimeoutMs = 3500) {
    const http = new HttpDataSource(apiUrl);
    const mock = new MockDataSource({ baseUrl: mockBaseUrl });
    this.ready = probe(apiUrl, probeTimeoutMs).then((ok) => {
      setMode(ok ? 'http' : 'mock');
      if (!ok) console.warn('[kyzyl-aspan] HELIOS API not reachable — using the synthetic demo data.');
      return ok ? http : mock;
    });
  }

  async getFirePoints(bbox: BBox, range: DateRange, options?: RequestOptions): Promise<FireCollection> {
    return (await this.ready).getFirePoints(bbox, range, options);
  }
  async getDetections(options?: RequestOptions): Promise<DetectionArchive> {
    return (await this.ready).getDetections(options);
  }
  async getCalendar(area: AreaQuery, options?: RequestOptions): Promise<CalendarSeries> {
    return (await this.ready).getCalendar(area, options);
  }
  async searchRegions(query: string, options?: RequestOptions): Promise<Region[]> {
    return (await this.ready).searchRegions(query, options);
  }
  async getOverview(options?: RequestOptions): Promise<ActivityOverview> {
    return (await this.ready).getOverview(options);
  }
  async getOnboardModel(options?: RequestOptions): Promise<OnboardModel> {
    return (await this.ready).getOnboardModel(options);
  }
}

async function probe(apiUrl: string, timeoutMs: number): Promise<boolean> {
  try {
    const origin = typeof window !== 'undefined' ? window.location.origin : 'http://localhost';
    const url = new URL(`${apiUrl.replace(/\/$/, '')}/helios/status`, origin);
    const res = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { Accept: 'application/json' },
    });
    return res.ok && (res.headers.get('content-type') ?? '').includes('application/json');
  } catch {
    return false;
  }
}

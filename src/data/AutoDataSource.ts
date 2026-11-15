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
 * The HELIOS server answers at all — even without the fire archive. Its live services (real orbits, the
 * five-satellite link forecast, link physics) need no archive, so they can run while the map stays on the demo.
 */
let live = false;
const liveListeners = new Set<() => void>();
export function heliosLive(): boolean {
  return live;
}
export function onHeliosLive(fn: () => void): () => void {
  liveListeners.add(fn);
  return () => liveListeners.delete(fn);
}
export function setHeliosLive(value: boolean) {
  live = value;
  for (const fn of liveListeners) fn();
}

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
    this.ready = probe(apiUrl, probeTimeoutMs).then(({ reachable, dataReady }) => {
      const ok = reachable && dataReady;
      setHeliosLive(reachable);
      setMode(ok ? 'http' : 'mock');
      if (!reachable) console.warn('[kyzyl-aspan] HELIOS API not reachable — using the synthetic demo data.');
      else if (!dataReady) console.warn('[kyzyl-aspan] HELIOS API has no fire archive yet — demo data on the map, live satellites stay on.');
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

/**
 * `reachable`: the server answers. `dataReady`: it also holds the fire archive the map reads — a server
 * started without it used to switch the app to "real data" and leave the map with failed requests.
 * Servers that predate the flag do not send it and count as ready.
 */
async function probe(apiUrl: string, timeoutMs: number): Promise<{ reachable: boolean; dataReady: boolean }> {
  try {
    const origin = typeof window !== 'undefined' ? window.location.origin : 'http://localhost';
    const url = new URL(`${apiUrl.replace(/\/$/, '')}/helios/status`, origin);
    const res = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { Accept: 'application/json' },
    });
    if (!res.ok || !(res.headers.get('content-type') ?? '').includes('application/json')) {
      return { reachable: false, dataReady: false };
    }
    const body = (await res.json().catch(() => null)) as { data_ready?: unknown } | null;
    return { reachable: true, dataReady: body?.data_ready !== false };
  } catch {
    return { reachable: false, dataReady: false };
  }
}

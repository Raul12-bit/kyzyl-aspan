import { AutoDataSource, setDataMode, setHeliosLive } from './AutoDataSource';
import type { DataSource } from './DataSource';
import { HttpDataSource } from './HttpDataSource';
import { MockDataSource, type MockMode } from './MockDataSource';

export type { DataSource, ActivityOverview, RequestOptions } from './DataSource';
export { dataMode, heliosLive, onDataMode, onHeliosLive, type DataMode } from './AutoDataSource';
export * from './types';

const MOCK_MODES: readonly MockMode[] = ['normal', 'slow', 'error', 'empty'];

function readMockMode(): MockMode {
  if (typeof window === 'undefined') return 'normal';
  const value = new URLSearchParams(window.location.search).get('mock');
  return MOCK_MODES.includes(value as MockMode) ? (value as MockMode) : 'normal';
}

/** Default HELIOS data API path (proxied to the Python backend by Vite in dev and by server/ in production). */
export const DEFAULT_API_URL = '/v1';

/**
 * THE place where the data source is chosen.
 *  - VITE_DATA_SOURCE=auto (default): real HELIOS API (VITE_API_URL, default /v1) if it answers, else the mock;
 *  - VITE_DATA_SOURCE=http: always the real API;
 *  - VITE_DATA_SOURCE=mock (or ?mock=… in the URL): static demo files.
 */
export function createDataSource(env: ImportMetaEnv = import.meta.env): DataSource {
  const mockBase = `${env.BASE_URL}data`;
  const forcedMock = typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('mock');
  const mode = forcedMock ? 'mock' : (env.VITE_DATA_SOURCE ?? 'auto');
  const apiUrl = env.VITE_API_URL || DEFAULT_API_URL;
  if (mode === 'http') {
    setDataMode('http');
    setHeliosLive(true);
    return new HttpDataSource(apiUrl);
  }
  if (mode === 'auto' && typeof fetch === 'function') return new AutoDataSource(apiUrl, mockBase);
  setDataMode('mock');
  return new MockDataSource({ baseUrl: mockBase, mode: readMockMode() });
}

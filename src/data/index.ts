import type { DataSource } from './DataSource';
import { HttpDataSource } from './HttpDataSource';
import { MockDataSource, type MockMode } from './MockDataSource';

export type { DataSource, ActivityOverview, RequestOptions } from './DataSource';
export * from './types';

const MOCK_MODES: readonly MockMode[] = ['normal', 'slow', 'error', 'empty'];

function readMockMode(): MockMode {
  if (typeof window === 'undefined') return 'normal';
  const value = new URLSearchParams(window.location.search).get('mock');
  return MOCK_MODES.includes(value as MockMode) ? (value as MockMode) : 'normal';
}

/**
 * THE place where the data source is chosen.
 * VITE_DATA_SOURCE=http + VITE_API_URL → real API; anything else → static mock files.
 */
export function createDataSource(env: ImportMetaEnv = import.meta.env): DataSource {
  if (env.VITE_DATA_SOURCE === 'http') {
    if (!env.VITE_API_URL) {
      console.warn('VITE_DATA_SOURCE=http but VITE_API_URL is empty — falling back to mock data.');
    } else {
      return new HttpDataSource(env.VITE_API_URL);
    }
  }
  return new MockDataSource({ baseUrl: `${env.BASE_URL}data`, mode: readMockMode() });
}

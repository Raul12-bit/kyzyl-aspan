/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** auto (default): HELIOS API if reachable, else the synthetic demo · http: always the API · mock: demo only. */
  readonly VITE_DATA_SOURCE?: 'mock' | 'http' | 'auto';
  /** HELIOS data API base, default "/v1" (proxied to the Python backend). */
  readonly VITE_API_URL?: string;
  readonly VITE_BASEMAP_STYLE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

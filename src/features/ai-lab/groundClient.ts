import { keepPreviousData, useQuery } from '@tanstack/react-query';
import {
  forecastSpread,
  syntheticWeather,
  trackDelays,
  type Fuel,
  type SpreadForecast,
  type StreamDelay,
  type Weather,
} from '@/domain/ai/ground';

/**
 * Client for AI #3 on the ground server (server/index.ts: /api/ai/*). When the server is not running —
 * a static deployment, or `pnpm dev` without `pnpm server` — the very same domain code runs in the
 * browser instead, and the result says so (`source`). Nothing is ever silently faked.
 */

export type ComputedOn = 'server' | 'browser';

export { useAiServerStatus, type ServerStatus } from './serverStatus';

async function getJson<T>(
  url: string,
  init: RequestInit,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<T | null> {
  try {
    const res = await fetch(url, {
      ...init,
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
        : AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok || !(res.headers.get('content-type') ?? '').includes('application/json')) return null;
    return (await res.json()) as T;
  } catch (err) {
    if (signal?.aborted) throw err;
    return null;
  }
}

export type WeatherOverrides = Partial<Pick<Weather, 'windKmh' | 'windFromDeg' | 'tempC' | 'rh' | 'drought'>>;

export interface GroundForecastQuery {
  lat: number;
  lng: number;
  fuel: Fuel;
  weather: WeatherOverrides;
  localHour: number;
}

export interface GroundForecast {
  source: ComputedOn;
  computedMs: number;
  weather: Weather;
  forecast: SpreadForecast;
}

function localForecast(q: GroundForecastQuery): GroundForecast {
  const t0 = performance.now();
  const weather = { ...syntheticWeather(q.lat, q.lng), ...q.weather };
  const forecast = forecastSpread({ lat: q.lat, lng: q.lng }, weather, {
    fuel: q.fuel,
    localHour: q.localHour,
  });
  return { source: 'browser', computedMs: performance.now() - t0, weather, forecast };
}

export function useGroundForecast(q: GroundForecastQuery) {
  return useQuery({
    queryKey: ['ai', 'ground', q],
    queryFn: async ({ signal }): Promise<GroundForecast> => {
      const r = await getJson<{ computedMs: number; weather: Weather; forecast: SpreadForecast }>(
        '/api/ai/ground/forecast',
        { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(q) },
        signal,
        4000,
      );
      return r
        ? { source: 'server', computedMs: r.computedMs, weather: r.weather, forecast: r.forecast }
        : localForecast(q);
    },
    staleTime: Infinity,
    placeholderData: keepPreviousData,
    retry: false,
  });
}

export interface GroundDelays {
  source: ComputedOn;
  computedMs: number;
  streams: StreamDelay[];
}

export function useGroundDelays(storm: string | null, kp: number) {
  return useQuery({
    queryKey: ['ai', 'delays', storm ?? '', kp],
    queryFn: async ({ signal }): Promise<GroundDelays> => {
      const params = new URLSearchParams({ kp: String(kp) });
      if (storm) params.set('storm', storm);
      const r = await getJson<{ computedMs: number; streams: StreamDelay[] }>(
        `/api/ai/ground/delays?${params}`,
        {},
        signal,
        6000,
      );
      if (r) return { source: 'server', computedMs: r.computedMs, streams: r.streams };
      const t0 = performance.now();
      const streams = trackDelays({ stormStation: storm, kp });
      return { source: 'browser', computedMs: performance.now() - t0, streams };
    },
    staleTime: Infinity,
    placeholderData: keepPreviousData,
    retry: false,
  });
}

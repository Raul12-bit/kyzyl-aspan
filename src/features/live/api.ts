import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import type { BBox4, LiveCell, LiveRow } from '@/domain/live/satellites';
import type { TleSet } from '@/domain/live/sgp4';

/**
 * Real-time feeds (server/live.ts): NASA FIRMS near-real-time hot spots, CelesTrak orbital elements and the
 * Open-Meteo wind at the fires. Refetched in the background, so every live view keeps up with the satellites.
 */
export type LiveRegion = 'kz' | 'ca' | 'world';
export type LiveHours = 24 | 48 | 168;

export interface LiveFeedInfo {
  key: string;
  ok: boolean;
  rows: number;
  updated: string | null;
}

export interface LiveFires {
  region: LiveRegion;
  hours: number;
  fetched: string;
  bbox: BBox4;
  feeds: LiveFeedInfo[];
  rows?: LiveRow[];
  cells?: LiveCell[];
}

export interface LiveWind {
  lat: number;
  lng: number;
  windKmh: number;
  windFromDeg: number;
  tempC: number;
  rh: number;
  precipMm: number;
  /** Hourly wind of the past 7 days and today (unix s start, 1 h step). */
  hourly?: { start: number; step: number; windKmh: number[]; windFromDeg: number[] } | null;
}

async function getJson<T>(path: string, signal: AbortSignal, timeoutMs = 30_000): Promise<T> {
  const res = await fetch(path, { signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) });
  if (!res.ok || !(res.headers.get('content-type') ?? '').includes('application/json')) {
    throw new Error(`${path}: HTTP ${res.status}`);
  }
  return (await res.json()) as T;
}

const MIN = 60_000;

/** Hot spots of the last `hours` (world: 24 h on a 0.5° grid). Refreshed every 5 minutes. */
export function useLiveFires(region: LiveRegion, hours: LiveHours = 48, enabled = true) {
  return useQuery({
    queryKey: ['live', 'fires', region, region === 'world' ? 24 : hours],
    queryFn: ({ signal }) =>
      getJson<LiveFires>(`/api/live/fires?region=${region}&hours=${region === 'world' ? 24 : hours}`, signal),
    enabled,
    staleTime: 4 * MIN,
    refetchInterval: 5 * MIN,
    placeholderData: keepPreviousData,
    retry: 1,
  });
}

/** Orbital elements of the five satellites (6-hourly). */
export function useLiveTle(enabled = true) {
  return useQuery({
    queryKey: ['live', 'tle'],
    queryFn: ({ signal }) =>
      getJson<{ fetched: string; live: boolean; tle: TleSet }>('/api/live/tle', signal),
    enabled,
    staleTime: 3 * 60 * MIN,
    refetchInterval: 6 * 60 * MIN,
    retry: 1,
  });
}

/** Current wind at up to 24 points (rounded to 0.1°, so nearby fires share one answer). Every 15 minutes. */
export function useLiveWind(points: readonly { lat: number; lng: number }[]) {
  const key = useMemo(
    () =>
      [
        ...new Set(
          points
            .slice(0, 24)
            .map(
              (p) =>
                `${(Math.round(p.lat * 10) / 10).toFixed(1)},${(Math.round(p.lng * 10) / 10).toFixed(1)}`,
            ),
        ),
      ]
        .sort()
        .join(';'),
    [points],
  );
  return useQuery({
    queryKey: ['live', 'wind', key],
    queryFn: ({ signal }) =>
      getJson<{ fetched: string; points: LiveWind[] }>(
        `/api/live/weather?pts=${encodeURIComponent(key)}`,
        signal,
      ),
    enabled: key.length > 0,
    staleTime: 10 * MIN,
    refetchInterval: 15 * MIN,
    placeholderData: keepPreviousData,
    retry: 1,
  });
}

/**
 * Wind near a point (the samples sit on a 0.1° lattice around the fires) — at time `t` (unix s) when given and
 * covered by the hourly series, else the current wind.
 */
export function nearestWind(
  list: readonly LiveWind[] | undefined,
  lat: number,
  lng: number,
  t?: number,
): LiveWind | null {
  const w = nearestSample(list, lat, lng);
  if (!w || t === undefined || !w.hourly) return w;
  const i = Math.round((t - w.hourly.start) / w.hourly.step);
  if (i < 0 || i >= w.hourly.windKmh.length) return w;
  return { ...w, windKmh: w.hourly.windKmh[i]!, windFromDeg: w.hourly.windFromDeg[i]! };
}

function nearestSample(list: readonly LiveWind[] | undefined, lat: number, lng: number): LiveWind | null {
  if (!list?.length) return null;
  let best: LiveWind | null = null;
  let bestD = Infinity;
  for (const w of list) {
    const d = (w.lat - lat) ** 2 + ((w.lng - lng) * Math.cos((lat * Math.PI) / 180)) ** 2;
    if (d < bestD) {
      bestD = d;
      best = w;
    }
  }
  return bestD <= 1 ? best : null;
}

/** A clock that ticks every `ms` (default 1 s) — for "now" lines and live counters. */
export function useNow(ms = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), ms);
    return () => window.clearInterval(id);
  }, [ms]);
  return now;
}

/** Newest Last-Modified of the FIRMS files that answered (ms), for "updated N min ago". */
export function feedUpdated(f: LiveFires | undefined): number | null {
  if (!f) return null;
  const ts = f.feeds.filter((x) => x.ok && x.rows > 0 && x.updated).map((x) => Date.parse(x.updated!));
  return ts.length ? Math.max(...ts) : null;
}

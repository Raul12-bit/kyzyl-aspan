import { useMemo } from 'react';
import { crossCheck, summarizeChecks, type CheckResult } from '@/domain/ai/crosscheck';
import { temporalBridge, type FireEvent } from '@/domain/ai/temporal';
import { CA_BBOX, KZ_BBOX, type BBox4, type LiveRow } from '@/domain/live/satellites';
import {
  groundTrack,
  pointPasses,
  regionPasses,
  satrecsByCode,
  type Pass,
  type Track,
} from '@/domain/live/sgp4';
import { nearestWind, useLiveFires, useLiveTle, useLiveWind, useNow, type LiveHours } from './api';

const EMPTY: LiveRow[] = [];

export type AnalysisRegion = 'kz' | 'ca';

/**
 * Everything the live views compute from the feeds, once per data refresh: SGP4 ground tracks of the five
 * satellites over the window (+12 h ahead), their passes over the region, the Temporal Bridge events, the
 * wind at the fires and the mutual-confirmation check of every hot spot.
 */
export function useLiveAnalysis(region: AnalysisRegion, hours: LiveHours) {
  const fires = useLiveFires(region, hours);
  const tle = useLiveTle();
  const rows = fires.data?.rows ?? EMPTY;
  const bbox: BBox4 = fires.data?.bbox ?? (region === 'kz' ? KZ_BBOX : CA_BBOX);
  // The orbit window moves in 10-minute steps, so the tracks are not recomputed every second.
  const tick = Math.floor(useNow(60_000) / 600_000) * 600;

  const tracks = useMemo(() => {
    if (!tle.data) return null;
    const recs = satrecsByCode(tle.data.tle);
    const from = tick - hours * 3600 - 6 * 3600;
    const to = tick + 12 * 3600;
    const step = hours > 48 ? 60 : 30;
    const out = new Map<number, Track>();
    for (const [code, rec] of recs) out.set(code, groundTrack(rec, code, from, to, step));
    return out;
  }, [tle.data, tick, hours]);

  const passes = useMemo(() => {
    const out = new Map<number, Pass[]>();
    if (tracks) for (const [code, tr] of tracks) out.set(code, regionPasses(tr, bbox));
    return out;
  }, [tracks, bbox]);

  const events = useMemo<FireEvent[]>(() => temporalBridge(rows), [rows]);
  const windPoints = useMemo(() => events.slice(0, 24).map((e) => ({ lat: e.lat, lng: e.lng })), [events]);
  const wind = useLiveWind(windPoints);

  const checks = useMemo<CheckResult[]>(() => {
    if (!rows.length) return [];
    return crossCheck(rows, {
      now: Date.now() / 1000,
      satellites: tracks ? [...tracks.keys()] : undefined,
      coverage: tracks
        ? (code, lat, lng, from, to) => {
            const tr = tracks.get(code);
            return tr ? pointPasses(tr, lat, lng, from, to).map((p) => p.tMid) : [];
          }
        : undefined,
      wind: (lat, lng, t) => nearestWind(wind.data?.points, lat, lng, t),
    });
  }, [rows, tracks, wind.data]);

  const summary = useMemo(() => summarizeChecks(checks), [checks]);

  return { fires, tle, rows, bbox, tracks, passes, events, wind, checks, summary };
}

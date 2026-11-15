/**
 * The live part of the HELIOS data API without Python: /v1/helios/status and /v1/helios/constellation,
 * answered by the TypeScript port (server/constellation). Used by the Vercel functions and, locally, by
 * `pnpm server` when the Python API does not answer — so the five satellites play on the landing page
 * wherever the site runs. The fire archive endpoints stay with the Python API.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import ai1 from '../artifacts/reports/ai1_edge_detector_metrics.json';
import ai2 from '../artifacts/reports/ai2_link_metrics.json';
import ai3 from '../artifacts/reports/ai3_ground_forecast_metrics.json';
import frontendExport from '../artifacts/reports/frontend_export.json';
import harmonization from '../artifacts/reports/harmonization_validation.json';
import { bestStormStation, simulate, STATION_ORDER, type Constellation, type SimInput } from './constellation/simulate';
import { loadSpaceWeather, loadTles, loadWeather, satrecs } from './constellation/sources';
import { send } from './handlers';

const GROUND = STATION_ORDER.filter((s) => s !== 'WHITE_SANDS') as string[];
const memo = new Map<string, Constellation>();

/** Same window rules as the Python API: two hours (30–240 min) from the current 10 minutes, 30 s steps. */
async function constellation(url: URL): Promise<{ status: number; body: unknown }> {
  const minutes = Math.min(240, Math.max(30, Number(url.searchParams.get('minutes')) || 120));
  const storm = url.searchParams.get('storm') || null;
  const outage = url.searchParams.get('outage') || null;
  const db = ['1', 'true'].includes(url.searchParams.get('db') ?? '');
  if (storm && storm !== 'auto' && !GROUND.includes(storm)) return { status: 400, body: { detail: `storm: auto or one of ${GROUND.join(', ')}` } };
  if (outage && !GROUND.includes(outage)) return { status: 400, body: { detail: `outage: one of ${GROUND.join(', ')}` } };
  const start = new Date(Math.floor(Date.now() / 600_000) * 600_000);
  const key = `${start.toISOString()}|${minutes}|${storm}|${outage}|${db}`;
  const hit = memo.get(key);
  if (hit) return { status: 200, body: hit };
  const [{ tle }, weather, space] = await Promise.all([loadTles(), loadWeather().catch(() => ({})), loadSpaceWeather()]);
  const input: Omit<SimInput, 'storm'> = { start, minutes, stepS: 30, outage, db, satrecs: satrecs(tle), weather, space };
  let result: Constellation;
  if (storm === 'auto') {
    const base = simulate({ ...input, storm: null });
    result = simulate({ ...input, storm: bestStormStation(input, base) });
  } else {
    result = simulate({ ...input, storm });
  }
  if (memo.size > 24) memo.clear();
  memo.set(key, result);
  return { status: 200, body: result };
}

/** The status the site probes at start-up: the server answers, the fire archive is not here. */
function status() {
  return {
    data_ready: false,
    live: ['constellation'],
    engine: 'typescript',
    data: frontendExport,
    models: { ai1_edge: ai1, ai2_link: ai2, ai3_ground: (ai3 as { horizons?: unknown }).horizons ?? null },
    harmonization,
  };
}

/** Answers /v1/helios/status and /v1/helios/constellation; false for any other path. */
export async function handleHeliosLite(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (req.method !== 'GET') return false;
  if (url.pathname === '/v1/helios/status') {
    send(res, 200, status(), { 'cache-control': 'public, max-age=300, s-maxage=3600' });
    return true;
  }
  if (url.pathname === '/v1/helios/constellation') {
    try {
      const out = await constellation(url);
      // The window moves every 10 minutes: the CDN may keep an answer for 5 and serve it a little stale.
      send(res, out.status, out.body, out.status === 200 ? { 'cache-control': 'public, max-age=60, s-maxage=300, stale-while-revalidate=600' } : {});
    } catch (err) {
      console.error('[helios-lite] constellation failed', err);
      send(res, 503, { detail: 'constellation unavailable' });
    }
    return true;
  }
  return false;
}

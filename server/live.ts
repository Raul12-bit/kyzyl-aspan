/**
 * Real-time inputs for the live views, from open services without keys, cached in memory (a warm Vercel
 * function or the local server reuses them) and at the CDN (Cache-Control on every answer):
 *
 *   GET /api/live/fires?region=kz|ca|world&hours=24|48|168
 *       NASA FIRMS near-real-time hot spots: MODIS (Terra, Aqua) and VIIRS (Suomi NPP, NOAA-20, NOAA-21).
 *       kz / ca → every detection in the box: [lng, lat, sat, unixSec, frpMW, conf 0|1|2, scanKm, trackKm, day 1|0,
 *                 T4µm K, T11µm K, MODIS confidence % (−1 for VIIRS)] (MODIS brightness / bright_t31, VIIRS bright_ti4 / bright_ti5)
 *       world   → last 24 h on a 0.5° grid:    [lng, lat, detections, frpSum, sensors bit mask (1 MODIS, 2 VIIRS), lastUnixSec]
 *   GET /api/live/tle
 *       CelesTrak elements of the five fire satellites (snapshot fallback), for SGP4 in the browser.
 *   GET /api/live/weather?pts=lat,lng;lat,lng…   (≤ 24 points)
 *       Open-Meteo current wind, temperature, humidity and rain at each point, plus the hourly wind of the past
 *       7 days (an older fire is checked against the wind it actually had).
 *
 * FIRMS publishes the files every few minutes; we keep each one 10 minutes, Open-Meteo answers 15 minutes.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { loadTles } from './constellation/sources';

export type LiveRegion = 'kz' | 'ca' | 'world';

/** Satellite codes in the rows (also src/domain/live/satellites.ts). */
export const SAT_CODE = { T: 0, A: 1, N: 2, N20: 3, N21: 4 } as const;

export const REGION_BBOX: Record<Exclude<LiveRegion, 'world'>, [number, number, number, number]> = {
  // Kazakhstan with a small margin (its outline spans 46.5–87.4 °E, 40.6–55.4 °N).
  kz: [46.2, 40.4, 87.6, 55.6],
  // Central Asia and the neighbouring steppe: Caspian to Altai, Iran's north to Siberia's south.
  ca: [44, 34, 96, 58],
};

const BASE = 'https://firms.modaps.eosdis.nasa.gov/data/active_fire';

interface Feed {
  key: string;
  /** Satellite code when the file holds one satellite (VIIRS); MODIS files mix Terra and Aqua. */
  sat: number | null;
  url: (area: 'Global' | 'Russia_Asia', span: string) => string;
}

const FEEDS: Feed[] = [
  { key: 'MODIS', sat: null, url: (a, s) => `${BASE}/modis-c6.1/csv/MODIS_C6_1_${a}_${s}.csv` },
  {
    key: 'SNPP',
    sat: SAT_CODE.N,
    url: (a, s) => `${BASE}/suomi-npp-viirs-c2/csv/SUOMI_VIIRS_C2_${a}_${s}.csv`,
  },
  { key: 'N20', sat: SAT_CODE.N20, url: (a, s) => `${BASE}/noaa-20-viirs-c2/csv/J1_VIIRS_C2_${a}_${s}.csv` },
  { key: 'N21', sat: SAT_CODE.N21, url: (a, s) => `${BASE}/noaa-21-viirs-c2/csv/J2_VIIRS_C2_${a}_${s}.csv` },
];

const SPAN: Record<number, string> = { 24: '24h', 48: '48h', 168: '7d' };
const TEN_MIN = 600_000;

export type FireRow = [number, number, number, number, number, number, number, number, number, number, number, number];
export type FireCell = [number, number, number, number, number, number];

interface FeedResult {
  key: string;
  ok: boolean;
  rows: number;
  /** Last-Modified of the FIRMS file (ISO), when sent. */
  updated: string | null;
}

/* ------------------------------------------------------------------ FIRMS CSV */

/**
 * Parses one FIRMS active-fire CSV (no quoted fields) into rows. Columns are found by name, so the MODIS
 * (brightness, confidence 0–100) and VIIRS (bright_ti4, confidence l/n/h) layouts both work.
 */
export function parseFirmsCsv(text: string, feedSat: number | null): FireRow[] {
  const lines = text.split(/\r?\n/);
  const head = (lines[0] ?? '').split(',').map((h) => h.trim().toLowerCase());
  const col = (name: string) => head.indexOf(name);
  const iLat = col('latitude');
  const iLng = col('longitude');
  const iDate = col('acq_date');
  const iTime = col('acq_time');
  const iSat = col('satellite');
  const iConf = col('confidence');
  const iFrp = col('frp');
  const iScan = col('scan');
  const iTrack = col('track');
  const iDn = col('daynight');
  // 4 µm and 11 µm brightness temperatures (AI #1's main inputs): MODIS and VIIRS name them differently.
  const iBt4 = col('brightness') >= 0 ? col('brightness') : col('bright_ti4');
  const iBt11 = col('bright_t31') >= 0 ? col('bright_t31') : col('bright_ti5');
  if (iLat < 0 || iLng < 0 || iDate < 0 || iTime < 0) return [];
  const out: FireRow[] = [];
  for (let k = 1; k < lines.length; k++) {
    const line = lines[k];
    if (!line) continue;
    const c = line.split(',');
    const lat = Number(c[iLat]);
    const lng = Number(c[iLng]);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    const hhmm = (c[iTime] ?? '').padStart(4, '0');
    const t = Date.parse(`${c[iDate]}T${hhmm.slice(0, 2)}:${hhmm.slice(2, 4)}:00Z`) / 1000;
    if (!Number.isFinite(t)) continue;
    let sat = feedSat;
    if (sat === null) {
      const s = (c[iSat] ?? '').trim();
      sat = s === 'T' || s === 'Terra' ? SAT_CODE.T : SAT_CODE.A;
    }
    const raw = (c[iConf] ?? '').trim().toLowerCase();
    let conf = 1;
    if (raw === 'l' || raw === 'low') conf = 0;
    else if (raw === 'h' || raw === 'high') conf = 2;
    else if (raw !== 'n' && raw !== 'nominal') {
      const v = Number(raw);
      if (Number.isFinite(v)) conf = v < 30 ? 0 : v < 80 ? 1 : 2;
    }
    const frp = Number(c[iFrp]);
    const scan = Number(c[iScan]);
    const track = Number(c[iTrack]);
    out.push([
      Math.round(lng * 1e4) / 1e4,
      Math.round(lat * 1e4) / 1e4,
      sat,
      t,
      Number.isFinite(frp) ? Math.round(frp * 10) / 10 : 0,
      conf,
      Number.isFinite(scan) ? scan : 1,
      Number.isFinite(track) ? track : 1,
      (c[iDn] ?? 'D').trim() === 'N' ? 0 : 1,
      Math.round((Number(c[iBt4]) || 0) * 10) / 10,
      Math.round((Number(c[iBt11]) || 0) * 10) / 10,
      Number.isFinite(Number(raw)) && raw !== '' ? Number(raw) : -1,
    ]);
  }
  return out;
}

const fileCache = new Map<string, { at: number; rows: FireRow[]; updated: string | null }>();

async function loadFeed(
  feed: Feed,
  area: 'Global' | 'Russia_Asia',
  span: string,
): Promise<{ rows: FireRow[]; updated: string | null }> {
  const url = feed.url(area, span);
  const hit = fileCache.get(url);
  if (hit && Date.now() - hit.at < TEN_MIN) return hit;
  const res = await fetch(url, { signal: AbortSignal.timeout(20_000), headers: { accept: 'text/csv,*/*' } });
  if (!res.ok) throw new Error(`FIRMS ${feed.key}: HTTP ${res.status}`);
  const rows = parseFirmsCsv(await res.text(), feed.sat);
  const lm = res.headers.get('last-modified');
  const updated = lm && Number.isFinite(Date.parse(lm)) ? new Date(lm).toISOString() : null;
  const value = { at: Date.now(), rows, updated };
  // A handful of files at most (4 feeds × 4 spans); drop the lot if something odd fills it up.
  if (fileCache.size > 24) fileCache.clear();
  fileCache.set(url, value);
  return value;
}

/** 0.5° grid of the world's last 24 h: one entry per cell with fire. */
export function gridCells(rows: readonly FireRow[], deg = 0.5): FireCell[] {
  const cells = new Map<number, FireCell>();
  const cols = Math.round(360 / deg);
  for (const r of rows) {
    const cx = Math.min(cols - 1, Math.floor((r[0] + 180) / deg));
    const cy = Math.floor((r[1] + 90) / deg);
    const key = cy * cols + cx;
    let c = cells.get(key);
    if (!c) {
      c = [
        Math.round((-180 + (cx + 0.5) * deg) * 100) / 100,
        Math.round((-90 + (cy + 0.5) * deg) * 100) / 100,
        0,
        0,
        0,
        0,
      ];
      cells.set(key, c);
    }
    c[2] += 1;
    c[3] = Math.round((c[3] + r[4]) * 10) / 10;
    c[4] |= r[2] <= SAT_CODE.A ? 1 : 2;
    if (r[3] > c[5]) c[5] = r[3];
  }
  return [...cells.values()];
}

export async function liveFires(region: LiveRegion, hours: number) {
  const span = region === 'world' ? '24h' : (SPAN[hours] ?? '48h');
  const area = region === 'world' ? 'Global' : 'Russia_Asia';
  const results = await Promise.allSettled(FEEDS.map((f) => loadFeed(f, area, span)));
  const feeds: FeedResult[] = [];
  let all: FireRow[] = [];
  results.forEach((r, i) => {
    const key = FEEDS[i]!.key;
    if (r.status === 'fulfilled') {
      feeds.push({ key, ok: true, rows: r.value.rows.length, updated: r.value.updated });
      all = all.concat(r.value.rows);
    } else {
      feeds.push({ key, ok: false, rows: 0, updated: null });
    }
  });
  if (!feeds.some((f) => f.ok)) throw new Error('no FIRMS feed answered');
  const fetched = new Date().toISOString();
  if (region === 'world') {
    return { region, hours: 24, fetched, feeds, bbox: [-180, -90, 180, 90], cells: gridCells(all) };
  }
  const [w, s, e, n] = REGION_BBOX[region];
  const rows = all
    .filter((r) => r[0] >= w && r[0] <= e && r[1] >= s && r[1] <= n)
    .sort((a, b) => a[3] - b[3]);
  return {
    region,
    hours: Number(Object.keys(SPAN).find((h) => SPAN[Number(h)] === span)),
    fetched,
    feeds,
    bbox: [w, s, e, n],
    rows,
  };
}

/* ------------------------------------------------------------------ orbits */

const FIRE_SATS = ['TERRA', 'AQUA', 'SUOMI NPP', 'NOAA 20', 'NOAA 21'];

export async function liveTle() {
  const { tle, live } = await loadTles();
  const out: Record<string, [string, string]> = {};
  for (const name of FIRE_SATS) if (tle[name]) out[name] = tle[name]!;
  return { fetched: new Date().toISOString(), live: live >= FIRE_SATS.length, tle: out };
}

/* ------------------------------------------------------------------ weather */

export interface PointWeather {
  lat: number;
  lng: number;
  windKmh: number;
  windFromDeg: number;
  tempC: number;
  rh: number;
  precipMm: number;
  /** Hourly 10 m wind of the past 7 days and today, so an older fire is checked against the wind it had. */
  hourly: { start: number; step: number; windKmh: number[]; windFromDeg: number[] } | null;
}

const weatherCache = new Map<string, { at: number; value: PointWeather }>();

/** Parses "lat,lng;lat,lng" (≤ 24 points), rounded to 0.1° so nearby fires share one cached answer. */
export function parsePoints(raw: string | null): { lat: number; lng: number }[] | null {
  if (!raw) return null;
  const pts = raw
    .split(';')
    .filter(Boolean)
    .map((p) => p.split(',').map(Number));
  if (!pts.length || pts.length > 24) return null;
  const out: { lat: number; lng: number }[] = [];
  for (const [lat, lng] of pts) {
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat!) > 90 || Math.abs(lng!) > 180)
      return null;
    out.push({ lat: Math.round(lat! * 10) / 10, lng: Math.round(lng! * 10) / 10 });
  }
  return out;
}

export async function liveWeather(points: { lat: number; lng: number }[]): Promise<PointWeather[]> {
  const key = (p: { lat: number; lng: number }) => `${p.lat.toFixed(1)},${p.lng.toFixed(1)}`;
  const missing = points.filter((p) => {
    const hit = weatherCache.get(key(p));
    return !hit || Date.now() - hit.at > 15 * 60_000;
  });
  if (missing.length) {
    const params = new URLSearchParams({
      latitude: missing.map((p) => p.lat.toFixed(1)).join(','),
      longitude: missing.map((p) => p.lng.toFixed(1)).join(','),
      current: 'temperature_2m,relative_humidity_2m,wind_speed_10m,wind_direction_10m,precipitation',
      hourly: 'wind_speed_10m,wind_direction_10m',
      past_days: '7',
      forecast_days: '1',
      wind_speed_unit: 'kmh',
      timezone: 'GMT',
    });
    const res = await fetch(`https://api.open-meteo.com/v1/forecast?${params}`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`Open-Meteo: HTTP ${res.status}`);
    const data = (await res.json()) as unknown;
    const items = (Array.isArray(data) ? data : [data]) as {
      current?: Record<string, number>;
      hourly?: {
        time?: string[];
        wind_speed_10m?: (number | null)[];
        wind_direction_10m?: (number | null)[];
      };
    }[];
    missing.forEach((p, i) => {
      const c = items[i]?.current;
      if (!c) return;
      const h = items[i]?.hourly;
      const t0 = h?.time?.[0] ? Date.parse(`${h.time[0]}Z`) / 1000 : Number.NaN;
      const hourly =
        h && Number.isFinite(t0) && h.wind_speed_10m && h.wind_direction_10m
          ? {
              start: t0,
              step: 3600,
              windKmh: h.wind_speed_10m.map((v) => (typeof v === 'number' ? Math.round(v * 10) / 10 : 0)),
              windFromDeg: h.wind_direction_10m.map((v) => (typeof v === 'number' ? Math.round(v) : 0)),
            }
          : null;
      weatherCache.set(key(p), {
        at: Date.now(),
        value: {
          lat: p.lat,
          lng: p.lng,
          windKmh: Number(c.wind_speed_10m) || 0,
          windFromDeg: Number(c.wind_direction_10m) || 0,
          tempC: Number(c.temperature_2m) || 0,
          rh: Number(c.relative_humidity_2m) || 0,
          precipMm: Number(c.precipitation) || 0,
          hourly,
        },
      });
    });
    if (weatherCache.size > 2000) weatherCache.clear();
  }
  return points.map((p) => weatherCache.get(key(p))?.value).filter((v): v is PointWeather => Boolean(v));
}

/* ------------------------------------------------------------------ router */

type Send = (res: ServerResponse, status: number, body: unknown, headers?: Record<string, string>) => void;

const CACHE_FIRES = 'public, max-age=120, s-maxage=600, stale-while-revalidate=1200';
const CACHE_PARTIAL = 'public, max-age=30, s-maxage=60';
const CACHE_TLE = 'public, max-age=1800, s-maxage=3600, stale-while-revalidate=21600';
const CACHE_WEATHER = 'public, max-age=300, s-maxage=900, stale-while-revalidate=1800';

/** Answers GET /api/live/*; returns false for any other path. */
export function handleLive(req: IncomingMessage, res: ServerResponse, send: Send): boolean {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (!url.pathname.startsWith('/api/live/')) return false;
  if (req.method !== 'GET') {
    send(res, 405, { error: 'Method not allowed' }, { allow: 'GET' });
    return true;
  }
  const fail = (err: unknown) => {
    console.warn(`[live] ${url.pathname}: ${(err as Error).message}`);
    if (!res.headersSent)
      send(res, 503, { error: 'Live source unavailable' }, { 'cache-control': 'no-store' });
  };
  if (url.pathname === '/api/live/fires') {
    const region = (url.searchParams.get('region') ?? 'kz') as LiveRegion;
    const hours = Number(url.searchParams.get('hours') ?? 48);
    if (!['kz', 'ca', 'world'].includes(region)) send(res, 422, { error: 'region: kz, ca or world' });
    else if (![24, 48, 168].includes(hours)) send(res, 422, { error: 'hours: 24, 48 or 168' });
    else
      liveFires(region, hours).then(
        // A feed that did not answer (Suomi NPP is simply empty) must not stay at the CDN for 10 minutes.
        (body) =>
          send(res, 200, body, {
            'cache-control': body.feeds.some((f) => !f.ok) ? CACHE_PARTIAL : CACHE_FIRES,
          }),
        fail,
      );
  } else if (url.pathname === '/api/live/tle') {
    liveTle().then((body) => send(res, 200, body, { 'cache-control': CACHE_TLE }), fail);
  } else if (url.pathname === '/api/live/weather') {
    const pts = parsePoints(url.searchParams.get('pts'));
    if (!pts) send(res, 422, { error: 'pts: 1–24 points "lat,lng;lat,lng"' });
    else
      liveWeather(pts).then(
        (points) =>
          send(res, 200, { fetched: new Date().toISOString(), points }, { 'cache-control': CACHE_WEATHER }),
        fail,
      );
  } else {
    send(res, 404, { error: 'Unknown endpoint' });
  }
  return true;
}

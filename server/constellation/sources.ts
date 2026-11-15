/**
 * Live inputs of the constellation, fetched from open services without keys and cached in memory (a warm
 * Vercel function or the local server reuses them):
 *   CelesTrak  — orbital elements of the five satellites and three TDRS (6 h; snapshot fallback);
 *   Open-Meteo — hourly forecast over every antenna: rain, cloud layers, humidity (30 min);
 *   NOAA SWPC  — planetary Kp, F10.7 radio flux, GOES X-ray flux (15 min; quiet-Sun defaults).
 * CelesTrak asks clients not to re-download the same elements more than every couple of hours: the cache
 * and the CDN cache of the response keep it to a few downloads a day.
 */
import { twoline2satrec, type SatRec } from 'satellite.js';
import { SATS, STATIONS, TDRS, type SpaceWeather, type StationWeather } from './simulate';
import fallback from './tle-fallback.json';

const NORAD: Record<string, number> = {
  TERRA: 25994,
  AQUA: 27424,
  'SUOMI NPP': 37849,
  'NOAA 20': 43013,
  'NOAA 21': 54234,
  'TDRS 11': 39070,
  'TDRS 12': 39504,
  'TDRS 13': 42915,
};
const HOUR = 3_600_000;

interface Cached<T> {
  at: number;
  value: T;
}
const cache: {
  tle?: Cached<Record<string, [string, string]>> & { ttl: number; live: number };
  weather?: Cached<Record<string, StationWeather>>;
  space?: Cached<SpaceWeather>;
} = {};

async function getJson(url: string, timeoutMs = 8000): Promise<unknown> {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`${new URL(url).host}: HTTP ${res.status}`);
  return res.json();
}

async function fetchTle(norad: number): Promise<[string, string]> {
  const res = await fetch(`https://celestrak.org/NORAD/elements/gp.php?CATNR=${norad}&FORMAT=TLE`, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`CelesTrak ${norad}: HTTP ${res.status}`);
  const lines = (await res.text()).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const l1 = lines.find((l) => l.startsWith('1 '));
  const l2 = lines.find((l) => l.startsWith('2 '));
  if (!l1 || !l2) throw new Error(`CelesTrak ${norad}: no elements`);
  return [l1, l2];
}

/** Orbital elements by CelesTrak name; any satellite CelesTrak cannot give right now comes from the snapshot. */
export async function loadTles(): Promise<{ tle: Record<string, [string, string]>; live: number }> {
  if (cache.tle && Date.now() - cache.tle.at < cache.tle.ttl) return { tle: cache.tle.value, live: cache.tle.live };
  const names = [...SATS, ...TDRS];
  const got = await Promise.allSettled(names.map((n) => fetchTle(NORAD[n]!)));
  const tle: Record<string, [string, string]> = {};
  let live = 0;
  names.forEach((n, i) => {
    const r = got[i]!;
    if (r.status === 'fulfilled') {
      tle[n] = r.value;
      live++;
    } else {
      const snap = (fallback.tle as Record<string, string[]>)[n];
      if (snap) tle[n] = [snap[0]!, snap[1]!];
    }
  });
  // Fresh elements are good for hours; after a failure try CelesTrak again in half an hour, not on every request.
  cache.tle = { at: Date.now(), value: tle, live, ttl: live === names.length ? 6 * HOUR : 0.5 * HOUR };
  return { tle, live };
}

export function satrecs(tle: Record<string, [string, string]>): Record<string, SatRec> {
  return Object.fromEntries(Object.entries(tle).map(([name, [l1, l2]]) => [name, twoline2satrec(l1, l2)]));
}

interface OpenMeteoHourly {
  hourly?: Record<string, (number | null)[] | string[]>;
}

/** Hourly forecast over each station (one Open-Meteo request for all of them). */
export async function loadWeather(): Promise<Record<string, StationWeather>> {
  if (cache.weather && Date.now() - cache.weather.at < 0.5 * HOUR) return cache.weather.value;
  const ids = Object.keys(STATIONS);
  const params = new URLSearchParams({
    latitude: ids.map((id) => STATIONS[id]!.lat.toFixed(4)).join(','),
    longitude: ids.map((id) => STATIONS[id]!.lon.toFixed(4)).join(','),
    hourly: 'precipitation,cloud_cover,cloud_cover_low,cloud_cover_mid,cloud_cover_high,relative_humidity_2m',
    forecast_days: '2',
    timezone: 'GMT',
  });
  const data = (await getJson(`https://api.open-meteo.com/v1/forecast?${params}`, 10_000)) as OpenMeteoHourly | OpenMeteoHourly[];
  const items = Array.isArray(data) ? data : [data];
  const num = (xs: unknown, def: number) => (Array.isArray(xs) ? xs.map((v) => (typeof v === 'number' ? v : def)) : []);
  const out: Record<string, StationWeather> = {};
  ids.forEach((id, i) => {
    const h = items[i]?.hourly;
    if (!h || !Array.isArray(h.time)) return;
    out[id] = {
      t: (h.time as string[]).map((s) => Date.parse(`${s}Z`) / 1000),
      precip: num(h.precipitation, 0),
      cloud: num(h.cloud_cover, 50),
      low: num(h.cloud_cover_low, 30),
      mid: num(h.cloud_cover_mid, 30),
      high: num(h.cloud_cover_high, 30),
      rh: num(h.relative_humidity_2m, 70),
    };
  });
  cache.weather = { at: Date.now(), value: out };
  return out;
}

/** Current geomagnetic and solar conditions; quiet-Sun values when NOAA does not answer. */
export async function loadSpaceWeather(): Promise<SpaceWeather> {
  if (cache.space && Date.now() - cache.space.at < 0.25 * HOUR) return cache.space.value;
  const value: SpaceWeather = { kp: 2, f107: 120, xray: 1e-7 };
  const base = 'https://services.swpc.noaa.gov';
  const [kp, f107, xray] = await Promise.allSettled([
    getJson(`${base}/products/noaa-planetary-k-index.json`),
    getJson(`${base}/products/summary/10cm-flux.json`),
    getJson(`${base}/json/goes/primary/xrays-6-hour.json`),
  ]);
  if (kp.status === 'fulfilled' && Array.isArray(kp.value) && kp.value.length) {
    const last = kp.value[kp.value.length - 1] as Record<string, unknown> | unknown[];
    const v = Array.isArray(last) ? Number(last[1]) : Number((last as Record<string, unknown>).Kp);
    if (Number.isFinite(v)) value.kp = v;
  }
  if (f107.status === 'fulfilled') {
    const row = (Array.isArray(f107.value) ? f107.value[0] : f107.value) as Record<string, unknown> | undefined;
    const v = Number(row?.flux ?? row?.Flux);
    if (Number.isFinite(v) && v > 0) value.f107 = v;
  }
  if (xray.status === 'fulfilled' && Array.isArray(xray.value)) {
    const long = (xray.value as Record<string, unknown>[]).filter((r) => r.energy === '0.1-0.8nm');
    const v = Number(long[long.length - 1]?.flux);
    if (Number.isFinite(v) && v > 0) value.xray = v;
  }
  cache.space = { at: Date.now(), value };
  return value;
}

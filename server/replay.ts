/**
 * "A real example" (POST /api/ai/replay): one real fire from the live NASA FIRMS feed, played through the three AIs
 * as they would have run at that moment.
 *
 *   1. AI #1 on board — the trained network (server/edge.ts) on every hot pixel of the first overpass: p(real fire),
 *      p(it grows within 72 h), the priority and the 24-byte alert packet.
 *   2. AI #2 on board — where the satellite really was then (SGP4, today's CelesTrak elements), which ground
 *      stations and relays it could see, the trained link network's drop risk per band with the weather that was over
 *      each antenna (Open-Meteo, hourly, past 7 days), and when the alert reaches the ground — against today's
 *      near-real-time chain (median 139 min, measured on a real fire day).
 *   3. AI #3 on the ground — which other satellite confirmed the fire and when, the spread vector across the passes
 *      (Temporal Bridge) checked against the wind of that hour, and the McArthur spread forecast with the weather
 *      that was at the fire.
 */
import { eciToEcf, gstime, propagate, type SatRec } from 'satellite.js';
import delivery from '../artifacts/reports/delivery_summary.json';
import edgeMeta from '../artifacts/models/edge_detector_meta.json';
import { fitsDrift } from '../src/domain/ai/crosscheck';
import { forecastSpread } from '../src/domain/ai/ground';
import { splitPasses, spreadVector, windFit } from '../src/domain/ai/temporal';
import type { LiveRow } from '../src/domain/live/satellites';
import { gradient, linkAi, outageRisk } from './constellation/linkAi';
import { geodeticToEcef, lineOfSight, lookAngles, rfMarginDb, RF_CHANNELS, type Band } from './constellation/physics';
import { ACCESS, STATIONS, TDRS, VIA_TDRS } from './constellation/simulate';
import { loadSpaceWeather, loadTles, satrecs } from './constellation/sources';
import { EDGE_PARAMETERS, encodeAlert, FLAG, scoreDetections, type EdgeResult, type Priority } from './edge';

const SAT_NAMES = ['TERRA', 'AQUA', 'SUOMI NPP', 'NOAA 20', 'NOAA 21'];
const PRIORITY_RANK: Record<Priority, number> = { SUPPRESS: 0, ROUTINE: 1, HIGH: 2, CRITICAL: 3 };
const MIN_EL = 5;
const DEG = Math.PI / 180;

/* ------------------------------------------------------------------ request */

export interface ReplayRequest {
  rows: LiveRow[];
}

const MAX_ROWS = 400;

export function parseReplay(body: unknown): { ok: true; value: ReplayRequest } | { ok: false; error: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, error: 'Body must be an object' };
  const b = body as Record<string, unknown>;
  for (const k of Object.keys(b)) if (k !== 'rows') return { ok: false, error: `Unknown field: ${k}` };
  if (!Array.isArray(b.rows) || !b.rows.length || b.rows.length > MAX_ROWS) return { ok: false, error: `rows: 1–${MAX_ROWS}` };
  const rows: LiveRow[] = [];
  for (const r of b.rows) {
    if (!Array.isArray(r) || r.length < 9 || r.length > 12 || !r.every((v) => typeof v === 'number' && Number.isFinite(v))) {
      return { ok: false, error: 'Each row: 9–12 finite numbers (the /api/live/fires layout)' };
    }
    const [lng, lat, sat, t] = r as number[];
    if (Math.abs(lat!) > 90 || Math.abs(lng!) > 180 || !Number.isInteger(sat) || sat! < 0 || sat! > 4 || t! < 1.5e9 || t! > 4e9) {
      return { ok: false, error: 'Row out of range' };
    }
    rows.push(r as unknown as LiveRow);
  }
  return { ok: true, value: { rows: rows.sort((a, b) => a[3] - b[3]) } };
}

/* ------------------------------------------------------------------ weather of the past week */

interface HourlyWeather {
  t: number[];
  temp: number[];
  rh: number[];
  precip: number[];
  cloud: number[];
  wind: number[];
  windDir: number[];
}

const weatherCache = new Map<string, { at: number; value: HourlyWeather }>();

/** Hourly weather of the past 7 days (and today) at a few points, one Open-Meteo request, cached 30 min. */
async function pastWeather(points: { lat: number; lng: number }[]): Promise<(HourlyWeather | null)[]> {
  const key = (p: { lat: number; lng: number }) => `${p.lat.toFixed(1)},${p.lng.toFixed(1)}`;
  const missing = points.filter((p) => {
    const hit = weatherCache.get(key(p));
    return !hit || Date.now() - hit.at > 30 * 60_000;
  });
  if (missing.length) {
    const params = new URLSearchParams({
      latitude: missing.map((p) => p.lat.toFixed(1)).join(','),
      longitude: missing.map((p) => p.lng.toFixed(1)).join(','),
      hourly: 'temperature_2m,relative_humidity_2m,precipitation,cloud_cover,wind_speed_10m,wind_direction_10m',
      past_days: '7',
      forecast_days: '1',
      wind_speed_unit: 'kmh',
      timezone: 'GMT',
    });
    try {
      const res = await fetch(`https://api.open-meteo.com/v1/forecast?${params}`, { signal: AbortSignal.timeout(10_000) });
      if (res.ok) {
        const data = (await res.json()) as unknown;
        const items = (Array.isArray(data) ? data : [data]) as { hourly?: Record<string, (number | null)[] | string[]> }[];
        const num = (xs: unknown, def: number) => (Array.isArray(xs) ? xs.map((v) => (typeof v === 'number' ? v : def)) : []);
        missing.forEach((p, i) => {
          const h = items[i]?.hourly;
          if (!h || !Array.isArray(h.time)) return;
          weatherCache.set(key(p), {
            at: Date.now(),
            value: {
              t: (h.time as string[]).map((s) => Date.parse(`${s}Z`) / 1000),
              temp: num(h.temperature_2m, 10),
              rh: num(h.relative_humidity_2m, 60),
              precip: num(h.precipitation, 0),
              cloud: num(h.cloud_cover, 50),
              wind: num(h.wind_speed_10m, 10),
              windDir: num(h.wind_direction_10m, 270),
            },
          });
        });
        if (weatherCache.size > 500) weatherCache.clear();
      }
    } catch {
      /* no weather: the stages fall back to neutral values and say so */
    }
  }
  return points.map((p) => weatherCache.get(key(p))?.value ?? null);
}

function hourIndex(w: HourlyWeather, t: number): number {
  if (!w.t.length) return -1;
  const i = Math.round((t - w.t[0]!) / 3600);
  return i >= 0 && i < w.t.length ? i : -1;
}

/** Weather at the hour of `t`, plus the rain of the 24 hours before. */
function weatherAt(w: HourlyWeather | null, t: number) {
  const i = w ? hourIndex(w, t) : -1;
  if (!w || i < 0) return null;
  let rain24h = 0;
  for (let k = Math.max(0, i - 23); k <= i; k++) rain24h += w.precip[k] ?? 0;
  return {
    tempC: w.temp[i]!,
    rh: w.rh[i]!,
    precipMm: w.precip[i]!,
    cloud: w.cloud[i]! / 100,
    windKmh: w.wind[i]!,
    windFromDeg: w.windDir[i]!,
    rain24h: Math.round(rain24h * 10) / 10,
  };
}

/* ------------------------------------------------------------------ orbits */

type Vec3 = [number, number, number];

function ecefAt(rec: SatRec, unixSec: number): Vec3 | null {
  const d = new Date(unixSec * 1000);
  const pos = propagate(rec, d)?.position;
  if (!pos || typeof pos !== 'object') return null;
  const e = eciToEcf(pos, gstime(d));
  return [e.x, e.y, e.z];
}

function toLatLng([x, y, z]: Vec3): { lat: number; lng: number } {
  const r = Math.hypot(x, y, z);
  return { lat: Math.asin(z / r) / DEG, lng: Math.atan2(y, x) / DEG };
}

/* ------------------------------------------------------------------ the replay */

export async function replay(req: ReplayRequest) {
  const rows = req.rows;
  const all = rows.map((_, i) => i);
  const passes = splitPasses(rows, all, 900);
  const first = passes[0]!;
  const sat = first.sat;
  const satName = SAT_NAMES[sat]!;
  const t0 = first.t;

  /* ---- AI #1 on board: every hot pixel of the first overpass ---- */
  const passRows = first.rows.map((i) => rows[i]!);
  const scene = rows.filter((r) => r[2] === sat && Math.abs(r[3] - t0) <= 600);
  const scored: EdgeResult[] = scoreDetections(passRows as unknown as number[][], scene as unknown as number[][]);
  let best = 0;
  scored.forEach((s, i) => {
    const b = scored[best]!;
    if (PRIORITY_RANK[s.priority] > PRIORITY_RANK[b.priority] || (s.priority === b.priority && s.pEscalation > b.pEscalation)) best = i;
  });
  const top = scored[best]!;
  const pRealMax = Math.max(...scored.map((s) => s.pReal));
  const pEscMax = Math.max(...scored.map((s) => s.pEscalation));
  const frpSum = passRows.reduce((s, r) => s + (r[4] || 0), 0);
  const lat0 = passRows.reduce((s, r) => s + r[1], 0) / passRows.length;
  const lng0 = passRows.reduce((s, r) => s + r[0], 0) / passRows.length;
  const flags =
    (scored.some((s) => s.geometry.night) ? FLAG.night : 0) |
    (scored.some((s) => s.history.staticSource) ? FLAG.staticNear : 0) |
    (scored.some((s) => !s.geometry.night && s.geometry.glintDeg < 12) ? FLAG.glint : 0);
  const packet = encodeAlert({
    priority: top.priority,
    sat,
    unixSec: t0,
    lat: lat0,
    lng: lng0,
    frpMw: frpSum,
    clusterN: passRows.length,
    pEscalation: pEscMax,
    pReal: pRealMax,
    flags,
  });
  const ai1 = {
    sat,
    t: t0,
    pixels: passRows.length,
    priority: top.priority,
    pReal: round(pRealMax, 3),
    pEscalation: round(pEscMax, 3),
    suppressed: scored.filter((s) => s.priority === 'SUPPRESS').length,
    frpSum: round(frpSum, 1),
    bt4: passRows[best]![9] ?? null,
    bt11: passRows[best]![10] ?? null,
    geometry: { ...top.geometry, sza: round(top.geometry.sza, 1), scanDeg: round(top.geometry.scanDeg, 1), glintDeg: round(top.geometry.glintDeg, 1) },
    history: { ...top.history, climMonth: round(top.history.climMonth, 2), staticScore: round(top.history.staticScore, 2) },
    context: top.context,
    packet,
    model: { parameters: EDGE_PARAMETERS, rocAucReal: edgeMeta.p_real.roc_auc, rocAucGrowth: edgeMeta.p_escalation.roc_auc, usPerPixel: edgeMeta.model.latency_us_per_detection_cpu },
  };

  /* ---- AI #2 on board: the satellite's links at that moment ---- */
  const [{ tle }, space] = await Promise.all([loadTles(), loadSpaceWeather().catch(() => ({ kp: 2, f107: 120, xray: 1e-7 }))]);
  const recs = satrecs(tle);
  const rec = recs[satName];
  const own = VIA_TDRS.has(satName) ? [] : [...(ACCESS[satName] ?? [])];
  const stationIds = [...new Set([...own, 'SVALSAT', 'POKER_FLAT', 'TROLLSAT', 'MCMURDO', 'WHITE_SANDS', 'ASTANA_DB'])].filter((id) => STATIONS[id]);
  const wx = await pastWeather([{ lat: lat0, lng: lng0 }, ...stationIds.map((id) => ({ lat: STATIONS[id]!.lat, lng: STATIONS[id]!.lon }))]);
  const fireWx = wx[0] ?? null;
  const stationWx = Object.fromEntries(stationIds.map((id, i) => [id, wx[i + 1] ?? null]));
  let ai2: Record<string, unknown> | null = null;
  if (rec) {
    const p0 = ecefAt(rec, t0);
    const sub = p0 ? toLatLng(p0) : null;
    // Visible stations now, with the drop risk of each downlink band over the next 5 minutes (30 s samples).
    const inView: { id: string; name: string; own: boolean; el: number; bands: { band: Band; risk: number; network: number; marginDb: number }[] }[] = [];
    for (const id of stationIds) {
      const st = STATIONS[id]!;
      const sta = geodeticToEcef(st.lat, st.lon, st.altKm);
      const looks = Array.from({ length: 11 }, (_, k) => {
        const p = ecefAt(rec, t0 + k * 30);
        return p ? lookAngles(p, st.lat, st.lon, st.altKm, sta) : null;
      });
      const now = looks[0];
      if (!now || now.el < MIN_EL) continue;
      const w = weatherAt(stationWx[id] ?? null, t0);
      const env = {
        rainMmH: w?.precipMm ?? 0,
        lwcMm: (w?.cloud ?? 0.5) * 0.25 + 0.08 * (w?.precipMm ?? 0),
        rh: w?.rh ?? 70,
        kp: space.kp,
        f107: space.f107,
        xray: space.xray,
      };
      const els = looks.map((l) => Math.max(0, l?.el ?? 0));
      const elRate = gradient(els).map((g) => g * 2);
      const ttl = (() => {
        let k = 0;
        while (k < els.length && els[k]! >= MIN_EL) k++;
        return (k * 30) / 60;
      })();
      const bands = (['Ka', 'X'] as const)
        .filter((b) => st.bands.includes(b))
        .map((band) => {
          const margins = looks.map((l) => (l && l.el >= MIN_EL ? rfMarginDb(band, l.rangeKm, l.el, st, 90, env) : -20));
          const pAi = linkAi({
            el: now.el,
            el_rate: elRate[0]!,
            range_km: now.rangeKm,
            t_since_aos: 3,
            t_to_los: ttl,
            max_el_pass: Math.max(...els),
            sun_sep: 90,
            geomag_abs: Math.abs(st.geomagLat),
            alt_km: st.altKm,
            fc_precip: env.rainMmH,
            fc_cloud: w?.cloud ?? 0.5,
            rh: env.rh,
            kp: space.kp,
            log_xray: Math.log10(space.xray),
            f107: space.f107,
            margin_now: margins[0]!,
            margin_trend: 0,
            ch_S: 0,
            ch_X: band === 'X' ? 1 : 0,
            ch_Ka: band === 'Ka' ? 1 : 0,
            ch_OPT: 0,
          });
          // Only weather and margin, as in training: a pass ending is certain geometry, reported apart.
          const inSight = margins.map((m, k) => (els[k]! >= MIN_EL ? m : margins[0]!));
          const risk = outageRisk(inSight.map(() => pAi), inSight, 30, 5)[0]!;
          return { band, risk: round(risk, 3), network: round(pAi, 3), marginDb: round(margins[0]!, 1) };
        });
      inView.push({ id, name: st.name, own: own.includes(id), el: round(now.el, 1), bands });
    }
    // Terra's real path: TDRS relays in geostationary orbit.
    const tdrsUp = VIA_TDRS.has(satName) && p0 ? TDRS.some((r) => recs[r] && lineOfSight(p0, ecefAt(recs[r]!, t0) ?? [0, 0, 0], 100)) : false;
    // No station now: the first contact within 3 h (own stations for the data; any station for the alert packet).
    const nextContact = (ids: string[]) => {
      for (let k = 1; k <= 360; k++) {
        const tt = t0 + k * 30;
        const p = ecefAt(rec, tt);
        if (!p) continue;
        for (const id of ids) {
          const st = STATIONS[id]!;
          if (lookAngles(p, st.lat, st.lon, st.altKm).el >= MIN_EL) return { id, name: st.name, t: tt, waitMin: round((k * 30) / 60, 1) };
        }
      }
      return null;
    };
    const anyNow = inView.length > 0;
    const ownNow = inView.filter((s) => s.own);
    const nextAny = anyNow || tdrsUp ? null : nextContact(stationIds);
    const nextOwn = ownNow.length || VIA_TDRS.has(satName) ? null : nextContact(own);
    // AI #2's choice for the bulk data: the band with the lowest risk on the best own station in view (Ka if safe).
    let choice: { station: string; band: Band; risk: number } | null = null;
    for (const s of ownNow.length ? ownNow : inView) {
      for (const b of s.bands) {
        const better = !choice || b.risk < choice.risk - 0.05 || (Math.abs(b.risk - choice.risk) <= 0.05 && b.band === 'Ka' && b.risk < 0.2);
        if (better) choice = { station: s.name, band: b.band, risk: b.risk };
      }
    }
    const alertSec = tdrsUp ? 2 : anyNow ? 8 : nextAny ? nextAny.waitMin * 60 + 8 : null;
    ai2 = {
      sat,
      t: t0,
      sub: sub && { lat: round(sub.lat, 2), lng: round(sub.lng, 2) },
      inView,
      tdrs: tdrsUp,
      choice,
      alertSec,
      via: tdrsUp ? 'tdrs' : anyNow ? 'radio' : nextAny ? 'next' : null,
      nextAny,
      nextOwn,
      todayMin: delivery.strategies.A_today_nrt.all.median_min,
      onboardStoreForwardMin: delivery.strategies.B_onboard_ai_store_forward.all.median_min,
      kp: space.kp,
      rates: { Ka: RF_CHANNELS.Ka.rateBps / 1e6, X: RF_CHANNELS.X.rateBps / 1e6 },
    };
  }

  /* ---- AI #3 on the ground: confirmation, Temporal Bridge, spread forecast ---- */
  const w0 = weatherAt(fireWx, t0);
  const windOf = (t: number) => {
    const w = weatherAt(fireWx, t);
    return w ? { windKmh: w.windKmh, windFromDeg: w.windFromDeg } : null;
  };
  let confirm: { sat: number; t: number; dtMin: number; distKm: number; cross: boolean } | null = null;
  for (const p of passes.slice(1)) {
    if (p.sat === sat || p.t - t0 > 6 * 3600) continue;
    const r = rows[p.rows[0]!]!;
    const a = passRows[0]!;
    if (!fitsDrift(a, r, windOf(t0))) continue;
    const kx = 111.32 * Math.cos(lat0 * DEG);
    confirm = {
      sat: p.sat,
      t: p.t,
      dtMin: Math.round((p.t - t0) / 60),
      distKm: round(Math.hypot((p.lng - lng0) * kx, (p.lat - lat0) * 111.32), 1),
      cross: (p.sat <= 1) !== (sat <= 1),
    };
    break;
  }
  const vector = spreadVector(rows, passes, 0.5);
  const mid = (passes[0]!.t + passes[passes.length - 1]!.t) / 2;
  const windMid = windOf(mid);
  const last = passes[passes.length - 1]!;
  const wLast = weatherAt(fireWx, last.t);
  const localHour = (((last.t / 3600 + last.lng / 15) % 24) + 24) % 24;
  const weather = wLast
    ? {
        windKmh: wLast.windKmh,
        windFromDeg: wLast.windFromDeg,
        tempC: wLast.tempC,
        rh: wLast.rh,
        drought: Math.max(0, Math.min(10, 10 - wLast.rain24h * 0.35 - Math.max(0, wLast.rh - 35) / 9)),
        rain24h: wLast.rain24h,
        pressureHpa: 1013,
        airMass: 'continentalMoist' as const,
      }
    : null;
  const forecast = weather
    ? forecastSpread({ lat: last.lat, lng: last.lng }, weather, { fuel: 'grass', hours: [6, 12, 24], localHour })
    : null;
  const ai3 = {
    confirm,
    passes: passes.map((p) => ({ sat: p.sat, t: p.t, n: p.n, frp: p.frp, lat: round(p.lat, 4), lng: round(p.lng, 4) })),
    vector: vector && {
      speedKmh: round(vector.speedKmh, 2),
      bearingDeg: Math.round(vector.bearingDeg),
      sigmaKmh: round(vector.sigmaKmh, 2),
      significant: vector.significant,
      distKm: round(vector.distKm, 1),
      frontKm: round(vector.frontKm, 1),
    },
    windMid,
    fit: windFit(vector, windMid),
    weather: weather && { ...weather, drought: round(weather.drought, 1) },
    weatherAtDetection: w0,
    forecast: forecast && {
      index: round(forecast.index, 1),
      danger: forecast.danger,
      rosKmh: round(forecast.rosKmh, 2),
      headingDeg: Math.round(forecast.headingDeg),
      horizons: forecast.horizons.map((h) => ({ hours: h.hours, headKm: round(h.headKm, 2), areaHa: Math.round(h.areaHa), ring: h.ring.filter((_, i) => i % 4 === 0) })),
      warnings: forecast.warnings,
    },
  };

  return {
    event: { lat: round(lat0, 4), lng: round(lng0, 4), start: t0, end: last.t, passes: passes.length, detections: rows.length },
    ai1,
    ai2,
    ai3,
  };
}

function round(v: number, digits = 2): number {
  const k = 10 ** digits;
  return Math.round(v * k) / k;
}

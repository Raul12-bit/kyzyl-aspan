/**
 * The five real satellites, their real ground stations, when each link ends and when data reach the ground —
 * a port of helios/comms/constellation.py to TypeScript, so the hosted site (Vercel, no Python) shows the same
 * constellation. Pure: every input (orbital elements, weather, space weather) is passed in; sources.ts fetches.
 *
 * Nothing on the satellites is changed. Orbits: SGP4 (satellite.js) from CelesTrak elements. Links: ITU-R
 * margins with the Open-Meteo forecast over each antenna, risk = AI #2 network + physics correction.
 * Ground segment as flown in November 2026: Terra via TDRS 11/12/13 → White Sands (direct broadcast off since
 * 2024-05-11); Aqua → Svalbard + Poker Flat (broadcast paused while dumping); NOAA-20/21 → Svalbard + McMurdo,
 * Troll backup; Suomi NPP flagged (NOAA stopped its data on 2026-11-02).
 */
import { eciToEcf, gstime, propagate, type SatRec } from 'satellite.js';
import { gradient, linkAi, outageRisk } from './linkAi';
import {
  ecefToLatLon,
  geodeticToEcef,
  geomagneticLat,
  haversineKm,
  interp,
  lineOfSight,
  lookAngles,
  rfMarginDb,
  RF_CHANNELS,
  sunEcefUnit,
  type Band,
  type Look,
  type Vec3,
} from './physics';

export const SATS = ['TERRA', 'AQUA', 'SUOMI NPP', 'NOAA 20', 'NOAA 21'] as const;
export const TDRS = ['TDRS 11', 'TDRS 12', 'TDRS 13'] as const;
const SENSOR: Record<string, 'MODIS' | 'VIIRS'> = { TERRA: 'MODIS', AQUA: 'MODIS', 'SUOMI NPP': 'VIIRS', 'NOAA 20': 'VIIRS', 'NOAA 21': 'VIIRS' };
export const ACCESS: Record<string, readonly string[]> = {
  TERRA: [],
  AQUA: ['SVALSAT', 'POKER_FLAT'],
  'SUOMI NPP': ['SVALSAT', 'MCMURDO', 'TROLLSAT'],
  'NOAA 20': ['SVALSAT', 'MCMURDO', 'TROLLSAT'],
  'NOAA 21': ['SVALSAT', 'MCMURDO', 'TROLLSAT'],
};
export const VIA_TDRS = new Set(['TERRA']);
const DIRECT_BROADCAST = new Set(['AQUA', 'SUOMI NPP', 'NOAA 20', 'NOAA 21']);
const PAUSES_BROADCAST_WHILE_DUMPING = new Set(['AQUA']);
const RETIRED: Record<string, string> = { 'SUOMI NPP': '2026-11-02' };
const PRODUCE_MBPS: Record<string, number> = { TERRA: 10.6, AQUA: 10.6, 'SUOMI NPP': 15, 'NOAA 20': 15, 'NOAA 21': 15 };
const TDRS_MBPS = 150;
const DB_MBPS = 15;
const TDRS_GROUND = 'WHITE_SANDS';
export const DB_STATION = 'ASTANA_DB';
const P_OUT = 0.5;
const MIN_EL = 5;
const LOOKAHEAD_MIN = 5;
const HALF_SWATH_KM = { MODIS: 1165, VIIRS: 1520 } as const;
export const ACTIONS = { STORE: 0, DOWNLINK: 1, BROADCAST: 5 } as const;
const REGION = { name: 'Казахстан', bbox: [46.4, 40.5, 87.4, 55.5] as [number, number, number, number] };

export interface Station {
  id: string;
  name: string;
  lat: number;
  lon: number;
  altKm: number;
  bands: readonly string[];
  dishM: number;
  geomagLat: number;
}
const st = (id: string, name: string, lat: number, lon: number, altM: number, bands: string[], dishM: number): Station => ({
  id,
  name,
  lat,
  lon,
  altKm: altM / 1000,
  bands,
  dishM,
  geomagLat: Math.round(geomagneticLat(lat, lon) * 10) / 10,
});
/** helios/comms/stations.py (the ones the five satellites use, plus the what-if antenna in Astana). */
export const STATIONS: Record<string, Station> = Object.fromEntries(
  [
    st('SVALSAT', 'Svalbard SvalSat (KSAT)', 78.229, 15.408, 500, ['S', 'X', 'Ka'], 11.3),
    st('POKER_FLAT', 'Poker Flat, Alaska (NASA NEN)', 65.117, -147.433, 500, ['S', 'X'], 11),
    st('TROLLSAT', 'TrollSat, Antarctica (KSAT)', -72.012, 2.535, 1270, ['S', 'X', 'Ka'], 7.3),
    st('MCMURDO', 'McMurdo, Antarctica (NASA NEN)', -77.839, 166.667, 100, ['S', 'X'], 10),
    st('WHITE_SANDS', 'White Sands Complex, NM (TDRS ground)', 32.5, -106.608, 1450, ['S', 'Ka'], 18),
    st('ASTANA_DB', 'Astana direct-broadcast antenna (what-if)', 51.169, 71.449, 350, ['X'], 3),
  ].map((s) => [s.id, s]),
);
export const STATION_ORDER = ['SVALSAT', 'POKER_FLAT', 'TROLLSAT', 'MCMURDO', TDRS_GROUND] as const;

/** Hourly weather at a station (Open-Meteo), as fetched. */
export interface StationWeather {
  /** Unix seconds of each hour. */
  t: number[];
  precip: number[];
  cloud: number[];
  low: number[];
  mid: number[];
  high: number[];
  rh: number[];
}
export interface SpaceWeather {
  kp: number;
  f107: number;
  xray: number;
}
export interface SimInput {
  start: Date;
  minutes: number;
  stepS: number;
  storm: string | null;
  outage: string | null;
  db: boolean;
  /** Parsed orbital elements by CelesTrak name (five observers + the three TDRS). */
  satrecs: Record<string, SatRec>;
  weather: Record<string, StationWeather | undefined>;
  space: SpaceWeather;
}

const INF = 1e9;
const round = (x: number, nd: number) => Math.round(x * 10 ** nd) / 10 ** nd;
const roundOrNull = (x: number, nd = 1) => (Number.isFinite(x) ? round(x, nd) : null);

/** Index ranges [a, b) where mask is true. */
export function runs(mask: readonly boolean[]): [number, number][] {
  const out: [number, number][] = [];
  let a = -1;
  for (let i = 0; i <= mask.length; i++) {
    const on = i < mask.length && mask[i];
    if (on && a < 0) a = i;
    if (!on && a >= 0) {
      out.push([a, i]);
      a = -1;
    }
  }
  return out;
}

/** Minutes until the link drops (if up) and until it comes back (if down); NaN = not in this window. */
export function linkForecast(ok: readonly boolean[], stepS: number): [number[], number[]] {
  const T = ok.length;
  const nf = new Array<number>(T + 1).fill(INF);
  const nt = new Array<number>(T + 1).fill(INF);
  for (let t = T - 1; t >= 0; t--) {
    nf[t] = !ok[t] ? t : nf[t + 1]!;
    nt[t] = ok[t] ? t : nt[t + 1]!;
  }
  const k = stepS / 60;
  return [
    ok.map((o, t) => (o && nf[t]! < INF ? (nf[t]! - t) * k : NaN)),
    ok.map((o, t) => (!o && nt[t]! < INF ? (nt[t]! - t) * k : NaN)),
  ];
}

/** Step when data taken at t are on the ground (INF: not in this window) and the path (2 broadcast, 1 dump, 0 none). */
export function groundArrival(dumpOk: readonly boolean[], dbOk: readonly boolean[]): [number[], number[]] {
  const T = dumpOk.length;
  const nxt = new Array<number>(T + 1).fill(INF);
  for (let t = T - 1; t >= 0; t--) nxt[t] = dumpOk[t] ? t : nxt[t + 1]!;
  return [dumpOk.map((_, t) => (dbOk[t] ? t : nxt[t]!)), dumpOk.map((_, t) => (dbOk[t] ? 2 : nxt[t]! < INF ? 1 : 0))];
}

/** numpy.quantile (linear). */
function quantile(sorted: number[], q: number): number {
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}
function stats(values: number[]) {
  if (!values.length) return { median_min: null, p90_min: null, max_min: null };
  const s = [...values].sort((a, b) => a - b);
  return { median_min: roundOrNull(quantile(s, 0.5)), p90_min: roundOrNull(quantile(s, 0.9)), max_min: roundOrNull(s[s.length - 1]!) };
}

interface Contact {
  st: number[];
  el: number[];
  p: number[];
  ttl: number[];
  rate: number[];
  ch: string[];
  storm: boolean[];
  blocked: number[];
  wx: number[];
  db: boolean[];
}

export function simulate(input: SimInput) {
  const { start, minutes, stepS, storm, outage, db, satrecs, space } = input;
  const T = Math.floor((minutes * 60) / stepS) + 1;
  const order: string[] = [...STATION_ORDER, ...(db ? [DB_STATION] : [])];
  const stations = order.map((id) => STATIONS[id]!);
  const sidx = Object.fromEntries(order.map((id, j) => [id, j]));
  const sats = SATS.filter((s) => satrecs[s]);
  const dates = Array.from({ length: T }, (_, t) => new Date(start.getTime() + t * stepS * 1000));
  const unix = dates.map((d) => d.getTime() / 1000);
  const gmst = dates.map((d) => gstime(d));
  const sun = dates.map((d, t) => sunEcefUnit(d, gmst[t]!));
  const ecefOf = (rec: SatRec): Vec3[] =>
    dates.map((d, t) => {
      const pv = propagate(rec, d);
      const pos = pv?.position;
      if (!pos || typeof pos === 'boolean') return [NaN, NaN, NaN];
      const e = eciToEcf(pos, gmst[t]!);
      return [e.x, e.y, e.z];
    });
  const ecef = Object.fromEntries(sats.map((s) => [s, ecefOf(satrecs[s]!)])) as Record<string, Vec3[]>;
  const tdrs = TDRS.filter((r) => satrecs[r]).map((r) => ecefOf(satrecs[r]!));

  // Weather at each station on the step grid; a storm scenario overrides one station.
  const envAt = (sid: string, stormy: boolean) => {
    const w = input.weather[sid];
    const at = (xs: number[] | undefined, def: number) => unix.map((u) => (w && xs && xs.length ? interp(u, w.t, xs) : def));
    const clip01 = (v: number) => Math.min(1, Math.max(0, v / 100));
    const precip = at(w?.precip, 0).map((v) => Math.max(v, 0));
    const cloud = at(w?.cloud, 50).map(clip01);
    const low = at(w?.low, 30).map(clip01);
    const mid = at(w?.mid, 30).map(clip01);
    const high = at(w?.high, 30).map(clip01);
    const rh = at(w?.rh, 70);
    const cloudOpt = low.map((l, i) => 1 - (1 - l) * (1 - 0.8 * mid[i]!) * (1 - 0.15 * high[i]!));
    if (stormy) return { precip: precip.map(() => 30), cloud: cloud.map(() => 1), cloudOpt: cloud.map(() => 1), rh: rh.map(() => 98) };
    return { precip, cloud, cloudOpt, rh };
  };
  const logXray = Math.log10(Math.max(space.xray, 1e-9));

  const contact: Record<string, Contact> = {};
  for (const s of sats) {
    const c: Contact = {
      st: new Array(T).fill(-1),
      el: new Array(T).fill(-90),
      p: new Array(T).fill(1),
      ttl: new Array(T).fill(0),
      rate: new Array(T).fill(0),
      ch: new Array(T).fill(''),
      storm: new Array(T).fill(false),
      blocked: new Array(T).fill(-1),
      wx: new Array(T).fill(0),
      db: new Array(T).fill(false),
    };
    contact[s] = c;
    for (const sid of ACCESS[s] ?? []) {
      const station = STATIONS[sid]!;
      const j = sidx[sid]!;
      const sta = geodeticToEcef(station.lat, station.lon, station.altKm);
      const look: Look[] = ecef[s]!.map((p) => lookAngles(p, station.lat, station.lon, station.altKm, sta));
      const up = look.map((l) => Number.isFinite(l.el) && l.el >= MIN_EL);
      if (!up.some(Boolean)) continue;
      if (sid === outage) {
        up.forEach((u, t) => {
          if (u) c.blocked[t] = j;
        });
        continue;
      }
      const stormy = Boolean(storm && sid === storm);
      const v = envAt(sid, stormy);
      const sunSep = look.map((l, t) => {
        const d = l.los[0] * sun[t]![0] + l.los[1] * sun[t]![1] + l.los[2] * sun[t]![2];
        return (Math.acos(Math.min(1, Math.max(-1, d))) * 180) / Math.PI;
      });
      for (const [a, b] of runs(up)) {
        const n = b - a;
        const idx = Array.from({ length: n }, (_, i) => a + i);
        const el = idx.map((t) => look[t]!.el);
        const elRate = gradient(el).map((g) => g * (60 / stepS));
        const maxEl = Math.max(...el);
        const ttl = idx.map((_, i) => ((n - 1 - i) * stepS) / 60);
        const bestP = new Array(n).fill(1);
        const bestCh = new Array(n).fill('');
        const bestRate = new Array(n).fill(0);
        for (const band of station.bands) {
          if (band !== 'X' && band !== 'Ka') continue; // stored data are dumped only on the fast channels
          const m = idx.map((t) =>
            rfMarginDb(band as Band, look[t]!.rangeKm, look[t]!.el, station, sunSep[t]!, {
              rainMmH: v.precip[t]!,
              lwcMm: v.cloud[t]! * 0.25 + 0.08 * v.precip[t]!,
              rh: v.rh[t]!,
              kp: space.kp,
              f107: space.f107,
              xray: space.xray,
            }),
          );
          const pAi = idx.map((t, i) =>
            linkAi({
              el: el[i]!,
              el_rate: elRate[i]!,
              range_km: look[t]!.rangeKm,
              t_since_aos: (i * stepS) / 60,
              t_to_los: ttl[i]!,
              max_el_pass: maxEl,
              sun_sep: sunSep[t]!,
              geomag_abs: Math.abs(station.geomagLat),
              alt_km: station.altKm,
              fc_precip: v.precip[t]!,
              fc_cloud: v.cloudOpt[t]!,
              rh: v.rh[t]!,
              kp: space.kp,
              log_xray: logXray,
              f107: space.f107,
              margin_now: m[i]!,
              margin_trend: i >= 2 ? m[i]! - m[i - 2]! : 0,
              ch_S: 0,
              ch_X: band === 'X' ? 1 : 0,
              ch_Ka: band === 'Ka' ? 1 : 0,
              ch_OPT: 0,
            }),
          );
          const risk = outageRisk(pAi, m, stepS, LOOKAHEAD_MIN);
          for (let i = 0; i < n; i++) {
            const p = m[i]! > 0 ? risk[i]! : 1;
            if (p < bestP[i] - 1e-9) {
              bestP[i] = p;
              bestCh[i] = band;
              bestRate[i] = RF_CHANNELS[band as Band].rateBps / 1e6;
            }
          }
        }
        // of the stations in view: the more reliable channel, then the higher one
        for (let i = 0; i < n; i++) {
          const t = a + i;
          if (bestP[i] + (90 - el[i]!) / 1000 < c.p[t]! + (90 - c.el[t]!) / 1000) {
            c.st[t] = j;
            c.el[t] = el[i]!;
            c.p[t] = bestP[i];
            c.ttl[t] = ttl[i]!;
            c.rate[t] = bestRate[i];
            c.ch[t] = bestCh[i];
            c.storm[t] = stormy;
            c.wx[t] = v.precip[t]!;
          }
        }
      }
    }
    if (VIA_TDRS.has(s) && tdrs.length) {
      // Terra: the relay in geostationary orbit replaces a station; station weather and horizons do not apply
      const anyVis = ecef[s]!.map((p, t) => tdrs.some((r) => lineOfSight(p, r[t]!, 100)));
      const remain = new Array(T).fill(0);
      for (const [a, b] of runs(anyVis)) for (let t = a; t < b; t++) remain[t] = ((b - 1 - t) * stepS) / 60;
      const j = sidx[TDRS_GROUND]!;
      for (let t = 0; t < T; t++) {
        if (!anyVis[t] || c.st[t]! >= 0) continue;
        c.st[t] = j;
        c.el[t] = 90;
        c.p[t] = 0.01;
        c.rate[t] = TDRS_MBPS;
        c.ch[t] = 'TDRS';
        c.ttl[t] = remain[t];
      }
    }
    if (db && DIRECT_BROADCAST.has(s)) {
      // direct broadcast received in Astana when the 15 Mbit/s margin is positive
      const station = STATIONS[DB_STATION]!;
      const sta = geodeticToEcef(station.lat, station.lon, station.altKm);
      const v = envAt(DB_STATION, false);
      const rateGain = 10 * Math.log10(RF_CHANNELS.X.rateBps / (DB_MBPS * 1e6));
      for (let t = 0; t < T; t++) {
        const l = lookAngles(ecef[s]![t]!, station.lat, station.lon, station.altKm, sta);
        if (!(Number.isFinite(l.el) && l.el >= MIN_EL)) continue;
        const d = l.los[0] * sun[t]![0] + l.los[1] * sun[t]![1] + l.los[2] * sun[t]![2];
        const sep = (Math.acos(Math.min(1, Math.max(-1, d))) * 180) / Math.PI;
        const m =
          rfMarginDb('X', l.rangeKm, l.el, station, sep, {
            rainMmH: v.precip[t]!,
            lwcMm: v.cloud[t]! * 0.25 + 0.08 * v.precip[t]!,
            rh: v.rh[t]!,
            kp: space.kp,
            f107: space.f107,
            xray: space.xray,
          }) + rateGain;
        const dumping = c.st[t]! >= 0 && c.p[t]! < P_OUT;
        c.db[t] = m > 0 && !(PAUSES_BROADCAST_WHILE_DUMPING.has(s) && dumping);
      }
    }
  }
  const dbJ = sidx[DB_STATION] ?? -1;

  // ---------------------------------------------------------------- actions and data on board
  const act = sats.map(() => new Array<number>(T).fill(ACTIONS.STORE));
  const qlog = sats.map(() => new Array<number>(T).fill(0));
  let deliveredMb = 0;
  sats.forEach((s, i) => {
    const c = contact[s]!;
    let queue = 0;
    const produce = RETIRED[s] ? 0 : PRODUCE_MBPS[s]!;
    for (let t = 0; t < T; t++) {
      queue += (produce * stepS) / 8;
      if (c.st[t]! >= 0 && c.p[t]! < P_OUT) {
        act[i]![t] = ACTIONS.DOWNLINK;
        const sent = Math.min(queue, (c.rate[t]! * stepS) / 8);
        queue -= sent;
        deliveredMb += sent;
      } else if (c.db[t]) {
        act[i]![t] = ACTIONS.BROADCAST;
      }
      qlog[i]![t] = queue;
    }
  });

  // ---------------------------------------------------------------- when each link ends
  const forecast = sats.map((s) => {
    const c = contact[s]!;
    const ok = c.st.map((x, t) => x >= 0 && c.p[t]! < P_OUT);
    const [drop, nxt] = linkForecast(ok, stepS);
    return ok.map((up, t) => {
      if (up) {
        const te = Number.isFinite(drop[t]!) ? t + Math.round((drop[t]! * 60) / stepS) : -1;
        const reason =
          te < 0 ? '' : c.st[te]! >= 0 ? (c.wx[te]! >= 0.5 || c.storm[te] ? 'weather' : 'margin') : c.blocked[te]! >= 0 ? 'outage' : 'los';
        return [roundOrNull(drop[t]!), null, -1, reason, round(c.p[t]!, 3)] as const;
      }
      const tn = Number.isFinite(nxt[t]!) ? t + Math.round((nxt[t]! * 60) / stepS) : -1;
      const reason = c.blocked[t]! >= 0 ? 'outage' : c.st[t]! >= 0 ? (c.wx[t]! >= 0.5 || c.storm[t] ? 'weather' : 'margin') : 'los';
      return [null, roundOrNull(nxt[t]!), tn >= 0 ? c.st[tn]! : -1, reason, round(c.p[t]!, 3)] as const;
    });
  });

  // ---------------------------------------------------------------- when data taken now are on the ground
  const k = stepS / 60;
  const arriveAll: number[][] = [];
  const dumpAll: number[][] = [];
  const delivery = sats.map((s) => {
    const c = contact[s]!;
    const dumpOk = c.st.map((x, t) => x >= 0 && c.p[t]! < P_OUT);
    const [arrive, path] = groundArrival(dumpOk, c.db);
    const [dumpOnly] = groundArrival(dumpOk, new Array(T).fill(false));
    arriveAll.push(arrive);
    dumpAll.push(dumpOnly);
    return arrive.map((a, t) => {
      const pth = path[t]!;
      const how = pth === 0 ? '' : pth === 2 ? 'db' : c.ch[a] === 'TDRS' ? 'tdrs' : 'dump';
      const station = pth === 2 ? dbJ : pth === 1 ? c.st[a]! : -1;
      return [a < INF ? round((a - t) * k, 1) : null, how, station, dumpOnly[t]! < INF ? round((dumpOnly[t]! - t) * k, 1) : null] as const;
    });
  });

  // ---------------------------------------------------------------- tracks and passes over Kazakhstan
  const tracks = sats.map((s) =>
    ecef[s]!.map((p) => {
      const [la, lo, alt] = ecefToLatLon(p);
      return [round(lo, 3), round(la, 3), round(alt, 1)] as [number, number, number];
    }),
  );
  const [w, so, e, no] = REGION.bbox;
  const passes: {
    sat: number;
    t_start: number;
    t_end: number;
    ground_t: number | null;
    wait_min: number | null;
    wait_dump_min: number | null;
    path: string;
    station: number;
  }[] = [];
  sats.forEach((s, i) => {
    if (RETIRED[s]) return;
    const sees = tracks[i]!.map(
      ([lo, la]) => haversineKm(la, lo, Math.min(no, Math.max(so, la)), Math.min(e, Math.max(w, lo))) <= HALF_SWATH_KM[SENSOR[s]!],
    );
    for (const [a, b] of runs(sees)) {
      const last = b - 1;
      const arr = Math.max(...arriveAll[i]!.slice(a, b));
      const arrDump = Math.max(...dumpAll[i]!.slice(a, b));
      const row = delivery[i]![last]!;
      passes.push({
        sat: i,
        t_start: a,
        t_end: last,
        ground_t: arr < INF ? arr : null,
        wait_min: arr < INF ? round((arr - last) * k, 1) : null,
        wait_dump_min: arrDump < INF ? round((arrDump - last) * k, 1) : null,
        path: row[1],
        station: row[2],
      });
    }
  });
  passes.sort((a, b) => a.t_start - b.t_start);
  const known = passes.filter((p) => p.ground_t !== null);
  const first = known.length ? known.reduce((x, y) => (y.ground_t! < x.ground_t! ? y : x)) : null;

  const active = sats.map((s, i) => (RETIRED[s] ? -1 : i)).filter((i) => i >= 0);
  const now: number[] = [];
  const withDb: number[] = [];
  let beyond = 0;
  for (const i of active) {
    for (let t = 0; t < T; t++) {
      if (dumpAll[i]![t]! < INF) now.push((dumpAll[i]![t]! - t) * k);
      else beyond++;
      if (arriveAll[i]![t]! < INF) withDb.push((arriveAll[i]![t]! - t) * k);
    }
  }

  const states = sats.map((s, i) => {
    const c = contact[s]!;
    return act[i]!.map((a, t) => [
      a,
      c.db[t] ? dbJ : -1,
      a === ACTIONS.DOWNLINK ? c.st[t]! : a === ACTIONS.BROADCAST ? dbJ : -1,
      round(c.p[t]!, 3),
      round(c.ttl[t]!, 1),
      round(qlog[i]![t]!, 1),
      a === ACTIONS.DOWNLINK ? c.ch[t]! : a === ACTIONS.BROADCAST ? 'DB' : '',
    ]);
  });
  const minutesBy = Object.fromEntries(
    Object.entries(ACTIONS).map(([name, code]) => [
      name,
      Object.fromEntries(sats.map((s, i) => [s, round(act[i]!.filter((a) => a === code).length * k, 1)])),
    ]),
  );
  return {
    start: start.toISOString(),
    step_s: stepS,
    minutes,
    storm,
    outage,
    db,
    satellites: sats.map((s, i) => ({
      name: s,
      track: tracks[i]!,
      sensor: SENSOR[s]!,
      retired: RETIRED[s] ?? null,
      broadcast: DIRECT_BROADCAST.has(s),
      access: VIA_TDRS.has(s) ? 'TDRS' : [...(ACCESS[s] ?? [])],
    })),
    stations: stations.map((x) => ({ id: x.id, name: x.name, lat: x.lat, lon: x.lon, kind: 'radio' })),
    states_fields: ['action', 'db_station', 'station', 'p_out', 'ttl_min', 'queue_mb', 'channel'],
    actions: ACTIONS,
    states,
    forecast_fields: ['drop_min', 'next_min', 'next_station', 'reason', 'p_out_5min'],
    forecast,
    delivery_fields: ['ground_min', 'path', 'station', 'dump_only_min'],
    delivery,
    region: { name: REGION.name, bbox: REGION.bbox, passes, first: first ? { sat: first.sat, t_end: first.t_end, ground_t: first.ground_t } : null },
    summary: {
      minutes: minutesBy,
      delivered_mb: Math.round(deliveredMb),
      latency: { now: stats(now), with_db: db ? stats(withDb) : null, beyond_window: beyond },
      p_out_threshold: P_OUT,
      lookahead_min: LOOKAHEAD_MIN,
      engine: 'typescript',
    },
  };
}

export type Constellation = ReturnType<typeof simulate>;

/** Station where a storm changes the most link decisions in this window (helios: _best_storm_cached). */
export function bestStormStation(input: Omit<SimInput, 'storm'>, base: Constellation): string | null {
  const used = [...new Set(base.states.flatMap((rows) => rows.filter((r) => r[0] === ACTIONS.DOWNLINK && (r[2] as number) >= 0).map((r) => r[2] as number)))].sort(
    (a, b) => a - b,
  );
  let best: string | null = null;
  let bestScore = 0;
  for (const j of used) {
    const sid = base.stations[j]!.id;
    if (sid === TDRS_GROUND) continue; // a storm over White Sands does not touch Terra's link to TDRS in orbit
    const other = simulate({ ...input, storm: sid });
    let score = 0;
    other.states.forEach((rows, i) => rows.forEach((r, t) => (score += r[0] !== base.states[i]![t]![0] ? 1 : 0)));
    if (score > bestScore) {
      best = sid;
      bestScore = score;
    }
  }
  return best ?? used.map((j) => base.stations[j]!.id).find((id) => id !== TDRS_GROUND) ?? null;
}

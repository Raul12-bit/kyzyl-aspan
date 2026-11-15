import { LINK, rainAttenuationDb, STATIONS, syntheticForecast, type GroundStation } from '../downlink';
import {
  EARTH_RADIUS_KM,
  elevationFromEcef,
  FLEET,
  geoToEcef,
  positionEcef,
  toGeo,
  type GeoPoint,
  type Satellite,
  type Vec3,
} from '../orbit';

/**
 * AI #2 — the satellite's link manager (runs on board, every 30 s).
 *
 * 1. Orbit calculation: propagates its own orbit and its neighbours' (orbit.ts, circular two-body
 *    orbits — or, live, SGP4 from today's CelesTrak elements through `propagator`) to know which ground
 *    stations, GEO laser relays and neighbouring satellites are in view — now and for the next minutes.
 * 2. Loss-of-signal prediction: for every link, the time until the geometry breaks (deterministic) and
 *    the chance that weather or space weather breaks it first (rain fade from the station forecast,
 *    laser pointing loss, ionospheric scintillation on the backup radio during a geomagnetic storm).
 * 3. Decision: bulk data rides the best link that will hold (laser to a GEO relay or a neighbour, Ka-
 *    or X-band to a station) and is handed over BEFORE the current link drops (make-before-break);
 *    a fire alert from AI #1 goes out at once — by laser if one is up, otherwise as a 16-byte packet over
 *    the backup S-band radio to a station or to a neighbour that forwards it.
 *
 * The baseline it is compared with reacts instead of predicting: it keeps a link until it drops, then
 * re-acquires, and alerts wait for the next bulk contact. Terminal ranges, rates, acquisition time and
 * outage probabilities are ASSUMPTIONS of the demo (orders of magnitude of current hardware); weather is
 * synthetic. No neural network here: AI #2 is an onboard planning agent built on physics and probabilities.
 */

export const STEP_SEC = 30;
export const GEO_RADIUS_KM = 42_164;

export interface Relay {
  id: string;
  name: string;
  lng: number;
}

/** European Data Relay System laser relays in geostationary orbit (real positions). */
export const RELAYS: readonly Relay[] = [
  { id: 'edrs-a', name: 'EDRS-A', lng: 9 },
  { id: 'edrs-c', name: 'EDRS-C', lng: 31 },
];

export const TERMINALS = {
  /** Laser data rate, Mbit/s (EDRS: 1.8 Gbit/s). */
  laserMbps: { relay: 1800, neighbour: 1000 },
  /** Longest LEO–LEO laser link, km (ASSUMPTION). */
  laserNeighbourKm: 5000,
  /** Time to point, acquire and lock a laser terminal, s (ASSUMPTION). */
  laserAcquireSec: 60,
  /** Time to lock an RF downlink, s (ASSUMPTION). */
  rfAcquireSec: 10,
  /** A path must clear the Earth by this much (atmosphere, refraction), km. */
  clearanceKm: 100,
  /** Backup S-band radio between satellites, km (ASSUMPTION). */
  radioNeighbourKm: 3000,
  /** Laser pointing-loss probability per 5 minutes (ASSUMPTION). */
  laserLoss5min: { relay: 0.02, neighbour: 0.06 },
  /** Kp at which scintillation starts to break the backup radio at high-latitude stations. */
  stormKp: 7,
  /** Average science data rate, Mbit/s (MODIS ≈ 6.2, VIIRS ≈ 10.5). */
  generateMbps: { MODIS: 6.2, VIIRS: 10.5 },
} as const;

export type LinkKind = 'laser-relay' | 'laser-neighbour' | 'ka' | 'x';
export type AlertVia = 'laser' | 'radio-ground' | 'radio-neighbour' | 'bulk';

export interface LinkOption {
  kind: LinkKind;
  /** Station, relay or satellite id. */
  target: string;
  /** Visible over this many steps from the current one (≥ 1 when up). */
  stepsLeft: number;
  /** Chance that weather / pointing breaks the link within 5 min (geometry excluded). */
  pEnv: number;
  mbps: number;
}

export interface SimOptions {
  satelliteId: string;
  /** Simulation start, s since the orbit epoch. */
  startSec?: number;
  minutes?: number;
  /** A station drowned in a downpour for the whole window (null = synthetic weather only). */
  stormStation?: string | null;
  /** Planetary K index of geomagnetic activity, 0–9. */
  kp?: number;
  /** Extra fire alerts from AI #1, as minutes after the start. */
  alertsAtMin?: number[];
  weatherSeed?: number;
  policy: 'ai' | 'reactive';
  /**
   * Real positions: Earth-fixed km of satellite `id` at `tSec` (same clock as `startSec`). Null for a satellite
   * it does not know, which then keeps its circular orbit.
   */
  propagator?: (id: string, tSec: number) => Vec3 | null;
}

export interface StepRecord {
  k: number;
  tSec: number;
  sub: GeoPoint;
  /** What the bulk channel does in this step. */
  action: LinkKind | 'acquire' | 'store';
  target: string | null;
  /** Predicted chance that the active link is lost within 5 min (geometry + environment). */
  pLoss: number | null;
  /** Minutes until the active link's geometry breaks. */
  minutesToLos: number | null;
  queueMB: number;
  /** The link dropped unexpectedly in this step (only the reactive policy lets that happen). */
  dropped: boolean;
  /** AI #2 started a handoff to another link before the current one was lost. */
  handoff: boolean;
}

export interface AlertRecord {
  atStep: number;
  deliveredStep: number | null;
  via: AlertVia | null;
  target: string | null;
  latencySec: number | null;
}

export interface SimResult {
  satellite: Satellite;
  policy: SimOptions['policy'];
  steps: StepRecord[];
  alerts: AlertRecord[];
  stats: {
    generatedGB: number;
    deliveredGB: number;
    /** Data age when it reached the ground, minutes (FIFO). */
    meanDelayMin: number | null;
    medianDelayMin: number | null;
    p90DelayMin: number | null;
    maxDelayMin: number | null;
    drops: number;
    handoffs: number;
    alertMedianSec: number | null;
    alertMaxSec: number | null;
  };
}

/* ------------------------------------------------------------------ geometry */

const dot = (a: Vec3, b: Vec3) => a.x * b.x + a.y * b.y + a.z * b.z;

/** True when the straight path a→b stays clear of the Earth (plus `clearanceKm`). */
export function lineOfSight(a: Vec3, b: Vec3, clearanceKm: number = TERMINALS.clearanceKm): boolean {
  const d = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z };
  const dd = dot(d, d);
  const t = dd > 0 ? Math.max(0, Math.min(1, -dot(a, d) / dd)) : 0;
  const c = { x: a.x + d.x * t, y: a.y + d.y * t, z: a.z + d.z * t };
  return Math.sqrt(dot(c, c)) > EARTH_RADIUS_KM + clearanceKm;
}

export function distanceKm(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

export function relayPosition(r: Relay): Vec3 {
  return geoToEcef({ lat: 0, lng: r.lng }, GEO_RADIUS_KM - EARTH_RADIUS_KM);
}

interface Geometry {
  n: number;
  start: number;
  sub: GeoPoint[];
  /** [station][step] elevation, deg. */
  elevation: Float32Array[];
  /**
   * Steps a link stays up from step k on (0 = down now) — the "time to loss of signal" AI #2 reads off
   * its orbit propagation. [station | relay | neighbour][step].
   */
  stationLeft: Int16Array[];
  relayLeft: Int16Array[];
  laserLeft: Int16Array[];
  radioUp: Uint8Array[];
  neighbours: Satellite[];
}

/** left[k] = consecutive steps from k on which up[k] holds (one backward pass). */
function stepsLeft(up: Uint8Array): Int16Array {
  const left = new Int16Array(up.length);
  for (let k = up.length - 1; k >= 0; k--) left[k] = up[k] ? 1 + (k + 1 < up.length ? left[k + 1]! : 0) : 0;
  return left;
}

type Propagator = SimOptions['propagator'];

/** Earth-fixed position of a satellite: the real one when the propagator knows it, else the circular orbit. */
export function fleetPosition(s: Satellite, t: number, propagator?: Propagator): Vec3 {
  return propagator?.(s.id, t) ?? positionEcef(s, t);
}

function computeGeometry(sat: Satellite, start: number, n: number, propagator?: Propagator): Geometry {
  const neighbours = FLEET.filter((s) => s.id !== sat.id);
  const relayPos = RELAYS.map(relayPosition);
  const elevation = STATIONS.map(() => new Float32Array(n));
  const stationUp = STATIONS.map(() => new Uint8Array(n));
  const relayUp = RELAYS.map(() => new Uint8Array(n));
  const laserUp = neighbours.map(() => new Uint8Array(n));
  const radioUp = neighbours.map(() => new Uint8Array(n));
  const sub: GeoPoint[] = [];
  for (let k = 0; k < n; k++) {
    const t = start + k * STEP_SEC;
    const p = fleetPosition(sat, t, propagator);
    sub.push(toGeo(p));
    STATIONS.forEach((st, i) => {
      const e = elevationFromEcef(p, st.location);
      elevation[i]![k] = e;
      stationUp[i]![k] = e >= LINK.minElevationDeg ? 1 : 0;
    });
    relayPos.forEach((r, i) => (relayUp[i]![k] = lineOfSight(p, r) ? 1 : 0));
    neighbours.forEach((o, i) => {
      const q = fleetPosition(o, t, propagator);
      const los = lineOfSight(p, q);
      const d = distanceKm(p, q);
      laserUp[i]![k] = los && d <= TERMINALS.laserNeighbourKm ? 1 : 0;
      radioUp[i]![k] = los && d <= TERMINALS.radioNeighbourKm ? 1 : 0;
    });
  }
  return {
    n,
    start,
    sub,
    elevation,
    stationLeft: stationUp.map(stepsLeft),
    relayLeft: relayUp.map(stepsLeft),
    laserLeft: laserUp.map(stepsLeft),
    radioUp,
    neighbours,
  };
}

/* ------------------------------------------------------------------ weather */

/** Deterministic 0…1 draw. */
function draw(...parts: number[]): number {
  let h = 2166136261;
  for (const p of parts) {
    h ^= p | 0;
    h = Math.imul(h, 16777619);
  }
  h ^= h >>> 13;
  h = Math.imul(h, 0x5bd1e995);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

const STORM_RAIN = 28; // mm/h — a downpour that breaks Ka-band at any elevation

/** Rain the station really gets in that hour (one draw from its forecast). */
function realizedRain(st: GroundStation, tSec: number, seed: number, storm: string | null): number {
  if (storm === st.id) return STORM_RAIN;
  const f = syntheticForecast(st, tSec, seed);
  let u = draw(seed, st.id.length * 131 + st.id.charCodeAt(0), Math.floor(tSec / 3600));
  for (const s of f.scenarios) {
    if (u < s.p) return s.rate;
    u -= s.p;
  }
  return 0;
}

/** Forecast chance that a band's margin holds at this station and elevation. */
function bandReliability(
  band: 'Ka' | 'X',
  st: GroundStation,
  tSec: number,
  elev: number,
  seed: number,
  storm: string | null,
): number {
  if (storm === st.id) return rainAttenuationDb(band, STORM_RAIN, elev) <= LINK.marginDb[band] ? 1 : 0;
  const f = syntheticForecast(st, tSec, seed);
  let p = 0;
  for (const s of f.scenarios)
    if (rainAttenuationDb(band, s.rate, Math.max(5, elev)) <= LINK.marginDb[band]) p += s.p;
  return p;
}

/* ------------------------------------------------------------------ the agent */

const SATELLITE_NAMES: Record<string, string> = Object.fromEntries(FLEET.map((s) => [s.id, s.name]));

export function satelliteName(id: string): string {
  return SATELLITE_NAMES[id] ?? id;
}

function options(g: Geometry, k: number, tSec: number, seed: number, storm: string | null): LinkOption[] {
  const out: LinkOption[] = [];
  RELAYS.forEach((r, i) => {
    const left = g.relayLeft[i]![k]!;
    if (left > 0)
      out.push({
        kind: 'laser-relay',
        target: r.id,
        stepsLeft: left,
        pEnv: TERMINALS.laserLoss5min.relay,
        mbps: TERMINALS.laserMbps.relay,
      });
  });
  g.neighbours.forEach((o, i) => {
    const left = g.laserLeft[i]![k]!;
    if (left > 0)
      out.push({
        kind: 'laser-neighbour',
        target: o.id,
        stepsLeft: left,
        pEnv: TERMINALS.laserLoss5min.neighbour,
        mbps: TERMINALS.laserMbps.neighbour,
      });
  });
  STATIONS.forEach((st, i) => {
    const left = g.stationLeft[i]![k]!;
    if (left === 0) return;
    const elev = g.elevation[i]![k]!;
    if (st.bands.includes('Ka')) {
      out.push({
        kind: 'ka',
        target: st.id,
        stepsLeft: left,
        pEnv: 1 - bandReliability('Ka', st, tSec, elev, seed, storm),
        mbps: LINK.rateMbps.Ka,
      });
    }
    out.push({
      kind: 'x',
      target: st.id,
      stepsLeft: left,
      pEnv: 1 - bandReliability('X', st, tSec, elev, seed, storm),
      mbps: LINK.rateMbps.X,
    });
  });
  return out;
}

/** Predicted chance of losing a link within the next 5 minutes: geometry is certain, environment is not. */
export function lossProbability(o: Pick<LinkOption, 'stepsLeft' | 'pEnv'>): number {
  const fiveMin = 300 / STEP_SEC;
  const pGeo = o.stepsLeft <= fiveMin ? 1 : 0;
  return 1 - (1 - pGeo) * (1 - o.pEnv);
}

function acquireSteps(kind: LinkKind): number {
  return Math.ceil(
    (kind.startsWith('laser') ? TERMINALS.laserAcquireSec : TERMINALS.rfAcquireSec) / STEP_SEC,
  );
}

/** Expected Mbit the link can still carry: rate × remaining time × chance it holds. */
function value(o: LinkOption): number {
  const usable = Math.max(0, o.stepsLeft - acquireSteps(o.kind));
  return o.mbps * usable * STEP_SEC * (1 - o.pEnv);
}

/** Did weather or pointing really break this link in this step? (one deterministic draw per contact-hour) */
function realizedFailure(
  o: LinkOption,
  g: Geometry,
  k: number,
  tSec: number,
  seed: number,
  storm: string | null,
): boolean {
  if (o.kind === 'ka' || o.kind === 'x') {
    const i = STATIONS.findIndex((s) => s.id === o.target);
    const st = STATIONS[i]!;
    const rain = realizedRain(st, tSec, seed, storm);
    const band = o.kind === 'ka' ? 'Ka' : 'X';
    return rainAttenuationDb(band, rain, Math.max(5, g.elevation[i]![k]!)) > LINK.marginDb[band];
  }
  // Laser: a pointing loss is a rare event; spread the 5-minute probability over its steps.
  const perStep = 1 - Math.pow(1 - o.pEnv, STEP_SEC / 300);
  return draw(seed, k, o.target.length * 97 + o.target.charCodeAt(0), 7) < perStep;
}

function radioGroundTarget(g: Geometry, k: number, kp: number): string | null {
  let best: { id: string; elev: number } | null = null;
  STATIONS.forEach((st, i) => {
    const e = g.elevation[i]![k]!;
    if (e < LINK.minElevationDeg) return;
    // Strong geomagnetic storms make high-latitude S-band links unreliable (scintillation).
    if (kp >= TERMINALS.stormKp && Math.abs(st.location.lat) >= 55) return;
    if (!best || e > best.elev) best = { id: st.id, elev: e };
  });
  return (best as { id: string } | null)?.id ?? null;
}

function radioNeighbourTarget(g: Geometry, k: number): string | null {
  const i = g.radioUp.findIndex((up) => up[k] === 1);
  return i >= 0 ? g.neighbours[i]!.id : null;
}

/**
 * Plays one satellite through `minutes` of orbit with either policy. Deterministic for fixed options.
 * ~1–3 ms for three hours on a laptop.
 */
export function simulateLinks(opts: SimOptions): SimResult {
  const sat = FLEET.find((s) => s.id === opts.satelliteId) ?? FLEET[0]!;
  const start = opts.startSec ?? 0;
  const n = Math.max(2, Math.round(((opts.minutes ?? 180) * 60) / STEP_SEC));
  const seed = opts.weatherSeed ?? 1;
  const storm = opts.stormStation ?? null;
  const kp = opts.kp ?? 2;
  const g = computeGeometry(sat, start, n, opts.propagator);
  const genMB = (TERMINALS.generateMbps[sat.sensor] * STEP_SEC) / 8;

  // Alerts: the first pass over Kazakhstan (where AI #1 would see the steppe burning) + the visitor's.
  const alertSteps = new Set<number>();
  const kz = g.sub.findIndex((p) => p.lat > 41 && p.lat < 55 && p.lng > 47 && p.lng < 87);
  if (kz >= 0) alertSteps.add(kz);
  for (const m of opts.alertsAtMin ?? []) {
    const k = Math.round((m * 60) / STEP_SEC);
    if (k >= 0 && k < n) alertSteps.add(k);
  }

  const queue: { step: number; mb: number }[] = [];
  const delays: number[] = [];
  const steps: StepRecord[] = [];
  const alerts: AlertRecord[] = [...alertSteps]
    .sort((a, b) => a - b)
    .map((s) => ({ atStep: s, deliveredStep: null, via: null, target: null, latencySec: null }));
  /** The link carrying data now, and the one the terminal is locking on (make-before-break). */
  let locked: { kind: LinkKind; target: string } | null = null;
  let acquiring: { kind: LinkKind; target: string; ready: number } | null = null;
  let generated = 0;
  let delivered = 0;
  let drops = 0;
  let handoffs = 0;
  const same = (o: LinkOption, l: { kind: LinkKind; target: string }) =>
    o.kind === l.kind && o.target === l.target;

  for (let k = 0; k < n; k++) {
    const tSec = start + k * STEP_SEC;
    queue.push({ step: k, mb: genMB });
    generated += genMB;
    const up = options(g, k, tSec, seed, storm);
    const find = (l: { kind: LinkKind; target: string } | null) =>
      l ? (up.find((o) => same(o, l)) ?? null) : null;
    let handoff = false;
    let dropped = false;

    // Geometry ended the locked link: planned (AI already locked the next one) or a surprise.
    if (locked && !find(locked)) {
      dropped = true;
      locked = null;
    }
    if (acquiring && !find(acquiring)) acquiring = null;
    if (acquiring && k >= acquiring.ready) {
      locked = { kind: acquiring.kind, target: acquiring.target };
      acquiring = null;
      dropped = false;
    }

    if (opts.policy === 'ai' && !acquiring) {
      // Predict, then act: never pick a link the forecast says will fail; switch before the current one ends.
      const current = find(locked);
      const candidates = up.filter((o) => o.pEnv < 0.5 && !(locked && same(o, locked)));
      const best = candidates.sort((a, b) => value(b) - value(a))[0] ?? null;
      if (!current) {
        if (best) acquiring = { kind: best.kind, target: best.target, ready: k + acquireSteps(best.kind) };
      } else if (best) {
        const endsSoon = current.stepsLeft <= acquireSteps(best.kind) + 1;
        const failing = current.pEnv >= 0.5;
        const muchBetter = value(best) > 2 * current.mbps * current.stepsLeft * STEP_SEC * (1 - current.pEnv);
        if (endsSoon || failing || muchBetter) {
          acquiring = { kind: best.kind, target: best.target, ready: k + acquireSteps(best.kind) };
          handoff = true;
          handoffs += 1;
        }
      }
    } else if (opts.policy === 'reactive' && !locked && !acquiring && up.length) {
      // React: take the first link in view (laser first) and keep it until it drops.
      const order: LinkKind[] = ['laser-relay', 'laser-neighbour', 'ka', 'x'];
      const pick = [...up].sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind))[0]!;
      acquiring = { kind: pick.kind, target: pick.target, ready: k + acquireSteps(pick.kind) };
    }

    // Transmit on the locked link — unless weather or pointing really breaks it in this step.
    let sendOn = find(locked);
    if (sendOn && realizedFailure(sendOn, g, k, tSec, seed, storm)) {
      dropped = true;
      sendOn = null;
      locked = null;
    }
    if (dropped) drops += 1;

    let budget = sendOn ? (sendOn.mbps * STEP_SEC) / 8 : 0;
    while (budget > 0 && queue.length) {
      const head = queue[0]!;
      const take = Math.min(head.mb, budget);
      head.mb -= take;
      budget -= take;
      delivered += take;
      if (head.mb <= 1e-9) {
        delays.push((k - head.step) * STEP_SEC);
        queue.shift();
      }
    }

    // Fire alerts from AI #1: laser if a link is up; otherwise AI #2 falls back to the backup radio.
    for (const a of alerts) {
      if (a.deliveredStep !== null || a.atStep > k) continue;
      let via: AlertVia | null = null;
      let target: string | null = null;
      if (sendOn) {
        via = sendOn.kind.startsWith('laser') ? 'laser' : 'bulk';
        target = sendOn.target;
      } else if (opts.policy === 'ai') {
        target = radioGroundTarget(g, k, kp);
        if (target) via = 'radio-ground';
        else {
          target = radioNeighbourTarget(g, k);
          if (target) via = 'radio-neighbour';
        }
      }
      if (via) {
        a.deliveredStep = k;
        a.via = via;
        a.target = target;
        // Sent in the step it was raised: seconds (laser ≈ 2 s, radio ≈ 8 s, via a neighbour ≈ 20 s).
        a.latencySec =
          k === a.atStep
            ? via === 'laser'
              ? 2
              : via === 'radio-neighbour'
                ? 20
                : 8
            : (k - a.atStep) * STEP_SEC;
      }
    }

    steps.push({
      k,
      tSec,
      sub: g.sub[k]!,
      action: sendOn ? sendOn.kind : acquiring ? 'acquire' : 'store',
      target: sendOn?.target ?? acquiring?.target ?? null,
      pLoss: sendOn ? lossProbability(sendOn) : null,
      minutesToLos: sendOn ? (sendOn.stepsLeft * STEP_SEC) / 60 : null,
      queueMB: queue.reduce((s, q) => s + q.mb, 0),
      dropped,
      handoff,
    });
  }

  const sorted = [...delays].sort((a, b) => a - b);
  const q = (p: number) =>
    sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]! / 60 : null;
  const lat = alerts
    .map((a) => a.latencySec)
    .filter((v): v is number => v !== null)
    .sort((a, b) => a - b);
  return {
    satellite: sat,
    policy: opts.policy,
    steps,
    alerts,
    stats: {
      generatedGB: generated / 1000,
      deliveredGB: delivered / 1000,
      meanDelayMin: sorted.length ? sorted.reduce((a, b) => a + b, 0) / sorted.length / 60 : null,
      medianDelayMin: q(0.5),
      p90DelayMin: q(0.9),
      maxDelayMin: sorted.length ? sorted[sorted.length - 1]! / 60 : null,
      drops,
      handoffs,
      alertMedianSec: lat.length ? lat[Math.floor((lat.length - 1) / 2)]! : null,
      alertMaxSec: lat.length ? lat[lat.length - 1]! : null,
    },
  };
}

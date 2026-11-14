import { findPasses, type GeoPoint, type Pass, type Satellite } from './orbit';

/**
 * Downlink planner — concept for idea 5 ("predict the link before it breaks").
 *
 * The planner knows (1) where the satellite will be (orbit.ts), (2) which ground stations will see it
 * and when, and (3) the rain forecast at each antenna. Ka-band carries the most data but fades in
 * heavy rain; X-band is slower but barely notices rain. For every upcoming pass it estimates the
 * probability that Ka-band holds, and picks Ka, falls back to X, or skips to a better station.
 *
 * Every number marked ASSUMPTION is a modelling choice for the demo, not a property of a real
 * station, and the "forecast" is synthetic. Production would plug in operational station
 * capabilities, link budgets and a numerical weather forecast.
 */

export type Band = 'Ka' | 'X';

export interface GroundStation {
  id: string;
  name: string;
  location: GeoPoint;
  /** Bands assumed available for this simulation (ASSUMPTION). */
  bands: readonly Band[];
  /** Climatological rain intensity factor, 0…1 (ASSUMPTION; drives the synthetic forecast). */
  wetness: number;
}

/** Well-known high-latitude and polar-orbit support sites; capabilities here are assumptions. */
export const STATIONS: readonly GroundStation[] = [
  { id: 'svalbard', name: 'Svalbard', location: { lat: 78.23, lng: 15.39 }, bands: ['Ka', 'X'], wetness: 0.35 },
  { id: 'fairbanks', name: 'Fairbanks', location: { lat: 64.86, lng: -147.85 }, bands: ['Ka', 'X'], wetness: 0.4 },
  { id: 'troll', name: 'Troll', location: { lat: -72.01, lng: 2.53 }, bands: ['Ka', 'X'], wetness: 0.1 },
  { id: 'mcmurdo', name: 'McMurdo', location: { lat: -77.85, lng: 166.67 }, bands: ['X'], wetness: 0.1 },
  { id: 'wallops', name: 'Wallops', location: { lat: 37.94, lng: -75.46 }, bands: ['X'], wetness: 0.7 },
  { id: 'hartebeesthoek', name: 'Hartebeesthoek', location: { lat: -25.89, lng: 27.69 }, bands: ['Ka', 'X'], wetness: 0.6 },
];

export const LINK = {
  /** Data rates, Mbit/s (ASSUMPTION, order of magnitude of polar-orbiter science downlinks). */
  rateMbps: { Ka: 300, X: 150 } as Record<Band, number>,
  /** Clear-sky margin left for rain fade, dB (ASSUMPTION). */
  marginDb: { Ka: 6, X: 4 } as Record<Band, number>,
  /**
   * Specific attenuation γ = k·R^α dB/km for rain rate R mm/h — the power-law form of ITU-R P.838;
   * coefficients approximate that recommendation near 26 GHz (Ka) and 8 GHz (X).
   */
  rainCoeff: { Ka: { k: 0.17, alpha: 0.95 }, X: { k: 0.0047, alpha: 1.3 } } as Record<Band, { k: number; alpha: number }>,
  /** Height of the rain layer, km (ASSUMPTION). */
  rainHeightKm: 3.5,
  /** Below this probability of holding, Ka is not attempted. */
  minKaReliability: 0.75,
  minElevationDeg: 5,
};

/** Rain forecast at one station: a few rain-rate scenarios with probabilities (synthetic). */
export interface RainForecast {
  /** mm/h scenarios with their probabilities (sum to 1). */
  scenarios: { rate: number; p: number }[];
}

/** Deterministic pseudo-random in [0, 1) from integers. */
function hash01(...parts: number[]): number {
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

/**
 * Synthetic hourly forecast. Rain cells drift through a station over a few hours; `seed` lets the UI
 * "re-roll the weather". Not a weather model.
 */
export function syntheticForecast(station: GroundStation, t: number, seed = 1): RainForecast {
  const hour = Math.floor(t / 3600);
  const sid = station.id.split('').reduce((a, c) => a * 31 + c.charCodeAt(0), 7);
  // Smooth "storminess" from neighbouring hours so rain comes in episodes, not single hours.
  let storm = 0;
  for (let dh = -2; dh <= 2; dh++) storm += hash01(seed, sid, hour + dh) * (3 - Math.abs(dh));
  storm = storm / 9;
  const wet = Math.max(0, Math.min(1, (storm - (1 - station.wetness) * 0.75) * 2.2));
  const heavy = Math.max(0, wet - 0.35) * 25;
  return {
    scenarios: [
      { rate: 0, p: 1 - wet },
      { rate: 1.5 + wet * 4, p: wet * 0.7 },
      { rate: 6 + heavy, p: wet * 0.3 },
    ],
  };
}

/** Rain attenuation, dB, along the slant path through the rain layer. */
export function rainAttenuationDb(band: Band, rateMmH: number, elevationDeg: number): number {
  if (rateMmH <= 0) return 0;
  const { k, alpha } = LINK.rainCoeff[band];
  const gamma = k * Math.pow(rateMmH, alpha);
  const path = LINK.rainHeightKm / Math.sin(Math.max(5, elevationDeg) * (Math.PI / 180));
  return gamma * path;
}

/** Probability that the band's margin covers the rain fade, given the forecast. */
export function linkReliability(band: Band, forecast: RainForecast, elevationDeg: number): number {
  let p = 0;
  for (const s of forecast.scenarios) if (rainAttenuationDb(band, s.rate, elevationDeg) <= LINK.marginDb[band]) p += s.p;
  return Math.max(0, Math.min(1, p));
}

export type Decision = 'ka' | 'x-fallback' | 'x-only' | 'skip';

export interface PlannedPass {
  station: GroundStation;
  pass: Pass;
  /** Ka-band reliability (null when the station has no Ka). */
  kaReliability: number | null;
  xReliability: number;
  /** Expected rain rate at the antenna, mm/h. */
  expectedRain: number;
  decision: Decision;
  band: Band | null;
  /** Expected delivered volume, Gbit (rate × duration × reliability). */
  expectedGbit: number;
  /** Cumulative expected volume after this pass. */
  cumulativeGbit: number;
}

export interface DownlinkPlan {
  passes: PlannedPass[];
  /** When the backlog is expected to be cleared, s (null if not within the horizon). */
  doneAt: number | null;
  /** Same plan if the planner ignored weather and always used Ka (for comparison). */
  naiveDoneAt: number | null;
  /** Expected number of passes lost to rain fade: this plan vs. "always Ka". */
  expectedFailures: number;
  naiveExpectedFailures: number;
  backlogGbit: number;
}

function choose(ka: number | null, x: number): { decision: Decision; band: Band | null } {
  if (ka !== null && ka >= LINK.minKaReliability) return { decision: 'ka', band: 'Ka' };
  if (x >= 0.5) return { decision: ka === null ? 'x-only' : 'x-fallback', band: 'X' };
  return { decision: 'skip', band: null };
}

/**
 * Plans the next `horizonSec` of downlinks for one satellite over the station network.
 * Passes are taken in time order (the onboard recorder is a FIFO); overlapping passes at two stations
 * are both scheduled — a real scheduler would also arbitrate antennas between satellites.
 */
export function planDownlinks(
  sat: Satellite,
  stations: readonly GroundStation[],
  opts: { from: number; horizonSec: number; backlogGbit: number; weatherSeed?: number },
): DownlinkPlan {
  const all: { station: GroundStation; pass: Pass }[] = [];
  for (const station of stations) {
    for (const pass of findPasses(sat, station.location, opts.from, opts.from + opts.horizonSec, LINK.minElevationDeg)) {
      all.push({ station, pass });
    }
  }
  all.sort((a, b) => a.pass.aos - b.pass.aos);

  let cumulative = 0;
  let doneAt: number | null = null;
  let naive = 0;
  let naiveDoneAt: number | null = null;
  let failures = 0;
  let naiveFailures = 0;
  const passes: PlannedPass[] = all.map(({ station, pass }) => {
    const forecast = syntheticForecast(station, pass.tca, opts.weatherSeed);
    const elev = pass.maxElevationDeg * 0.7; // a pass spends most of its time well below its peak
    const ka = station.bands.includes('Ka') ? linkReliability('Ka', forecast, elev) : null;
    const x = linkReliability('X', forecast, elev);
    const { decision, band } = choose(ka, x);
    const seconds = pass.los - pass.aos;
    const reliability = band === 'Ka' ? ka! : band === 'X' ? x : 0;
    const expectedGbit = band ? (LINK.rateMbps[band] * seconds * reliability) / 1000 : 0;
    cumulative += expectedGbit;
    if (band) failures += 1 - reliability;
    if (doneAt === null && cumulative >= opts.backlogGbit) doneAt = pass.los;

    // Naive: always Ka where available, a fade loses the whole pass.
    const naiveBand: Band = station.bands.includes('Ka') ? 'Ka' : 'X';
    const naiveRel = naiveBand === 'Ka' ? ka! : x;
    naive += (LINK.rateMbps[naiveBand] * seconds * naiveRel) / 1000;
    naiveFailures += 1 - naiveRel;
    if (naiveDoneAt === null && naive >= opts.backlogGbit) naiveDoneAt = pass.los;

    const expectedRain = forecast.scenarios.reduce((a, s) => a + s.rate * s.p, 0);
    return { station, pass, kaReliability: ka, xReliability: x, expectedRain, decision, band, expectedGbit, cumulativeGbit: cumulative };
  });
  return { passes, doneAt, naiveDoneAt, expectedFailures: failures, naiveExpectedFailures: naiveFailures, backlogGbit: opts.backlogGbit };
}

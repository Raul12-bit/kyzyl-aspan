import { nextCoverage, type GeoPoint, type Satellite } from './orbit';

/**
 * Cross-satellite cueing — concept for idea 6 ("tip and cue").
 *
 * 1. Satellite A sees a candidate hot spot and sends a short alert through a relay.
 * 2. The system picks the satellite that will cover the spot soonest after the alert arrives.
 * 3. That satellite's next look confirms or rejects the candidate; a confirmed alert is promoted.
 *
 * This needs satellites that accept tasking and an inter-satellite or relay link. MODIS and VIIRS
 * are whisk-broom/push-broom imagers that always look straight down — they cannot be re-pointed, so
 * here "cueing" only means "whose next regular pass covers the spot". It cannot be added to the
 * existing missions by a website update; the simulation shows what the logic would decide.
 */

export interface CueInput {
  site: GeoPoint;
  /** Detection time on satellite A, s since epoch. */
  detectedAt: number;
  detectedBy: Satellite;
  /** 0…1 confidence of the first detection. */
  confidence: number;
  /** Relay latency until the alert reaches the planner, s (ASSUMPTION). */
  relayLatencySec: number;
  /** Probability the follow-up view is not blocked by cloud (ASSUMPTION / forecast). */
  clearSkyProbability: number;
}

export interface Candidate {
  satellite: Satellite;
  /** Next time the spot is inside the swath, s; null within the horizon. */
  coverageAt: number | null;
  /** Wait after the detection, s. */
  delaySec: number | null;
}

export type Priority = 'critical' | 'high' | 'watch';

export interface CuePlan {
  candidates: Candidate[];
  chosen: Candidate | null;
  /** Probability that the follow-up confirms a real fire. */
  confirmProbability: number;
  /** Priority now, and after a successful confirmation. */
  priorityNow: Priority;
  priorityIfConfirmed: Priority;
}

export function priorityFor(confidence: number, confirmed: boolean): Priority {
  if (confirmed) return confidence >= 0.5 ? 'critical' : 'high';
  return confidence >= 0.8 ? 'high' : 'watch';
}

/**
 * Picks the follow-up satellite. Satellite A itself is excluded (its next look is ~12 h later and
 * re-uses the same viewing geometry); sensors of the other type are preferred on ties, because an
 * independent instrument is a stronger confirmation.
 */
export function planCue(input: CueInput, fleet: readonly Satellite[], horizonSec = 36 * 3600): CuePlan {
  const ready = input.detectedAt + input.relayLatencySec;
  const candidates: Candidate[] = fleet
    .filter((s) => s.id !== input.detectedBy.id)
    .map((satellite) => {
      const coverageAt = nextCoverage(satellite, input.site, ready, horizonSec);
      return { satellite, coverageAt, delaySec: coverageAt === null ? null : coverageAt - input.detectedAt };
    })
    .sort((a, b) => {
      if (a.coverageAt === null) return 1;
      if (b.coverageAt === null) return -1;
      const dt = a.coverageAt - b.coverageAt;
      // Within 10 minutes, prefer the other instrument.
      if (Math.abs(dt) < 600) {
        const ax = a.satellite.sensor !== input.detectedBy.sensor ? 0 : 1;
        const bx = b.satellite.sensor !== input.detectedBy.sensor ? 0 : 1;
        if (ax !== bx) return ax - bx;
      }
      return dt;
    });
  const chosen = candidates.find((c) => c.coverageAt !== null) ?? null;
  // Confirmation needs a clear view and a real fire; a weak first detection is more often a false alarm.
  const confirmProbability = chosen ? input.clearSkyProbability * (0.35 + 0.6 * input.confidence) : 0;
  return {
    candidates,
    chosen,
    confirmProbability,
    priorityNow: priorityFor(input.confidence, false),
    priorityIfConfirmed: priorityFor(input.confidence, true),
  };
}

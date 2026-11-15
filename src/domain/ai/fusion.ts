import { VIIRS_START_INDEX } from '../../lib/date';
import type { FireArchive } from '../archive';
import { SENSOR_MODIS } from '../detections';
import { FLAG_ALL_NOISE } from '../noise';
import type { FireCluster } from './contextual';

/**
 * How Kyzyl Aspan combines the two detection systems — at two levels.
 *
 * Event level (this module): after the noise filter, every detection is snapped to its H3 cell
 * (res 6, ≈36 km²) and day. A cell-day seen by both MODIS and VIIRS is one fire event confirmed by two
 * independent instruments; seen by one only, it is a single-sensor event. Confirmation raises confidence:
 * p = 1 − (1 − p_MODIS)(1 − p_VIIRS), which assumes the two sensors err independently (an approximation —
 * clouds and smoke hide a fire from both). The location comes from VIIRS when it has one (375 m beats 1 km).
 * FRP is never added across sensors: each sensor's FRP is a different measurement of the same fire.
 *
 * Series level (src/domain/harmonize.ts + hexCalendar.ts): burning hexagon-days per sensor, the residual
 * VIIRS/MODIS ratio calibrated on the 2012+ overlap, VIIRS rescaled to the MODIS scale and blended by
 * inverse-variance weighting with a 90% interval. Rescaled and blended — never summed.
 */

/** Detection probability behind each FIRMS confidence class (ASSUMPTION used for fusing). */
export const CLASS_PROBABILITY = [0.3, 0.65, 0.9] as const;

export function fuseProbability(pModis: number | null, pViirs: number | null): number {
  const a = pModis ?? 0;
  const b = pViirs ?? 0;
  return 1 - (1 - a) * (1 - b);
}

export interface FusionStats {
  /** Cell-days (H3 res 6 × day) with fire after the noise filter, 2012 onwards. */
  events: number;
  both: number;
  modisOnly: number;
  viirsOnly: number;
  /** Of MODIS fire cell-days, the share VIIRS confirmed the same day. */
  modisConfirmedByViirs: number;
  /** Of VIIRS fire cell-days, the share MODIS saw too. */
  viirsSeenByModis: number;
  /** Mean fused confidence by event type. */
  meanConfidence: { both: number; modisOnly: number; viirsOnly: number };
  /** On events both saw: mean hot pixels per sensor. */
  pixelsPerEvent: { modis: number; viirs: number } | null;
}

interface Acc {
  m: number;
  v: number;
  pm: number;
  pv: number;
}

/** Event-level fusion over the archive's overlap era (optionally inside an area mask). ~5–20 ms for the demo sample. */
export function fuseArchive(archive: FireArchive, mask: Uint8Array | null = null): FusionStats {
  const { table, base, flags } = archive;
  const events = new Map<number, Acc>();
  for (let i = 0; i < table.n; i++) {
    if (mask && !mask[i]) continue;
    if (table.month[i]! < VIIRS_START_INDEX || flags[i]! & FLAG_ALL_NOISE) continue;
    const key = base.cellOf[i]! * 16384 + table.day[i]!;
    let e = events.get(key);
    if (!e) {
      e = { m: 0, v: 0, pm: 0, pv: 0 };
      events.set(key, e);
    }
    const p = CLASS_PROBABILITY[table.conf[i] as 0 | 1 | 2] ?? 0.65;
    if (table.sensor[i] === SENSOR_MODIS) {
      e.m += 1;
      e.pm = Math.max(e.pm, p);
    } else {
      e.v += 1;
      e.pv = Math.max(e.pv, p);
    }
  }
  let both = 0;
  let mOnly = 0;
  let vOnly = 0;
  let cBoth = 0;
  let cM = 0;
  let cV = 0;
  let pxM = 0;
  let pxV = 0;
  for (const e of events.values()) {
    if (e.m && e.v) {
      both += 1;
      cBoth += fuseProbability(e.pm, e.pv);
      pxM += e.m;
      pxV += e.v;
    } else if (e.m) {
      mOnly += 1;
      cM += e.pm;
    } else {
      vOnly += 1;
      cV += e.pv;
    }
  }
  const safe = (a: number, b: number) => (b > 0 ? a / b : 0);
  return {
    events: events.size,
    both,
    modisOnly: mOnly,
    viirsOnly: vOnly,
    modisConfirmedByViirs: safe(both, both + mOnly),
    viirsSeenByModis: safe(both, both + vOnly),
    meanConfidence: { both: safe(cBoth, both), modisOnly: safe(cM, mOnly), viirsOnly: safe(cV, vOnly) },
    pixelsPerEvent: both ? { modis: pxM / both, viirs: pxV / both } : null,
  };
}

export type FusedStatus = 'both' | 'modisOnly' | 'viirsOnly' | 'none';

export interface FusedObservation {
  status: FusedStatus;
  /** Confidence after fusion (0 when neither sensor saw a fire). */
  p: number;
  /** Which sensor the reported location comes from. */
  locatedBy: 'VIIRS' | 'MODIS' | null;
}

/** Fuses the two sensors' views of one scene (the AI #1 lab shows both side by side). */
export function fuseObservations(modis: FireCluster | null, viirs: FireCluster | null): FusedObservation {
  const pm = modis ? CLASS_PROBABILITY[modis.confidenceClass] : null;
  const pv = viirs ? CLASS_PROBABILITY[viirs.confidenceClass] : null;
  const status: FusedStatus = modis && viirs ? 'both' : modis ? 'modisOnly' : viirs ? 'viirsOnly' : 'none';
  return {
    status,
    p: status === 'none' ? 0 : fuseProbability(pm, pv),
    locatedBy: viirs ? 'VIIRS' : modis ? 'MODIS' : null,
  };
}

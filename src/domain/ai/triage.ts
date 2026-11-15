import { featureVector, predictRow, type OnboardModel } from '../onboard';
import type { ConfidenceClass } from './contextual';
import type { CellHistory } from './scene';
import type { SensorId } from './thermal';

/**
 * AI #1, stages B and C — what the satellite does with a detected hot spot.
 *
 * B. The onboard triage model (logistic regression, src/domain/onboard.ts) gives the probability that
 *    the hot spot is a real vegetation fire. Its strongest clue is memory: a cell that was hot in most
 *    of 26 years and in every season is a flare or a factory, however bright it is today.
 * C. A priority decides what happens next: CRITICAL and HIGH alerts become a 16-byte packet that AI #2
 *    sends at once (laser, or the backup radio); ROUTINE waits for the next bulk downlink; DROP stays in
 *    the onboard log. The thresholds are design assumptions of this demo, not operational values.
 */
export type Priority = 'CRITICAL' | 'HIGH' | 'ROUTINE' | 'DROP';

export const TRIAGE_RULES = {
  /** Below this probability the hot spot is not reported as a fire. */
  keepP: 0.5,
  /** At or above this probability the model is confident. */
  sureP: 0.8,
  criticalFrpMW: 100,
  criticalPixels: 4,
  highFrpMW: 30,
} as const;

export type TriageReason = 'persistent' | 'unlikely' | 'large' | 'confident' | 'radiant' | 'uncertain';

export interface TriageInput {
  confidenceClass: ConfidenceClass;
  frpMW: number;
  pixels: number;
  history: CellHistory;
}

export interface TriageResult {
  pReal: number;
  priority: Priority;
  reasons: TriageReason[];
}

type Weights = Pick<OnboardModel, 'mean' | 'scale' | 'weights' | 'bias'>;

export function triage(model: Weights, input: TriageInput): TriageResult {
  const x = featureVector({
    confidence: input.confidenceClass,
    frp: input.frpMW,
    years: input.history.years,
    months: input.history.months,
    cellCount: input.history.count,
  });
  const pReal = predictRow(model, x, 0);
  const r = TRIAGE_RULES;
  if (pReal < r.keepP) {
    return { pReal, priority: 'DROP', reasons: [input.history.years >= 5 ? 'persistent' : 'unlikely'] };
  }
  const large = input.frpMW >= r.criticalFrpMW || input.pixels >= r.criticalPixels;
  if (pReal >= r.sureP && large) return { pReal, priority: 'CRITICAL', reasons: ['confident', 'large'] };
  if (pReal >= r.sureP) return { pReal, priority: 'HIGH', reasons: ['confident'] };
  if (input.frpMW >= r.highFrpMW) return { pReal, priority: 'HIGH', reasons: ['radiant'] };
  return { pReal, priority: 'ROUTINE', reasons: ['uncertain'] };
}

/* ------------------------------------------------------------------ alert packet */

/** Bytes in one alert: small enough for a few seconds of a kilobit-per-second backup radio. */
export const PACKET_BYTES = 16;

export interface AlertPacket {
  version: number;
  priority: Priority;
  sensor: SensorId;
  day: boolean;
  lat: number;
  lng: number;
  /** Seconds since 2000-01-01T00:00Z. */
  timeSec: number;
  frpMW: number;
  pReal: number;
  pixels: number;
}

const PRIORITY_CODE: Record<Priority, number> = { DROP: 0, ROUTINE: 1, HIGH: 2, CRITICAL: 3 };
const PRIORITY_OF: Priority[] = ['DROP', 'ROUTINE', 'HIGH', 'CRITICAL'];
const INT24_MAX = 8_388_607;

/** CRC-8 (polynomial 0x07, init 0x00) — catches corrupted bytes on a noisy radio link. */
export function crc8(bytes: ArrayLike<number>, length = bytes.length): number {
  let crc = 0;
  for (let i = 0; i < length; i++) {
    crc ^= bytes[i]! & 0xff;
    for (let b = 0; b < 8; b++) crc = crc & 0x80 ? ((crc << 1) ^ 0x07) & 0xff : (crc << 1) & 0xff;
  }
  return crc;
}

function putInt24(out: Uint8Array, at: number, v: number) {
  const u = v < 0 ? v + 0x1000000 : v;
  out[at] = (u >>> 16) & 0xff;
  out[at + 1] = (u >>> 8) & 0xff;
  out[at + 2] = u & 0xff;
}

function getInt24(b: Uint8Array, at: number): number {
  const u = (b[at]! << 16) | (b[at + 1]! << 8) | b[at + 2]!;
  return u & 0x800000 ? u - 0x1000000 : u;
}

/**
 * Layout (big-endian): [0] version·priority·sensor·day, [1–3] latitude, [4–6] longitude (int24, ≈1–2 m),
 * [7–10] time (uint32 s since 2000), [11–12] FRP (0.1 MW), [13] p(real) × 255, [14] pixels, [15] CRC-8.
 */
export function encodeAlert(a: Omit<AlertPacket, 'version'>): Uint8Array {
  const out = new Uint8Array(PACKET_BYTES);
  out[0] =
    (1 << 4) | (PRIORITY_CODE[a.priority] << 2) | ((a.sensor === 'VIIRS' ? 1 : 0) << 1) | (a.day ? 1 : 0);
  putInt24(out, 1, Math.round((Math.max(-90, Math.min(90, a.lat)) / 90) * INT24_MAX));
  putInt24(out, 4, Math.round((Math.max(-180, Math.min(180, a.lng)) / 180) * INT24_MAX));
  const t = Math.max(0, Math.min(0xffffffff, Math.round(a.timeSec)));
  out[7] = (t >>> 24) & 0xff;
  out[8] = (t >>> 16) & 0xff;
  out[9] = (t >>> 8) & 0xff;
  out[10] = t & 0xff;
  const frp = Math.max(0, Math.min(0xffff, Math.round(a.frpMW * 10)));
  out[11] = (frp >>> 8) & 0xff;
  out[12] = frp & 0xff;
  out[13] = Math.max(0, Math.min(255, Math.round(a.pReal * 255)));
  out[14] = Math.max(0, Math.min(255, Math.round(a.pixels)));
  out[15] = crc8(out, PACKET_BYTES - 1);
  return out;
}

/** Decodes a packet; null when the length or the checksum is wrong. */
export function decodeAlert(b: Uint8Array): AlertPacket | null {
  if (b.length !== PACKET_BYTES || crc8(b, PACKET_BYTES - 1) !== b[15]) return null;
  return {
    version: b[0]! >>> 4,
    priority: PRIORITY_OF[(b[0]! >>> 2) & 0x03]!,
    sensor: (b[0]! >>> 1) & 1 ? 'VIIRS' : 'MODIS',
    day: (b[0]! & 1) === 1,
    lat: (getInt24(b, 1) / INT24_MAX) * 90,
    lng: (getInt24(b, 4) / INT24_MAX) * 180,
    timeSec: ((b[7]! << 24) >>> 0) + (b[8]! << 16) + (b[9]! << 8) + b[10]!,
    frpMW: ((b[11]! << 8) | b[12]!) / 10,
    pReal: b[13]! / 255,
    pixels: b[14]!,
  };
}

export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (v) => v.toString(16).padStart(2, '0')).join(' ');
}

/**
 * The five satellites behind the near-real-time fire feed, as the live views use them. Codes match the rows of
 * GET /api/live/fires (server/live.ts): [lng, lat, sat, unixSec, frpMW, conf 0|1|2, scanKm, trackKm, day 1|0].
 */
export type LiveSensor = 'MODIS' | 'VIIRS';

export interface LiveSat {
  code: number;
  /** Same ids as the circular-orbit fleet in src/domain/orbit.ts (plus noaa21). */
  id: string;
  name: string;
  /** CelesTrak name of its orbital elements. */
  tle: string;
  sensor: LiveSensor;
  /** Cross-track swath, km. */
  swathKm: number;
  /** Nadir pixel of the fire product, km. */
  pixelKm: number;
  color: string;
}

export const LIVE_SATS: readonly LiveSat[] = [
  {
    code: 0,
    id: 'terra',
    name: 'Terra',
    tle: 'TERRA',
    sensor: 'MODIS',
    swathKm: 2330,
    pixelKm: 1,
    color: '#b7c9da',
  },
  {
    code: 1,
    id: 'aqua',
    name: 'Aqua',
    tle: 'AQUA',
    sensor: 'MODIS',
    swathKm: 2330,
    pixelKm: 1,
    color: '#6f97bf',
  },
  {
    code: 2,
    id: 'snpp',
    name: 'Suomi NPP',
    tle: 'SUOMI NPP',
    sensor: 'VIIRS',
    swathKm: 3060,
    pixelKm: 0.375,
    color: '#ffd28a',
  },
  {
    code: 3,
    id: 'noaa20',
    name: 'NOAA-20',
    tle: 'NOAA 20',
    sensor: 'VIIRS',
    swathKm: 3060,
    pixelKm: 0.375,
    color: '#ffad4a',
  },
  {
    code: 4,
    id: 'noaa21',
    name: 'NOAA-21',
    tle: 'NOAA 21',
    sensor: 'VIIRS',
    swathKm: 3060,
    pixelKm: 0.375,
    color: '#f37021',
  },
];

export const liveSat = (code: number): LiveSat => LIVE_SATS[code] ?? LIVE_SATS[0]!;
export const isModis = (code: number) => liveSat(code).sensor === 'MODIS';

/** One detection of the live feed (brightness temperatures at 4 and 11 µm, K, when the feed has them). */
export type LiveRow = [
  lng: number,
  lat: number,
  sat: number,
  t: number,
  frp: number,
  conf: number,
  scan: number,
  track: number,
  day: number,
  bt4?: number,
  bt11?: number,
  /** MODIS confidence, % (−1 for VIIRS, whose confidence is the l/n/h class in `conf`). */
  confPct?: number,
];
/** One 0.5° cell of the world feed: [lng, lat, detections, frpSum, sensors (1 MODIS | 2 VIIRS), lastUnixSec]. */
export type LiveCell = [lng: number, lat: number, n: number, frp: number, mask: number, last: number];

export type BBox4 = readonly [number, number, number, number];

/** Kazakhstan's box as the live feed cuts it (server/live.ts REGION_BBOX.kz). */
export const KZ_BBOX: BBox4 = [46.2, 40.4, 87.6, 55.6];
export const CA_BBOX: BBox4 = [44, 34, 96, 58];

const DEG = Math.PI / 180;
export const KM_PER_DEG = 111.32;

/** Great-circle distance, km. */
export function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const h =
    Math.sin(((lat2 - lat1) * DEG) / 2) ** 2 +
    Math.cos(lat1 * DEG) * Math.cos(lat2 * DEG) * Math.sin(((lng2 - lng1) * DEG) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** East/north offset of b from a, km (local tangent plane; fine within a few hundred km). */
export function offsetKm(aLat: number, aLng: number, bLat: number, bLng: number): [number, number] {
  let dLng = bLng - aLng;
  if (dLng > 180) dLng -= 360;
  if (dLng < -180) dLng += 360;
  return [dLng * KM_PER_DEG * Math.cos(((aLat + bLat) / 2) * DEG), (bLat - aLat) * KM_PER_DEG];
}

/** Local solar hour (0–24) at a longitude. */
export function localSolarHour(unixSec: number, lng: number): number {
  return (((unixSec / 3600 + lng / 15) % 24) + 24) % 24;
}

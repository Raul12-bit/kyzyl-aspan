import type { Feature, FeatureCollection, Point } from 'geojson';

/** [west, south, east, north] in WGS84 degrees. west > east means the box crosses the antimeridian. */
export type BBox = readonly [west: number, south: number, east: number, north: number];

/** Inclusive date range, ISO dates 'YYYY-MM-DD'. */
export interface DateRange {
  start: string;
  end: string;
}

export type Sensor = 'MODIS' | 'VIIRS';

/**
 * Normalised confidence. MODIS reports 0–100 and VIIRS reports l/n/h;
 * a real adapter maps MODIS <30 → low, 30–79 → nominal, ≥80 → high.
 */
export type Confidence = 'low' | 'nominal' | 'high';

export interface FireProperties {
  id: string;
  sensor: Sensor;
  /** Acquisition date, 'YYYY-MM-DD' (UTC). */
  date: string;
  /** Fire radiative power, MW. */
  frp: number;
  confidence: Confidence;
}

export type FireFeature = Feature<Point, FireProperties>;

export interface FireCollection extends FeatureCollection<Point, FireProperties> {
  meta: {
    /** Number of features matched before any server-side cap. */
    total: number;
    truncated: boolean;
    synthetic: boolean;
  };
}

/** One month of the harmonized burn calendar. */
export interface CalendarPoint {
  year: number;
  month: number;
  /** MODIS detections in the area (raw count). */
  modis: number;
  /** VIIRS 375 m detections (raw count); null before VIIRS existed (2012-01). */
  viirsRaw: number | null;
  /** Harmonized activity on the common MODIS-equivalent scale. */
  harmonized: number;
  /** Lower / upper bound of the 90% interval of `harmonized`. */
  lo: number;
  hi: number;
  /** Standardised anomaly vs. the same calendar month in other years; null when not meaningful. */
  anomalyZ: number | null;
}

export interface CalendarSeries {
  bbox: BBox;
  points: CalendarPoint[];
  meta: {
    /** Unit of `harmonized`, `lo`, `hi`. */
    scale: 'modis-equivalent-detections-per-month';
    /** Central probability of [lo, hi]. */
    interval: number;
    /** Estimated VIIRS/MODIS detection ratio over the overlap period, with its interval. */
    ratio: { value: number; lo: number; hi: number; overlapStart: string; overlapEnd: string };
    /** 0…1 share of the requested box covered by the source archive. */
    coverage: number;
    synthetic: boolean;
    /** Identifier of the harmonization method/version that produced the series. */
    method: string;
  };
}

export type RegionKind = 'country' | 'province';

export interface Region {
  id: string;
  kind: RegionKind;
  name: { en: string; ru: string };
  /** ISO 3166-1 alpha-2 for countries. */
  iso2?: string;
  parentId?: string;
  bbox: BBox;
  /** Extra search terms (transliterations, local names). */
  aliases?: string[];
  group: 'central-asia' | 'world';
  featured?: boolean;
}

/** Thrown by data sources for failures the UI can explain. */
export class DataSourceError extends Error {
  readonly kind: 'network' | 'timeout' | 'invalid-response' | 'not-found' | 'server';
  constructor(kind: DataSourceError['kind'], message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'DataSourceError';
    this.kind = kind;
  }
}

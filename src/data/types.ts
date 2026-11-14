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
  /**
   * Ground truth, present only in the synthetic demo data. It lets the UI score the noise filter;
   * a real archive has no such label (at most the FIRMS `type` attribute of the standard products).
   */
  truth?: 'fire' | 'static' | 'false-alarm';
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
  /** MODIS detections kept by the noise filter (raw count). */
  modis: number;
  /** VIIRS 375 m detections kept by the noise filter (raw count); null before VIIRS existed (2012-01). */
  viirsRaw: number | null;
  /** Burning hexagon-days on the harmonization grid, MODIS. */
  modisHex: number;
  /** Burning hexagon-days on the harmonization grid, VIIRS; null before 2012-01. */
  viirsHex: number | null;
  /** Harmonized activity: MODIS-equivalent burning hexagon-days. */
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
    scale: 'modis-equivalent-hex-days-per-month';
    /** Central probability of [lo, hi]. */
    interval: number;
    /** The common grid both sensors are snapped to. */
    grid: { system: 'h3'; resolution: number; cellAreaKm2: number };
    /** VIIRS/MODIS ratio of raw detections over the overlap period — what a naive merge inherits. */
    rawRatio: number | null;
    /** Residual VIIRS/MODIS ratio of burning hexagon-days, calibrated on the overlap period. */
    ratio: { value: number; lo: number; hi: number; overlapStart: string; overlapEnd: string; calibrated: boolean };
    /** What the noise filter removed inside the area, over the whole archive. */
    noise: { considered: number; lowConfidence: number; staticSources: number; staticCells: number };
    /** 0…1 share of the requested area covered by the source archive. */
    coverage: number;
    synthetic: boolean;
    /** Identifier of the harmonization method/version that produced the series. */
    method: string;
  };
}

/**
 * One compact detection row: [lng, lat, sensor (0 MODIS, 1 VIIRS), day since 2000-01-01, FRP MW,
 * confidence (0 low, 1 nominal, 2 high), truth?]. `truth` (0 fire, 1 static source, 2 false alarm)
 * exists only in the synthetic demo archive.
 */
export type DetectionRow = readonly [number, number, number, number, number, number, number?];

export interface DetectionArchive {
  version: string;
  rows: DetectionRow[];
  synthetic: boolean;
  /**
   * Real archives are served to the browser as a sample (the full archive stays on the server, where the
   * calendar is computed). For real data `truth` is the class given by the HELIOS server-side noise filter.
   */
  meta?: { total_rows: number; sample_rows: number; sample_rate: number; truthMeaning?: string };
}

/** An area as the API understands it: a box, optionally narrowed to a country outline. */
export interface AreaQuery {
  bbox: BBox;
  /** ISO 3166-1 alpha-2 of a country, or a province id like 'KZ-KUS' (box only). */
  regionId?: string | null;
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

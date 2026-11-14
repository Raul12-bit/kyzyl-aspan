/**
 * Hand-authored synthetic fire zones. Locations follow well-known fire landscapes
 * (steppe and cropland belts, reed deltas, savannas, boreal forests), but every magnitude,
 * ratio and trend here is invented for the demo and must not be read as a measurement.
 */

export type Regime =
  | 'steppe'
  | 'cropland'
  | 'reeds'
  | 'mountain-forest'
  | 'boreal'
  | 'tropical-forest'
  | 'savanna-south'
  | 'savanna-north'
  | 'savanna-australia'
  | 'peat'
  | 'mediterranean'
  | 'cropland-south-asia'
  | 'tropical-dry';

/** Relative monthly activity, Jan…Dec (normalised by the generator). */
export const SEASONS: Record<Regime, number[]> = {
  // Central Asia: spring burning (Mar–May) and post-harvest autumn (Sep–Oct), quieter summer.
  steppe: [0.2, 0.3, 1.3, 2.7, 2.0, 0.7, 0.8, 1.0, 1.9, 1.7, 0.4, 0.15],
  cropland: [0.1, 0.2, 1.0, 2.5, 1.5, 0.4, 0.5, 1.1, 2.6, 2.3, 0.6, 0.1],
  reeds: [0.3, 0.8, 2.6, 2.4, 1.0, 0.4, 0.4, 0.6, 1.1, 1.4, 0.8, 0.3],
  'mountain-forest': [0.05, 0.1, 0.5, 1.7, 2.0, 1.0, 1.1, 1.4, 1.6, 0.8, 0.2, 0.05],
  boreal: [0.02, 0.05, 0.2, 0.9, 1.8, 2.6, 2.9, 2.0, 0.9, 0.3, 0.05, 0.02],
  'tropical-forest': [0.2, 0.15, 0.15, 0.2, 0.4, 0.8, 1.6, 2.9, 3.2, 1.8, 0.5, 0.3],
  'savanna-south': [0.1, 0.1, 0.2, 0.5, 1.4, 2.4, 2.8, 2.6, 1.6, 0.6, 0.2, 0.1],
  'savanna-north': [2.6, 2.0, 1.2, 0.5, 0.2, 0.1, 0.05, 0.05, 0.1, 0.6, 1.8, 2.8],
  'savanna-australia': [0.1, 0.1, 0.2, 0.6, 1.4, 1.9, 2.1, 2.2, 1.9, 1.3, 0.6, 0.2],
  peat: [0.2, 0.3, 0.4, 0.3, 0.4, 0.6, 1.2, 2.6, 3.2, 2.2, 0.5, 0.2],
  mediterranean: [0.1, 0.2, 0.4, 0.3, 0.4, 1.0, 2.4, 3.0, 2.2, 1.0, 0.3, 0.1],
  'cropland-south-asia': [0.1, 0.2, 0.4, 2.2, 2.0, 0.4, 0.1, 0.1, 0.3, 3.0, 2.6, 0.5],
  'tropical-dry': [0.6, 1.0, 2.6, 3.0, 2.0, 0.6, 0.2, 0.2, 0.2, 0.3, 0.4, 0.4],
};

export type ClimateGroup =
  | 'central-asia'
  | 'mongolia'
  | 'siberia'
  | 'south-america'
  | 'africa-south'
  | 'africa-north'
  | 'australia'
  | 'se-asia'
  | 'north-america'
  | 'south-asia'
  | 'europe'
  | 'mesoamerica';

export interface ZoneDef {
  id: string;
  center: [number, number];
  sigma: [number, number];
  regime: Regime;
  climate: ClimateGroup;
  /** Expected MODIS detections per year (synthetic). */
  annual: number;
  /** True VIIRS / MODIS detection ratio used to simulate VIIRS (synthetic). */
  k: number;
  /** Relative change per year (synthetic), e.g. -0.009 = −0.9 %/yr. */
  trend: number;
  /** Points on the map are sampled more densely for the demo focus region. */
  focus: boolean;
}

export const ZONE_DEFS: ZoneDef[] = [
  // ---- Kazakhstan & Central Asia (demo focus) ----
  { id: 'kz-west-steppe', center: [51.8, 50.4], sigma: [2.0, 0.9], regime: 'steppe', climate: 'central-asia', annual: 3200, k: 3.6, trend: -0.012, focus: true },
  { id: 'kz-aktobe-steppe', center: [57.0, 50.6], sigma: [2.4, 0.9], regime: 'steppe', climate: 'central-asia', annual: 3600, k: 3.6, trend: -0.01, focus: true },
  { id: 'kz-kostanay-cropland', center: [63.6, 52.6], sigma: [2.6, 0.85], regime: 'cropland', climate: 'central-asia', annual: 6400, k: 4.0, trend: -0.006, focus: true },
  { id: 'kz-north-cropland', center: [69.5, 53.6], sigma: [2.4, 0.7], regime: 'cropland', climate: 'central-asia', annual: 5200, k: 3.9, trend: -0.004, focus: true },
  { id: 'kz-pavlodar-steppe', center: [76.0, 52.0], sigma: [2.2, 0.9], regime: 'steppe', climate: 'central-asia', annual: 4200, k: 3.7, trend: -0.011, focus: true },
  { id: 'kz-karaganda-steppe', center: [70.5, 49.2], sigma: [3.2, 1.1], regime: 'steppe', climate: 'central-asia', annual: 2600, k: 3.5, trend: -0.012, focus: true },
  { id: 'kz-east-forest', center: [83.6, 49.9], sigma: [1.5, 0.8], regime: 'mountain-forest', climate: 'central-asia', annual: 1500, k: 3.1, trend: 0.004, focus: true },
  { id: 'kz-ili-balkhash-reeds', center: [76.6, 45.3], sigma: [1.8, 0.55], regime: 'reeds', climate: 'central-asia', annual: 2300, k: 3.7, trend: -0.008, focus: true },
  { id: 'kz-syrdarya-delta', center: [65.3, 44.9], sigma: [2.2, 0.65], regime: 'reeds', climate: 'central-asia', annual: 2400, k: 4.1, trend: -0.01, focus: true },
  { id: 'ru-altai-cropland', center: [81.4, 52.9], sigma: [1.8, 0.8], regime: 'cropland', climate: 'central-asia', annual: 2400, k: 3.8, trend: -0.006, focus: true },
  { id: 'uz-amudarya-delta', center: [60.0, 42.6], sigma: [1.3, 0.75], regime: 'cropland', climate: 'central-asia', annual: 900, k: 4.2, trend: 0.002, focus: true },
  { id: 'uz-fergana-valley', center: [71.6, 40.7], sigma: [1.1, 0.35], regime: 'cropland', climate: 'central-asia', annual: 700, k: 4.3, trend: 0.004, focus: true },
  { id: 'kg-chuy-valley', center: [74.6, 42.8], sigma: [1.1, 0.3], regime: 'cropland', climate: 'central-asia', annual: 420, k: 4.0, trend: 0.0, focus: true },
  { id: 'tm-murgab-oasis', center: [61.8, 37.5], sigma: [1.4, 0.55], regime: 'cropland', climate: 'central-asia', annual: 520, k: 4.0, trend: 0.003, focus: true },
  { id: 'tj-vakhsh-valley', center: [68.7, 37.9], sigma: [0.8, 0.4], regime: 'cropland', climate: 'central-asia', annual: 300, k: 4.0, trend: 0.0, focus: true },
  { id: 'af-north-plains', center: [67.6, 36.7], sigma: [1.6, 0.5], regime: 'cropland', climate: 'central-asia', annual: 550, k: 4.2, trend: 0.005, focus: true },

  // ---- Elsewhere (sparser sample, so search across countries still has data) ----
  { id: 'mn-east-steppe', center: [114.0, 47.6], sigma: [3.0, 1.2], regime: 'steppe', climate: 'mongolia', annual: 2600, k: 3.4, trend: -0.01, focus: false },
  { id: 'ru-zabaykalsky', center: [115.0, 51.5], sigma: [4.5, 1.8], regime: 'boreal', climate: 'siberia', annual: 9000, k: 3.0, trend: 0.012, focus: false },
  { id: 'ru-yakutia', center: [125.0, 62.0], sigma: [7.0, 2.8], regime: 'boreal', climate: 'siberia', annual: 7000, k: 2.9, trend: 0.02, focus: false },
  { id: 'ua-ru-black-earth', center: [37.0, 47.6], sigma: [5.0, 1.8], regime: 'cropland', climate: 'europe', annual: 8000, k: 4.0, trend: -0.02, focus: false },
  { id: 'in-punjab', center: [75.6, 30.6], sigma: [1.4, 0.9], regime: 'cropland-south-asia', climate: 'south-asia', annual: 14000, k: 4.3, trend: -0.01, focus: false },
  { id: 'br-amazon-arc', center: [-54.0, -10.0], sigma: [5.0, 2.4], regime: 'tropical-forest', climate: 'south-america', annual: 30000, k: 3.2, trend: -0.012, focus: false },
  { id: 'br-cerrado', center: [-46.5, -12.5], sigma: [3.4, 3.0], regime: 'tropical-forest', climate: 'south-america', annual: 17000, k: 3.4, trend: -0.008, focus: false },
  { id: 'bo-chiquitania', center: [-61.5, -16.6], sigma: [2.4, 1.4], regime: 'tropical-forest', climate: 'south-america', annual: 9000, k: 3.2, trend: 0.006, focus: false },
  { id: 'ar-chaco', center: [-61.0, -25.0], sigma: [2.5, 1.8], regime: 'tropical-dry', climate: 'south-america', annual: 5000, k: 3.3, trend: 0.0, focus: false },
  { id: 'ao-zm-miombo', center: [22.5, -12.0], sigma: [6.0, 3.0], regime: 'savanna-south', climate: 'africa-south', annual: 60000, k: 3.3, trend: -0.012, focus: false },
  { id: 'sahel-nigeria-chad', center: [11.0, 9.8], sigma: [6.0, 1.6], regime: 'savanna-north', climate: 'africa-north', annual: 34000, k: 3.5, trend: -0.01, focus: false },
  { id: 'sudan-south-sudan', center: [29.5, 8.6], sigma: [4.0, 1.8], regime: 'savanna-north', climate: 'africa-north', annual: 26000, k: 3.5, trend: -0.008, focus: false },
  { id: 'au-north-savanna', center: [132.0, -15.0], sigma: [8.0, 2.0], regime: 'savanna-australia', climate: 'australia', annual: 30000, k: 3.3, trend: 0.0, focus: false },
  { id: 'id-kalimantan', center: [113.0, -2.0], sigma: [2.8, 1.4], regime: 'peat', climate: 'se-asia', annual: 8000, k: 3.6, trend: -0.015, focus: false },
  { id: 'id-sumatra', center: [102.5, -1.5], sigma: [2.0, 1.5], regime: 'peat', climate: 'se-asia', annual: 6000, k: 3.6, trend: -0.015, focus: false },
  { id: 'ca-boreal-west', center: [-118.0, 57.0], sigma: [7.0, 3.0], regime: 'boreal', climate: 'north-america', annual: 9000, k: 2.8, trend: 0.02, focus: false },
  { id: 'us-california', center: [-121.0, 38.8], sigma: [1.8, 2.2], regime: 'mediterranean', climate: 'north-america', annual: 4000, k: 3.0, trend: 0.015, focus: false },
  { id: 'mx-south', center: [-91.5, 17.8], sigma: [3.0, 1.5], regime: 'tropical-dry', climate: 'mesoamerica', annual: 6000, k: 3.3, trend: -0.004, focus: false },
  { id: 'eu-iberia', center: [-7.5, 40.6], sigma: [2.2, 1.5], regime: 'mediterranean', climate: 'europe', annual: 2600, k: 3.1, trend: 0.0, focus: false },
  { id: 'eu-greece-turkey', center: [26.5, 38.6], sigma: [4.0, 1.4], regime: 'mediterranean', climate: 'europe', annual: 2400, k: 3.1, trend: 0.006, focus: false },
  { id: 'za-highveld', center: [28.5, -26.5], sigma: [3.0, 1.6], regime: 'savanna-south', climate: 'africa-south', annual: 7000, k: 3.3, trend: -0.005, focus: false },
];

/** Where the synthetic archive has data (a query outside returns "no data"). */
export const FOCUS_COVERAGE: [number, number, number, number] = [44, 34, 92, 56.5];

/** Demo bbox used to tune anomalies (Kazakhstan). */
export const DEMO_BBOX: [number, number, number, number] = [46.47, 40.66, 87.36, 55.39];

/**
 * Months with an injected burst in Kazakhstan (synthetic "unusual" months).
 * The generator verifies that exactly these get anomalyZ ≥ 2 for the demo box.
 */
export const INJECTED_ANOMALIES: { year: number; month: number; factor: number }[] = [
  { year: 2006, month: 4, factor: 2.2 },
  { year: 2010, month: 9, factor: 2.1 },
  { year: 2017, month: 4, factor: 2.3 },
  { year: 2023, month: 10, factor: 2.2 },
];

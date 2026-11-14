/**
 * Synthetic "not a wildfire" heat sources planted into the demo archive so the noise filter has
 * something to remove. Sites sit near well-known industrial regions and volcanoes, but coordinates
 * are approximate and every rate is invented: this is NOT an inventory of real facilities.
 */
export type StaticKind = 'flare' | 'steel' | 'volcano';

export interface StaticDef {
  id: string;
  /** [lng, lat], approximate. */
  at: [number, number];
  kind: StaticKind;
  /** First year the source is active in the synthetic archive. */
  since: number;
  /** Expected MODIS detections per month in the map sample. */
  rate: number;
}

const flare = (id: string, lng: number, lat: number, since = 2000, rate = 0.07): StaticDef => ({ id, at: [lng, lat], kind: 'flare', since, rate });
const steel = (id: string, lng: number, lat: number, since = 2000, rate = 0.05): StaticDef => ({ id, at: [lng, lat], kind: 'steel', since, rate });
const volcano = (id: string, lng: number, lat: number, rate = 0.06): StaticDef => ({ id, at: [lng, lat], kind: 'volcano', since: 2000, rate });

export const STATIC_DEFS: StaticDef[] = [
  // ---- Kazakhstan & Central Asia (demo focus: denser, so the filter is visible on the map) ----
  flare('kz-atyrau-field', 53.4, 46.2, 2000, 0.1),
  flare('kz-uralsk-field', 53.2, 51.3, 2001, 0.09),
  flare('kz-aktobe-field', 57.4, 48.3, 2003, 0.08),
  flare('kz-kyzylorda-field', 65.6, 46.4, 2000, 0.08),
  flare('kz-mangystau-field', 52.9, 43.3, 2000, 0.09),
  flare('kz-caspian-shelf', 51.6, 46.0, 2013, 0.1),
  steel('kz-temirtau-works', 72.96, 50.05, 2000, 0.08),
  steel('kz-ekibastuz-plant', 75.35, 51.72, 2000, 0.06),
  steel('kz-oskemen-smelter', 82.6, 49.95, 2000, 0.06),
  steel('kz-balkhash-smelter', 75.0, 46.82, 2000, 0.06),
  steel('kz-zhezkazgan-smelter', 67.7, 47.8, 2000, 0.05),
  steel('kz-aksu-ferroalloy', 76.9, 52.03, 2005, 0.05),
  flare('tm-balkan-field', 54.0, 39.5, 2000, 0.07),
  flare('uz-bukhara-field', 64.3, 39.6, 2004, 0.06),

  // ---- Elsewhere ----
  flare('ru-west-siberia-1', 73.4, 61.2, 2000, 0.07),
  flare('ru-west-siberia-2', 76.6, 61.0, 2000, 0.07),
  flare('ru-west-siberia-3', 77.8, 65.9, 2006, 0.06),
  steel('ru-magnitogorsk-works', 59.05, 53.4),
  steel('ru-norilsk-smelter', 88.2, 69.35),
  steel('ru-cherepovets-works', 37.9, 59.12),
  flare('iq-basra-field', 47.4, 30.5, 2000, 0.09),
  flare('ir-khuzestan-field', 49.0, 31.0, 2000, 0.08),
  flare('qa-gulf-offshore', 51.9, 25.9, 2000, 0.07),
  flare('ae-gulf-offshore', 53.2, 25.0, 2002, 0.06),
  flare('dz-sahara-field', 6.05, 31.7, 2000, 0.08),
  flare('ly-sirte-field', 19.6, 28.9, 2000, 0.06),
  flare('ng-delta-1', 6.6, 4.8, 2000, 0.09),
  flare('ng-delta-2', 7.2, 5.1, 2000, 0.08),
  flare('ao-offshore', 11.9, -6.4, 2002, 0.06),
  flare('us-permian-field', -102.5, 31.8, 2011, 0.08),
  flare('us-bakken-field', -103.2, 48.0, 2010, 0.07),
  flare('ve-eastern-field', -63.5, 9.7, 2000, 0.07),
  flare('mx-campeche-offshore', -92.1, 19.4, 2000, 0.07),
  steel('ua-dnipro-works', 33.4, 47.9),
  steel('de-rhine-works', 6.75, 51.45),
  steel('it-apulia-works', 17.2, 40.5),
  steel('in-jharkhand-works', 86.2, 22.8),
  steel('cn-hebei-works', 118.2, 39.6, 2003),
  steel('cn-inner-mongolia-works', 109.8, 40.6, 2004),
  steel('kr-east-coast-works', 129.37, 36.0),
  steel('jp-tokyo-bay-works', 139.9, 35.36),
  steel('us-lake-michigan-works', -87.3, 41.6),
  steel('br-espirito-santo-works', -40.25, -20.25),
  steel('za-highveld-plant', 29.17, -26.55),
  steel('au-illawarra-works', 150.88, -34.47),
  volcano('it-etna', 15.0, 37.75),
  volcano('us-kilauea', -155.28, 19.41, 0.08),
  volcano('cd-nyiragongo', 29.25, -1.52, 0.08),
  volcano('et-erta-ale', 40.67, 13.6),
  volcano('mx-popocatepetl', -98.62, 19.02, 0.05),
  volcano('vu-yasur', 169.44, -19.53, 0.05),
];

/** Synthetic sensor behaviour over a static source: [MODIS, VIIRS]. */
export const STATIC_PROFILE: Record<StaticKind, { medianFrp: [number, number]; frpSigma: number; viirsBoost: number }> = {
  flare: { medianFrp: [24, 7], frpSigma: 0.45, viirsBoost: 2.4 },
  steel: { medianFrp: [12, 3.4], frpSigma: 0.4, viirsBoost: 2.6 },
  volcano: { medianFrp: [40, 11], frpSigma: 1.0, viirsBoost: 2.0 },
};

/** False alarms (glint, hot bare ground, cloud edges) as a share of a zone's mean monthly sample. */
export const FALSE_ALARM = {
  share: 0.07,
  /** They scatter wider than the fire landscape itself. */
  sigmaFactor: 1.5,
  medianFrp: [7, 1.7] as [number, number],
  frpSigma: 0.5,
  /** Probability that a false alarm is flagged low-confidence by the product. */
  lowConfidence: 0.82,
};

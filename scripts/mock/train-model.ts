import { buildArchive } from '../../src/domain/archive';
import { tableFromRows, type FireRow } from '../../src/domain/detections';
import { FLAG_ALL_NOISE } from '../../src/domain/noise';
import {
  buildFeatures,
  classifierMetrics,
  ONBOARD_FEATURES,
  predictAll,
  trainLogistic,
  type OnboardModel,
} from '../../src/domain/onboard';
import { END_MONTH, END_YEAR, START_YEAR, toYearMonth } from '../../src/lib/date';
import { round } from '../../src/lib/stats';

/** 15° × 15° spatial blocks; every 5th block (by a fixed hash) is held out for testing. */
const BLOCK_DEG = 15;
const isTestBlock = (lng: number, lat: number) => {
  const bx = Math.floor((lng + 180) / BLOCK_DEG);
  const by = Math.floor((lat + 90) / BLOCK_DEG);
  return ((bx * 73856093) ^ (by * 19349663)) % 5 === 0;
};

const roundMetrics = (m: ReturnType<typeof classifierMetrics>) => ({
  accuracy: round(m.accuracy, 4),
  precision: round(m.precision, 4),
  recall: round(m.recall, 4),
  f1: round(m.f1, 4),
  rows: m.rows,
});

/**
 * Trains the onboard triage model on the synthetic archive. Spatial hold-out: the test rows come from
 * regions the model never saw, which is the honest question for a satellite flying over new ground.
 */
export function trainOnboardModel(rows: readonly FireRow[], version: string): OnboardModel {
  const table = tableFromRows(rows);
  if (!table.truth) throw new Error('Training needs the synthetic truth column');
  const archive = buildArchive(table);
  const X = buildFeatures(table, archive.base, archive.persistence);
  const y = new Uint8Array(table.n);
  for (let i = 0; i < table.n; i++) y[i] = table.truth[i] === 0 ? 1 : 0;

  const train: number[] = [];
  const test: number[] = [];
  for (let i = 0; i < table.n; i++) (isTestBlock(table.lng[i]!, table.lat[i]!) ? test : train).push(i);

  const w = trainLogistic(X, y, train);
  const p = predictAll(w, X, table.n);
  const threshold = 0.5;
  const test_ = classifierMetrics((i) => p[i]! >= threshold, y, test);
  const baseline = classifierMetrics((i) => (archive.flags[i]! & FLAG_ALL_NOISE) === 0, y, test);

  return {
    version,
    kind: 'logistic-regression',
    features: [...ONBOARD_FEATURES],
    mean: w.mean.map((v) => round(v, 6)),
    scale: w.scale.map((v) => round(v, 6)),
    weights: w.weights.map((v) => round(v, 6)),
    bias: round(w.bias, 6),
    threshold,
    metrics: { test: roundMetrics(test_), baseline: roundMetrics(baseline), trainRows: train.length },
    trainedOn: {
      period: `${toYearMonth(START_YEAR, 1)}…${toYearMonth(END_YEAR, END_MONTH)}`,
      synthetic: true,
      note: 'Trained and tested on SYNTHETIC labels (spatial hold-out, 15° blocks). Illustrates the approach; not a validated detector.',
    },
  };
}

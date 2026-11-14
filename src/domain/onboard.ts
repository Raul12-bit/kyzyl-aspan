import { END_YEAR, START_YEAR } from '../lib/date';
import type { DetectionTable } from './detections';
import type { CellIndex } from './hexgrid';
import type { CellPersistence } from './noise';

/**
 * "Onboard" triage model: a logistic regression small enough to live on a satellite's flight
 * computer — six inputs, seven numbers of state, no network. It answers one question per hot pixel:
 * is this a vegetation fire worth a downlink slot, or a flare / glint that can wait?
 *
 * What it carries from the 26-year history is the persistence of the pixel's grid cell
 * (see noise.ts); the weights are fitted offline (scripts/mock/train-model.ts) and shipped as
 * public/data/model.json. In this demo it is trained and scored on SYNTHETIC labels only.
 * Image-based onboard screening (a small CNN on thermal chips) is part of the concept, not of this code.
 */
export const ONBOARD_FEATURES = [
  'lowConfidence',
  'highConfidence',
  'logFrp',
  'yearsActive',
  'monthSpread',
  'logCellCount',
] as const;
export type OnboardFeature = (typeof ONBOARD_FEATURES)[number];
export const FEATURE_COUNT = ONBOARD_FEATURES.length;

const ARCHIVE_YEARS = END_YEAR - START_YEAR + 1;

export interface ClassifierMetrics {
  /** Positive class = real vegetation fire. */
  accuracy: number;
  precision: number;
  recall: number;
  f1: number;
  rows: number;
}

export interface OnboardModel {
  version: string;
  kind: 'logistic-regression';
  features: OnboardFeature[];
  /** Standardisation: x' = (x − mean) / scale. */
  mean: number[];
  scale: number[];
  weights: number[];
  bias: number;
  /** Probability at or above which a detection is called a fire. */
  threshold: number;
  metrics: {
    /** Held-out spatial blocks the model never saw. */
    test: ClassifierMetrics;
    /** Rule baseline on the same rows: "not low-confidence and not in a persistent cell". */
    baseline: ClassifierMetrics;
    trainRows: number;
  };
  trainedOn: { period: string; synthetic: boolean; note: string };
}

/** One feature vector, e.g. for the "try it yourself" control on the mission page. */
export interface FeatureInput {
  confidence: 0 | 1 | 2;
  frp: number;
  /** Distinct years the cell was hot. */
  years: number;
  /** Distinct calendar months the cell was hot. */
  months: number;
  /** Detections ever seen in the cell. */
  cellCount: number;
}

export function featureVector(input: FeatureInput, out = new Float32Array(FEATURE_COUNT), offset = 0): Float32Array {
  out[offset] = input.confidence === 0 ? 1 : 0;
  out[offset + 1] = input.confidence === 2 ? 1 : 0;
  out[offset + 2] = Math.log1p(Math.max(0, input.frp));
  out[offset + 3] = input.years / ARCHIVE_YEARS;
  out[offset + 4] = input.months / 12;
  out[offset + 5] = Math.log1p(input.cellCount);
  return out;
}

/** Row-major feature matrix (n × FEATURE_COUNT) for a whole table. */
export function buildFeatures(table: DetectionTable, cells: CellIndex, persistence: CellPersistence): Float32Array {
  const X = new Float32Array(table.n * FEATURE_COUNT);
  for (let i = 0; i < table.n; i++) {
    const c = cells.cellOf[i]!;
    featureVector(
      {
        confidence: table.conf[i] as 0 | 1 | 2,
        frp: table.frp[i]!,
        years: persistence.years[c]!,
        months: persistence.months[c]!,
        cellCount: persistence.count[c]!,
      },
      X,
      i * FEATURE_COUNT,
    );
  }
  return X;
}

const sigmoid = (z: number) => 1 / (1 + Math.exp(-z));

type Weights = Pick<OnboardModel, 'mean' | 'scale' | 'weights' | 'bias'>;

/** Probability that row `i` of `X` is a real fire. */
export function predictRow(model: Weights, X: ArrayLike<number>, i: number): number {
  let z = model.bias;
  const o = i * FEATURE_COUNT;
  for (let f = 0; f < FEATURE_COUNT; f++) z += model.weights[f]! * ((X[o + f]! - model.mean[f]!) / model.scale[f]!);
  return sigmoid(z);
}

export function predictAll(model: Weights, X: ArrayLike<number>, n: number): Float32Array {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = predictRow(model, X, i);
  return out;
}

export interface TrainOptions {
  epochs?: number;
  learningRate?: number;
  l2?: number;
}

/**
 * Batch gradient descent on standardised features with class weights (fires dominate the data,
 * so noise rows are up-weighted to keep the boundary honest). Deterministic: zero initial weights.
 */
export function trainLogistic(X: ArrayLike<number>, y: ArrayLike<number>, rows: readonly number[], opts: TrainOptions = {}): Weights {
  const { epochs = 400, learningRate = 0.5, l2 = 1e-3 } = opts;
  const F = FEATURE_COUNT;
  const n = rows.length;
  const mean = new Array<number>(F).fill(0);
  const scale = new Array<number>(F).fill(0);
  for (const i of rows) for (let f = 0; f < F; f++) mean[f]! += X[i * F + f]! / n;
  for (const i of rows) for (let f = 0; f < F; f++) scale[f]! += (X[i * F + f]! - mean[f]!) ** 2 / n;
  for (let f = 0; f < F; f++) scale[f] = Math.sqrt(scale[f]!) || 1;

  let positives = 0;
  for (const i of rows) positives += y[i]!;
  const wPos = n / (2 * Math.max(1, positives));
  const wNeg = n / (2 * Math.max(1, n - positives));

  const weights = new Array<number>(F).fill(0);
  let bias = 0;
  const grad = new Array<number>(F).fill(0);
  for (let epoch = 0; epoch < epochs; epoch++) {
    grad.fill(0);
    let gradBias = 0;
    for (const i of rows) {
      let z = bias;
      for (let f = 0; f < F; f++) z += weights[f]! * ((X[i * F + f]! - mean[f]!) / scale[f]!);
      const err = (sigmoid(z) - y[i]!) * (y[i] ? wPos : wNeg);
      for (let f = 0; f < F; f++) grad[f]! += (err * (X[i * F + f]! - mean[f]!)) / scale[f]!;
      gradBias += err;
    }
    for (let f = 0; f < F; f++) weights[f]! -= learningRate * (grad[f]! / n + l2 * weights[f]!);
    bias -= learningRate * (gradBias / n);
  }
  return { mean, scale, weights, bias };
}

export function classifierMetrics(isFire: (i: number) => boolean, y: ArrayLike<number>, rows: readonly number[]): ClassifierMetrics {
  let tp = 0;
  let fp = 0;
  let fn = 0;
  let tn = 0;
  for (const i of rows) {
    const truth = y[i] === 1;
    const pred = isFire(i);
    if (truth && pred) tp += 1;
    else if (truth) fn += 1;
    else if (pred) fp += 1;
    else tn += 1;
  }
  const precision = tp + fp ? tp / (tp + fp) : 0;
  const recall = tp + fn ? tp / (tp + fn) : 0;
  return {
    accuracy: rows.length ? (tp + tn) / rows.length : 0,
    precision,
    recall,
    f1: precision + recall ? (2 * precision * recall) / (precision + recall) : 0,
    rows: rows.length,
  };
}

/** Bytes needed to store the model's numbers as float32 — the whole "program state". */
export function modelSizeBytes(model: Pick<OnboardModel, 'weights' | 'mean' | 'scale'>): number {
  return 4 * (model.weights.length + model.mean.length + model.scale.length + 2);
}

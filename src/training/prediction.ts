import * as tf from "@tensorflow/tfjs";
import { type PairFeatures, readPairFeatures } from "../pairPolicy.ts";
import { PAIR_RANKER_INPUT_COUNT as FEATURE_COUNT } from "../modelConfig.ts";
const MIN_SCORE = 0;
const MAX_SCORE = 1;

export function predictPairScores(model: tf.LayersModel, features: readonly PairFeatures[]): number[] {
  if (!features.length) return [];
  const scores = tf.tidy(() => {
    const input = tf.tensor2d(features.map((row) => Array.from(readPairFeatures(row))), [features.length, FEATURE_COUNT]);
    const prediction = model.predict(input);
    if (Array.isArray(prediction)) throw new Error("O modelo deve ter uma única saída");
    return Array.from(prediction.dataSync());
  });
  if (scores.length !== features.length || !scores.every(Number.isFinite)) {
    throw new Error("O modelo produziu pontuações inválidas");
  }
  // A regressão pode ultrapassar ligeiramente os limites; a pontuação continua em [0, 1].
  return scores.map((score) => Math.max(MIN_SCORE, Math.min(MAX_SCORE, score)));
}


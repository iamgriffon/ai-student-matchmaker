import { PAIR_RANKER_INPUT_COUNT } from "../../src/modelConfig.ts";
import { readPairFeatures } from "../../src/pairPolicy.ts";

export const VECTORIZE_DIMENSIONS = 32;
const PADDING_VALUE = 0;

// Extra zero coordinates preserve Euclidean distances between our feature vectors.
export function encodeVectorizeValues(values: readonly number[]) {
  if (values.length > VECTORIZE_DIMENSIONS || !values.every(Number.isFinite)) {
    throw new Error("Invalid Vectorize feature values.");
  }
  return [...values, ...Array<number>(VECTORIZE_DIMENSIONS - values.length).fill(PADDING_VALUE)];
}

// Storage dimensions are independent of the four inputs expected by the ranker.
export function decodePairVectorizeValues(values: ArrayLike<number>) {
  const coordinates = Array.from(values);
  if (coordinates.length !== VECTORIZE_DIMENSIONS ||
      coordinates.slice(PAIR_RANKER_INPUT_COUNT).some((value) => value !== PADDING_VALUE)) {
    throw new Error("Invalid stored pair vector encoding.");
  }
  return readPairFeatures(coordinates.slice(0, PAIR_RANKER_INPUT_COUNT));
}

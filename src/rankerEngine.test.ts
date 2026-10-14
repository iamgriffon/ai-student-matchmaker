import { modelHash, decodeBase64 } from "./training/encoding.ts";
import { beforeAll, afterAll, describe, expect, test } from "bun:test";
import * as tf from "@tensorflow/tfjs";
import { evaluatePair, type PairFeatures } from "./pairPolicy.ts";
import { trainPairRanker, serializeRanker, deserializeRanker, predictPairScores } from "./rankerEngine.ts";
const SAMPLE_COUNT = 40;
const TEST_EPOCHS = 2;
const samples = Array.from({ length: SAMPLE_COUNT }, (_unused, index) => {
  const features: PairFeatures = [(index % 10) / 20, (index % 7) / 7, (index % 5) / 4, index % 2];
  const policy = evaluatePair(features);
  return { features, target: policy.score, eligible: policy.eligible };
});

let trained: Awaited<ReturnType<typeof trainPairRanker>>;
let artifact: Awaited<ReturnType<typeof serializeRanker>>;
beforeAll(async () => {
  trained = await trainPairRanker(samples, "fixture-context", { epochs: TEST_EPOCHS });
  artifact = await serializeRanker(trained.model, trained.metadata);
});
afterAll(() => trained.model.dispose());
describe("training/rankerEngine", () => {
  test("trains a real TensorFlow model with a separate validation subset", () => {
    expect(trained.metadata.labelSource).toBe("policy-generated");
    expect(trained.metadata.sampleCount).toBe(SAMPLE_COUNT);
    expect(trained.metadata.trainingCount).toBe(32);
    expect(trained.metadata.validationCount).toBe(8);
    expect(trained.metadata.epochs).toBe(TEST_EPOCHS);
    expect(Number.isFinite(trained.metadata.validationMeanAbsoluteError)).toBe(true);
  });

  test("predicts finite bounded scores without leaking prediction tensors", () => {
    const count = tf.memory().numTensors;
    const scores = predictPairScores(trained.model, samples.map((sample) => sample.features));
    expect(scores).toHaveLength(SAMPLE_COUNT);
    expect(scores.every((score) => Number.isFinite(score) && score >= 0 && score <= 1)).toBe(true);
    expect(tf.memory().numTensors).toBe(count);
  });

  test("hashes the persisted topology so server checksum validation succeeds", async () => {
    const hash = await modelHash(artifact.modelTopology, decodeBase64(artifact.weightData));
    expect(artifact.metadata.modelId).toBe("pair-ranker-" + hash.slice(0, 12));
  });

  test("round-trips architecture and trained weights", async () => {
    const loaded = await deserializeRanker(artifact);
    try {
      expect(predictPairScores(loaded.model, samples.map((sample) => sample.features))).toEqual(predictPairScores(trained.model, samples.map((sample) => sample.features)));
      expect(loaded.metadata.modelId).toMatch(/^pair-ranker-/);
    } finally { loaded.model.dispose(); }
  });

  test("rejects insufficient samples, invalid targets, and invalid epoch counts", async () => {
    await expect(trainPairRanker([], "context")).rejects.toThrow("pelo menos");
    await expect(trainPairRanker(samples.map((sample) => ({ ...sample, target: NaN })), "context")).rejects.toThrow("Rótulo");
    await expect(trainPairRanker(samples, "context", { epochs: 0 })).rejects.toThrow("épocas");
  });

});

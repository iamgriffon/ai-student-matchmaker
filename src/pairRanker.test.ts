import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { database } from "../db/tests/fixtutes/db.fixtures.ts";
import { trainedModelFixture } from "../db/tests/fixtutes/trainedModels.fixtures.ts";
import * as tf from "@tensorflow/tfjs";
import { actualRankWithTrainedModel } from "../db/tests/fixtutes/ranker.fixtures.ts";
import { evaluatePair, type PairFeatures } from "./pairPolicy.ts";
const { trainPairRanker, serializeRanker, deserializeRanker, predictPairScores, clearRankerCache, MAX_VALIDATION_MAE } = await import("./pairRanker.ts");

const SAMPLE_COUNT = 40;
const TEST_EPOCHS = 2;
const samples = Array.from({ length: SAMPLE_COUNT }, (_unused, index) => {
  const features: PairFeatures = [(index % 10) / 20, (index % 7) / 7, (index % 5) / 4, index % 2];
  const policy = evaluatePair(features);
  return { features, target: policy.score, eligible: policy.eligible };
});
let trained: Awaited<ReturnType<typeof trainPairRanker>>;
let artifact: Awaited<ReturnType<typeof serializeRanker>>;
const { invalidateTrainedModelCaches } = await import("../db/trainedModels.ts");

beforeAll(async () => {
  trained = await trainPairRanker(samples, "fixture-context", { epochs: TEST_EPOCHS });
  artifact = await serializeRanker(trained.model, trained.metadata);
});
beforeEach(() => { database.reset(); invalidateTrainedModelCaches(); });
afterEach(() => { clearRankerCache(); });
afterAll(() => { trained.model.dispose(); });
function setActiveArtifact(value: unknown) {
  const modelId = artifact.metadata.modelId;
  database.mocks.trainedPointer.mockResolvedValue({ id: trainedModelFixture.id, updatedAt: trainedModelFixture.updatedAt });
  database.mocks.trainedFirst.mockResolvedValue({ ...trainedModelFixture, modelId, artifact: value, trainingReport: null });
}

// Loader tests use declared low-error metadata to exercise activation gates,
// not to claim that the deliberately short fixture training passed validation.
const activeArtifact = () => ({ ...artifact, metadata: { ...artifact.metadata, validationMeanAbsoluteError: 0.01, eligibleValidationMeanAbsoluteError: 0.01 } });

describe("pairRanker", () => {
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

  test("returns no trained inference when the artifact is absent", async () => {
    expect(await actualRankWithTrainedModel([])).toBeNull();
  });

  test("loads a persisted model and reuses its weights between calls", async () => {
    setActiveArtifact(activeArtifact());
    const first = await actualRankWithTrainedModel([samples[0]!.features]);
    const count = tf.memory().numTensors;
    const second = await actualRankWithTrainedModel([samples[0]!.features]);
    expect(first?.metadata.labelSource).toBe("policy-generated");
    expect(second?.scores).toEqual(first?.scores);
    expect(tf.memory().numTensors).toBe(count);
  });

  test("rejects excessive validation error", async () => {
    setActiveArtifact({ ...activeArtifact(), metadata: { ...activeArtifact().metadata, validationMeanAbsoluteError: MAX_VALIDATION_MAE + 0.1 } });
    await expect(actualRankWithTrainedModel([])).rejects.toThrow("limite de erro");
  });

  test("does not activate a model using an obsolete encoder", async () => {
    setActiveArtifact({ ...activeArtifact(), metadata: { ...activeArtifact().metadata, encoderVersion: "old-encoder" } });
    expect(await actualRankWithTrainedModel([])).toBeNull();
  });

  test("rejects a corrupt artifact rather than claiming a trained recommendation", async () => {
    setActiveArtifact({});
    await expect(actualRankWithTrainedModel([])).rejects.toThrow();
  });
  test("shares concurrent loads and releases the cached TensorFlow tensors", async () => {
    setActiveArtifact(activeArtifact());
    const baseline = tf.memory().numTensors;
    const [first, second] = await Promise.all([actualRankWithTrainedModel([samples[0]!.features]), actualRankWithTrainedModel([samples[0]!.features])]);
    expect(first?.scores).toEqual(second?.scores);
    const loadedCount = tf.memory().numTensors;
    await actualRankWithTrainedModel([samples[0]!.features]);
    expect(tf.memory().numTensors).toBe(loadedCount);
    clearRankerCache();
    expect(tf.memory().numTensors).toBe(baseline);
  });
  test("loads a newly activated execution without restarting the server", async () => {
    setActiveArtifact(activeArtifact());
    await actualRankWithTrainedModel([]);
    const changed = { ...trainedModelFixture, modelId: "pair-ranker-bbbbbbbbbbbb", trainingReport: null,
      updatedAt: "2026-10-13T20:00:00.000Z", artifact: { ...activeArtifact(), metadata: { ...activeArtifact().metadata, modelId: "pair-ranker-bbbbbbbbbbbb" } } };
    database.mocks.trainedPointer.mockResolvedValue({ id: changed.id, updatedAt: changed.updatedAt });
    database.mocks.trainedFirst.mockResolvedValue(changed);
    expect((await actualRankWithTrainedModel([]))?.metadata.modelId).toBe(changed.modelId);
  });

});

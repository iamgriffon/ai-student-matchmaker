import { describe, expect, test, spyOn } from "bun:test";
import * as tf from "@tensorflow/tfjs";
import { trainBatches, evaluateBatches } from "./batches.ts";
import type { TrainingSample, TrainingBatchProgress } from "./types.ts";
import { prepareTrainingBackend, trainPairRanker } from "../rankerEngine.ts";

const samples: TrainingSample[] = [
  { features: [0, 0, 0, 0], target: 0, eligible: true },
  { features: [0, 0, 0, 0], target: 1, eligible: false },
  { features: [0, 0, 0, 0], target: 0.5, eligible: true },
];

describe("training/batches", () => {
  test("includes the final partial batch and weights iteration loss by sample count", async () => {
    await prepareTrainingBackend();
    const model = tf.sequential();
    const sizes: number[] = [];
    const train = spyOn(model, "trainOnBatch").mockImplementation(async (xs) => {
      sizes.push((xs as tf.Tensor).shape[0]!);
      return sizes.length === 1 ? 0.2 : 0.8;
    });
    const progress: TrainingBatchProgress[] = [];
    const losses: number[] = [];
    const tensorsBefore = tf.memory().numTensors;
    try {
      await trainBatches(model, samples, 1, 2, {
        onBatch: (value) => { progress.push(value); },
        onEpoch: (_epoch, loss) => { losses.push(loss); },
      });
      expect(sizes).toEqual([2, 1]);
      expect(losses[0]).toBeCloseTo(0.4);
      expect(progress.map(({ processedSamples }) => processedSamples)).toEqual([2, 3]);
      expect(progress.every(({ totalBatches, sampleCount }) => totalBatches === 2 && sampleCount === 3)).toBe(true);
      expect(tf.memory().numTensors).toBe(tensorsBefore);
    } finally { train.mockRestore(); model.dispose(); }
  });

  test("releases input tensors when training throws", async () => {
    const model = tf.sequential();
    const train = spyOn(model, "trainOnBatch").mockRejectedValue(new Error("batch failed"));
    const before = tf.memory().numTensors;
    try {
      await expect(trainBatches(model, samples, 1, 2)).rejects.toThrow("batch failed");
      expect(tf.memory().numTensors).toBe(before);
    } finally { train.mockRestore(); model.dispose(); }
  });

  test("evaluates all samples and eligible samples separately without retaining tensors", async () => {
    const model = tf.sequential();
    model.add(tf.layers.dense({ units: 1, inputShape: [4], kernelInitializer: "zeros", biasInitializer: "zeros" }));
    const before = tf.memory().numTensors;
    try {
      const metrics = await evaluateBatches(model, samples, 2);
      expect(metrics.validationMeanAbsoluteError).toBeCloseTo(0.5);
      expect(metrics.eligibleValidationMeanAbsoluteError).toBeCloseTo(0.25);
      const noEligible = await evaluateBatches(model, samples.map((sample) => ({ ...sample, eligible: false })), 2);
      expect(noEligible.eligibleValidationMeanAbsoluteError).toBeNull();
      expect(tf.memory().numTensors).toBe(before);
    } finally { model.dispose(); }
  });

  test("disposes the model and optimizer if a progress callback fails", async () => {
    const dataset = Array.from({ length: 25 }, () => samples[0]!);
    const before = tf.memory().numTensors;
    await expect(trainPairRanker(dataset, "test-context", {
      epochs: 1, batchSize: 4,
      onBatch: () => { throw new Error("progress failed"); },
    })).rejects.toThrow("progress failed");
    expect(tf.memory().numTensors).toBe(before);
  });
});

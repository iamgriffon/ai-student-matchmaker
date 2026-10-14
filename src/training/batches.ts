import * as tf from "@tensorflow/tfjs";
import { PAIR_RANKER_INPUT_COUNT as FEATURE_COUNT, PAIR_RANKER_OUTPUT_COUNT as OUTPUT_COUNT } from "../modelConfig.ts";
import { predictPairScores } from "./prediction.ts";
import type { TrainingSample, TrainingBatchProgress } from "./types.ts";

const DISPLAY_INDEX_OFFSET = 1;

export async function trainBatches(
  model: tf.LayersModel,
  training: readonly TrainingSample[],
  epochs: number,
  batchSize: number,
  callbacks: {
    onBatch?: (progress: TrainingBatchProgress) => void | Promise<void>;
    onEpoch?: (epoch: number, loss: number) => void | Promise<void>;
  } = {},
) {
    const totalBatches = Math.ceil(training.length / batchSize);
    // The same model and Adam optimizer survive every batch and iteration.
    // Only input/target tensors are recreated, so their size is bounded by batchSize.
    for (let epoch = 0; epoch < epochs; epoch++) {
      let weightedLoss = 0;
      for (let offset = 0; offset < training.length; offset += batchSize) {
        const batch = training.slice(offset, offset + batchSize);
        const xs = tf.tensor2d(batch.map((sample) => Array.from(sample.features)), [batch.length, FEATURE_COUNT]);
        let ys: tf.Tensor2D | undefined;
        let loss: number;
        try {
          ys = tf.tensor2d(batch.map((sample) => [sample.target]), [batch.length, OUTPUT_COUNT]);
          const result = await model.trainOnBatch(xs, ys);
          const value = Array.isArray(result) ? result[0] : result;
          if (typeof value == 'undefined' || !Number.isFinite(value)) throw new Error("Invalid training loss.");
          loss = value;
          weightedLoss += loss * batch.length;
        } finally { xs.dispose(); ys?.dispose(); }
        const memory = tf.memory();
        await callbacks.onBatch?.({ epoch, batch: Math.floor(offset / batchSize) + DISPLAY_INDEX_OFFSET, totalBatches,
          processedSamples: Math.min(offset + batchSize, training.length), sampleCount: training.length,
          loss, tensorBytes: memory.numBytes, numTensors: memory.numTensors });
        // Yield for responsiveness; this does not reset a Cloudflare CPU budget.
        await tf.nextFrame();
      }
      await callbacks.onEpoch?.(epoch, weightedLoss / training.length);
    }
}

export async function evaluateBatches(model: tf.LayersModel, validation: readonly TrainingSample[], batchSize: number) {
    // Accumulate errors rather than retaining tensors/predictions for the entire validation set.
    let absoluteError = 0, eligibleAbsoluteError = 0, eligibleCount = 0;
    for (let offset = 0; offset < validation.length; offset += batchSize) {
      const batch = validation.slice(offset, offset + batchSize);
      const predictions = predictPairScores(model, batch.map((sample) => sample.features));
      for (const [index, sample] of batch.entries()) {
        const prediction = predictions[index];
        if (typeof prediction == 'undefined') throw new Error("Missing validation prediction.");
        const error = Math.abs(prediction - sample.target);
        absoluteError += error;
        if (sample.eligible) { eligibleAbsoluteError += error; eligibleCount++; }
      }
      await tf.nextFrame();
    }
    return {
      validationMeanAbsoluteError: absoluteError / validation.length,
      eligibleValidationMeanAbsoluteError: eligibleCount ? eligibleAbsoluteError / eligibleCount : null,
    };
}

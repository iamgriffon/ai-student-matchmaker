import type { PairFeatures } from "../pairPolicy.ts";

export type TrainingSample = { features: PairFeatures; target: number; eligible: boolean; userAId?: string; userBId?: string };

export type TrainingBatchProgress = {
  epoch: number; batch: number; totalBatches: number; processedSamples: number; sampleCount: number;
  loss: number; tensorBytes: number; numTensors: number;
};


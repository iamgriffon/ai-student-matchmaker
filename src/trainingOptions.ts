import { categoryWeightsSchema, DEFAULT_CATEGORY_WEIGHTS, normalizeCategoryWeights } from "./categoryWeights.ts";
import { z } from "zod";
import { DEFAULT_EPOCHS, DEFAULT_LEARNING_RATE, DEFAULT_TRAINING_BATCH_SIZE, MAX_TRAINING_BATCH_SIZE } from "./modelConfig.ts";

export const trainingOptionsSchema = z.object({
  learningRate: z.coerce.number().positive("Learning rate must be greater than zero.").default(DEFAULT_LEARNING_RATE),
  epochs: z.coerce.number().int("Iterations must be an integer.").positive("Iterations must be greater than zero.").default(DEFAULT_EPOCHS),
  batchSize: z.coerce.number().int().min(1).max(MAX_TRAINING_BATCH_SIZE).default(DEFAULT_TRAINING_BATCH_SIZE),
  categoryWeights: categoryWeightsSchema.default(DEFAULT_CATEGORY_WEIGHTS).transform(normalizeCategoryWeights),
  compareLearningRates: z.boolean().default(false),
});

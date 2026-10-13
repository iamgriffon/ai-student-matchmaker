import { z } from "zod";
import { DEFAULT_EPOCHS, DEFAULT_LEARNING_RATE } from "./modelConfig.ts";

export const trainingOptionsSchema = z.object({
  learningRate: z.coerce.number().finite().positive("Learning rate must be greater than zero.").default(DEFAULT_LEARNING_RATE),
  epochs: z.coerce.number().int("Iterations must be an integer.").positive("Iterations must be greater than zero.").default(DEFAULT_EPOCHS),
  compareLearningRates: z.boolean().default(false),
});

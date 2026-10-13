import { z } from "zod";

export const TRAINING_PROGRESS_PREFIX = "TRAINING_PROGRESS ";
export const trainingProgressSchema = z.object({
  message: z.string(),
  epoch: z.number().int().nonnegative().optional(),
  learningRate: z.number().positive().optional(),
  loss: z.number().finite().nonnegative().optional(),
  totalEpochs: z.number().int().positive().optional(),
  iteration: z.number().int().positive().optional(),
  iterationCount: z.number().int().positive().optional(),
});

export function reportTrainingProgress(progress: z.input<typeof trainingProgressSchema>) {
  console.log(TRAINING_PROGRESS_PREFIX + JSON.stringify(trainingProgressSchema.parse(progress)));
}

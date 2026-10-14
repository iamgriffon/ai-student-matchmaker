import { z } from "zod";
import { parseId } from "./utils/idParser.ts";
import { modelIdSchema } from "./validators/trainedModels.ts";

const MIN_SCORE = 0;
const MAX_SCORE = 100;
const MIN_PARTICIPATION = 0;
const MAX_PARTICIPATION = 1;
const MIN_FEEDBACK = 1;
const MAX_FEEDBACK = 5;
const MAX_NOTES_LENGTH = 2000;

export const startPairSchema = z.object({
  userAId: z.string().transform(parseId), userBId: z.string().transform(parseId),
  contextVersion: z.string().trim().min(1),
  modelId: modelIdSchema.nullable().optional(),
}).refine((input) => input.userAId !== input.userBId, "A study pair needs two different students.");

export const completePairSchema = z.object({
  scoreAfterA: z.number().finite().min(MIN_SCORE).max(MAX_SCORE),
  scoreAfterB: z.number().finite().min(MIN_SCORE).max(MAX_SCORE),
  participationA: z.number().finite().min(MIN_PARTICIPATION).max(MAX_PARTICIPATION),
  participationB: z.number().finite().min(MIN_PARTICIPATION).max(MAX_PARTICIPATION),
  feedbackA: z.number().int().min(MIN_FEEDBACK).max(MAX_FEEDBACK),
  feedbackB: z.number().int().min(MIN_FEEDBACK).max(MAX_FEEDBACK),
  notes: z.string().trim().max(MAX_NOTES_LENGTH).optional(),
});

export class PairOutcomeConflictError extends Error {}
export class PairOutcomeNotFoundError extends Error {}


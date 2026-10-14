import { z } from "zod";

export const DEFAULT_CATEGORY_WEIGHTS = { balance: 0.7, incomeDistance: 0.2, disabilityDifference: 0.1 };
export const categoryWeightsSchema = z.object({
  balance: z.number().finite().nonnegative(),
  incomeDistance: z.number().finite().nonnegative(),
  disabilityDifference: z.number().finite().nonnegative(),
}).refine((weights) => {
  const total = weights.balance + weights.incomeDistance + weights.disabilityDifference;
  return Number.isFinite(total) && total > 0;
}, "At least one category weight must be positive.");
export type CategoryWeights = z.infer<typeof categoryWeightsSchema>;
const NORMALIZED_WEIGHT_TOLERANCE = 1e-12;
export function normalizeCategoryWeights(input: CategoryWeights): CategoryWeights {
  const weights = categoryWeightsSchema.parse(input);
  const total = weights.balance + weights.incomeDistance + weights.disabilityDifference;
  if (Math.abs(total - 1) <= NORMALIZED_WEIGHT_TOLERANCE) return weights;
  return { balance: weights.balance / total, incomeDistance: weights.incomeDistance / total, disabilityDifference: weights.disabilityDifference / total };
}

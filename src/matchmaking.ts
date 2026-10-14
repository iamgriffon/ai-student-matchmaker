import type { RuntimeEnv as Env } from "./runtimeEnv.ts";
import { evaluatePair } from "./pairPolicy.ts";
import { database, HttpError } from "./database.ts";
import { cohort, pairFeatures, parseUserId } from "./vectors.ts";
import { activeModel } from "./models.ts";

const RECOMMENDATION_LIMIT = 5;
const MAX_EXAM_SCORE = 100;
export async function recommendPartners(env: Env, userId: string) {
  const id = parseUserId(userId), db = database(env);
  const context = await cohort(db);
  const selected = context.students.find((student) => student.userId === id);
  if (typeof selected == 'undefined') throw new HttpError(404, "Student not found.");
  const model = await activeModel(db);
  if (!model) throw new HttpError(409, "Model training required.");
  const outcomes = await db.pairOutcome.findMany({
    where: { OR: [{ userAId: id }, { userBId: id }] },
    select: { id: true, userAId: true, userBId: true },
  });
  const users = new Map(context.users.map((user) => [user.id, user]));
  const started = new Map(outcomes.map((outcome) => [outcome.userAId === id ? outcome.userBId : outcome.userAId, outcome.id]));
  // Rank the full cohort; vector-search priority cannot change the final score ordering.
  const pairs = context.students.filter((student) => student.userId !== id)
    .map((student) => {
      const features = pairFeatures(selected, student, context.cohortMeanScore);
      const partner = users.get(student.userId);
      if (typeof partner == 'undefined') throw new Error("Partner not found in cohort.");
      return { userAId: id, userBId: student.userId, features,
        partner: { id: partner.id, name: partner.name, score: partner.score, income: partner.income, disability: partner.disability },
        outcomeId: started.get(student.userId) ?? null, ...evaluatePair(features) };
    });
  const eligible = pairs.filter((pair) => pair.eligible);
  return {
    userId: id, selectedScore: selected.features.score * MAX_EXAM_SCORE, contextVersion: context.contextVersion,
    cohortMeanScore: context.cohortMeanScore * MAX_EXAM_SCORE, evaluatedCount: pairs.length, eligibleCount: eligible.length,
    canStartPairs: true, rankingSource: "trained-policy-model", model: model.artifact.metadata,
    recommendations: [],
    inference: { artifact: model.artifact, candidates: eligible, limit: RECOMMENDATION_LIMIT },
  };
}

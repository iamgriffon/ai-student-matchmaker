import { evaluatePair } from "../../src/pairPolicy.ts";
import { database, HttpError } from "./database.ts";
import { cohort, pairFeatures, parseUserId, savePairFeatures, synchronizeStudentVectors } from "./vectors.ts";
import { activeModel, scoreWithModel } from "./models.ts";
import { encodeVectorizeValues } from "./vectorizeEncoding.ts";

const RECOMMENDATION_LIMIT = 5;
const VECTOR_CANDIDATE_LIMIT = 50;
const MAX_EXAM_SCORE = 100;
export async function recommendPartners(env: Env, userId: string) {
  const id = parseUserId(userId), db = database(env);
  const context = await cohort(db);
  const selected = context.students.find((student) => student.userId === id);
  if (typeof selected == 'undefined') throw new HttpError(404, "Student not found.");
  const model = await activeModel(db);
  if (!model) throw new HttpError(409, "Model training required.");
  const [indexed, outcomes] = await Promise.all([
    db.studentVector.count({ where: { contextVersion: context.contextVersion } }),
    db.pairOutcome.findMany({ where: { OR: [{ userAId: id }, { userBId: id }] }, select: { id: true, userAId: true, userBId: true } }),
  ]);
  if (indexed !== context.students.length) await synchronizeStudentVectors(env, context);
  // Complementary score targets the cohort mean; opposite social features encourage diversity.
  const vectorMatches = await env.STUDENT_INDEX.query(encodeVectorizeValues([
    Math.max(0, Math.min(1, context.cohortMeanScore * 2 - selected.features.score)),
    1 - selected.features.income, 1 - selected.features.disability,
  ]), { namespace: context.contextVersion, topK: VECTOR_CANDIDATE_LIMIT, returnMetadata: "all" });
  const priority = new Map(vectorMatches.matches.flatMap((match, index) => typeof match.metadata?.userId === "string" ? [[match.metadata.userId, index] as const] : []));
  const users = new Map(context.users.map((user) => [user.id, user]));
  const started = new Map(outcomes.map((outcome) => [outcome.userAId === id ? outcome.userBId : outcome.userAId, outcome.id]));
  // Vectorize is eventually consistent. Include the full cohort so it cannot omit an eligible partner.
  const pairs = context.students.filter((student) => student.userId !== id)
    .sort((a, b) => (priority.get(a.userId) ?? VECTOR_CANDIDATE_LIMIT) - (priority.get(b.userId) ?? VECTOR_CANDIDATE_LIMIT) || a.userId.localeCompare(b.userId))
    .map((student) => {
      const features = pairFeatures(selected, student, context.cohortMeanScore);
      const partner = users.get(student.userId);
      if (typeof partner == 'undefined') throw new Error("Partner not found in cohort.");
      return { userAId: id, userBId: student.userId, features,
        partner: { id: partner.id, name: partner.name, score: partner.score, income: partner.income, disability: partner.disability },
        outcomeId: started.get(student.userId) ?? null, ...evaluatePair(features) };
    });
  await savePairFeatures(env, context, pairs);
  const scores = await scoreWithModel(model.artifact, pairs.map((pair) => pair.features));
  const eligible = pairs.map((pair, index) => ({ ...pair, policyScore: pair.score, score: scores[index] ?? pair.score })).filter((pair) => pair.eligible);
  return {
    userId: id, selectedScore: selected.features.score * MAX_EXAM_SCORE, contextVersion: context.contextVersion,
    cohortMeanScore: context.cohortMeanScore * MAX_EXAM_SCORE, evaluatedCount: pairs.length, eligibleCount: eligible.length,
    canStartPairs: true, rankingSource: "trained-policy-model", model: model.artifact.metadata,
    recommendations: eligible.sort((a, b) => b.score - a.score || a.partner.id.localeCompare(b.partner.id)).slice(0, RECOMMENDATION_LIMIT),
  };
}

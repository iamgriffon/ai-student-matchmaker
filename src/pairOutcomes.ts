import type { RuntimeEnv as Env } from "./runtimeEnv.ts";
import { startPairSchema, completePairSchema } from "./pairOutcomeSchema.ts";
import { PAIR_ENCODER_VERSION } from "./vectorSchema.ts";
import { PAIR_POLICY_VERSION, evaluatePair } from "./pairPolicy.ts";
import { database, APP_STATE_ID, HttpError, ACTIVE_MODEL_KIND } from "./database.ts";
import { cohort, orderedMembers, pairFeatures, parseUserId, savePairFeatures } from "./vectors.ts";
import { activeModel, requireModel } from "./models.ts";
import type { PairOutcome } from "./generated/prisma/client.ts";

const HISTORY_LIMIT = 100;
export function outcomeDto(row: PairOutcome) {
  return { ...row, vector: [row.imbalance, row.academicGap, row.incomeDistance, row.disabilityDifference] };
}
export async function listPairOutcomes(env: Env, userId: string) {
  const db = database(env), id = parseUserId(userId);
  const [rows, model] = await Promise.all([
    db.pairOutcome.findMany({ where: { OR: [{ userAId: id }, { userBId: id }] }, orderBy: { startedAt: "desc" }, take: HISTORY_LIMIT }), activeModel(db),
  ]);
  return rows.map((row) => ({ ...outcomeDto(row), modelOutdated: !model || row.modelId !== model.modelId || row.encoderVersion !== PAIR_ENCODER_VERSION || row.policyVersion !== PAIR_POLICY_VERSION }));
}
export async function startPairOutcome(env: Env, input: unknown) {
  const parsed = startPairSchema.parse(input);
  const members = orderedMembers(parsed.userAId, parsed.userBId), db = database(env);
  const existing = await db.pairOutcome.findUnique({ where: { userAId_userBId: members } });
  if (existing) return { outcome: outcomeDto(existing), created: false };
  const model = await requireModel(db);
  if (parsed.modelId !== model.modelId) throw new HttpError(409, "Refresh recommendations before starting this study pair.");
  const context = await cohort(db);
  if (context.contextVersion !== parsed.contextVersion) throw new HttpError(409, "The cohort changed. Refresh recommendations.");
  const a = context.students.find((student) => student.userId === members.userAId);
  const b = context.students.find((student) => student.userId === members.userBId);
  if (!a || !b) throw new HttpError(404, "Student not found.");
  const features = pairFeatures(a, b, context.cohortMeanScore);
  if (!evaluatePair(features).eligible) throw new HttpError(409, "This study pair does not meet the academic balance criterion.");
  // Persist only a pair that is actually being started, after eligibility checks.
  await savePairFeatures(env, context, [{ ...members, features }]);
  const id = crypto.randomUUID();
  const result = await env.DB.prepare(`INSERT OR IGNORE INTO PairOutcomes
    (id, userAId, userBId, contextVersion, encoderVersion, policyVersion, modelId, imbalance, academicGap, incomeDistance, disabilityDifference, scoreBeforeA, scoreBeforeB, startedAt)
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    FROM AppState WHERE id = ? AND revision = ? AND vectorGeneration = ?
    AND EXISTS (SELECT 1 FROM TrainedModels WHERE id = ? AND activeKey = ?)
    AND EXISTS (SELECT 1 FROM PairVectors WHERE userAId = ? AND userBId = ? AND contextVersion = ? AND generation = ?)
  `).bind(id, members.userAId, members.userBId, context.contextVersion, PAIR_ENCODER_VERSION, PAIR_POLICY_VERSION, model.modelId,
    ...features, context.users.find((user) => user.id === members.userAId)!.score, context.users.find((user) => user.id === members.userBId)!.score,
    new Date().toISOString(), APP_STATE_ID, context.revision, context.generation, model.id, ACTIVE_MODEL_KIND,
    members.userAId, members.userBId, context.contextVersion, context.generation).run();
  const outcome = await db.pairOutcome.findUnique({ where: { userAId_userBId: members } });
  if (!outcome) throw new HttpError(409, "The recommendation expired. Refresh recommendations before starting this study pair.");
  return { outcome: outcomeDto(outcome), created: result.meta.changes > 0 };
}
export async function completePairOutcome(env: Env, id: string, input: unknown) {
  const outcomeId = parseUserId(id), observations = completePairSchema.parse(input), db = database(env);
  const result = await db.pairOutcome.updateMany({ where: { id: outcomeId, completedAt: null }, data: { ...observations, completedAt: new Date() } });
  const row = await db.pairOutcome.findUnique({ where: { id: outcomeId } });
  if (!row) throw new HttpError(404, "Study pair record not found.");
  if (!result.count) throw new HttpError(409, "Outcomes have already been recorded for this study pair.");
  return outcomeDto(row);
}

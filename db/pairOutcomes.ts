import { or } from "@prisma/orm-postgres/orm-client";
import { z } from "zod";
import { PAIR_ENCODER_VERSION } from "../src/vectorSchema.ts";
import { evaluatePair, PAIR_POLICY_VERSION, readPairFeatures } from "../src/pairPolicy.ts";
import { createContextFromUsers } from "../src/vectors.ts";
import { parseId } from "../src/utils/idParser.ts";
import { connectDatabase, db } from "./db.ts";
import { lockStudentMutations } from "./vectorSync.ts";
import { getActiveTrainedModel, requireActiveTrainedModel } from "./trainedModels.ts";
import { modelIdSchema } from "./validators/trainedModels.ts";

const MIN_SCORE = 0;
const MAX_SCORE = 100;
const MIN_PARTICIPATION = 0;
const MAX_PARTICIPATION = 1;
const MIN_FEEDBACK = 1;
const MAX_FEEDBACK = 5;
const MAX_NOTES_LENGTH = 2000;
const HISTORY_LIMIT = 100;

export const startPairSchema = z.object({
  userAId: z.string().transform(parseId), userBId: z.string().transform(parseId),
  contextVersion: z.string().trim().min(1),
  modelId: modelIdSchema.nullable().optional(),
}).refine((input) => input.userAId !== input.userBId, "Uma dupla precisa de dois alunos diferentes");

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

export async function startPairOutcome(input: z.input<typeof startPairSchema>) {
  const parsed = startPairSchema.parse(input);
  const [userAId, userBId] = [parsed.userAId, parsed.userBId].sort();
  if (typeof userAId == 'undefined' || typeof userBId == 'undefined') throw new Error("Integrantes ausentes");
  await connectDatabase();
  return db.transaction(async (tx) => {
    await lockStudentMutations(tx);
    const existing = await tx.orm.public.PairOutcomes.where((p) => p.userAId.eq(userAId))
      .where((p) => p.userBId.eq(userBId)).first();
    // Retentativas reutilizam o mesmo registro, mesmo após conclusão ou mudança da turma.
    if (existing) return { outcome: existing, created: false };
    const model = await requireActiveTrainedModel(tx);
    if (parsed.modelId !== model.modelId) throw new PairOutcomeConflictError("Refresh recommendations before starting this study pair.");
    const users = await tx.orm.public.Users.all();
    if (!users.length) throw new PairOutcomeNotFoundError("Student not found");
    const context = createContextFromUsers(users.map((user) => ({
      ...user, age: Number(user.age), score: Number(user.score),
    })));
    try {
      if (context.contextVersion !== parsed.contextVersion) throw new PairOutcomeConflictError("The cohort changed. Refresh recommendations.");
    } finally { context.studentVectors.dispose(); }
    const pair = await tx.orm.public.PairVectors.where((p) => p.userAId.eq(userAId))
      .where((p) => p.userBId.eq(userBId)).where((p) => p.contextVersion.eq(parsed.contextVersion)).first();
    if (!pair) throw new PairOutcomeConflictError("The recommendation expired. Refresh recommendations before starting this study pair.");
    if (!evaluatePair(readPairFeatures(Array.from(pair.vector))).eligible) throw new PairOutcomeConflictError("This study pair does not meet the academic balance criterion.");
    const a = users.find((user) => user.id === userAId);
    const b = users.find((user) => user.id === userBId);
    if (!a || !b) throw new PairOutcomeNotFoundError("Student not found");
    // Snapshot independente de PairVectors: a próxima normalização não apaga a evidência.
    const outcome = await tx.orm.public.PairOutcomes.create({
      userAId, userBId, vector: pair.vector, contextVersion: pair.contextVersion,
      encoderVersion: PAIR_ENCODER_VERSION, policyVersion: PAIR_POLICY_VERSION,
      modelId: model.modelId, scoreBeforeA: Number(a.score), scoreBeforeB: Number(b.score),
    });
    return { outcome, created: true };
  });
}

export async function completePairOutcome(id: string, input: z.input<typeof completePairSchema>) {
  const outcomeId = parseId(id);
  const observations = completePairSchema.parse(input);
  await connectDatabase();
  return db.transaction(async (tx) => {
    await lockStudentMutations(tx);
    const row = await tx.orm.public.PairOutcomes.where((p) => p.id.eq(outcomeId)).first();
    if (!row) throw new PairOutcomeNotFoundError("Study pair record not found");
    if (row.completedAt) throw new PairOutcomeConflictError("Outcomes have already been recorded for this study pair");
    await tx.orm.public.PairOutcomes.where((p) => p.id.eq(outcomeId)).update({
      ...observations, completedAt: new Date().toISOString(),
    });
    return tx.orm.public.PairOutcomes.where((p) => p.id.eq(outcomeId)).first();
  });
}

export async function listPairOutcomes(userId: string) {
  const id = parseId(userId);
  await connectDatabase();
  const [rows, activeModel] = await Promise.all([
    db.orm.public.PairOutcomes.where((p) => or(p.userAId.eq(id), p.userBId.eq(id)))
      .orderBy((p) => p.startedAt.desc()).limit(HISTORY_LIMIT).all(),
    getActiveTrainedModel(),
  ]);
  // Derivado na leitura: trocar ou apagar o modelo atualiza todo o histórico.
  return rows.map((row) => ({
    ...row,
    modelOutdated: !activeModel || !row.modelId || row.modelId !== activeModel.modelId ||
      row.encoderVersion !== PAIR_ENCODER_VERSION || row.policyVersion !== PAIR_POLICY_VERSION ||
      activeModel.artifact.metadata.encoderVersion !== PAIR_ENCODER_VERSION ||
      activeModel.artifact.metadata.policyVersion !== PAIR_POLICY_VERSION,
  }));
}

export async function getStartedPairPartners(userId: string) {
  const id = parseId(userId);
  await connectDatabase();
  // Não aplica o limite do histórico: todas as duplas existentes devem ocultar o botão.
  const rows = await db.orm.public.PairOutcomes.select("id", "userAId", "userBId")
    .where((p) => or(p.userAId.eq(id), p.userBId.eq(id))).all();
  return new Map(rows.map((row) => [row.userAId === id ? row.userBId : row.userAId, row.id]));
}

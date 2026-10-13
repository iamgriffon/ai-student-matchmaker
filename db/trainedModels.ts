import { z } from "zod";
import { PAIR_RANKER_KIND, MAX_VALIDATION_MAE } from "../src/modelConfig.ts";
import { PAIR_ENCODER_VERSION } from "../src/vectorSchema.ts";
import { PAIR_POLICY_VERSION } from "../src/pairPolicy.ts";
import { parseId } from "../src/utils/idParser.ts";
import { connectDatabase, db } from "./db.ts";
import { modelIdSchema, parseModelPayload, type RankerArtifact } from "./validators/trainedModels.ts";

const MIN_QUERY_LIMIT = 1;
const MAX_QUERY_LIMIT = 100;
const TRAINED_MODEL_WRITE_LOCK = 637892;
export const TRAINED_MODELS_CACHE_TTL_MS = 3_600_000;

type DatabaseRow = Awaited<ReturnType<typeof db.orm.public.TrainedModels.all>>[number];
export type TrainedModel = Omit<DatabaseRow, "artifact" | "trainingReport"> & ReturnType<typeof parseModelPayload>;
type Cache<Value> = { value: Value; expiresAt: number };
export const caches = {
  lists: new Map<string, Cache<TrainedModel[]>>(),
  byId: new Map<string, Cache<TrainedModel | null>>(),
  byModelId: new Map<string, Cache<TrainedModel | null>>(),
  active: new Map<string, Cache<TrainedModel | null>>(),
};
let cacheRevision = 0;

export function invalidateTrainedModelCaches() {
  for (const cache of Object.values(caches)) cache.clear();
  cacheRevision++;
}

async function readCached<Value>(cache: Map<string, Cache<Value>>, key: string, load: () => Promise<Value>) {
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) return structuredClone(cached.value);
  cache.delete(key);
  const revision = cacheRevision;
  const value = await load();
  if (revision === cacheRevision) cache.set(key, { value: structuredClone(value), expiresAt: Date.now() + TRAINED_MODELS_CACHE_TTL_MS });
  return structuredClone(value);
}

function parseRow(row: DatabaseRow): TrainedModel {
  const payload = parseModelPayload(row.artifact, row.trainingReport);
  if (row.kind !== PAIR_RANKER_KIND || row.modelId !== payload.artifact.metadata.modelId || (row.activeKey !== null && row.activeKey !== row.kind)) {
    throw new Error("Identificação do modelo inconsistente no banco");
  }
  return { ...row, ...payload };
}
function validateLimit(limit?: number) {
  if (typeof limit != 'undefined' && (!Number.isInteger(limit) || limit < MIN_QUERY_LIMIT || limit > MAX_QUERY_LIMIT)) throw new Error(`O limite deve ser um inteiro entre ${MIN_QUERY_LIMIT} e ${MAX_QUERY_LIMIT}`);
}
function validateActivation(artifact: RankerArtifact) {
  if (artifact.metadata.encoderVersion !== PAIR_ENCODER_VERSION || artifact.metadata.policyVersion !== PAIR_POLICY_VERSION) throw new Error("The model is incompatible with the current encoder or policy");
  if (artifact.metadata.validationMeanAbsoluteError > MAX_VALIDATION_MAE || (artifact.metadata.eligibleValidationMeanAbsoluteError ?? 0) > MAX_VALIDATION_MAE) throw new Error("The model did not meet the validation error threshold");
}
type ModelTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
export async function lockModelWrites(tx: ModelTransaction) {
  const plan = db.raw.sql`SELECT 1 AS "locked" FROM pg_advisory_xact_lock(${TRAINED_MODEL_WRITE_LOCK}::bigint)`
    .returnsRow({ locked: { codecId: "pg/int4@1" } }).build();
  await tx.query(plan);
}
export class TrainedModelRequiredError extends Error {}
export async function requireActiveTrainedModel(tx: ModelTransaction) {
  // Impede desativação/exclusão entre a verificação do modelo e a criação da dupla.
  await lockModelWrites(tx);
  const row = await tx.orm.public.TrainedModels.where((m) => m.activeKey.eq(PAIR_RANKER_KIND)).first();
  if (!row || row.activeKey !== PAIR_RANKER_KIND) throw new TrainedModelRequiredError("Train and activate a model before starting study pairs.");
  const parsed = parseRow(row);
  try { validateActivation(parsed.artifact); }
  catch { throw new TrainedModelRequiredError("A compatible trained model is required to start study pairs."); }
  return parsed;
}
async function activateInTransaction(tx: ModelTransaction, id: DatabaseRow["id"]) {
  await tx.orm.public.TrainedModels.where((m) => m.activeKey.eq(PAIR_RANKER_KIND)).updateAll({ activeKey: null });
  await tx.orm.public.TrainedModels.where((m) => m.id.eq(id)).update({ activeKey: PAIR_RANKER_KIND });
  const row = await tx.orm.public.TrainedModels.where((m) => m.id.eq(id)).first();
  if (!row) throw new Error("Model not found");
  return parseRow(row);
}

export async function getTrainedModels(limit?: number, options: { fresh?: boolean } = {}) {
  validateLimit(limit);
  if (options.fresh) invalidateTrainedModelCaches();
  const key = typeof limit == 'undefined' ? "all" : String(limit);
  return readCached(caches.lists, key, async () => {
    await connectDatabase();
    const query = db.orm.public.TrainedModels.orderBy([(m) => m.createdAt.desc(), (m) => m.id.desc()]);
    const rows = typeof limit == 'undefined' ? await query.all() : await query.limit(limit).all();
    return rows.map(parseRow);
  });
}
export async function getTrainedModelById(id: string) {
  const parsedId = parseId(id);
  return readCached(caches.byId, parsedId, async () => {
    await connectDatabase();
    const row = await db.orm.public.TrainedModels.where((m) => m.id.eq(parsedId)).first();
    return row ? parseRow(row) : null;
  });
}
export async function getTrainedModelByModelId(modelId: string) {
  const parsed = modelIdSchema.parse(modelId.trim());
  return readCached(caches.byModelId, parsed, async () => {
    await connectDatabase();
    const row = await db.orm.public.TrainedModels.where((m) => m.modelId.eq(parsed))
      .orderBy([(m) => m.createdAt.desc(), (m) => m.id.desc()]).first();
    return row ? parseRow(row) : null;
  });
}
export async function getActiveTrainedModel(kind = PAIR_RANKER_KIND) {
  const parsedKind = z.literal(PAIR_RANKER_KIND).parse(kind);
  await connectDatabase();
  // A consulta pequena detecta ativações feitas por OUTRO processo de treinamento.
  // O JSONB pesado só é carregado quando id/updatedAt mudam ou o TTL expira.
  const pointer = await db.orm.public.TrainedModels.select("id", "updatedAt")
    .where((m) => m.activeKey.eq(parsedKind)).first();
  if (!pointer) { caches.active.clear(); return null; }
  const key = JSON.stringify([parsedKind, pointer.id, pointer.updatedAt]);
  for (const oldKey of caches.active.keys()) if (oldKey !== key) caches.active.delete(oldKey);
  return readCached(caches.active, key, async () => {
    const row = await db.orm.public.TrainedModels.where((m) => m.id.eq(pointer.id))
      .where((m) => m.activeKey.eq(parsedKind)).first();
    return row ? parseRow(row) : null;
  });
}

export async function saveTrainedModel(artifact: unknown, options: { trainingReport?: unknown; activate?: boolean } = {}) {
  const payload = parseModelPayload(artifact, options.trainingReport);
  if (options.activate) validateActivation(payload.artifact);
  // Campos opcionais explicitamente undefined são omitidos na representação JSON.
  // A validação anterior impede perder valores não JSON durante essa conversão.
  const artifactJson = z.json().parse(JSON.parse(JSON.stringify(payload.artifact)));
  const reportJson = payload.trainingReport ? z.json().parse(JSON.parse(JSON.stringify(payload.trainingReport))) : null;
  await connectDatabase();
  const saved = await db.transaction(async (tx) => {
    await lockModelWrites(tx);
    // Sempre cria uma execução: pesos idênticos não devem sobrescrever o histórico.
    const row = await tx.orm.public.TrainedModels.create({
      modelId: payload.artifact.metadata.modelId, kind: PAIR_RANKER_KIND,
      artifact: artifactJson, trainingReport: reportJson,
      activeKey: null,
    });
    return options.activate ? activateInTransaction(tx, row.id) : parseRow(row);
  });
  invalidateTrainedModelCaches();
  return saved;
}
export async function activateTrainedModel(id: string) {
  const parsedId = parseId(id);
  await connectDatabase();
  const saved = await db.transaction(async (tx) => {
    await lockModelWrites(tx);
    const row = await tx.orm.public.TrainedModels.where((m) => m.id.eq(parsedId)).first();
    if (!row) throw new Error("Model not found");
    const parsed = parseRow(row);
    validateActivation(parsed.artifact);
    return activateInTransaction(tx, parsedId);
  });
  invalidateTrainedModelCaches();
  return saved;
}
export async function deleteTrainedModel(id: string) {
  const parsedId = parseId(id);
  await connectDatabase();
  const deleted = await db.transaction(async (tx) => {
    await lockModelWrites(tx);
    return tx.orm.public.TrainedModels.where((m) => m.id.eq(parsedId)).delete();
  });
  invalidateTrainedModelCaches();
  return deleted ? parseRow(deleted) : null;
}

import { parseModelPayload, type RankerArtifact } from "./validators/trainedModels.ts";
import { PAIR_ENCODER_VERSION } from "./vectorSchema.ts";
import { PAIR_POLICY_VERSION } from "./pairPolicy.ts";
import { MAX_VALIDATION_MAE, PAIR_RANKER_INPUT_COUNT } from "./modelConfig.ts";
import { ACTIVE_MODEL_KIND, HttpError, type Database } from "./database.ts";
import type { TrainedModel } from "./generated/prisma/client.ts";

export function modelPayload(row: TrainedModel) { return { ...row, ...parseModelPayload(row.artifact, row.trainingReport) }; }
export function isCompatible(artifact: RankerArtifact) {
  return artifact.metadata.encoderVersion === PAIR_ENCODER_VERSION && artifact.metadata.policyVersion === PAIR_POLICY_VERSION &&
    artifact.metadata.validationMeanAbsoluteError <= MAX_VALIDATION_MAE &&
    (artifact.metadata.eligibleValidationMeanAbsoluteError ?? 0) <= MAX_VALIDATION_MAE;
}
export async function activeModel(db: Database) {
  const row = await db.trainedModel.findUnique({ where: { activeKey: ACTIVE_MODEL_KIND } });
  if (!row) return null;
  const model = modelPayload(row);
  return isCompatible(model.artifact) ? model : null;
}
export async function requireModel(db: Database) {
  const model = await activeModel(db);
  if (!model) throw new HttpError(409, "Train and activate a model before starting study pairs.");
  return model;
}
export function trainingIteration(row: TrainedModel) {
  const model = modelPayload(row);
  return {
    id: row.id, modelId: row.modelId, kind: row.kind, active: row.activeKey !== null,
    createdAt: row.createdAt, updatedAt: row.updatedAt, metadata: model.artifact.metadata,
    architecture: [PAIR_RANKER_INPUT_COUNT, ...model.artifact.modelTopology.config.layers.map((layer) => layer.config.units)],
    trainingReport: model.trainingReport,
  };
}

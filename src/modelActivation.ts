import type { RuntimeEnv } from "./runtimeEnv.ts";
import { database, APP_STATE_ID, ACTIVE_MODEL_KIND, HttpError } from "./database.ts";
import { cohort, parseUserId } from "./vectors.ts";
import { isCompatible, modelPayload, trainingIteration } from "./models.ts";

const HTTP_NOT_FOUND = 404;
const HTTP_CONFLICT = 409;
export async function activatePreviousModel(env: RuntimeEnv, modelId: string) {
  const db = database(env);
  const id = parseUserId(modelId);
  const row = await db.trainedModel.findUnique({ where: { id } });
  if (!row) throw new HttpError(HTTP_NOT_FOUND, "Training run not found.");
  const model = modelPayload(row);
  const context = await cohort(db);
  if (row.kind !== ACTIVE_MODEL_KIND || !isCompatible(model.artifact) ||
    model.artifact.metadata.validationStrategy !== "student-disjoint" ||
    model.artifact.metadata.sourceContextVersion !== context.contextVersion) {
    throw new HttpError(HTTP_CONFLICT, "This model is incompatible with the current cohort or validation requirements.");
  }
  // Batch is transactional in both D1 and PostgreSQL. Lock the cohort row first;
  // the same guards protect clearing the old selection and activating the new one.
  const guard = `EXISTS (SELECT 1 FROM AppState WHERE id = ? AND revision = ? AND vectorGeneration = ?)
    AND EXISTS (SELECT 1 FROM TrainedModels WHERE id = ? AND kind = ?)
    AND EXISTS (SELECT 1 FROM TrainingJob WHERE id = ? AND status = 'completed')
    AND NOT EXISTS (SELECT 1 FROM TrainingJob WHERE activeKey IS NOT NULL)`;
  const values = [APP_STATE_ID, context.revision, context.generation, id, ACTIVE_MODEL_KIND, row.jobId];
  // D1 serializes writers. PostgreSQL needs this lock so a training/clear job
  // cannot appear between the two guarded updates and leave no active model.
  const operationLock = "withSession" in env.DB ? [] : [env.DB.prepare("LOCK TABLE TrainingJob IN SHARE ROW EXCLUSIVE MODE")];
  const results = await env.DB.batch([
    ...operationLock,
    env.DB.prepare("UPDATE AppState SET revision = revision WHERE id = ?").bind(APP_STATE_ID),
    env.DB.prepare(`UPDATE TrainedModels SET activeKey = NULL WHERE activeKey = ? AND ${guard}`).bind(ACTIVE_MODEL_KIND, ...values),
    env.DB.prepare(`UPDATE TrainedModels SET activeKey = ? WHERE id = ? AND ${guard}`).bind(ACTIVE_MODEL_KIND, id, ...values),
  ]);
  if (!results.at(-1)?.meta.changes) throw new HttpError(HTTP_CONFLICT, "The cohort changed or another training operation is running. Refresh and try again.");
  return { iteration: trainingIteration({ ...row, activeKey: ACTIVE_MODEL_KIND }) };
}

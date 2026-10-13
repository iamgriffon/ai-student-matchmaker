import { readFile } from "node:fs/promises";
import { connectDatabase, db } from "../db/db.ts";
import { activateTrainedModel, getTrainedModelByModelId, saveTrainedModel } from "../db/trainedModels.ts";
import { parseModelPayload } from "../db/validators/trainedModels.ts";
import { deserializeRanker } from "../src/pairRanker.ts";

const ARTIFACT_ARGUMENT_INDEX = 2;
const REPORT_ARGUMENT_INDEX = 3;
const artifactPath = process.argv[ARTIFACT_ARGUMENT_INDEX];
const reportPath = process.argv[REPORT_ARGUMENT_INDEX];
if (typeof artifactPath == 'undefined') throw new Error("Use bun run import:trained-models <artifact.json> [report.json]");
try {
  const report = typeof reportPath == 'undefined' ? undefined : JSON.parse(await readFile(reportPath, "utf8"));
  const payload = parseModelPayload(JSON.parse(await readFile(artifactPath, "utf8")), report);
  const loaded = await deserializeRanker(payload.artifact);
  loaded.model.dispose();
  await connectDatabase();
  const existing = await getTrainedModelByModelId(payload.artifact.metadata.modelId);
  // A importação pode ser repetida sem duplicar a mesma execução histórica.
  const saved = existing?.artifact.metadata.trainedAt === payload.artifact.metadata.trainedAt
    ? await activateTrainedModel(existing.id)
    : await saveTrainedModel(payload.artifact, { trainingReport: payload.trainingReport, activate: true });
  console.log(JSON.stringify({ iterationId: saved.id, modelId: saved.modelId, active: saved.activeKey !== null, hasReport: saved.trainingReport !== null }));
} finally { await db.close(); }

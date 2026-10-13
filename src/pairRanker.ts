import { getActiveTrainedModel } from "../db/trainedModels.ts";
import { rankerArtifactSchema as artifactSchema } from "../db/validators/trainedModels.ts";
import { PAIR_ENCODER_VERSION } from "./vectorSchema.ts";
import { PAIR_POLICY_VERSION, type PairFeatures } from "./pairPolicy.ts";
import { MAX_VALIDATION_MAE } from "./modelConfig.ts";
import { deserializeRanker, predictPairScores } from "./rankerEngine.ts";
export { DEFAULT_EPOCHS, DEFAULT_LEARNING_RATE, MAX_VALIDATION_MAE, trainPairRanker, predictPairScores, serializeRanker, deserializeRanker } from "./rankerEngine.ts";
export type { RankerArtifact, RankerMetadata, TrainingSample } from "./rankerEngine.ts";
const MIN_SCORE = 0;

type LoadedRanker = Awaited<ReturnType<typeof deserializeRanker>>;
type ModelEntry = { promise: Promise<LoadedRanker>; loaded: LoadedRanker | null; users: number; retired: boolean };
const loadedModels = new Map<string, ModelEntry>();
let currentRevision: string | null = null;

function retireEntry(key: string, entry: ModelEntry) {
  if (entry.users) return;
  entry.loaded?.model.dispose();
  entry.loaded = null;
  if (loadedModels.get(key) === entry) loadedModels.delete(key);
}
export function clearRankerCache() {
  currentRevision = null;
  for (const [key, entry] of loadedModels) {
    entry.retired = true;
    retireEntry(key, entry);
  }
  loadedModels.clear();
}

export async function rankWithTrainedModel(features: readonly PairFeatures[]) {
  const row = await getActiveTrainedModel();
  if (!row) { clearRankerCache(); return null; }
  const artifact = artifactSchema.parse(row.artifact);
  if (artifact.metadata.encoderVersion !== PAIR_ENCODER_VERSION || artifact.metadata.policyVersion !== PAIR_POLICY_VERSION) {
    clearRankerCache();
    return null;
  }
  if (artifact.metadata.validationMeanAbsoluteError > MAX_VALIDATION_MAE ||
    (artifact.metadata.eligibleValidationMeanAbsoluteError ?? MIN_SCORE) > MAX_VALIDATION_MAE) {
    throw new Error("The model did not meet the validation error threshold");
  }
  const revision = JSON.stringify([row.id, row.updatedAt]);
  currentRevision = revision;
  for (const [key, entry] of loadedModels) if (key !== revision) retireEntry(key, entry);
  let entry = loadedModels.get(revision);
  if (typeof entry == 'undefined') {
    const created: ModelEntry = { promise: deserializeRanker(artifact), loaded: null, users: 0, retired: false };
    created.promise = created.promise.then((loaded) => { created.loaded = loaded; return loaded; });
    entry = created;
    loadedModels.set(revision, entry);
  }
  // Mantém o modelo vivo enquanto outra requisição aguarda a mesma desserialização.
  // Uma troca/limpeza do cache só libera os tensores depois desses consumidores.
  entry.users++;
  try {
    const loaded = await entry.promise;
    return { scores: predictPairScores(loaded.model, features), metadata: structuredClone(loaded.metadata) };
  } catch (error) {
    entry.retired = true;
    throw error;
  } finally {
    entry.users--;
    if (entry.retired || revision !== currentRevision) retireEntry(revision, entry);
  }
}

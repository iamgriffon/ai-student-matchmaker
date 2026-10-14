import { trainBatches, evaluateBatches } from "./training/batches.ts";
import type { TrainingSample, TrainingBatchProgress } from "./training/types.ts";
export type { TrainingSample, TrainingBatchProgress } from "./training/types.ts";
export { predictPairScores } from "./training/prediction.ts";
import * as tf from "@tensorflow/tfjs";
import { encodeBase64, decodeBase64, modelHash } from "./training/encoding.ts";
import { PAIR_POLICY_VERSION, readPairFeatures } from "./pairPolicy.ts";
import { PAIR_ENCODER_VERSION } from "./vectorSchema.ts";
import { parseId } from "./utils/idParser.ts";
import { rankerArtifactSchema as artifactSchema, type RankerArtifact, type RankerMetadata } from "./validators/trainedModels.ts";
import { DEFAULT_EPOCHS, DEFAULT_LEARNING_RATE, MAX_VALIDATION_MAE, PAIR_RANKER_INPUT_COUNT, PAIR_RANKER_OUTPUT_COUNT, DEFAULT_TRAINING_BATCH_SIZE, MAX_TRAINING_BATCH_SIZE } from "./modelConfig.ts";
export { DEFAULT_EPOCHS, DEFAULT_LEARNING_RATE, MAX_VALIDATION_MAE } from "./modelConfig.ts";
export type { RankerArtifact, RankerMetadata } from "./validators/trainedModels.ts";

const FEATURE_COUNT = PAIR_RANKER_INPUT_COUNT;
const OUTPUT_COUNT = PAIR_RANKER_OUTPUT_COUNT;
const FIRST_HIDDEN_UNITS = 128;
const SECOND_HIDDEN_UNITS = 64;
const THIRD_HIDDEN_UNITS = 32;
const FIRST_HIDDEN_INITIALIZER_SEED = 17;
const SECOND_HIDDEN_INITIALIZER_SEED = 18;
const THIRD_HIDDEN_INITIALIZER_SEED = 19;
const OUTPUT_INITIALIZER_SEED = 20;
const VALIDATION_STRIDE = 5;
const VALIDATION_REMAINDER = 0;
const MIN_TRAINING_SAMPLES = 25;
const MIN_SCORE = 0;
const MAX_SCORE = 1;
const MODEL_ID_HASH_LENGTH = 12;
export async function prepareTrainingBackend() {
  await tf.setBackend("cpu");
  await tf.ready();
}

export async function trainPairRanker(
  samples: readonly TrainingSample[],
  contextVersion: string,
  options: {
    epochs?: number; learningRate?: number; batchSize?: number; validationSamples?: readonly TrainingSample[];
    onEpoch?: (epoch: number, loss: number) => void | Promise<void>;
    onBatch?: (progress: TrainingBatchProgress) => void | Promise<void>;
  } = {},
) {
  const batchSize = options.batchSize ?? DEFAULT_TRAINING_BATCH_SIZE;
  if (!Number.isInteger(batchSize) || batchSize <= MIN_SCORE || batchSize > MAX_TRAINING_BATCH_SIZE) throw new Error("Invalid training batch size.");
  const epochs = options.epochs ?? DEFAULT_EPOCHS;
  if (!Number.isInteger(epochs) || epochs <= MIN_SCORE) throw new Error("Número de épocas inválido");
  if (!contextVersion.trim()) throw new Error("A versão do contexto é obrigatória");
  if (samples.length < MIN_TRAINING_SAMPLES) throw new Error(`O treinamento exige pelo menos ${MIN_TRAINING_SAMPLES} duplas`);
  const learningRate = options.learningRate ?? DEFAULT_LEARNING_RATE;
  if (!Number.isFinite(learningRate) || learningRate <= MIN_SCORE) throw new Error("Taxa de aprendizado inválida");
  for (const partition of [samples, options.validationSamples ?? []]) {
    for (const sample of partition) {
      readPairFeatures(sample.features);
      if (!Number.isFinite(sample.target) || sample.target < MIN_SCORE || sample.target > MAX_SCORE) throw new Error("Rótulo de treinamento inválido");
    }
  }
  // O chamador fornece uma ordem determinística embaralhada por hash de IDs.
  // Uma em cada cinco duplas fica fora do ajuste dos pesos, para validação.
  const hasExplicitValidation = typeof options.validationSamples != 'undefined';
  const training = hasExplicitValidation ? samples : samples.filter((_sample, index) => index % VALIDATION_STRIDE !== VALIDATION_REMAINDER);
  const validation = options.validationSamples ?? samples.filter((_sample, index) => index % VALIDATION_STRIDE === VALIDATION_REMAINDER);
  if (!validation.length) throw new Error("O conjunto de validação não pode ser vazio");
  if (hasExplicitValidation) {
    const collectIds = (rows: readonly TrainingSample[]) => new Set(rows.flatMap((row) => {
      if (typeof row.userAId == 'undefined' || typeof row.userBId == 'undefined') throw new Error("Validação por alunos exige os IDs dos dois integrantes");
      const first = parseId(row.userAId);
      const second = parseId(row.userBId);
      if (first === second) throw new Error("Uma dupla precisa de dois alunos diferentes");
      return [first, second];
    }));
    const trainingIds = collectIds(training);
    const validationIds = collectIds(validation);
    if ([...validationIds].some((id) => trainingIds.has(id))) throw new Error("Um aluno não pode aparecer no treino e na validação");
  }
  const model = tf.sequential();
  model.add(tf.layers.dense({ units: FIRST_HIDDEN_UNITS, inputShape: [FEATURE_COUNT], activation: "relu", kernelInitializer: tf.initializers.glorotUniform({ seed: FIRST_HIDDEN_INITIALIZER_SEED }) }));
  model.add(tf.layers.dense({ units: SECOND_HIDDEN_UNITS, activation: "relu", kernelInitializer: tf.initializers.glorotUniform({ seed: SECOND_HIDDEN_INITIALIZER_SEED }) }));
  model.add(tf.layers.dense({ units: THIRD_HIDDEN_UNITS, activation: "relu", kernelInitializer: tf.initializers.glorotUniform({ seed: THIRD_HIDDEN_INITIALIZER_SEED }) }));
  model.add(tf.layers.dense({ units: OUTPUT_COUNT, activation: "linear", kernelInitializer: tf.initializers.glorotUniform({ seed: OUTPUT_INITIALIZER_SEED }) }));
  const optimizer = tf.train.adam(learningRate);
  model.compile({ optimizer, loss: "meanSquaredError" });
  try {
    await trainBatches(model, training, epochs, batchSize, options);
    const metrics = await evaluateBatches(model, validation, batchSize);
    const metadata: RankerMetadata = {
      modelId: "pending-serialization", encoderVersion: PAIR_ENCODER_VERSION, policyVersion: PAIR_POLICY_VERSION,
      labelSource: "policy-generated", sourceContextVersion: contextVersion.trim(), trainedAt: new Date().toISOString(),
      learningRate, validationStrategy: hasExplicitValidation ? "student-disjoint" : "pair-holdout",
      sampleCount: training.length + validation.length, trainingCount: training.length, validationCount: validation.length, epochs,
      ...metrics,
    };
    return { model, metadata };
  } catch (error) {
    model.dispose();
    throw error;
  } finally {
    optimizer.dispose();
  }
}

export async function serializeRanker(model: tf.LayersModel, metadata: RankerMetadata): Promise<RankerArtifact> {
  let captured: tf.io.ModelArtifacts | undefined;
  await model.save(tf.io.withSaveHandler(async (artifacts) => {
    captured = artifacts;
    return { modelArtifactsInfo: tf.io.getModelArtifactsInfoForJSON(artifacts) };
  }), { includeOptimizer: false });
  if (typeof captured == 'undefined' || !captured.weightData || !captured.modelTopology || !captured.weightSpecs) throw new Error("Artefato de modelo incompleto");
  const weightData = Array.isArray(captured.weightData) ? tf.io.concatenateArrayBuffers(captured.weightData) : captured.weightData;
  const weights = new Uint8Array(weightData);
  // Zod normalizes key order. Hash the persisted topology, not TensorFlow's raw object.
  const artifact = artifactSchema.parse({
    metadata: { ...metadata, modelId: "pair-ranker-000000000000" },
    modelTopology: captured.modelTopology, weightSpecs: captured.weightSpecs, weightData: encodeBase64(weights),
  });
  const hash = await modelHash(artifact.modelTopology, weights);
  artifact.metadata.modelId = `pair-ranker-${hash.slice(MIN_SCORE, MODEL_ID_HASH_LENGTH)}`;
  return artifact;
}

export async function deserializeRanker(value: unknown) {
  const artifact = artifactSchema.parse(value);
  const weightData = decodeBase64(artifact.weightData).buffer;
  const model = await tf.loadLayersModel(tf.io.fromMemory({ modelTopology: artifact.modelTopology, weightSpecs: artifact.weightSpecs, weightData }));
  if (model.inputs[0]?.shape.at(-1) !== FEATURE_COUNT || model.outputs.length !== OUTPUT_COUNT || model.outputs[0]?.shape.at(-1) !== OUTPUT_COUNT) {
    model.dispose();
    throw new Error("Dimensões incompatíveis do modelo de duplas");
  }
  return { model, metadata: artifact.metadata };
}


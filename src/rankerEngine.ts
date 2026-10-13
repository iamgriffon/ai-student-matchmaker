import * as tf from "@tensorflow/tfjs";
import { createHash } from "node:crypto";
import { PAIR_POLICY_VERSION, type PairFeatures, readPairFeatures } from "./pairPolicy.ts";
import { PAIR_ENCODER_VERSION } from "./vectorSchema.ts";
import { parseId } from "./utils/idParser.ts";
import { rankerArtifactSchema as artifactSchema, type RankerArtifact, type RankerMetadata } from "../db/validators/trainedModels.ts";
import { DEFAULT_EPOCHS, DEFAULT_LEARNING_RATE, MAX_VALIDATION_MAE, PAIR_RANKER_INPUT_COUNT, PAIR_RANKER_OUTPUT_COUNT } from "./modelConfig.ts";
export { DEFAULT_EPOCHS, DEFAULT_LEARNING_RATE, MAX_VALIDATION_MAE } from "./modelConfig.ts";
export type { RankerArtifact, RankerMetadata } from "../db/validators/trainedModels.ts";

const FEATURE_COUNT = PAIR_RANKER_INPUT_COUNT;
const OUTPUT_COUNT = PAIR_RANKER_OUTPUT_COUNT;
const FIRST_HIDDEN_UNITS = 128;
const SECOND_HIDDEN_UNITS = 64;
const THIRD_HIDDEN_UNITS = 32;
const FIRST_HIDDEN_INITIALIZER_SEED = 17;
const SECOND_HIDDEN_INITIALIZER_SEED = 18;
const THIRD_HIDDEN_INITIALIZER_SEED = 19;
const OUTPUT_INITIALIZER_SEED = 20;
const BATCH_SIZE = 64;
const VALIDATION_STRIDE = 5;
const VALIDATION_REMAINDER = 0;
const MIN_TRAINING_SAMPLES = 25;
const MIN_SCORE = 0;
const MAX_SCORE = 1;
const MODEL_ID_HASH_LENGTH = 12;
export type TrainingSample = { features: PairFeatures; target: number; eligible: boolean; userAId?: string; userBId?: string };

export async function prepareTrainingBackend() {
  await tf.setBackend("cpu");
  await tf.ready();
}

export function predictPairScores(model: tf.LayersModel, features: readonly PairFeatures[]): number[] {
  if (!features.length) return [];
  const scores = tf.tidy(() => {
    const input = tf.tensor2d(features.map((row) => Array.from(readPairFeatures(row))), [features.length, FEATURE_COUNT]);
    const prediction = model.predict(input);
    if (Array.isArray(prediction)) throw new Error("O modelo deve ter uma única saída");
    return Array.from(prediction.dataSync());
  });
  if (scores.length !== features.length || !scores.every(Number.isFinite)) {
    throw new Error("O modelo produziu pontuações inválidas");
  }
  // A regressão pode ultrapassar ligeiramente os limites; a pontuação continua em [0, 1].
  return scores.map((score) => Math.max(MIN_SCORE, Math.min(MAX_SCORE, score)));
}

export async function trainPairRanker(
  samples: readonly TrainingSample[],
  contextVersion: string,
  options: { epochs?: number; learningRate?: number; validationSamples?: readonly TrainingSample[]; onEpoch?: (epoch: number, loss: number) => void | Promise<void> } = {},
) {
  const epochs = options.epochs ?? DEFAULT_EPOCHS;
  if (!Number.isInteger(epochs) || epochs <= MIN_SCORE) throw new Error("Número de épocas inválido");
  if (!contextVersion.trim()) throw new Error("A versão do contexto é obrigatória");
  if (samples.length < MIN_TRAINING_SAMPLES) throw new Error(`O treinamento exige pelo menos ${MIN_TRAINING_SAMPLES} duplas`);
  const learningRate = options.learningRate ?? DEFAULT_LEARNING_RATE;
  if (!Number.isFinite(learningRate) || learningRate <= MIN_SCORE) throw new Error("Taxa de aprendizado inválida");
  for (const sample of [...samples, ...(options.validationSamples ?? [])]) {
    readPairFeatures(sample.features);
    if (!Number.isFinite(sample.target) || sample.target < MIN_SCORE || sample.target > MAX_SCORE) throw new Error("Rótulo de treinamento inválido");
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
  const xs = tf.tensor2d(training.map((sample) => Array.from(sample.features)), [training.length, FEATURE_COUNT]);
  const ys = tf.tensor2d(training.map((sample) => [sample.target]), [training.length, OUTPUT_COUNT]);
  const model = tf.sequential();
  model.add(tf.layers.dense({ units: FIRST_HIDDEN_UNITS, inputShape: [FEATURE_COUNT], activation: "relu", kernelInitializer: tf.initializers.glorotUniform({ seed: FIRST_HIDDEN_INITIALIZER_SEED }) }));
  model.add(tf.layers.dense({ units: SECOND_HIDDEN_UNITS, activation: "relu", kernelInitializer: tf.initializers.glorotUniform({ seed: SECOND_HIDDEN_INITIALIZER_SEED }) }));
  model.add(tf.layers.dense({ units: THIRD_HIDDEN_UNITS, activation: "relu", kernelInitializer: tf.initializers.glorotUniform({ seed: THIRD_HIDDEN_INITIALIZER_SEED }) }));
  model.add(tf.layers.dense({ units: OUTPUT_COUNT, activation: "linear", kernelInitializer: tf.initializers.glorotUniform({ seed: OUTPUT_INITIALIZER_SEED }) }));
  const optimizer = tf.train.adam(learningRate);
  model.compile({ optimizer, loss: "meanSquaredError" });
  try {
    await model.fit(xs, ys, {
      epochs, batchSize: Math.min(BATCH_SIZE, training.length), shuffle: false,
      callbacks: { onEpochEnd: async (epoch, logs) => { await options.onEpoch?.(epoch, Number(logs?.loss)); } },
    });
    const predictions = predictPairScores(model, validation.map((sample) => sample.features));
    const errors = validation.map((sample, index) => {
      const prediction = predictions[index];
      if (typeof prediction == 'undefined') throw new Error("Previsão de validação ausente");
      return { eligible: sample.eligible, error: Math.abs(prediction - sample.target) };
    });
    const meanError = (rows: typeof errors) => rows.reduce((sum, row) => sum + row.error, MIN_SCORE) / rows.length;
    const eligibleErrors = errors.filter((row) => row.eligible);
    const metadata: RankerMetadata = {
      modelId: "pending-serialization", encoderVersion: PAIR_ENCODER_VERSION, policyVersion: PAIR_POLICY_VERSION,
      labelSource: "policy-generated", sourceContextVersion: contextVersion.trim(), trainedAt: new Date().toISOString(),
      learningRate, validationStrategy: hasExplicitValidation ? "student-disjoint" : "pair-holdout",
      sampleCount: training.length + validation.length, trainingCount: training.length, validationCount: validation.length, epochs,
      validationMeanAbsoluteError: meanError(errors),
      eligibleValidationMeanAbsoluteError: eligibleErrors.length ? meanError(eligibleErrors) : null,
    };
    return { model, metadata };
  } catch (error) {
    model.dispose();
    throw error;
  } finally {
    xs.dispose(); ys.dispose(); optimizer.dispose();
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
  const weights = Buffer.from(weightData);
  const hash = createHash("sha256").update(JSON.stringify(captured.modelTopology)).update(weights).digest("hex");
  return artifactSchema.parse({
    metadata: { ...metadata, modelId: `pair-ranker-${hash.slice(MIN_SCORE, MODEL_ID_HASH_LENGTH)}` },
    modelTopology: captured.modelTopology, weightSpecs: captured.weightSpecs, weightData: weights.toString("base64"),
  });
}

export async function deserializeRanker(value: unknown) {
  const artifact = artifactSchema.parse(value);
  const weightData = Uint8Array.from(Buffer.from(artifact.weightData, "base64")).buffer;
  const model = await tf.loadLayersModel(tf.io.fromMemory({ modelTopology: artifact.modelTopology, weightSpecs: artifact.weightSpecs, weightData }));
  if (model.inputs[0]?.shape.at(-1) !== FEATURE_COUNT || model.outputs.length !== OUTPUT_COUNT || model.outputs[0]?.shape.at(-1) !== OUTPUT_COUNT) {
    model.dispose();
    throw new Error("Dimensões incompatíveis do modelo de duplas");
  }
  return { model, metadata: artifact.metadata };
}


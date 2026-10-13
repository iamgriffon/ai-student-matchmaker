import { z } from "zod";
import { PAIR_RANKER_INPUT_COUNT, PAIR_RANKER_OUTPUT_COUNT } from "../../src/modelConfig.ts";

const FLOAT32_BYTES = 4;
const FIRST_LAYER_INDEX = 0;
const SHAPE_BATCH_INDEX = 0;
const SHAPE_FEATURE_INDEX = 1;
const INPUT_SHAPE_LENGTH = 2;
const WEIGHTS_PER_DENSE_LAYER = 2;
const BIAS_SPEC_OFFSET = 1;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
export const modelIdSchema = z.string().regex(/^pair-ranker-[a-f0-9]{12}$/, "Identificador de modelo inválido");

const metadataFields = {
  modelId: z.string().min(1), encoderVersion: z.string().min(1), policyVersion: z.string().min(1),
  labelSource: z.literal("policy-generated"), sourceContextVersion: z.string().min(1),
  trainedAt: z.iso.datetime(), sampleCount: z.number().int().positive(),
  trainingCount: z.number().int().positive(), validationCount: z.number().int().positive(),
  epochs: z.number().int().positive(), learningRate: z.number().finite().positive().optional(),
  validationStrategy: z.enum(["pair-holdout", "student-disjoint"]).optional(),
  validationMeanAbsoluteError: z.number().finite().nonnegative(),
  eligibleValidationMeanAbsoluteError: z.number().finite().nonnegative().nullable(),
};
const metadataObject = z.object(metadataFields);
export const rankerMetadataSchema = metadataObject.superRefine((metadata, context) => {
  if (metadata.sampleCount !== metadata.trainingCount + metadata.validationCount) {
    context.addIssue({ code: "custom", path: ["sampleCount"], message: "Total de amostras não corresponde ao treino e à validação" });
  }
});

// Preserva os campos JSON do TensorFlow, validando explicitamente a arquitetura usada aqui.
const denseConfigSchema = z.object({
  name: z.string().min(1), units: z.number().int().positive(),
  activation: z.enum(["relu", "linear"]), use_bias: z.literal(true), trainable: z.boolean(),
  batch_input_shape: z.array(z.number().int().positive().nullable()).optional(),
  dtype: z.literal("float32").optional(),
  kernel_initializer: z.object({
    class_name: z.literal("VarianceScaling"),
    config: z.object({ scale: z.number().finite().positive(), mode: z.enum(["fan_in", "fan_out", "fan_avg"]), distribution: z.enum(["normal", "uniform", "truncated_normal"]), seed: z.number().int().optional() }).catchall(z.json()),
  }).catchall(z.json()),
  bias_initializer: z.object({ class_name: z.literal("Zeros"), config: z.object({}).catchall(z.json()) }).catchall(z.json()),
}).catchall(z.json());
const topologySchema = z.object({
  class_name: z.literal("Sequential"),
  config: z.object({
    name: z.string().min(1),
    layers: z.array(z.object({ class_name: z.literal("Dense"), config: denseConfigSchema }).catchall(z.json())).min(1),
  }).catchall(z.json()),
  keras_version: z.string().min(1), backend: z.literal("tensor_flow.js"),
}).catchall(z.json());

export const rankerArtifactSchema = z.object({
  metadata: rankerMetadataSchema,
  modelTopology: topologySchema,
  weightSpecs: z.array(z.object({ name: z.string().min(1), shape: z.array(z.number().int().positive()), dtype: z.literal("float32") })).min(1),
  weightData: z.string().min(1).regex(BASE64_PATTERN, "Pesos devem estar em base64 válido"),
}).superRefine((artifact, context) => {
  const issue = (path: (string | number)[], message: string) => context.addIssue({ code: "custom", path, message });
  if (!modelIdSchema.safeParse(artifact.metadata.modelId).success) issue(["metadata", "modelId"], "Identificador de modelo inválido");
  const layers = artifact.modelTopology.config.layers;
  const first = layers[FIRST_LAYER_INDEX];
  const last = layers.at(-1);
  const inputShape = first?.config.batch_input_shape;
  if (inputShape?.length !== INPUT_SHAPE_LENGTH || inputShape[SHAPE_BATCH_INDEX] !== null || inputShape[SHAPE_FEATURE_INDEX] !== PAIR_RANKER_INPUT_COUNT) {
    issue(["modelTopology"], "O ranker exige quatro entradas");
  }
  if (last?.config.units !== PAIR_RANKER_OUTPUT_COUNT || last.config.activation !== "linear") issue(["modelTopology"], "O ranker exige uma saída linear");
  if (new Set(layers.map((layer) => layer.config.name)).size !== layers.length) issue(["modelTopology"], "Nomes de camadas duplicados");
  if (artifact.weightSpecs.length !== layers.length * WEIGHTS_PER_DENSE_LAYER) issue(["weightSpecs"], "Número de tensores incompatível com a arquitetura");
  let inputUnits = PAIR_RANKER_INPUT_COUNT;
  for (const [index, layer] of layers.entries()) {
    const kernel = artifact.weightSpecs[index * WEIGHTS_PER_DENSE_LAYER];
    const bias = artifact.weightSpecs[index * WEIGHTS_PER_DENSE_LAYER + BIAS_SPEC_OFFSET];
    if (kernel?.name !== `${layer.config.name}/kernel` || JSON.stringify(kernel.shape) !== JSON.stringify([inputUnits, layer.config.units])) issue(["weightSpecs", index * WEIGHTS_PER_DENSE_LAYER], "Kernel incompatível com a camada");
    if (bias?.name !== `${layer.config.name}/bias` || JSON.stringify(bias.shape) !== JSON.stringify([layer.config.units])) issue(["weightSpecs", index * WEIGHTS_PER_DENSE_LAYER + BIAS_SPEC_OFFSET], "Bias incompatível com a camada");
    inputUnits = layer.config.units;
  }
  const bytes = Buffer.from(artifact.weightData, "base64");
  const expectedBytes = artifact.weightSpecs.reduce((total, spec) => total + spec.shape.reduce((size, dimension) => size * dimension, 1) * FLOAT32_BYTES, 0);
  if (bytes.toString("base64") !== artifact.weightData || bytes.length !== expectedBytes) {
    issue(["weightData"], "Tamanho dos pesos incompatível com os tensores");
    return;
  }
  for (let offset = 0; offset < bytes.length; offset += FLOAT32_BYTES) {
    if (!Number.isFinite(bytes.readFloatLE(offset))) { issue(["weightData"], "Pesos devem ser finitos"); break; }
  }
});

export const trainingReportSchema = z.object({
  labelSource: z.literal("policy-generated"), validationStrategy: z.enum(["pair-holdout", "student-disjoint"]),
  architecture: z.array(z.number().int().positive()).optional(), epochs: z.number().int().positive().optional(),
  trainingStudents: z.number().int().positive(), validationStudents: z.number().int().positive(),
  trainingPairs: z.number().int().positive(), validationPairs: z.number().int().positive(),
  excludedCrossGroupPairs: z.number().int().nonnegative(), modelId: modelIdSchema.optional(), activatedModelId: modelIdSchema.optional(),
  lossHistory: z.array(z.object({ epoch: z.number().int().positive(), loss: z.number().finite().nonnegative() })).optional(),
  comparisons: z.array(metadataObject.partial().extend({
    modelId: modelIdSchema.optional(),
    learningRate: z.number().finite().positive(), validationMeanAbsoluteError: z.number().finite().nonnegative(),
    eligibleValidationMeanAbsoluteError: z.number().finite().nonnegative().nullable(),
  }).superRefine((comparison, context) => {
    if (typeof comparison.sampleCount != 'undefined' && typeof comparison.trainingCount != 'undefined' && typeof comparison.validationCount != 'undefined' && comparison.sampleCount !== comparison.trainingCount + comparison.validationCount) {
      context.addIssue({ code: "custom", path: ["sampleCount"], message: "Total de amostras da comparação inconsistente" });
    }
  })).min(1),
}).superRefine((report, context) => {
  let previousEpoch = 0;
  for (const [index, entry] of (report.lossHistory ?? []).entries()) {
    if (entry.epoch <= previousEpoch) context.addIssue({ code: "custom", path: ["lossHistory", index, "epoch"], message: "As épocas devem ser únicas e estar em ordem crescente" });
    previousEpoch = entry.epoch;
  }
});

export function parseModelPayload(artifact: unknown, report?: unknown) {
  const parsedArtifact = rankerArtifactSchema.parse(artifact);
  const parsedReport = typeof report == 'undefined' || report === null ? null : trainingReportSchema.parse(report);
  if (parsedReport) {
    const reportModelId = parsedReport.modelId ?? parsedReport.activatedModelId;
    if (typeof reportModelId != 'undefined' && reportModelId !== parsedArtifact.metadata.modelId) throw new Error("O relatório pertence a outro modelo");
    if (parsedReport.lossHistory?.some((entry) => entry.epoch > parsedArtifact.metadata.epochs)) throw new Error("Época do relatório excede o treinamento");
    if (parsedReport.trainingPairs !== parsedArtifact.metadata.trainingCount || parsedReport.validationPairs !== parsedArtifact.metadata.validationCount) throw new Error("O relatório não corresponde às amostras do modelo");
    if (parsedReport.labelSource !== parsedArtifact.metadata.labelSource || parsedReport.validationStrategy !== parsedArtifact.metadata.validationStrategy) throw new Error("O relatório não corresponde à estratégia do modelo");
    if (parsedReport.architecture && JSON.stringify(parsedReport.architecture) !== JSON.stringify([PAIR_RANKER_INPUT_COUNT, ...parsedArtifact.modelTopology.config.layers.map((layer) => layer.config.units)])) throw new Error("A arquitetura do relatório não corresponde ao modelo");
    if (typeof parsedReport.epochs != 'undefined' && parsedReport.epochs !== parsedArtifact.metadata.epochs) throw new Error("O número de épocas do relatório não corresponde ao modelo");
  }
  return { artifact: parsedArtifact, trainingReport: parsedReport };
}

export type RankerMetadata = z.infer<typeof rankerMetadataSchema>;
export type RankerArtifact = z.infer<typeof rankerArtifactSchema>;
export type TrainingReport = z.infer<typeof trainingReportSchema>;

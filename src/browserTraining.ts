import type { RuntimeEnv as Env } from "./runtimeEnv.ts";
import { z } from "zod";
import { database, APP_STATE_ID, ACTIVE_MODEL_KIND, HttpError } from "./database.ts";
import { cohort } from "./vectors.ts";
import { createOperation, trainingStatus } from "./training.ts";
import { trainingOptionsSchema } from "./trainingOptions.ts";
import { parseModelPayload } from "./validators/trainedModels.ts";
import { decodeBase64, modelHash } from "./training/encoding.ts";
import { isCompatible } from "./models.ts";

const ARCHITECTURE = [128, 64, 32, 1];
const MAX_BROWSER_MODELS = 2;
const COMPARISON_LEARNING_RATE = 0.01;
const MODEL_HASH_LENGTH = 12;
const updateSchema = z.object({
  jobId: z.uuid(), action: z.enum(["progress", "model", "complete", "failed"]),
  iteration: z.number().int().min(1).max(MAX_BROWSER_MODELS).optional(),
  progress: z.object({
    epoch: z.number().int().nonnegative(), totalEpochs: z.number().int().positive(),
    iteration: z.number().int().min(1).max(MAX_BROWSER_MODELS),
    iterationCount: z.number().int().min(1).max(MAX_BROWSER_MODELS),
    learningRate: z.number().positive(), loss: z.number().finite().nonnegative(),
    batch: z.number().int().nonnegative(), totalBatches: z.number().int().positive(),
    processedSamples: z.number().int().nonnegative(), sampleCount: z.number().int().positive(),
    tensorBytes: z.number().int().nonnegative(), numTensors: z.number().int().nonnegative(),
  }).optional(),
  artifact: z.unknown().optional(), report: z.unknown().optional(),
});

export async function startBrowserTraining(env: Env, input: unknown) {
  const options = trainingOptionsSchema.parse(input);
  const job = await createOperation(env, "running", "Preparing browser training…", options, true);
  const db = database(env);
  try {
    const context = await cohort(db);
    if (context.revision !== job.revision || context.generation !== job.generation) throw new HttpError(409, "The cohort changed. Start training again.");
    await db.trainingJob.update({ where: { id: job.id }, data: {
      options: { ...options, executor: "external", client: "browser", contextVersion: context.contextVersion, lastHeartbeat: Date.now() },
    } });
    return { training: trainingStatus(job), executor: "browser", options, context: {
      contextVersion: context.contextVersion, cohortMeanScore: context.cohortMeanScore, students: context.students,
    } };
  } catch (error) {
    await db.trainingJob.update({ where: { id: job.id }, data: { status: "failed", activeKey: null, finishedAt: new Date(), message: "Could not prepare browser training." } });
    throw error;
  }
}

export async function updateBrowserTraining(env: Env, input: unknown) {
  const data = updateSchema.parse(input);
  const db = database(env);
  const job = await db.trainingJob.findUnique({ where: { id: data.jobId } });
  if (!job) throw new HttpError(404, "Training run not found.");
  const stored = z.object({ client: z.literal("browser"), contextVersion: z.string() }).parse(job.options);
  const options = trainingOptionsSchema.parse(job.options);
  if (job.status !== "running") {
    if (job.status === "completed" && data.action === "complete") return { training: trainingStatus(job) };
    throw new HttpError(409, "This training run is no longer running.");
  }
  const state = await db.appState.findUniqueOrThrow({ where: { id: APP_STATE_ID } });
  if (state.revision !== job.revision || state.vectorGeneration !== job.generation) {
    await db.trainingJob.update({ where: { id: job.id }, data: { status: "failed", activeKey: null, finishedAt: new Date(), message: "The cohort changed during training. Start again." } });
    throw new HttpError(409, "The cohort changed during training. Start again.");
  }
  if (data.action === "failed") {
    await db.trainingJob.update({ where: { id: job.id }, data: { status: "failed", activeKey: null, finishedAt: new Date(), message: "Browser training was interrupted. Keep the page open and try again." } });
  } else if (data.action === "progress") {
    const progress = data.progress;
    if (typeof progress == 'undefined') throw new HttpError(400, "Missing progress.");
    await db.trainingJob.updateMany({ where: { id: job.id, status: "running" }, data: {
      epoch: progress.epoch, iteration: progress.iteration, iterationCount: progress.iterationCount, loss: progress.loss,
      message: "Training in your browser. Keep this page open.",
      options: { ...options, ...stored, executor: "external", lastHeartbeat: Date.now(), batchProgress: progress },
    } });
  } else if (data.action === "model") {
    const iteration = data.iteration;
    if (typeof iteration == 'undefined') throw new HttpError(400, "Missing model iteration.");
    const payload = parseModelPayload(data.artifact, data.report);
    const metadata = payload.artifact.metadata;
    const rates = options.compareLearningRates ? [...new Set([COMPARISON_LEARNING_RATE, options.learningRate])] : [options.learningRate];
    if (!payload.trainingReport || metadata.sourceContextVersion !== stored.contextVersion ||
      JSON.stringify(metadata.categoryWeights) !== JSON.stringify(options.categoryWeights) ||
      JSON.stringify(payload.trainingReport.categoryWeights) !== JSON.stringify(options.categoryWeights) ||
      metadata.epochs !== options.epochs || metadata.learningRate !== rates[iteration - 1] ||
      metadata.validationStrategy !== "student-disjoint" ||
      JSON.stringify(payload.artifact.modelTopology.config.layers.map((layer) => layer.config.units)) !== JSON.stringify(ARCHITECTURE)) {
      throw new HttpError(400, "The model does not match this training run.");
    }
    const hash = await modelHash(payload.artifact.modelTopology, decodeBase64(payload.artifact.weightData));
    if (metadata.modelId !== "pair-ranker-" + hash.slice(0, MODEL_HASH_LENGTH)) throw new HttpError(400, "Model checksum mismatch.");
    await db.trainedModel.upsert({
      where: { jobId_iteration: { jobId: job.id, iteration } },
      create: { id: crypto.randomUUID(), kind: ACTIVE_MODEL_KIND, activeKey: null, jobId: job.id, iteration,
        modelId: metadata.modelId, artifact: JSON.parse(JSON.stringify(payload.artifact)), trainingReport: JSON.parse(JSON.stringify(payload.trainingReport)) },
      update: {},
    });
  } else {
    const models = await db.trainedModel.findMany({ where: { jobId: job.id }, orderBy: { iteration: "asc" } });
    const expectedCount = options.compareLearningRates && options.learningRate !== COMPARISON_LEARNING_RATE ? MAX_BROWSER_MODELS : 1;
    if (models.length !== expectedCount) throw new HttpError(409, "Upload every trained model before completing.");
    const payloads = models.map((model) => parseModelPayload(model.artifact, model.trainingReport));
    const selected = payloads.findIndex((payload) => payload.artifact.metadata.learningRate === options.learningRate);
    const selectedRow = models[selected];
    const selectedPayload = payloads[selected];
    if (!selectedRow || !selectedPayload || !isCompatible(selectedPayload.artifact)) throw new HttpError(409, "The model did not meet the validation error threshold.");
    for (const [index, model] of models.entries()) {
      await db.trainedModel.update({ where: { id: model.id }, data: {
        trainingReport: JSON.parse(JSON.stringify({ ...payloads[index]!.trainingReport, comparisons: payloads.map((payload) => payload.artifact.metadata) })),
      } });
    }
    // The existing D1 trigger atomically checks the cohort and activates the selected model.
    await db.trainingJob.updateMany({ where: { id: job.id, status: "running" }, data: {
      epoch: options.epochs, iteration: selectedRow.iteration, status: "completed", activeKey: null, finishedAt: new Date(), message: "Model trained and activated.",
    } });
  }
  return { training: trainingStatus(await db.trainingJob.findUnique({ where: { id: job.id } })) };
}

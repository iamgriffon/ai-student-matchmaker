import type { RuntimeEnv as Env } from "./runtimeEnv.ts";
import { z } from "zod";
import { trainingOptionsSchema } from "./trainingOptions.ts";
import { database, HttpError, ACTIVE_OPERATION_KEY, APP_STATE_ID } from "./database.ts";
import type { TrainingJob } from "./generated/prisma/client.ts";

const EXTERNAL_HEARTBEAT_TIMEOUT_MS = 15 * 60_000;

export type TrainingOptions = ReturnType<typeof trainingOptionsSchema.parse>;
const batchProgressSchema = z.object({
  batch: z.number().int().nonnegative(), totalBatches: z.number().int().positive(),
  processedSamples: z.number().int().nonnegative(), sampleCount: z.number().int().positive(),
  tensorBytes: z.number().int().nonnegative(), numTensors: z.number().int().nonnegative(),
});
export function trainingStatus(job: TrainingJob | null) {
  const progress = z.object({ batchProgress: batchProgressSchema.optional() }).safeParse(job?.options);
  const batchProgress = progress.success ? progress.data.batchProgress : undefined;
  return job ? { jobId: job.id, ...batchProgress, status: job.status, message: job.message, startedAt: job.startedAt, finishedAt: job.finishedAt,
    epoch: job.epoch, totalEpochs: job.totalEpochs, iteration: job.iteration, iterationCount: job.iterationCount,
    learningRate: job.learningRate, loss: job.loss } : { status: "idle", message: "", startedAt: null, finishedAt: null };
}
export async function latestTraining(env: Env, db = database(env)) {
  let job = await db.trainingJob.findFirst({ orderBy: { startedAt: "desc" } });
  const externallyTrained = job?.options && typeof job.options === "object" && !Array.isArray(job.options) && job.options.executor === "external";
  if (job?.status === "running" && externallyTrained) {
    // A crashed external process cannot hold the training lock forever.
    await env.DB.prepare(`UPDATE TrainingJob SET status = 'failed', activeKey = NULL, message = ?, finishedAt = ?
      WHERE id = ? AND status = 'running' AND coalesce(json_extract(options, '$.lastHeartbeat'), 0) < ?`)
      .bind("Training stopped reporting progress. Keep the training page open and try again.", new Date().toISOString(), job.id, Date.now() - EXTERNAL_HEARTBEAT_TIMEOUT_MS).run();
    job = await db.trainingJob.findUnique({ where: { id: job.id } });
  }
  if (job?.status === "running" && !externallyTrained) {
    if (!env.TRAINING) throw new HttpError(409, "This training run belongs to the Cloudflare Workflow runtime.");
    const instance = await env.TRAINING.get(job.id);
    const status = await instance.status();
    if (["errored", "terminated"].includes(status.status)) {
      job = await db.trainingJob.update({ where: { id: job.id }, data: {
        status: "failed", activeKey: null, finishedAt: new Date(), message: "Training failed or was interrupted. Please try again.",
      } });
    }
  }
  return trainingStatus(job);
}
export async function createOperation(env: Env, status: string, message: string, options: TrainingOptions, external = false) {
  const db = database(env);
  const state = await db.appState.findUniqueOrThrow({ where: { id: APP_STATE_ID } });
  try {
    return await db.trainingJob.create({ data: {
      id: crypto.randomUUID(), activeKey: ACTIVE_OPERATION_KEY, status, message, options: external ? { ...options, executor: "external", lastHeartbeat: Date.now() } : options,
      revision: state.revision, generation: state.vectorGeneration, totalEpochs: options.epochs, learningRate: options.learningRate,
    } });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "P2002") throw new HttpError(409, "Wait for the current training operation to finish.");
    throw error;
  }
}
export async function clearTrainingData(env: Env) {
  const job = await createOperation(env, "clearing", "Deleting training data…", trainingOptionsSchema.parse({}));
  try {
    const now = new Date().toISOString();
    // D1 batch is atomic; interactive Prisma transactions and PostgreSQL advisory locks are unavailable.
    const result = await env.DB.batch([
      env.DB.prepare("DELETE FROM PairVectors"),
      env.DB.prepare("DELETE FROM TrainedModels"),
      env.DB.prepare("UPDATE AppState SET vectorGeneration = vectorGeneration + 1 WHERE id = ?").bind(APP_STATE_ID),
      env.DB.prepare("UPDATE TrainingJob SET status = 'idle', message = ?, activeKey = NULL, finishedAt = ? WHERE id = ?")
        .bind("Training data deleted. Model training required.", now, job.id),
    ]);
    // The generation change hides old vectors immediately. Physical deletion runs through the durable outbox.
    return { deleted: { pairVectors: result[0]?.meta.changes ?? 0, trainedModels: result[1]?.meta.changes ?? 0 }, training: await latestTraining(env) };
  } catch (error) {
    await database(env).trainingJob.update({ where: { id: job.id }, data: { activeKey: null, status: "failed", finishedAt: new Date(), message: "Could not delete training data." } });
    throw error;
  }
}

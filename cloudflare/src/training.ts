import { trainingOptionsSchema } from "../../src/trainingOptions.ts";
import { database, HttpError, ACTIVE_OPERATION_KEY, APP_STATE_ID } from "./database.ts";
import type { TrainingJob } from "./generated/prisma/client.ts";

const EXTERNAL_HEARTBEAT_TIMEOUT_MS = 15 * 60_000;

export type TrainingOptions = ReturnType<typeof trainingOptionsSchema.parse>;
export function trainingStatus(job: TrainingJob | null) {
  return job ? { status: job.status, message: job.message, startedAt: job.startedAt, finishedAt: job.finishedAt,
    epoch: job.epoch, totalEpochs: job.totalEpochs, iteration: job.iteration, iterationCount: job.iterationCount,
    learningRate: job.learningRate, loss: job.loss } : { status: "idle", message: "", startedAt: null, finishedAt: null };
}
export async function latestTraining(env: Env) {
  const db = database(env);
  let job = await db.trainingJob.findFirst({ orderBy: { startedAt: "desc" } });
  const externallyTrained = job?.options && typeof job.options === "object" && !Array.isArray(job.options) && job.options.executor === "external";
  if (job?.status === "running" && externallyTrained) {
    // A crashed external process cannot hold the training lock forever.
    await env.DB.prepare(`UPDATE TrainingJob SET status = 'failed', activeKey = NULL, message = ?, finishedAt = ?
      WHERE id = ? AND status = 'running' AND coalesce(json_extract(options, '$.lastHeartbeat'), 0) < ?`)
      .bind("External training stopped reporting progress. Run the local command again.", new Date().toISOString(), job.id, Date.now() - EXTERNAL_HEARTBEAT_TIMEOUT_MS).run();
    job = await db.trainingJob.findUnique({ where: { id: job.id } });
  }
  if (job?.status === "running" && !externallyTrained) {
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
async function createOperation(env: Env, status: string, message: string, options: TrainingOptions, external = false) {
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
type ExternalTrainingEnv = Env & { TRAINING_SERVICE_URL?: string; TRAINING_SERVICE_TOKEN?: string };
const SERVICE_START_TIMEOUT_MS = 10_000;
export async function startTraining(env: ExternalTrainingEnv, input: unknown) {
  const options = trainingOptionsSchema.parse(input);
  if (!env.TRAINING_SERVICE_URL || !env.TRAINING_SERVICE_TOKEN) {
    throw new HttpError(503, "Configure the external training service URL and token before starting training.");
  }
  const endpoint = new URL("/training", env.TRAINING_SERVICE_URL);
  if (endpoint.protocol !== "https:") throw new HttpError(503, "The training service must use an HTTPS URL.");
  const job = await createOperation(env, "running", "Starting the external training service…", options, true);
  try {
    const response = await fetch(endpoint, {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${env.TRAINING_SERVICE_TOKEN}` },
      body: JSON.stringify({ jobId: job.id, options }), signal: AbortSignal.timeout(SERVICE_START_TIMEOUT_MS),
    });
    if (!response.ok) throw new HttpError(502, "The external training service could not accept this run.");
    const acknowledgment = await response.json();
    if (!acknowledgment || typeof acknowledgment !== "object" || !("jobId" in acknowledgment) || acknowledgment.jobId !== job.id) {
      throw new HttpError(502, "The external training service returned an invalid job acknowledgment.");
    }
    return trainingStatus(job);
  } catch (error) {
    await database(env).trainingJob.updateMany({ where: { id: job.id, status: "running" }, data: {
      activeKey: null, status: "failed", finishedAt: new Date(), message: "Could not start the external training service.",
    } });
    if (error instanceof HttpError) throw error;
    throw new HttpError(502, "Could not reach the external training service.");
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

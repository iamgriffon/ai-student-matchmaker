import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { deleteTrainingData } from "../db/trainingData.ts";
import { invalidatePairVectorCaches } from "../db/pairVectors.ts";
import { invalidateTrainedModelCaches } from "../db/trainedModels.ts";
import { clearRankerCache } from "./pairRanker.ts";
import { TRAINING_PROGRESS_PREFIX, trainingProgressSchema } from "./trainingProgress.ts";
import { APPLICATION_WORKING_DIRECTORY, TRAINING_ENTRYPOINT } from "./runtimePaths.ts";
import { COMPARE_LEARNING_RATES_FLAG } from "./modelConfig.ts";
import { trainingOptionsSchema } from "./trainingOptions.ts";

const TRAINING_TIMEOUT_MS = 15 * 60 * 1000;
const MAX_OUTPUT_TAIL_CHARACTERS = 4000;
type TrainingStatus = {
  status: "idle" | "running" | "completed" | "failed" | "clearing";
  message: string;
  startedAt: string | null;
  finishedAt: string | null;
  epoch?: number;
  learningRate?: number;
  loss?: number;
  totalEpochs?: number;
  iteration?: number;
  iterationCount?: number;
};
let status: TrainingStatus = { status: "idle", message: "", startedAt: null, finishedAt: null };

export class TrainingBusyError extends Error {
  constructor() { super("Wait for the current training operation to finish."); }
}
export function getTrainingStatus() { return { ...status }; }
function requireIdle() {
  if (status.status === "running" || status.status === "clearing") throw new TrainingBusyError();
}
function invalidateTrainingCaches() {
  invalidatePairVectorCaches();
  invalidateTrainedModelCaches();
  clearRankerCache();
}

export async function clearTrainingData() {
  requireIdle();
  status = { status: "clearing", message: "Deleting training data…", startedAt: new Date().toISOString(), finishedAt: null };
  try {
    const deleted = await deleteTrainingData();
    invalidateTrainingCaches();
    status = { status: "idle", message: "Training data deleted. Model training required.", startedAt: null, finishedAt: new Date().toISOString() };
    return { deleted, training: getTrainingStatus() };
  } catch (error) {
    status = { ...status, status: "failed", message: "Could not delete training data.", finishedAt: new Date().toISOString() };
    throw error;
  }
}

export function startTraining(options: { learningRate?: number; epochs?: number; compareLearningRates?: boolean } = {}) {
  const parsed = trainingOptionsSchema.parse(options);
  requireIdle();
  status = { status: "running", message: "Preparing pair vectors…", startedAt: new Date().toISOString(), finishedAt: null };
  const executable = typeof process.versions.bun == 'undefined' ? "bun" : process.execPath;
  const args = ["run", fileURLToPath(TRAINING_ENTRYPOINT), "--learning-rate", String(parsed.learningRate), "--epochs", String(parsed.epochs)];
  if (parsed.compareLearningRates) args.push(COMPARE_LEARNING_RATES_FLAG);
  const child = spawn(executable, args, {
    cwd: fileURLToPath(APPLICATION_WORKING_DIRECTORY),
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let pendingLine = "";
  let outputTail = "";
  let failureMessage: string | null = null;
  const rememberOutput = (text: string) => { outputTail = (outputTail + text).slice(-MAX_OUTPUT_TAIL_CHARACTERS); };
  child.stdout.on("data", (chunk: Buffer) => {
    const text = chunk.toString();
    rememberOutput(text);
    pendingLine += text;
    const lines = pendingLine.split("\n");
    pendingLine = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith(TRAINING_PROGRESS_PREFIX)) continue;
      try {
        const progress = trainingProgressSchema.parse(JSON.parse(line.slice(TRAINING_PROGRESS_PREFIX.length)));
        status = { ...status, ...progress };
      } catch { /* Logs comuns não alteram o estado do treinamento. */ }
    }
  });
  child.stderr.on("data", (chunk: Buffer) => rememberOutput(chunk.toString()));
  child.on("error", (error) => { failureMessage = `Could not start training: ${error.message}`; });
  const stopChild = () => child.kill();
  process.once("exit", stopChild);
  const timeout = setTimeout(() => {
    failureMessage = "Training timed out. Please try again.";
    child.kill();
  }, TRAINING_TIMEOUT_MS);
  child.on("close", (code) => {
    clearTimeout(timeout);
    process.removeListener("exit", stopChild);
    invalidateTrainingCaches();
    const succeeded = code === 0 && failureMessage === null;
    if (!succeeded) console.error("Training failed:", outputTail);
    status = { ...status, status: succeeded ? "completed" : "failed", finishedAt: new Date().toISOString(),
      message: succeeded ? "Model trained and activated." : failureMessage ?? "Training failed. Check that there are enough students and pairs and that the cohort did not change during training." };
  });
  return getTrainingStatus();
}

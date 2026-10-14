import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { createHash } from "node:crypto";
import { trainingOptionsSchema } from "./trainingOptions.ts";
import { splitStudentIds, splitPairsByStudent } from "./utils/studentSplit.ts";
import { evaluatePair, readPairFeatures } from "./pairPolicy.ts";
import { prepareTrainingBackend, trainPairRanker, serializeRanker, type RankerArtifact } from "./rankerEngine.ts";
import { parseModelPayload } from "./validators/trainedModels.ts";
import { PAIR_RANKER_INPUT_COUNT } from "./modelConfig.ts";
import { database, APP_STATE_ID, ACTIVE_MODEL_KIND, HttpError } from "./database.ts";
import { cohort, pairFeatures, savePairFeatures, synchronizeStudentVectors, type Cohort } from "./vectors.ts";
import { isCompatible, modelPayload } from "./models.ts";
import { decodePairVectorizeValues } from "./vectorizeEncoding.ts";

// Vectorize getByIds accepts at most 20 IDs, independently of D1 write batches.
const VECTORIZE_READ_BATCH_SIZE = 20;
const ANCHORS_PER_GROUP = 2;
const MIN_PARTITION_PAIRS = 200;
const COMPARISON_LEARNING_RATE = 0.01;
const FIRST_ITERATION = 1;
const MAX_TRAINING_PAIRS = 3000;
const MAX_VALIDATION_PAIRS = 1000;
const BATCH_PROGRESS_INTERVAL = 10;
const TRAINING_STEP_TIMEOUT = "15 minutes";

async function samplesForTraining(env: Env, context: Cohort) {
  const ids = splitStudentIds(context.students.map((student) => student.userId));
  const samples = new Map<string, { userAId: string; userBId: string; features: ReturnType<typeof pairFeatures> }>();
  for (const group of [ids.trainingIds, ids.validationIds]) {
    const anchors = [...group].slice(0, ANCHORS_PER_GROUP);
    for (const anchorId of anchors) {
      const anchor = context.students.find((student) => student.userId === anchorId);
      if (typeof anchor == 'undefined') continue;
      for (const partner of context.students) {
        if (partner.userId === anchorId || !group.has(partner.userId)) continue;
        const [userAId, userBId] = [anchorId, partner.userId].sort();
        if (typeof userAId == 'undefined' || typeof userBId == 'undefined') throw new Error("Pair members missing.");
        samples.set(`${userAId}:${userBId}`, { userAId, userBId, features: pairFeatures(anchor, partner, context.cohortMeanScore) });
      }
    }
  }
  const pairs = [...samples.values()].sort((a, b) => {
    const key = (pair: typeof a) => createHash("sha256").update(`${pair.userAId}:${pair.userBId}`).digest("hex");
    return key(a).localeCompare(key(b));
  });
  const split = splitPairsByStudent(pairs, ids);
  const training = split.training.slice(0, MAX_TRAINING_PAIRS), validation = split.validation.slice(0, MAX_VALIDATION_PAIRS);
  if (training.length < MIN_PARTITION_PAIRS || validation.length < MIN_PARTITION_PAIRS) throw new HttpError(409, "Not enough study pairs. Add more students before training.");
  await savePairFeatures(env, context, [...training, ...validation]);
  // Read persisted vector values when available; recent writes may not be indexed yet.
  const db = database(env);
  const selectedPairs = [...training, ...validation];
  // Fetch only the sampled pairs, in bounded SQL and Vectorize batches.
  for (let offset = 0; offset < selectedPairs.length; offset += VECTORIZE_READ_BATCH_SIZE) {
    const batch = selectedPairs.slice(offset, offset + VECTORIZE_READ_BATCH_SIZE);
    const rows = await db.pairVector.findMany({ where: {
      contextVersion: context.contextVersion, generation: context.generation,
      OR: batch.map(({ userAId, userBId }) => ({ userAId, userBId })),
    } });
    if (rows.length !== batch.length) throw new HttpError(409, "The pair dataset changed while preparing training.");
    const vectors = await env.PAIR_INDEX.getByIds(rows.map((row) => row.vectorId));
    const byId = new Map(vectors.map((vector) => [vector.id, vector.values]));
    const byMembers = new Map(rows.map((row) => [`${row.userAId}:${row.userBId}`, row.vectorId]));
    for (const pair of batch) {
      const vectorId = byMembers.get(`${pair.userAId}:${pair.userBId}`);
      const values = typeof vectorId == 'undefined' ? undefined : byId.get(vectorId);
      if (typeof values != 'undefined') pair.features = decodePairVectorizeValues(values);
    }
  }
  const toSample = (pair: typeof pairs[number]) => {
    const features = readPairFeatures(pair.features);
    const evaluation = evaluatePair(features);
    return { features, target: evaluation.score, eligible: evaluation.eligible, userAId: pair.userAId, userBId: pair.userBId };
  };
  return { training: training.map(toSample), validation: validation.map(toSample), ids, excludedCount: split.excludedCount };
}

export class TrainingWorkflow extends WorkflowEntrypoint<Env, { jobId: string }> {
  async run(event: WorkflowEvent<{ jobId: string }>, step: WorkflowStep) {
    const db = database(this.env);
    const jobId = event.payload.jobId;
    try {
      const job = await step.do("load training parameters", async () => {
        const row = await db.trainingJob.findUniqueOrThrow({ where: { id: jobId } });
        return { options: trainingOptionsSchema.parse(row.options), revision: row.revision, generation: row.generation };
      });
      const learningRates = job.options.compareLearningRates ? [...new Set([COMPARISON_LEARNING_RATE, job.options.learningRate])] : [job.options.learningRate];
      const saved: { id: string; artifact: RankerArtifact }[] = [];
      for (const [index, learningRate] of learningRates.entries()) {
        const iteration = index + FIRST_ITERATION;
        const result = await step.do(`train model ${iteration}`, { timeout: TRAINING_STEP_TIMEOUT, retries: { limit: 0, delay: "1 second" } }, async () => {
          const existing = await db.trainedModel.findUnique({ where: { jobId_iteration: { jobId, iteration } } });
          if (existing) return { id: existing.id, artifact: modelPayload(existing).artifact };
          const context = await cohort(db);
          if (context.revision !== job.revision || context.generation !== job.generation) throw new HttpError(409, "The cohort changed during training. Please start a new training run.");
          await synchronizeStudentVectors(this.env, context);
          const dataset = await samplesForTraining(this.env, context);
          await prepareTrainingBackend();
          const lossHistory: { epoch: number; loss: number }[] = [];
          let lastBatchProgress: Record<string, number> | undefined;
          const trained = await trainPairRanker(dataset.training, context.contextVersion, {
            learningRate, epochs: job.options.epochs, batchSize: job.options.batchSize, validationSamples: dataset.validation,
            onBatch: async ({ epoch, batch, totalBatches, processedSamples, sampleCount, loss, tensorBytes, numTensors }) => {
              lastBatchProgress = { batch, totalBatches, processedSamples, sampleCount, tensorBytes, numTensors };
              if (batch !== FIRST_ITERATION && batch !== totalBatches && batch % BATCH_PROGRESS_INTERVAL !== 0) return;
              const result = await this.env.DB.prepare(`UPDATE TrainingJob SET message = ?, epoch = ?, iteration = ?, iterationCount = ?, learningRate = ?, loss = ?, options = json_set(options, '$.batchProgress', json(?))
                WHERE id = ? AND status = 'running' AND EXISTS (SELECT 1 FROM AppState WHERE id = ? AND revision = ? AND vectorGeneration = ?)`)
                .bind(`Training ${iteration}/${learningRates.length} · iteration ${epoch + FIRST_ITERATION}/${job.options.epochs} · batch ${batch}/${totalBatches}`,
                  epoch, iteration, learningRates.length, learningRate, loss, JSON.stringify(lastBatchProgress), jobId, APP_STATE_ID, job.revision, job.generation).run();
              if (!result.meta.changes) throw new HttpError(409, "The cohort changed or training was stopped.");
            },
            onEpoch: async (epoch, loss) => {
              const displayed = epoch + FIRST_ITERATION;
              lossHistory.push({ epoch: displayed, loss });
              await db.trainingJob.update({ where: { id: jobId }, data: {
                message: `Training ${iteration}/${learningRates.length} · iteration ${displayed}/${job.options.epochs}`,
                epoch: displayed, iteration, iterationCount: learningRates.length, learningRate, loss,
                options: { ...job.options, batchProgress: { ...lastBatchProgress, batch: 0 } },
              } });
            },
          });
          try {
            const artifact = await serializeRanker(trained.model, trained.metadata);
            const payload = parseModelPayload(artifact, {
              modelId: artifact.metadata.modelId, labelSource: artifact.metadata.labelSource, validationStrategy: "student-disjoint",
              architecture: [PAIR_RANKER_INPUT_COUNT, ...artifact.modelTopology.config.layers.map((layer) => layer.config.units)],
              epochs: job.options.epochs, batchSize: job.options.batchSize, trainingStudents: dataset.ids.trainingIds.size, validationStudents: dataset.ids.validationIds.size,
              trainingPairs: dataset.training.length, validationPairs: dataset.validation.length, excludedCrossGroupPairs: dataset.excludedCount,
              comparisons: [artifact.metadata], lossHistory,
            });
            const row = await db.trainedModel.create({ data: {
              id: crypto.randomUUID(), modelId: artifact.metadata.modelId, kind: ACTIVE_MODEL_KIND, activeKey: null,
              artifact: JSON.parse(JSON.stringify(payload.artifact)), trainingReport: JSON.parse(JSON.stringify(payload.trainingReport)), jobId, iteration,
            } });
            return { id: row.id, artifact };
          } finally { trained.model.dispose(); }
        });
        saved.push(result);
      }
      await step.do("activate model and complete report", async () => {
        const selected = saved.find((model) => model.artifact.metadata.learningRate === job.options.learningRate);
        if (typeof selected == 'undefined') throw new Error("Selected model missing.");
        const comparisons = saved.map((model) => model.artifact.metadata);
        for (const model of saved) {
          const row = await db.trainedModel.findUniqueOrThrow({ where: { id: model.id } });
          const payload = parseModelPayload(row.artifact, row.trainingReport);
          const report = payload.trainingReport;
          if (!report) throw new Error("Training report missing.");
          const updated = parseModelPayload(payload.artifact, { ...report, comparisons });
          await db.trainedModel.update({ where: { id: model.id }, data: { trainingReport: JSON.parse(JSON.stringify(updated.trainingReport)) } });
        }
        if (!isCompatible(selected.artifact)) throw new HttpError(409, "The model did not meet the validation error threshold. Training runs were saved without activation.");
        const now = new Date().toISOString();
        const results = await this.env.DB.batch([
          this.env.DB.prepare(`UPDATE TrainedModels SET activeKey = NULL, updatedAt = ? WHERE activeKey = ? AND EXISTS (SELECT 1 FROM AppState WHERE id = ? AND revision = ? AND vectorGeneration = ?)`)
            .bind(now, ACTIVE_MODEL_KIND, APP_STATE_ID, job.revision, job.generation),
          this.env.DB.prepare(`UPDATE TrainedModels SET activeKey = ?, updatedAt = ? WHERE id = ? AND EXISTS (SELECT 1 FROM AppState WHERE id = ? AND revision = ? AND vectorGeneration = ?)`)
            .bind(ACTIVE_MODEL_KIND, now, selected.id, APP_STATE_ID, job.revision, job.generation),
        ]);
        if (!results[1]?.meta.changes) throw new HttpError(409, "The cohort changed during training. Models were saved without activation.");
        await db.trainingJob.update({ where: { id: jobId }, data: {
          activeKey: null, status: "completed", message: "Model trained and activated.", finishedAt: new Date(),
        } });
      });
    } catch (error) {
      console.error(JSON.stringify({ event: "training-failed", jobId, message: error instanceof Error ? error.message : String(error) }));
      await db.trainingJob.update({ where: { id: jobId }, data: {
        activeKey: null, status: "failed", message: error instanceof HttpError ? error.message : error instanceof Error && error.message.includes("CPU time limit") ? "Training exceeded the Worker CPU limit." : "Training failed. Check the training parameters and try again.", finishedAt: new Date(),
      } });
      throw error;
    }
  }
}

import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { z } from "zod";
import { contextFromUsers, pairFeatures } from "../src/cohortEncoding.ts";
import { splitStudentIds, splitPairsByStudent } from "../src/utils/studentSplit.ts";
import { evaluatePair } from "../src/pairPolicy.ts";
import { prepareTrainingBackend, trainPairRanker, serializeRanker, type RankerArtifact } from "../src/rankerEngine.ts";
import { parseModelPayload } from "../src/validators/trainedModels.ts";
import { trainingOptionsSchema } from "../src/trainingOptions.ts";
import { PAIR_RANKER_KIND, PAIR_RANKER_INPUT_COUNT, MAX_VALIDATION_MAE } from "../src/modelConfig.ts";

const ANCHORS_PER_GROUP = 2;
const MIN_PARTITION_PAIRS = 200;
const MAX_TRAINING_PAIRS = 3000;
const MAX_VALIDATION_PAIRS = 1000;
const PROGRESS_ITERATION_INTERVAL = 10;
const FIRST_ITERATION = 1;
const COMPARISON_LEARNING_RATE = 0.01;
const LOSS_DISPLAY_DIGITS = 6;
const PACKAGE_ROOT = fileURLToPath(new URL("../", import.meta.url));
const { values } = parseArgs({ args: process.argv.slice(2), options: {
  "job-id": { type: "string" },
  "learning-rate": { type: "string" }, "batch-size": { type: "string" }, epochs: { type: "string" },
  "compare-learning-rates": { type: "boolean", default: false },
  local: { type: "boolean", default: false },
} });
const options = trainingOptionsSchema.parse({ learningRate: values["learning-rate"], epochs: values.epochs, batchSize: values["batch-size"], compareLearningRates: values["compare-learning-rates"] });
const target = values.local ? "--local" : "--remote";
const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
let jobId: string | undefined;
let completed = false;
let interrupted = false;
process.once("SIGINT", () => { interrupted = true; });
process.once("SIGTERM", () => { interrupted = true; });

// SQL goes through Wrangler's authenticated D1 API, outside the Worker CPU budget.
async function execute(sql: string) {
  const process = Bun.spawn(["node", "node_modules/wrangler/bin/wrangler.js", "d1", "execute", "vestibulandos", target, "--command", sql, "--json"], {
    cwd: PACKAGE_ROOT, stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited]);
  if (code !== 0) throw new Error(`D1 operation failed: ${stderr.trim() || "check Wrangler authentication and migrations"}`);
  const responses = z.array(z.object({ results: z.array(z.record(z.string(), z.unknown())).default([]), success: z.boolean().optional() })).parse(JSON.parse(stdout));
  if (responses.some((response) => response.success === false)) throw new Error("D1 rejected the operation.");
  return responses.flatMap((response) => response.results);
}

try {
  console.log(`Training locally; models and reports will be saved to ${values.local ? "local" : "production"} D1.`);
  // Refuse to start before the atomic activation migration has been installed.
  const migrations = await execute("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name = 'activate_external_training';");
  if (!migrations.length) throw new Error("Run the D1 migrations first (db:migrate:remote, or db:migrate:local with --local).");
  // A single SELECT captures students and revision from the same database snapshot.
  const [snapshot] = await execute(`SELECT revision, vectorGeneration, (SELECT json_group_array(json_object('id', id, 'score', score, 'income', income, 'disability', disability)) FROM Users) AS users FROM AppState WHERE id = 'main';`);
  const parsed = z.object({ revision: z.number().int(), vectorGeneration: z.number().int(), users: z.string().transform((value) => JSON.parse(value)).pipe(z.array(z.object({
    id: z.uuid(), score: z.number().int().min(0).max(100), income: z.string(), disability: z.union([z.literal(0), z.literal(1)]).transform(Boolean),
  }))) }).parse(snapshot);
  const context = contextFromUsers(parsed.users, parsed.revision, parsed.vectorGeneration);
  const ids = splitStudentIds(context.students.map((student) => student.userId));
  const byId = new Map(context.students.map((student) => [student.userId, student]));
  const pairs = new Map<string, { userAId: string; userBId: string; features: ReturnType<typeof pairFeatures>; key: string }>();
  for (const group of [ids.trainingIds, ids.validationIds]) {
    for (const anchorId of [...group].slice(0, ANCHORS_PER_GROUP)) {
      const anchor = byId.get(anchorId);
      if (typeof anchor == 'undefined') throw new Error("Training anchor missing.");
      for (const partnerId of group) {
        if (partnerId === anchorId) continue;
        const partner = byId.get(partnerId);
        if (typeof partner == 'undefined') throw new Error("Training partner missing.");
        const [userAId, userBId] = [anchorId, partnerId].sort();
        if (typeof userAId == 'undefined' || typeof userBId == 'undefined') throw new Error("Pair members missing.");
        const members = `${userAId}:${userBId}`;
        pairs.set(members, { userAId, userBId, features: pairFeatures(anchor, partner, context.cohortMeanScore), key: createHash("sha256").update(members).digest("hex") });
      }
    }
  }
  const split = splitPairsByStudent([...pairs.values()].sort((a, b) => a.key.localeCompare(b.key)), ids);
  const makeSamples = (rows: typeof split.training) => rows.map((row) => ({ ...row, target: evaluatePair(row.features).score, eligible: evaluatePair(row.features).eligible }));
  const training = makeSamples(split.training.slice(0, MAX_TRAINING_PAIRS));
  const validation = makeSamples(split.validation.slice(0, MAX_VALIDATION_PAIRS));
  if (training.length < MIN_PARTITION_PAIRS || validation.length < MIN_PARTITION_PAIRS) throw new Error("Not enough pairs for student-disjoint validation.");
  console.log(`${ids.trainingIds.size} training students / ${ids.validationIds.size} validation students; ${training.length} training pairs / ${validation.length} validation pairs.`);
  const learningRates = options.compareLearningRates ? [...new Set([COMPARISON_LEARNING_RATE, options.learningRate])] : [options.learningRate];
  const requestedJobId = typeof values["job-id"] == 'undefined' ? undefined : z.uuid().parse(values["job-id"]);
  const candidateJobId = requestedJobId ?? crypto.randomUUID();
  const startedAt = new Date().toISOString();
  // An endpoint-created job is claimed once; replaying its ID cannot start another trainer.
  const created = typeof requestedJobId == 'undefined' ? await execute(`INSERT INTO TrainingJob (id, activeKey, status, message, options, revision, generation, totalEpochs, learningRate, iterationCount, startedAt)
    SELECT ${quote(candidateJobId)}, 'training', 'running', 'Training in Bun outside Cloudflare…', ${quote(JSON.stringify({ ...options, executor: "external", lastHeartbeat: Date.now() }))}, revision, vectorGeneration, ${options.epochs}, ${options.learningRate}, ${learningRates.length}, ${quote(startedAt)}
    FROM AppState WHERE id = 'main' AND revision = ${context.revision} AND vectorGeneration = ${context.generation} RETURNING id;`) : await execute(`
    UPDATE TrainingJob SET iterationCount = ${learningRates.length}, options = json_set(options, '$.externalClaim', ${quote(crypto.randomUUID())}, '$.lastHeartbeat', ${Date.now()})
    WHERE id = ${quote(requestedJobId)} AND status = 'running' AND activeKey = 'training'
      AND revision = ${context.revision} AND generation = ${context.generation}
      AND json_extract(options, '$.executor') = 'external' AND json_extract(options, '$.externalClaim') IS NULL
      AND totalEpochs = ${options.epochs} AND learningRate = ${options.learningRate}
      AND json_extract(options, '$.compareLearningRates') = ${options.compareLearningRates ? 1 : 0}
    RETURNING id;`);
  if (!created.length) throw new Error("The cohort changed. Start again.");
  jobId = candidateJobId;
  await prepareTrainingBackend();
  const iterations: { artifact: RankerArtifact; lossHistory: { epoch: number; loss: number }[] }[] = [];
  for (const [index, learningRate] of learningRates.entries()) {
    const iteration = index + FIRST_ITERATION;
    const lossHistory: { epoch: number; loss: number }[] = [];
    const trained = await trainPairRanker(training, context.contextVersion, {
      learningRate, epochs: options.epochs, batchSize: options.batchSize, validationSamples: validation,
      onEpoch: async (epoch, loss) => {
        if (interrupted) throw new Error("External training interrupted.");
        const displayed = epoch + FIRST_ITERATION;
        lossHistory.push({ epoch: displayed, loss });
        if (displayed === FIRST_ITERATION || displayed % PROGRESS_ITERATION_INTERVAL === 0 || displayed === options.epochs) {
          console.log(`Run ${iteration}/${learningRates.length}, iteration ${displayed}/${options.epochs}: loss ${loss.toFixed(LOSS_DISPLAY_DIGITS)}`);
          const progress = await execute(`UPDATE TrainingJob SET message = ${quote(`Training ${iteration}/${learningRates.length} · iteration ${displayed}/${options.epochs}`)}, epoch = ${displayed}, iteration = ${iteration}, learningRate = ${learningRate}, loss = ${loss}, options = json_set(options, '$.lastHeartbeat', ${Date.now()})
            WHERE id = ${quote(candidateJobId)} AND status = 'running' AND EXISTS (SELECT 1 FROM AppState WHERE id = 'main' AND revision = ${context.revision} AND vectorGeneration = ${context.generation}) RETURNING id;`);
          if (!progress.length) throw new Error("The cohort changed or this run was stopped. Start again.");
        }
      },
    });
    try { iterations.push({ artifact: await serializeRanker(trained.model, trained.metadata), lossHistory }); }
    finally { trained.model.dispose(); }
  }
  const comparisons = iterations.map((iteration) => iteration.artifact.metadata);
  for (const [index, iteration] of iterations.entries()) {
    const metadata = iteration.artifact.metadata;
    const payload = parseModelPayload(iteration.artifact, {
      modelId: metadata.modelId, labelSource: metadata.labelSource, validationStrategy: "student-disjoint",
      architecture: [PAIR_RANKER_INPUT_COUNT, ...iteration.artifact.modelTopology.config.layers.map((layer) => layer.config.units)],
      epochs: metadata.epochs, batchSize: options.batchSize, trainingStudents: ids.trainingIds.size, validationStudents: ids.validationIds.size,
      trainingPairs: training.length, validationPairs: validation.length, excludedCrossGroupPairs: split.excludedCount,
      comparisons, lossHistory: iteration.lossHistory,
    });
    const now = new Date().toISOString();
    await execute(`INSERT INTO TrainedModels (id, modelId, kind, artifact, trainingReport, activeKey, jobId, iteration, createdAt, updatedAt)
      VALUES (${quote(crypto.randomUUID())}, ${quote(metadata.modelId)}, ${quote(PAIR_RANKER_KIND)}, ${quote(JSON.stringify(payload.artifact))}, ${quote(JSON.stringify(payload.trainingReport))}, NULL, ${quote(candidateJobId)}, ${index + FIRST_ITERATION}, ${quote(now)}, ${quote(now)}) ON CONFLICT(jobId, iteration) DO NOTHING;`);
  }
  const selectedIndex = iterations.findIndex((iteration) => iteration.artifact.metadata.learningRate === options.learningRate);
  const selected = iterations[selectedIndex];
  if (typeof selected == 'undefined') throw new Error("Selected model missing.");
  if (selected.artifact.metadata.validationMeanAbsoluteError > MAX_VALIDATION_MAE || (selected.artifact.metadata.eligibleValidationMeanAbsoluteError ?? 0) > MAX_VALIDATION_MAE) {
    throw new Error("Model failed validation. Reports were saved; the previous active model is preserved.");
  }
  // The database trigger checks the snapshot and atomically switches the active model.
  const activation = await execute(`UPDATE TrainingJob SET iteration = ${selectedIndex + FIRST_ITERATION}, status = 'completed', activeKey = NULL, message = 'Model trained externally and activated.', finishedAt = ${quote(new Date().toISOString())} WHERE id = ${quote(candidateJobId)} AND status = 'running' RETURNING id;`);
  if (!activation.length) throw new Error("Training run is no longer active.");
  completed = true;
  console.log(`Activated ${selected.artifact.metadata.modelId} in D1. Refresh the frontend to see the report.`);
} catch (error) {
  if (typeof jobId != 'undefined' && !completed) {
    const message = error instanceof Error ? error.message : String(error);
    await execute(`UPDATE TrainingJob SET status = 'failed', activeKey = NULL, message = ${quote(message)}, finishedAt = ${quote(new Date().toISOString())} WHERE id = ${quote(jobId)} AND status = 'running';`).catch(() => console.error("Could not release the training lock. Check TrainingJob in D1."));
  }
  throw error;
}

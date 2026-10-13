import { createHash } from "node:crypto";
import { parseArgs } from "node:util";
import { connectDatabase, db } from "../db/db.ts";
import { getPairVectorsForContext } from "../db/pairVectors.ts";
import { activateTrainedModel, saveTrainedModel } from "../db/trainedModels.ts";
import { createContext } from "../src/vectors.ts";
import { evaluatePair, readPairFeatures } from "../src/pairPolicy.ts";
import { recommendPartners } from "../src/matchmaking.ts";
import { PAIR_RANKER_INPUT_COUNT } from "../src/modelConfig.ts";
import { splitPairsByStudent, splitStudentIds } from "../src/utils/studentSplit.ts";
import { MAX_VALIDATION_MAE, serializeRanker, trainPairRanker, type RankerArtifact } from "../src/pairRanker.ts";
import { reportTrainingProgress } from "../src/trainingProgress.ts";
import { trainingOptionsSchema } from "../src/trainingOptions.ts";

const MIN_PARTITION_PAIRS = 200;
const POPULATION_ANCHORS_PER_GROUP = 2;
const COMPARISON_LEARNING_RATE = 0.01;
const PROGRESS_EPOCH_INTERVAL = 10;
const DISPLAY_EPOCH_OFFSET = 1;
const LOSS_DISPLAY_DIGITS = 6;
const { values } = parseArgs({ args: process.argv.slice(2), options: {
  "learning-rate": { type: "string" }, epochs: { type: "string" },
  "compare-learning-rates": { type: "boolean", default: false },
} });
const options = trainingOptionsSchema.parse({ learningRate: values["learning-rate"], epochs: values.epochs, compareLearningRates: values["compare-learning-rates"] });
const compareLearningRates = options.compareLearningRates;
const learningRates = compareLearningRates
  ? [...new Set([COMPARISON_LEARNING_RATE, options.learningRate])]
  : [options.learningRate];

await connectDatabase();
let context: Awaited<ReturnType<typeof createContext>> | undefined;
try {
  reportTrainingProgress({ message: "Preparing pair vectors…" });
  context = await createContext();
  const ids = splitStudentIds(context.students.map((student) => student.userId));
  let rows = await getPairVectorsForContext(context.contextVersion);
  let split = splitPairsByStudent(rows, ids);
  if (split.training.length < MIN_PARTITION_PAIRS || split.validation.length < MIN_PARTITION_PAIRS) {
    // Cada grupo precisa de duplas internas; duplas entre grupos não entram no treino.
    for (const group of [ids.trainingIds, ids.validationIds]) {
      for (const id of [...group].slice(0, POPULATION_ANCHORS_PER_GROUP)) await recommendPartners(id);
    }
    rows = await getPairVectorsForContext(context.contextVersion);
    split = splitPairsByStudent(rows, ids);
  }
  if (split.training.length < MIN_PARTITION_PAIRS || split.validation.length < MIN_PARTITION_PAIRS) {
    throw new Error("Duplas insuficientes para validação com alunos separados; amplie a turma ou gere mais vetores.");
  }
  const makeSamples = (pairs: typeof rows) => pairs.map((row) => {
    const features = readPairFeatures(Array.from(row.vector));
    const evaluation = evaluatePair(features);
    const key = createHash("sha256").update(`${row.userAId}:${row.userBId}`).digest("hex");
    return { key, features, target: evaluation.score, eligible: evaluation.eligible, userAId: row.userAId, userBId: row.userBId };
  }).sort((a, b) => a.key.localeCompare(b.key));
  const training = makeSamples(split.training);
  const validation = makeSamples(split.validation);
  console.log(`Students: ${ids.trainingIds.size} treino / ${ids.validationIds.size} validação, sem sobreposição.`);
  console.log(`Duplas: ${training.length} treino / ${validation.length} validação / ${split.excludedCount} cruzadas excluídas. Rótulos: política atual.`);
  const iterations: { artifact: RankerArtifact; lossHistory: { epoch: number; loss: number }[] }[] = [];
  for (const [iterationIndex, learningRate] of learningRates.entries()) {
    const progressContext = { totalEpochs: options.epochs, iteration: iterationIndex + DISPLAY_EPOCH_OFFSET, iterationCount: learningRates.length };
    reportTrainingProgress({ message: `Training with learning rate ${learningRate}…`, learningRate, epoch: 0, ...progressContext });
    const lossHistory: { epoch: number; loss: number }[] = [];
    const trained = await trainPairRanker(training, context.contextVersion, {
      learningRate, epochs: options.epochs, validationSamples: validation,
      onEpoch: (epoch, loss) => {
        const displayedEpoch = epoch + DISPLAY_EPOCH_OFFSET;
        lossHistory.push({ epoch: displayedEpoch, loss });
        reportTrainingProgress({ message: `Training ${progressContext.iteration}/${progressContext.iterationCount} · iteration ${displayedEpoch}/${options.epochs}`, epoch: displayedEpoch, learningRate, loss, ...progressContext });
        if (displayedEpoch % PROGRESS_EPOCH_INTERVAL === 0) {
          console.log(`LR ${learningRate}, iteração ${displayedEpoch}: MSE ${loss.toFixed(LOSS_DISPLAY_DIGITS)}`);
        }
      },
    });
    try { iterations.push({ artifact: await serializeRanker(trained.model, trained.metadata), lossHistory }); }
    finally { trained.model.dispose(); }
  }
  const comparisons = iterations.map((iteration) => iteration.artifact.metadata);
  reportTrainingProgress({ message: "Saving models and training reports…" });
  const savedIterations = [];
  for (const iteration of iterations) {
    const metadata = iteration.artifact.metadata;
    const saved = await saveTrainedModel(iteration.artifact, { trainingReport: {
      modelId: metadata.modelId, labelSource: metadata.labelSource, validationStrategy: "student-disjoint",
      architecture: [PAIR_RANKER_INPUT_COUNT, ...iteration.artifact.modelTopology.config.layers.map((layer) => layer.config.units)],
      epochs: metadata.epochs, trainingStudents: ids.trainingIds.size, validationStudents: ids.validationIds.size,
      trainingPairs: training.length, validationPairs: validation.length, excludedCrossGroupPairs: split.excludedCount,
      comparisons, lossHistory: iteration.lossHistory,
    } });
    savedIterations.push(saved);
    console.log(JSON.stringify({ iterationId: saved.id, ...metadata }, null, 2));
  }
  const selected = savedIterations.find((row) => row.artifact.metadata.learningRate === options.learningRate);
  if (typeof selected == 'undefined') throw new Error("Iteração selecionada não encontrada");
  if (selected.artifact.metadata.validationMeanAbsoluteError > MAX_VALIDATION_MAE ||
    (selected.artifact.metadata.eligibleValidationMeanAbsoluteError ?? 0) > MAX_VALIDATION_MAE) {
    throw new Error("Modelo reprovado; as iterações foram salvas para consulta, mantendo o modelo ativo anterior.");
  }
  const current = await createContext();
  try {
    if (current.contextVersion !== context.contextVersion) throw new Error("A turma mudou durante o treinamento; iterações salvas sem ativação.");
  } finally { current.studentVectors.dispose(); }
  const active = await activateTrainedModel(selected.id);
  console.log(`Active model no Postgres: ${active.modelId} (iteração ${active.id})`);
  if (compareLearningRates) {
    console.log("Comparação com os mesmos alunos, duplas, arquitetura e iterações:");
    console.log(JSON.stringify(comparisons, null, 2));
  }
} finally {
  context?.studentVectors.dispose();
  await db.close();
}

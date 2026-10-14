import { prepareTrainingBackend, trainPairRanker, serializeRanker } from "../rankerEngine.ts";
import { trainingOptionsSchema } from "../trainingOptions.ts";
import { browserDataset, type BrowserContext } from "./browserDataset.ts";

const COMPARISON_LEARNING_RATE = 0.01;
let running = false;
self.onmessage = async (event: MessageEvent<{ context: BrowserContext; options: unknown }>) => {
  if (running) return;
  running = true;
  try {
    const options = trainingOptionsSchema.parse(event.data.options);
    const dataset = await browserDataset(event.data.context);
    const rates = options.compareLearningRates ? [...new Set([COMPARISON_LEARNING_RATE, options.learningRate])] : [options.learningRate];
    await prepareTrainingBackend();
    for (const [index, learningRate] of rates.entries()) {
      const lossHistory: { epoch: number; loss: number }[] = [];
      const model = await trainPairRanker(dataset.training, event.data.context.contextVersion, {
        ...options, learningRate, validationSamples: dataset.validation,
        onBatch: (progress) => self.postMessage({ type: "progress", progress: {
          ...progress, iteration: index + 1, iterationCount: rates.length, totalEpochs: options.epochs, learningRate,
          message: "Training in your browser. Keep this page open.",
        } }),
        onEpoch: (epoch, loss) => { lossHistory.push({ epoch: epoch + 1, loss }); },
      });
      try {
        const artifact = await serializeRanker(model.model, model.metadata);
        self.postMessage({ type: "model", iteration: index + 1, artifact, report: {
          modelId: artifact.metadata.modelId, labelSource: "policy-generated", validationStrategy: "student-disjoint",
          architecture: [4, 128, 64, 32, 1], epochs: options.epochs, batchSize: options.batchSize,
          trainingStudents: dataset.trainingStudents, validationStudents: dataset.validationStudents,
          trainingPairs: dataset.training.length, validationPairs: dataset.validation.length,
          excludedCrossGroupPairs: 0, comparisons: [artifact.metadata], lossHistory,
        } });
      } finally { model.model.dispose(); }
    }
    self.postMessage({ type: "complete", selectedIteration: rates.indexOf(options.learningRate) + 1 });
  } catch (error) {
    self.postMessage({ type: "failed", message: error instanceof Error ? error.message : "Browser training failed." });
  } finally { running = false; }
};

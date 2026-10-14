import { deserializeRanker, predictPairScores, prepareTrainingBackend } from "../rankerEngine.ts";
import { type PairFeatures } from "../pairPolicy.ts";

const INFERENCE_BATCH_SIZE = 64;
type Candidate = { features: PairFeatures; score: number; partner: { id: string }; [key: string]: unknown };
let loaded: Awaited<ReturnType<typeof deserializeRanker>> | undefined;
let backendReady = false;
let queue = Promise.resolve();
async function rank(event: MessageEvent<{ artifact: unknown; candidates: Candidate[]; limit: number }>) {
  try {
    if (!backendReady) { await prepareTrainingBackend(); backendReady = true; }
    const metadata = (event.data.artifact as { metadata?: { modelId?: string } }).metadata;
    if (!loaded || loaded.metadata.modelId !== metadata?.modelId) {
      loaded?.model.dispose();
      loaded = undefined;
      loaded = await deserializeRanker(event.data.artifact);
    }
    {
      const ranked: Candidate[] = [];
      for (let offset = 0; offset < event.data.candidates.length; offset += INFERENCE_BATCH_SIZE) {
        const batch = event.data.candidates.slice(offset, offset + INFERENCE_BATCH_SIZE);
        const scores = predictPairScores(loaded.model, batch.map((candidate) => candidate.features));
        batch.forEach((candidate, index) => {
          const score = scores[index];
          if (typeof score == 'undefined') throw new Error("Missing recommendation score.");
          ranked.push({ ...candidate, policyScore: candidate.score, score });
        });
      }
      ranked.sort((a, b) => b.score - a.score || a.partner.id.localeCompare(b.partner.id));
      self.postMessage({ recommendations: ranked.slice(0, event.data.limit) });
    }
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : "Recommendation inference failed." });
  }
};


// Serialize asynchronous initialization and model replacement.
self.onmessage = (event) => {
  queue = queue.then(() => rank(event));
};

import { createServer, type IncomingMessage } from "node:http";
import { readFile } from "node:fs/promises";

import { connectDatabase, db } from "../db/db.ts";
import { createUser, deleteUser, getUserById, listUsers, updateUser } from "../db/users.ts";
import { userCreationSchema } from "../db/validators/schema.ts";
import { parseId, type UserId } from "./utils/idParser.ts";
import { recommendPartners, StudentNotFoundError } from "./matchmaking.ts";
import { clearRankerCache, rankWithTrainedModel } from "./pairRanker.ts";
import { z, ZodError } from "zod";
import { getTrainedModelById, getTrainedModels, TrainedModelRequiredError, type TrainedModel } from "../db/trainedModels.ts";
import { PAIR_RANKER_INPUT_COUNT } from "./modelConfig.ts";
import { completePairOutcome, completePairSchema, listPairOutcomes, PairOutcomeConflictError, PairOutcomeNotFoundError, startPairOutcome, startPairSchema } from "../db/pairOutcomes.ts";
import { clearTrainingData, getTrainingStatus, startTraining, TrainingBusyError } from "./trainingService.ts";
import { PUBLIC_DIRECTORY } from "./runtimePaths.ts";
import { trainingOptionsSchema } from "./trainingOptions.ts";

const MAX_REQUEST_BYTES = 16_384;
const TRAINING_HISTORY_LIMIT = 100;
const SERVER_SHUTDOWN_TIMEOUT_MS = 4000;
function trainingIteration(row: TrainedModel) {
  return {
    id: row.id, modelId: row.modelId, kind: row.kind, active: row.activeKey !== null,
    createdAt: row.createdAt, updatedAt: row.updatedAt, metadata: row.artifact.metadata,
    architecture: [PAIR_RANKER_INPUT_COUNT, ...row.artifact.modelTopology.config.layers.map((layer) => layer.config.units)],
    trainingReport: row.trainingReport,
  };
}
class RequestBodyError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}
async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > MAX_REQUEST_BYTES) throw new RequestBodyError("Request body exceeds the allowed size.", 413);
    chunks.push(buffer);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new RequestBodyError("Send valid JSON.", 400); }
}

const port = Number(process.env.PORT ?? 3000);
const RECOMMENDATION_LIMIT = 5;
const HTTP_STATUS = { ok: 200, badRequest: 400, notFound: 404, methodNotAllowed: 405, internalError: 500 } as const;

const assets = new Map<string, readonly [string, string]>([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/index.html", ["index.html", "text/html; charset=utf-8"]],
  ["/styles.css", ["styles.css", "text/css; charset=utf-8"]],
  ["/training", ["training.html", "text/html; charset=utf-8"]],
  ["/training.html", ["training.html", "text/html; charset=utf-8"]],
  ["/training.js", ["training.js", "text/javascript; charset=utf-8"]],
  ["/trainingControls.js", ["trainingControls.js", "text/javascript; charset=utf-8"]],
  ["/outcomes.js", ["outcomes.js", "text/javascript; charset=utf-8"]],
  ["/i18n.js", ["i18n.js", "text/javascript; charset=utf-8"]],
  ["/locales/en-US.json", ["locales/en-US.json", "application/json; charset=utf-8"]],
  ["/locales/pt-BR.json", ["locales/pt-BR.json", "application/json; charset=utf-8"]],
  ["/locales/source.json", ["locales/source.json", "application/json; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
]);

export const server = createServer(async (request, response) => {
  const json = (status: number, body: unknown) => {
    response.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    });
    response.end(JSON.stringify(body));
  };

  try {
    const url = new URL(request.url ?? "/", "http://localhost");
    const pathname = url.pathname;
    if (pathname === "/api/training") {
      if (request.method === "GET") {
        const inference = await rankWithTrainedModel([]);
        json(HTTP_STATUS.ok, { training: getTrainingStatus(), modelReady: inference !== null, modelId: inference?.metadata.modelId ?? null });
      } else if (request.method === "POST") {
        const compareLearningRates = z.enum(["true", "false"]).default("false")
          .parse(url.searchParams.get("compareLearningRates") ?? undefined) === "true";
        const options = trainingOptionsSchema.parse({
          compareLearningRates,
          learningRate: url.searchParams.get("learningRate") ?? undefined,
          epochs: url.searchParams.get("epochs") ?? undefined,
          batchSize: url.searchParams.get("batchSize") ?? undefined,
        });
        json(202, { training: startTraining(options) });
      } else if (request.method === "DELETE") {
        json(HTTP_STATUS.ok, await clearTrainingData());
      } else {
        response.setHeader("allow", "GET, POST, DELETE");
        json(HTTP_STATUS.methodNotAllowed, { error: "Use GET, POST ou DELETE." });
      }
      return;
    }
    if (pathname === "/api/trained-models") {
      if (request.method !== "GET") {
        response.setHeader("allow", "GET");
        json(HTTP_STATUS.methodNotAllowed, { error: "Use GET to list training runs." });
        return;
      }
      const models = await getTrainedModels(TRAINING_HISTORY_LIMIT, { fresh: true });
      json(HTTP_STATUS.ok, { iterations: models.map(trainingIteration) });
      return;
    }
    const trainedModelMatch = /^\/api\/trained-models\/([^/]+)$/.exec(pathname);
    if (trainedModelMatch) {
      if (request.method !== "GET") {
        response.setHeader("allow", "GET");
        json(HTTP_STATUS.methodNotAllowed, { error: "Use GET to view a training run." });
        return;
      }
      const id = trainedModelMatch[1];
      if (typeof id == 'undefined') throw new RequestBodyError("Invalid ID.", HTTP_STATUS.badRequest);
      const model = await getTrainedModelById(id);
      if (!model) { json(HTTP_STATUS.notFound, { error: "Training run not found." }); return; }
      json(HTTP_STATUS.ok, { iteration: trainingIteration(model) });
      return;
    }
    if (pathname === "/api/pair-outcomes") {
      if (request.method === "GET") {
        json(HTTP_STATUS.ok, { outcomes: await listPairOutcomes(url.searchParams.get("userId") ?? "") });
        return;
      }
      if (request.method === "POST") {
        const input = startPairSchema.parse(await readJson(request));
        const result = await startPairOutcome(input);
        json(result.created ? 201 : HTTP_STATUS.ok, result);
        return;
      }
      response.setHeader("allow", "GET, POST");
      json(HTTP_STATUS.methodNotAllowed, { error: "Use GET or POST." });
      return;
    }
    const outcomeMatch = /^\/api\/pair-outcomes\/([^/]+)$/.exec(pathname);
    if (outcomeMatch) {
      if (request.method !== "PATCH") {
        response.setHeader("allow", "PATCH");
        json(HTTP_STATUS.methodNotAllowed, { error: "Use PATCH to record outcomes." });
        return;
      }
      const id = outcomeMatch[1];
      if (typeof id == 'undefined') throw new RequestBodyError("Invalid ID.", HTTP_STATUS.badRequest);
      const input = completePairSchema.parse(await readJson(request));
      json(HTTP_STATUS.ok, { outcome: await completePairOutcome(id, input) });
      return;
    }
    if (pathname === "/api/matchmaking/model" && request.method === "GET") {
      const inference = await rankWithTrainedModel([]);
      json(HTTP_STATUS.ok, {
        rankingSource: inference ? "trained-policy-model" : "policy",
        model: inference?.metadata ?? null,
      });
      return;
    }
    const recommendationMatch = /^\/api\/users\/([^/]+)\/recommendations$/.exec(pathname);
    if (recommendationMatch) {
      if (request.method !== "POST") {
        response.setHeader("allow", "POST");
        json(HTTP_STATUS.methodNotAllowed, { error: "Use POST to generate recommendations." });
        return;
      }
      const requestedId = recommendationMatch[1];
      if (typeof requestedId == 'undefined') {
        json(HTTP_STATUS.badRequest, { error: "Invalid student ID." });
        return;
      }
      let id: UserId;
      try {
        id = parseId(decodeURIComponent(requestedId));
      } catch {
        json(HTTP_STATUS.badRequest, { error: "Invalid student ID." });
        return;
      }
      await connectDatabase();
      if (!await getUserById(id)) {
        json(HTTP_STATUS.notFound, { error: "Student not found." });
        return;
      }
      json(HTTP_STATUS.ok, await recommendPartners(id, RECOMMENDATION_LIMIT));
      return;
    }
    const asset = assets.get(pathname);
    if (request.method === "GET" && asset) {
      const [filename, contentType] = asset;
      const body = await readFile(new URL(filename, PUBLIC_DIRECTORY));
      response.writeHead(200, { "content-type": contentType });
      response.end(body);
      return;
    }

    if (pathname === "/api/users" && request.method === "GET") {
      await connectDatabase();
      json(200, { users: await listUsers() });
      return;
    }

    const updateMatch = /^\/api\/users\/([^/]+)$/.exec(pathname);
    if ((pathname === "/api/users" && request.method === "POST") || (updateMatch && request.method === "PATCH")) {
      const input = await readJson(request);
      const parsed = userCreationSchema.safeParse(input);
      if (!parsed.success) {
        json(400, { error: parsed.error.issues.map((issue) => issue.message).join("; ") });
        return;
      }
      if (!Number.isInteger(parsed.data.score)) {
        json(400, { error: "Score must be an integer between 0 and 100." });
        return;
      }

      await connectDatabase();
      const updateId = updateMatch?.[1];
      if (request.method === "PATCH" && typeof updateId == 'undefined') throw new RequestBodyError("Invalid ID.", HTTP_STATUS.badRequest);
      if (typeof updateId != 'undefined' && !await getUserById(updateId)) {
        json(HTTP_STATUS.notFound, { error: "Student not found." });
        return;
      }
      const result = typeof updateId == 'undefined' ? await createUser(parsed.data) : await updateUser(updateId, parsed.data);
      if (!result.success) {
        json(409, { error: result.message });
        return;
      }
      json(typeof updateId == 'undefined' ? 201 : HTTP_STATUS.ok, { users: await listUsers() });
      return;
    }

    const deleteMatch = /^\/api\/users\/([0-9a-f-]{36})$/i.exec(pathname);
    if (deleteMatch && request.method === "DELETE") {
      const id = deleteMatch[1]!;
      await connectDatabase();
      const user = await listUsers();
      if (!user.some((candidate) => candidate.id === id)) {
        json(404, { error: "Student not found." });
        return;
      }
      const result = await deleteUser(id);
      if (!result.success) {
        json(500, { error: result.message });
        return;
      }
      json(200, { users: await listUsers() });
      return;
    }

    json(404, { error: "Route not found." });
  } catch (error) {
    if (error instanceof RequestBodyError) { json(error.status, { error: error.message }); return; }
    if (error instanceof TrainingBusyError) { json(409, { error: error.message }); return; }
    if (error instanceof ZodError) { json(HTTP_STATUS.badRequest, { error: error.issues.map((issue) => issue.message).join("; ") }); return; }
    if (error instanceof PairOutcomeConflictError) { json(409, { error: error.message }); return; }
    if (error instanceof TrainedModelRequiredError) { json(409, { error: error.message }); return; }
    if (error instanceof PairOutcomeNotFoundError) { json(HTTP_STATUS.notFound, { error: error.message }); return; }
    if (error instanceof StudentNotFoundError) {
      json(HTTP_STATUS.notFound, { error: error.message });
      return;
    }
    console.error("Request failed:", error);
    json(500, { error: "Could not complete the operation." });
  }
});

if (import.meta.main) {
  server.listen(port, "0.0.0.0", () => {
    console.log(`Server running at http://localhost:${port}`);
  });
  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    // Libera a porta antes de o watcher iniciar a próxima instância.
    const timeout = setTimeout(() => process.exit(0), SERVER_SHUTDOWN_TIMEOUT_MS);
    timeout.unref();
    server.close(async () => {
      try { clearRankerCache(); await db.close(); }
      finally { process.exit(0); }
    });
    server.closeAllConnections();
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

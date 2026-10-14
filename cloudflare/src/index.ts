import { z, ZodError } from "zod";
import { trainingOptionsSchema } from "../../src/trainingOptions.ts";
import { userCreationSchema } from "../../db/validators/schema.ts";
import { database, flushVectorDeletions, HttpError } from "./database.ts";
import { activeModel, trainingIteration } from "./models.ts";
import { parseUserId, cohort, synchronizeStudentVectors } from "./vectors.ts";
import { recommendPartners } from "./matchmaking.ts";
import { startPairOutcome, completePairOutcome, listPairOutcomes } from "./pairOutcomes.ts";
import { startTraining, clearTrainingData, latestTraining } from "./training.ts";
export { TrainingWorkflow } from "./trainingWorkflow.ts";

const MAX_REQUEST_BYTES = 16_384;
const TRAINING_HISTORY_LIMIT = 100;
const HTTP = { ok: 200, created: 201, accepted: 202, badRequest: 400, notFound: 404, methodNotAllowed: 405, conflict: 409, tooLarge: 413, serverError: 500 } as const;
const userInputSchema = userCreationSchema.extend({
  income: z.string().trim().regex(/^\d+(?:\.\d+)?$/, "Enter a valid nonnegative income."),
});
const json = (status: number, body: unknown) => Response.json(body, { status, headers: { "cache-control": "no-store" } });
const methodError = (allowed: string) => Response.json({ error: `Use ${allowed}.` }, { status: HTTP.methodNotAllowed, headers: { allow: allowed } });
async function readJson(request: Request): Promise<unknown> {
  const reader = request.body?.getReader();
  if (!reader) throw new HttpError(HTTP.badRequest, "Send valid JSON.");
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > MAX_REQUEST_BYTES) { await reader.cancel(); throw new HttpError(HTTP.tooLarge, "Request body exceeds the allowed size."); }
    chunks.push(value);
  }
  const buffer = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder().decode(buffer)); }
  catch { throw new HttpError(HTTP.badRequest, "Send valid JSON."); }
}
function cleanupVectors(env: Env, ctx: ExecutionContext) {
  ctx.waitUntil(flushVectorDeletions(env).catch((error) => console.error(JSON.stringify({ event: "vector-deletion-pending", message: String(error) }))));
}
async function refreshUserVectors(env: Env) {
  const db = database(env);
  const context = await cohort(db);
  await db.pairVector.deleteMany({ where: { contextVersion: { not: context.contextVersion } } });
  await synchronizeStudentVectors(env, context);
}
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url), path = url.pathname;
    if (!path.startsWith("/api/")) {
      return env.ASSETS.fetch(request);
    }
    const db = database(env);
    try {
      if (path === "/api/users") {
        if (request.method === "GET") return json(HTTP.ok, { users: await db.user.findMany() });
        if (request.method === "POST") {
          const input = userInputSchema.parse(await readJson(request));
          await db.user.create({ data: { id: crypto.randomUUID(), ...input } });
          ctx.waitUntil(refreshUserVectors(env).then(() => flushVectorDeletions(env)).catch((error) => console.error(JSON.stringify({ event: "vector-sync-pending", message: String(error) }))));
          return json(HTTP.created, { users: await db.user.findMany() });
        }
        return methodError("GET, POST");
      }
      const user = /^\/api\/users\/([^/]+)$/.exec(path);
      if (user) {
        const id = parseUserId(decodeURIComponent(user[1]!));
        if (request.method === "PATCH") {
          const input = userInputSchema.parse(await readJson(request));
          const result = await db.user.updateMany({ where: { id }, data: input });
          if (!result.count) throw new HttpError(HTTP.notFound, "Student not found.");
        } else if (request.method === "DELETE") {
          const result = await db.user.deleteMany({ where: { id } });
          if (!result.count) throw new HttpError(HTTP.notFound, "Student not found.");
        } else return methodError("PATCH, DELETE");
        ctx.waitUntil(refreshUserVectors(env).then(() => flushVectorDeletions(env)).catch((error) => console.error(JSON.stringify({ event: "vector-sync-pending", message: String(error) }))));
        return json(HTTP.ok, { users: await db.user.findMany() });
      }
      const recommendation = /^\/api\/users\/([^/]+)\/recommendations$/.exec(path);
      if (recommendation) {
        if (request.method !== "POST") return methodError("POST");
        const id = recommendation[1];
        if (typeof id == 'undefined') throw new HttpError(HTTP.badRequest, "Invalid student ID.");
        const result = await recommendPartners(env, decodeURIComponent(id));
        cleanupVectors(env, ctx);
        return json(HTTP.ok, result);
      }
      if (path === "/api/training") {
        if (request.method === "GET") {
          const [model, training] = await Promise.all([activeModel(db), latestTraining(env)]);
          cleanupVectors(env, ctx);
          return json(HTTP.ok, { training, executor: "external", modelReady: model !== null, modelId: model?.modelId ?? null });
        }
        if (request.method === "POST") {
          const options = trainingOptionsSchema.parse({
            learningRate: url.searchParams.get("learningRate") ?? undefined,
            epochs: url.searchParams.get("epochs") ?? undefined,
            compareLearningRates: z.enum(["true", "false"]).default("false").parse(url.searchParams.get("compareLearningRates") ?? undefined) === "true",
          });
          return json(HTTP.accepted, { training: await startTraining(env, options) });
        }
        if (request.method === "DELETE") {
          const result = await clearTrainingData(env);
          cleanupVectors(env, ctx);
          return json(HTTP.ok, result);
        }
        return methodError("GET, POST, DELETE");
      }
      if (path === "/api/matchmaking/model") {
        if (request.method !== "GET") return methodError("GET");
        const model = await activeModel(db);
        return json(HTTP.ok, { rankingSource: model ? "trained-policy-model" : "policy", model: model?.artifact.metadata ?? null });
      }
      if (path === "/api/trained-models") {
        if (request.method !== "GET") return methodError("GET");
        const rows = await db.trainedModel.findMany({ orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: TRAINING_HISTORY_LIMIT });
        return json(HTTP.ok, { iterations: rows.map(trainingIteration) });
      }
      const trainedModel = /^\/api\/trained-models\/([^/]+)$/.exec(path);
      if (trainedModel) {
        if (request.method !== "GET") return methodError("GET");
        const id = trainedModel[1];
        if (typeof id == 'undefined') throw new HttpError(HTTP.badRequest, "Invalid ID.");
        const row = await db.trainedModel.findUnique({ where: { id: parseUserId(id) } });
        if (!row) throw new HttpError(HTTP.notFound, "Training run not found.");
        return json(HTTP.ok, { iteration: trainingIteration(row) });
      }
      if (path === "/api/pair-outcomes") {
        if (request.method === "GET") return json(HTTP.ok, { outcomes: await listPairOutcomes(env, url.searchParams.get("userId") ?? "") });
        if (request.method === "POST") {
          const result = await startPairOutcome(env, await readJson(request));
          return json(result.created ? HTTP.created : HTTP.ok, result);
        }
        return methodError("GET, POST");
      }
      const outcome = /^\/api\/pair-outcomes\/([^/]+)$/.exec(path);
      if (outcome) {
        if (request.method !== "PATCH") return methodError("PATCH");
        const id = outcome[1];
        if (typeof id == 'undefined') throw new HttpError(HTTP.badRequest, "Invalid ID.");
        return json(HTTP.ok, { outcome: await completePairOutcome(env, id, await readJson(request)) });
      }
      return json(HTTP.notFound, { error: "Route not found." });
    } catch (error) {
      if (error instanceof HttpError) return json(error.status, { error: error.message });
      if (error instanceof ZodError) return json(HTTP.badRequest, { error: error.issues.map((issue) => issue.message).join("; ") });
      if (error instanceof Error && "code" in error && error.code === "P2002") return json(HTTP.conflict, { error: "This record already exists." });
      console.error(JSON.stringify({ event: "request-failed", path, message: error instanceof Error ? error.message : String(error) }));
      return json(HTTP.serverError, { error: "Could not complete the operation." });
    }
  },
} satisfies ExportedHandler<Env>;

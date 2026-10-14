import { timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { z, ZodError } from "zod";
import { trainingOptionsSchema } from "../../src/trainingOptions.ts";

const DEFAULT_PORT = 3001;
const MAX_REQUEST_BYTES = 16_384;
const PROJECT_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const TRAINER_SCRIPT = fileURLToPath(new URL("./trainExternal.ts", import.meta.url));
const HTTP = { ok: 200, accepted: 202, badRequest: 400, unauthorized: 401, notFound: 404, conflict: 409, serverError: 500 } as const;
const token = process.env.TRAINING_SERVICE_TOKEN;
if (typeof token == 'undefined' || !token.trim()) throw new Error("Set TRAINING_SERVICE_TOKEN before starting the training service.");
const expectedAuthorization = Buffer.from(`Bearer ${token}`);
const requestSchema = z.object({ jobId: z.uuid(), options: trainingOptionsSchema });
let active: { jobId: string; child: ReturnType<typeof Bun.spawn> } | null = null;
const json = (status: number, body: unknown) => Response.json(body, { status, headers: { "cache-control": "no-store" } });
function authorized(request: Request) {
  const provided = Buffer.from(request.headers.get("authorization") ?? "");
  return provided.length === expectedAuthorization.length && timingSafeEqual(provided, expectedAuthorization);
}

const server = Bun.serve({
  hostname: process.env.TRAINING_HOST ?? "0.0.0.0",
  port: z.coerce.number().int().positive().parse(process.env.PORT ?? DEFAULT_PORT),
  maxRequestBodySize: MAX_REQUEST_BYTES,
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/health" && request.method === "GET") return json(HTTP.ok, { status: "ok" });
    if (!authorized(request)) return json(HTTP.unauthorized, { error: "Unauthorized." });
    if (path !== "/training" || request.method !== "POST") return json(HTTP.notFound, { error: "Route not found." });
    try {
      const { jobId, options } = requestSchema.parse(await request.json());
      if (active?.jobId === jobId) return json(HTTP.accepted, { jobId });
      if (active) return json(HTTP.conflict, { error: "A training process is already running." });
      // Fixed executable and validated arguments: HTTP callers never supply a shell command.
      const args = [process.execPath, "run", TRAINER_SCRIPT, "--job-id", jobId,
        "--learning-rate", String(options.learningRate), "--epochs", String(options.epochs), "--batch-size", String(options.batchSize)];
      if (options.compareLearningRates) args.push("--compare-learning-rates");
      const child = Bun.spawn(args, { cwd: PROJECT_ROOT, stdin: "ignore", stdout: "inherit", stderr: "inherit" });
      active = { jobId, child };
      void child.exited.then(async (exitCode) => {
        if (exitCode !== 0) {
          console.error(JSON.stringify({ event: "external-training-exited", jobId, exitCode }));
          // Also release endpoint-created jobs when preparation fails before the trainer claims them.
          const sql = `UPDATE TrainingJob SET status = 'failed', activeKey = NULL, message = 'The external training process stopped. Check the service logs.', finishedAt = '${new Date().toISOString()}' WHERE id = '${jobId}' AND status = 'running';`;
          const release = Bun.spawn(["node", "node_modules/wrangler/bin/wrangler.js", "d1", "execute", "vestibulandos", "--remote", "--command", sql], {
            cwd: fileURLToPath(new URL("../", import.meta.url)), stdin: "ignore", stdout: "ignore", stderr: "inherit",
          });
          await release.exited;
        }
      }).catch((error) => console.error(JSON.stringify({ event: "external-training-monitor-failed", jobId, message: String(error) })))
        .finally(() => { if (active?.jobId === jobId) active = null; });
      return json(HTTP.accepted, { jobId });
    } catch (error) {
      if (error instanceof ZodError || error instanceof SyntaxError) return json(HTTP.badRequest, { error: "Invalid training parameters." });
      console.error(JSON.stringify({ event: "external-training-start-failed", message: String(error) }));
      return json(HTTP.serverError, { error: "Could not start the training process." });
    }
  },
});
console.log(`Training service listening on ${server.hostname}:${server.port}.`);
async function shutdown() {
  server.stop(true);
  const child = active?.child;
  child?.kill("SIGTERM");
  if (child) await child.exited;
  process.exit(0);
}
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

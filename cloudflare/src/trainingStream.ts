import { database } from "./database.ts";
import { latestTraining } from "./training.ts";

const PROGRESS_INTERVAL_MS = 2000;
const STREAM_SESSION_MS = 25_000;
const HTTP_OK = 200;

export function trainingStream(request: Request, env: Env) {
  const db = database(env);
  const encoder = new TextEncoder();
  const startedAt = Date.now();
  let stopped = false;
  let previous = "";
  let first = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let wake: (() => void) | undefined;
  const stop = () => {
    stopped = true;
    clearTimeout(timer);
    wake?.();
    request.signal.removeEventListener("abort", stop);
  };
  request.signal.addEventListener("abort", stop, { once: true });
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      // pull() honors backpressure: one status chunk at a time, no event history buffer.
      if (!first) await new Promise<void>((resolve) => { wake = resolve; timer = setTimeout(resolve, PROGRESS_INTERVAL_MS); });
      first = false;
      wake = undefined;
      if (stopped) return;
      if (request.signal.aborted) { stop(); controller.close(); return; }
      try {
        const training = await latestTraining(env, db);
        if (stopped) return;
        const data = JSON.stringify({ training });
        if (data !== previous) {
          controller.enqueue(encoder.encode(`event: training-progress\ndata: ${data}\n\n`));
          previous = data;
        } else controller.enqueue(encoder.encode(": heartbeat\n\n"));
        if (!["running", "clearing"].includes(training.status)) { stop(); controller.close(); }
        else if (Date.now() - startedAt >= STREAM_SESSION_MS) {
          // Renew the tracking connection; the training job is independent of this stream.
          controller.enqueue(encoder.encode("event: stream-renew\ndata: {}\n\n"));
          stop(); controller.close();
        }
      } catch {
        if (!stopped) {
          controller.enqueue(encoder.encode('event: stream-failed\ndata: {}\n\n'));
          stop(); controller.close();
        }
      }
    },
    cancel() { stop(); },
  }, { highWaterMark: 0 });
  return new Response(body, { status: HTTP_OK, headers: {
    "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store, no-transform",
  } });
}

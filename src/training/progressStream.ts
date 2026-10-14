
const PROGRESS_INTERVAL_MS = 2000;
const STREAM_SESSION_MS = 25_000;
const HTTP_OK = 200;

export function createTrainingStream<T extends { status: string }>(
  request: Request,
  readStatus: () => Promise<T>,
  options: { intervalMs?: number; sessionMs?: number; now?: () => number } = {},
) {
  const intervalMs = options.intervalMs ?? PROGRESS_INTERVAL_MS;
  const sessionMs = options.sessionMs ?? STREAM_SESSION_MS;
  const now = options.now ?? Date.now;
  const encoder = new TextEncoder();
  const startedAt = now();
  let stopped = false;
  let previous = "";
  let first = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let wake: (() => void) | undefined;
  const stop = () => {
    stopped = true;
    clearTimeout(timer);
    wake?.();
    request.signal.removeEventListener("abort", abort);
  };
  let closeOnAbort: (() => void) | undefined;
  const abort = () => { stop(); closeOnAbort?.(); };
  request.signal.addEventListener("abort", abort, { once: true });
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      closeOnAbort = () => controller.close();
      if (request.signal.aborted) abort();
    },
    async pull(controller) {
      if (stopped) return;
      // pull() honors backpressure: one status chunk at a time, no event history buffer.
      if (!first) await new Promise<void>((resolve) => { wake = resolve; timer = setTimeout(resolve, intervalMs); });
      first = false;
      wake = undefined;
      if (stopped) return;
      if (request.signal.aborted) { stop(); controller.close(); return; }
      try {
        const training = await readStatus();
        if (stopped) return;
        const data = JSON.stringify({ training });
        if (data !== previous) {
          controller.enqueue(encoder.encode(`event: training-progress\ndata: ${data}\n\n`));
          previous = data;
        } else controller.enqueue(encoder.encode(": heartbeat\n\n"));
        if (!["running", "clearing"].includes(training.status)) { stop(); controller.close(); }
        else if (now() - startedAt >= sessionMs) {
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

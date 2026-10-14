import { describe, expect, test, mock } from "bun:test";
import { createTrainingStream } from "./progressStream.ts";

const request = () => new Request("https://example.com/api/training/events");
const decode = (value?: Uint8Array) => new TextDecoder().decode(value);

describe("training/progressStream", () => {
  test("sends a terminal status and closes", async () => {
    const response = createTrainingStream(request(), async () => ({ status: "completed" }));
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(await response.text()).toBe('event: training-progress\ndata: {"training":{"status":"completed"}}\n\n');
  });

  test("honors backpressure and emits heartbeats for unchanged status", async () => {
    const read = mock(async () => ({ status: "running" }));
    const reader = createTrainingStream(request(), read, { intervalMs: 0 }).body!.getReader();
    expect(read).not.toHaveBeenCalled();
    expect(decode((await reader.read()).value)).toContain("training-progress");
    expect(read).toHaveBeenCalledTimes(1);
    expect(decode((await reader.read()).value)).toBe(": heartbeat\n\n");
    await reader.cancel();
    expect((await reader.read()).done).toBe(true);
    expect(read).toHaveBeenCalledTimes(2);
  });

  test("requests connection renewal after the session deadline", async () => {
    let now = 0;
    const read = mock(async () => { now = 10; return { status: "running" }; });
    const response = createTrainingStream(request(), read, { sessionMs: 10, now: () => now });
    expect(await response.text()).toContain("event: stream-renew");
    expect(read).toHaveBeenCalledTimes(1);
  });

  test("signals status failures without leaking internal errors", async () => {
    const response = createTrainingStream(request(), async () => { throw new Error("private database details"); });
    expect(await response.text()).toBe("event: stream-failed\ndata: {}\n\n");
  });

  test("aborting the request closes a pending read", async () => {
    const abort = new AbortController();
    const reader = createTrainingStream(new Request(request(), { signal: abort.signal }),
      async () => ({ status: "running" }), { intervalMs: 60_000 }).body!.getReader();
    await reader.read();
    const pending = reader.read();
    abort.abort();
    expect((await pending).done).toBe(true);
  });

  test("an already aborted request never reads status", async () => {
    const abort = new AbortController();
    abort.abort();
    const read = mock(async () => ({ status: "running" }));
    const response = createTrainingStream(new Request(request(), { signal: abort.signal }), read);
    expect(await response.text()).toBe("");
    expect(read).not.toHaveBeenCalled();
  });
});

import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";

const source = await readFile(new URL("../recommendationWorkerClient.js", import.meta.url), "utf8");
function harness() {
  let instance: FakeWorker;
  class FakeWorker {
    terminated = false;
    onmessage?: (event: { data: unknown }) => void;
    onerror?: (event: { message: string }) => void;
    posted: unknown;
    constructor() { instance = this; }
    postMessage(value: unknown) { this.posted = value; }
    terminate() { this.terminated = true; }
  }
  const window: { rankRecommendations?: (data: unknown, signal: AbortSignal) => Promise<unknown> } = {};
  runInNewContext(source, { window, Worker: FakeWorker, DOMException });
  return { rank: window.rankRecommendations!, worker: () => instance! };
}
describe("frontend/recommendationWorker", () => {
  test("returns ranked results without retaining the full model payload", async () => {
    const { rank, worker } = harness();
    const controller = new AbortController();
    const result = rank({ userId: "student", inference: { artifact: "model" }, recommendations: [] }, controller.signal);
    worker().onmessage!({ data: { recommendations: [{ score: 0.9 }] } });
    expect(await result).toEqual({ userId: "student", recommendations: [{ score: 0.9 }] });
    expect(worker().terminated).toBe(false);
  });
  test("reuses the initialized worker between completed requests", async () => {
    const { rank, worker } = harness();
    const first = rank({ inference: {} }, new AbortController().signal);
    const initial = worker();
    initial.onmessage!({ data: { recommendations: [] } });
    await first;
    const second = rank({ inference: {} }, new AbortController().signal);
    expect(worker()).toBe(initial);
    initial.onmessage!({ data: { recommendations: [] } });
    await second;
    expect(initial.terminated).toBe(false);
  });
  test("cancels stale inference when the selected student changes", async () => {
    const { rank, worker } = harness();
    const controller = new AbortController();
    const result = rank({ inference: {} }, controller.signal);
    controller.abort();
    await expect(result).rejects.toMatchObject({ name: "AbortError" });
    expect(worker().terminated).toBe(true);
  });
  test("surfaces inference failures and releases the worker", async () => {
    const { rank, worker } = harness();
    const result = rank({ inference: {} }, new AbortController().signal);
    worker().onmessage!({ data: { error: "Invalid model" } });
    await expect(result).rejects.toThrow("Invalid model");
    expect(worker().terminated).toBe(true);
  });
});

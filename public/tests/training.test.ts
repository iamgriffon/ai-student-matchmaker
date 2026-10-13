import { beforeEach, describe, expect, mock, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { trainedArtifactFixture, trainedModelFixture, trainingReportFixture } from "../../db/tests/fixtutes/trainedModels.fixtures.ts";
import { parseId } from "../../src/utils/idParser.ts";

const FIRST_ID = trainedModelFixture.id;
const SECOND_ID = parseId("00000000-0000-4000-8000-000000000051");
const ITERATION = {
  id: FIRST_ID, modelId: trainedModelFixture.modelId, active: true,
  metadata: trainedArtifactFixture.metadata, architecture: [4, 1], trainingReport: trainingReportFixture,
};
const source = await readFile(new URL("../training.js", import.meta.url), "utf8");
class Element {
  innerHTML = ""; textContent = ""; disabled = false;
  listeners = new Map<string, (event: unknown) => void>();
  addEventListener(name: string, listener: (event: unknown) => void) { this.listeners.set(name, listener); }
}
type TrainingApp = {
  state: { iterations: (typeof ITERATION)[]; selectedId: string | null; loading: boolean };
  loadTraining: () => Promise<void>; renderTraining: () => void;
};
let elements: Map<string, Element>;
let fetchMock: ReturnType<typeof mock<typeof fetch>>;
let app: TrainingApp;
beforeEach(async () => {
  elements = new Map();
  fetchMock = mock<typeof fetch>(async () => Response.json({ iterations: [ITERATION] }));
  const sandbox: { window: { i18n: { locale: string } }; document: { getElementById: (id: string) => Element; addEventListener: () => void }; fetch: typeof fetchMock; initialLoad: Promise<void>; testApi?: TrainingApp } = {
    document: { getElementById(id) { let element = elements.get(id); if (typeof element == 'undefined') { element = new Element(); elements.set(id, element); } return element; }, addEventListener: () => undefined },
    window: { i18n: { locale: "en-US" } }, fetch: fetchMock, initialLoad: Promise.resolve(),
  };
  const instrumented = source.replace(/loadTraining\(\);\s*$/, "globalThis.initialLoad = loadTraining();") +
    "\nglobalThis.testApi = { state: trainingState, loadTraining, renderTraining };";
  runInNewContext(instrumented, sandbox);
  await sandbox.initialLoad;
  if (typeof sandbox.testApi == 'undefined') throw new Error("Training test API missing");
  app = sandbox.testApi;
  fetchMock.mockClear();
});

describe("training history frontend", () => {
  test("loads actual iterations from the API and selects the active execution", () => {
    expect(app.state.selectedId).toBe(FIRST_ID);
    expect(elements.get("training-list")?.innerHTML).toContain(ITERATION.modelId);
    expect(elements.get("training-detail")?.innerHTML).toContain("Active model");
    expect(elements.get("training-notice")?.textContent).toContain("banco de dados");
  });
  test("shows architecture, validation, report comparisons and the epoch chart", () => {
    const detail = elements.get("training-detail")?.innerHTML;
    expect(detail).toContain("4 → 1");
    expect(detail).toContain("Students separados");
    expect(detail).toContain("Training pairs");
    expect(detail).toContain("Comparação da mesma rodada");
    expect(detail).toContain("Training MSE per iteration");
    expect(detail).toContain("View metadata and JSON report");
    expect(detail).not.toContain("weightData");
  });
  test("keeps distinct executions of the same weights selectable", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ iterations: [ITERATION, { ...ITERATION, id: SECOND_ID, active: false }] }));
    await app.loadTraining();
    elements.get("training-list")?.listeners.get("click")?.({ target: { closest: () => ({ dataset: { iterationId: SECOND_ID } }) } });
    expect(app.state.selectedId).toBe(SECOND_ID);
    expect(elements.get("training-detail")?.innerHTML).toContain(SECOND_ID);
    expect(elements.get("training-detail")?.innerHTML).not.toContain("Active model");
  });
  test("preserves the selected execution on refresh", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ iterations: [ITERATION, { ...ITERATION, id: SECOND_ID, active: false }] }));
    await app.loadTraining(); app.state.selectedId = SECOND_ID;
    fetchMock.mockResolvedValueOnce(Response.json({ iterations: [ITERATION, { ...ITERATION, id: SECOND_ID, active: false }] }));
    await app.loadTraining(); expect(app.state.selectedId).toBe(SECOND_ID);
  });
  test("shows empty history without inventing iterations", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ iterations: [] }));
    await app.loadTraining();
    expect(app.state.selectedId).toBeNull();
    expect(elements.get("training-list")?.innerHTML).toContain("Nenhum treinamento salvo");
  });
  test("handles imported executions without epoch histories", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ iterations: [{ ...ITERATION, trainingReport: null }] }));
    await app.loadTraining();
    expect(elements.get("training-detail")?.innerHTML).toContain("Sem histórico de perda por iteração");
    expect(elements.get("training-detail")?.innerHTML).toContain("Sem relatório comparativo");
  });
  test("displays request errors and allows retrying", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ error: "History unavailable" }, { status: 500 }));
    await app.loadTraining();
    expect(elements.get("training-notice")?.textContent).toBe("History unavailable");
    expect(app.state.loading).toBe(false);
    fetchMock.mockResolvedValueOnce(Response.json({ iterations: [ITERATION] }));
    await app.loadTraining(); expect(app.state.iterations).toHaveLength(1);
  });
  test("rejects invalid API histories", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ iterations: "invalid" }));
    await app.loadTraining();
    expect(elements.get("training-notice")?.textContent).toBe("Invalid training history.");
  });
  test("blocks duplicate refresh requests while loading", async () => {
    const pending = Promise.withResolvers<Response>(); fetchMock.mockReturnValueOnce(pending.promise);
    const loading = app.loadTraining();
    expect(elements.get("reload-training")?.disabled).toBe(true);
    await app.loadTraining(); expect(fetchMock).toHaveBeenCalledTimes(1);
    pending.resolve(Response.json({ iterations: [ITERATION] })); await loading;
    expect(elements.get("reload-training")?.disabled).toBe(false);
  });
  test("escapes JSON and rendered content", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ iterations: [{ ...ITERATION, metadata: { ...ITERATION.metadata, sourceContextVersion: '<script>alert("x")</script>' } }] }));
    await app.loadTraining();
    const html = elements.get("training-detail")?.innerHTML;
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&quot;metadata&quot;");
  });
});

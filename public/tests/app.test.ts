import { beforeEach, describe, expect, mock, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";

const FIRST_ID = "00000000-0000-4000-8000-000000000001";
const SECOND_ID = "00000000-0000-4000-8000-000000000002";
const USERS = [
  { id: FIRST_ID, name: "Ana", email: "ana@example.com", age: 20, score: 50, income: "1000", disability: false },
  { id: SECOND_ID, name: "Caio", email: "caio@example.com", age: 21, score: 70, income: "4000", disability: true },
];
const RESULT = {
  userId: FIRST_ID, selectedScore: 50, cohortMeanScore: 60,
  evaluatedCount: 1, eligibleCount: 1, canStartPairs: true,
  rankingSource: "trained-policy-model", model: { modelId: "pair-ranker-aaaaaaaaaaaa" },
  recommendations: [{
    partner: USERS[1], score: 0.9,
    metrics: { imbalance: 0, academicGap: 0.2, incomeDistance: 1, disabilityDifference: 1 },
  }],
};

class Element {
  innerHTML = "";
  textContent = "";
  value = "";
  hidden = false;
  disabled = false;
  attributes = new Map<string, string>();
  listeners = new Map<string, (event: unknown) => unknown>();
  classList = { toggle: () => undefined };
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  addEventListener(name: string, listener: (event: unknown) => unknown) { this.listeners.set(name, listener); }
}

type TestApp = {
  state: {
    users: typeof USERS; selectedId: string | null; loading: boolean;
    recommendationLoading: boolean; recommendationError: string;
    recommendationResult: typeof RESULT | null; startedPairs: Set<string>;
    modelReady: boolean | null; modelId: string | null; trainingBusy: boolean;
  };
  generateRecommendations: () => Promise<void>;
  clearRecommendations: () => void;
  replaceUsers: (users: typeof USERS) => void;
  render: () => void;
  rememberStartedPair: (outcome: { userAId: string; userBId: string }) => void;
};
const source = await readFile(new URL("../app.js", import.meta.url), "utf8");
let app: TestApp;
let elements: Map<string, Element>;
let fetchMock: ReturnType<typeof mock<typeof fetch>>;
let documentListeners: Map<string, (event: unknown) => unknown>;

beforeEach(async () => {
  elements = new Map();
  documentListeners = new Map();
  fetchMock = mock<typeof fetch>(async () => Response.json({ users: USERS }));
  const sandbox = {
    document: { getElementById: (id: string) => {
      let element = elements.get(id);
      if (typeof element == 'undefined') { element = new Element(); elements.set(id, element); }
      return element;
    }, addEventListener: (name: string, listener: (event: unknown) => unknown) => documentListeners.set(name, listener) },
    fetch: fetchMock, AbortController, structuredClone, console,
    window: { confirm: () => true, i18n: { locale: "en-US", t: (value: string) => value } },
    initialLoad: Promise.resolve(), testApi: undefined,
  };
  // Exercise the actual frontend script with a minimal DOM and simulated HTTP.
  const instrumented = source.replace(/loadUsers\(\);\s*$/, "globalThis.initialLoad = loadUsers();") +
    "\nglobalThis.testApi = { state, generateRecommendations, clearRecommendations, replaceUsers, render, rememberStartedPair };";
  runInNewContext(instrumented, sandbox);
  await sandbox.initialLoad;
  app = sandbox.testApi as unknown as TestApp;
  app.state.selectedId = FIRST_ID;
  app.render();
  fetchMock.mockClear();
});

describe("training reactivity frontend", () => {
  const updateModel = (modelReady: boolean, status: string, modelId: string | null = null) =>
    documentListeners.get("training-model-status")?.({ detail: { modelReady, modelId, training: { status } } });

  test("loads recommendations automatically when the first training finishes", async () => {
    await updateModel(false, "idle");
    await updateModel(false, "running");
    fetchMock.mockResolvedValueOnce(Response.json(RESULT));
    await updateModel(true, "completed", RESULT.model.modelId);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(app.state.selectedId).toBe(FIRST_ID);
    expect(app.state.trainingBusy).toBe(false);
    expect(elements.get("recommendations")?.innerHTML).toContain("Caio");
    expect(elements.get("notice")?.textContent).toContain("Model trained");
  });

  test("does not rebuild the student list on each training progress update", async () => {
    await updateModel(false, "running");
    const list = elements.get("student-list")!;
    list.innerHTML = "Keep current list and focus";
    await updateModel(false, "running");
    expect(list.innerHTML).toBe("Keep current list and focus");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("clears stale recommendations after model deletion and refreshes after replacement", async () => {
    app.state.modelReady = true;
    app.state.modelId = RESULT.model.modelId;
    fetchMock.mockResolvedValueOnce(Response.json(RESULT));
    await app.generateRecommendations();
    await updateModel(false, "idle");
    expect(app.state.recommendationResult).toBeNull();
    expect(elements.get("recommendations")?.innerHTML).toContain("Model training required");
    fetchMock.mockResolvedValueOnce(Response.json(RESULT));
    await updateModel(true, "completed", "pair-ranker-bbbbbbbbbbbb");
    expect(app.state.recommendationResult).not.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("recommendation frontend", () => {
  test("generates on selection and reuses recommendations when selected again", async () => {
    app.state.modelReady = true;
    app.state.modelId = RESULT.model.modelId;
    fetchMock.mockResolvedValueOnce(Response.json(RESULT));
    const click = { target: { closest: () => ({ dataset: { userId: FIRST_ID } }) } };
    await elements.get("student-list")?.listeners.get("click")?.(click);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(elements.get("selected-student")?.innerHTML).toContain("Refresh recommendations");
    app.clearRecommendations();
    app.state.selectedId = SECOND_ID;
    await elements.get("student-list")?.listeners.get("click")?.(click);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(elements.get("recommendations")?.innerHTML).toContain("Caio");
  });

  test("posts the selected ID and renders the ranked response", async () => {
    fetchMock.mockResolvedValueOnce(Response.json(RESULT));
    await app.generateRecommendations();
    expect(fetchMock).toHaveBeenCalledWith(`/api/users/${FIRST_ID}/recommendations`, expect.objectContaining({ method: "POST" }));
    expect(app.state.recommendationLoading).toBe(false);
    expect(elements.get("recommendations")?.innerHTML).toContain("Caio");
    expect(elements.get("recommendation-summary")?.textContent).toContain("1 recommendation");
  });

  test("shows loading and prevents duplicate requests", async () => {
    const pending = Promise.withResolvers<Response>();
    fetchMock.mockReturnValueOnce(pending.promise);
    const reading = app.generateRecommendations();
    expect(app.state.recommendationLoading).toBe(true);
    expect(elements.get("recommendations")?.innerHTML).toContain("recommendation-skeleton");
    expect(elements.get("recommendation-summary")?.textContent).toContain("Loading recommendations");
    await app.generateRecommendations();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    pending.resolve(Response.json(RESULT));
    await reading;
  });

  test("renders a server error and allows retrying", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ error: "Não foi possível gerar" }, { status: 500 }));
    await app.generateRecommendations();
    expect(elements.get("recommendations")?.innerHTML).toContain("Não foi possível gerar");
    expect(app.state.recommendationLoading).toBe(false);
    fetchMock.mockResolvedValueOnce(Response.json(RESULT));
    await app.generateRecommendations();
    expect(app.state.recommendationError).toBe("");
    expect(elements.get("recommendations")?.innerHTML).toContain("Caio");
  });

  test("renders the no-eligible-candidate state", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ ...RESULT, eligibleCount: 0, recommendations: [] }));
    await app.generateRecommendations();
    expect(elements.get("recommendations")?.innerHTML).toContain("No study pairs meet");
  });

  test("rejects responses for a different selected student", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ ...RESULT, userId: SECOND_ID }));
    await app.generateRecommendations();
    expect(app.state.recommendationResult).toBeNull();
    expect(app.state.recommendationError).toContain("invalid recommendations");
  });

  test("ignores a late response after changing the selected student", async () => {
    const pending = Promise.withResolvers<Response>();
    fetchMock.mockReturnValueOnce(pending.promise);
    const reading = app.generateRecommendations();
    const options = fetchMock.mock.calls[0]?.[1];
    app.clearRecommendations();
    app.state.selectedId = SECOND_ID;
    app.render();
    expect(options?.signal?.aborted).toBe(true);
    pending.resolve(Response.json(RESULT));
    await reading;
    expect(app.state.recommendationResult).toBeNull();
    expect(app.state.recommendationLoading).toBe(false);
    expect(elements.get("recommendations")?.innerHTML).toContain("Waiting for recommendations");
  });

  test("clears generated recommendations when the cohort is replaced", async () => {
    fetchMock.mockResolvedValueOnce(Response.json(RESULT));
    await app.generateRecommendations();
    app.replaceUsers([USERS[1]!]);
    app.render();
    expect(app.state.selectedId).toBeNull();
    expect(app.state.recommendationResult).toBeNull();
  });
});

describe("trained recommendations display", () => {
  test("keeps technical model and cache details out of the recommendations", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({
      ...RESULT, rankingSource: "trained-policy-model", reusedCount: 1, calculatedCount: 0,
      model: { modelId: "fixture-trained-model", sampleCount: 3990, validationMeanAbsoluteError: 0.0016 },
    }));
    await app.generateRecommendations();
    expect(elements.get("recommendation-summary")?.textContent).toBe("1 recommendation");
    expect(elements.get("recommendations")?.innerHTML).not.toContain("fixture-trained-model");
    expect(elements.get("recommendations")?.innerHTML).not.toContain("Pontuação:");
  });
  test("hides start actions when no trained model is available", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ ...RESULT, canStartPairs: false, rankingSource: "policy", model: null }));
    await app.generateRecommendations();
    expect(elements.get("recommendations")?.innerHTML).not.toContain("Start study pair");
    expect(elements.get("recommendation-summary")?.textContent).toContain("Train a model");
  });
  test("hides start actions for a pair already returned by the server", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ ...RESULT, recommendations: [{ ...RESULT.recommendations[0], outcomeId: "existing-pair" }] }));
    await app.generateRecommendations();
    expect(elements.get("recommendations")?.innerHTML).not.toContain("Start study pair");
  });
  test("hides start actions immediately and for reversed student selection", async () => {
    fetchMock.mockResolvedValueOnce(Response.json(RESULT)); await app.generateRecommendations();
    expect(elements.get("recommendations")?.innerHTML).toContain("Start study pair");
    app.rememberStartedPair({ userAId: SECOND_ID, userBId: FIRST_ID }); app.render();
    expect(elements.get("recommendations")?.innerHTML).not.toContain("Start study pair");
    app.clearRecommendations(); app.state.selectedId = SECOND_ID;
    fetchMock.mockResolvedValueOnce(Response.json({ ...RESULT, userId: SECOND_ID, selectedScore: 70, recommendations: [{ ...RESULT.recommendations[0], partner: USERS[0] }] }));
    await app.generateRecommendations();
    expect(elements.get("recommendations")?.innerHTML).not.toContain("Start study pair");
  });

});

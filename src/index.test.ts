import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { pairOutcomeFixture } from "../db/tests/fixtutes/pairOutcomes.fixtures.ts";
import { trainedModelFixture } from "../db/tests/fixtutes/trainedModels.fixtures.ts";
import { database, dbUsersFixture } from "../db/tests/fixtutes/db.fixtures.ts";
import { makeVectorContext, resetVectorMocks } from "../db/tests/fixtutes/vectorContext.fixtures.ts";
import { resetRankerMock } from "../db/tests/fixtutes/ranker.fixtures.ts";
const { invalidatePairVectorCaches } = await import("../db/pairVectors.ts");
const { invalidateTrainedModelCaches } = await import("../db/trainedModels.ts");
const { server } = await import("./index.ts");

const HOST = "127.0.0.1";
const EPHEMERAL_PORT = 0;
const SELECTED_ID = dbUsersFixture[0].id;
const UNKNOWN_ID = "00000000-0000-4000-8000-000000000099";
let baseUrl = "";
let context = makeVectorContext();
let errorLog: { mockRestore: () => void } | undefined;

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(EPHEMERAL_PORT, HOST, resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected a listening test server");
  baseUrl = `http://${HOST}:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections();
  });
});

beforeEach(() => {
  database.reset();
  database.mocks.pairAll.mockResolvedValue([]);
  resetRankerMock();
  invalidatePairVectorCaches();
  invalidateTrainedModelCaches();
  context = makeVectorContext();
  resetVectorMocks(context);
  errorLog = spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => errorLog?.mockRestore());

const recommend = (id = SELECTED_ID, method = "POST") => fetch(`${baseUrl}/api/users/${id}/recommendations`, { method });

describe("recommendation endpoint", () => {
  test("returns real ranked recommendations and persists evaluated vectors", async () => {
    const response = await recommend();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const result = await response.json();
    expect(result.userId).toBe(SELECTED_ID);
    expect(result.contextVersion).toBe(context.contextVersion);
    expect(result.recommendations[0].partner.id).toBe(dbUsersFixture[1].id);
    expect(database.mocks.upsertPair).toHaveBeenCalledTimes(1);
    expect(context.studentVectors.dispose).toHaveBeenCalledTimes(1);
  });

  test("returns 400 for an invalid UUID without querying the database", async () => {
    const response = await recommend("invalid-id");
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("ID do aluno inválido.");
    expect(database.mocks.connectDatabase).not.toHaveBeenCalled();
  });

  test("returns 400 for a malformed percent-encoded identifier", async () => {
    const response = await recommend("%invalid");
    expect(response.status).toBe(400);
    expect(database.mocks.connectDatabase).not.toHaveBeenCalled();
  });

  test("returns 404 when the selected student does not exist", async () => {
    database.mocks.first.mockResolvedValueOnce(null);
    const response = await recommend(UNKNOWN_ID);
    expect(response.status).toBe(404);
    expect((await response.json()).error).toBe("Aluno não encontrado.");
    expect(database.mocks.upsertPair).not.toHaveBeenCalled();
  });

  test("returns 404 when the student disappears before context preparation", async () => {
    const response = await recommend(UNKNOWN_ID);
    expect(response.status).toBe(404);
    expect(context.studentVectors.dispose).toHaveBeenCalledTimes(1);
  });

  test("requires POST and advertises the allowed method", async () => {
    const response = await recommend(SELECTED_ID, "GET");
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
    expect(database.mocks.connectDatabase).not.toHaveBeenCalled();
  });

  test("returns an empty successful response when no candidates qualify", async () => {
    context.cohortMeanScore = 0;
    const response = await recommend();
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.recommendations).toEqual([]);
    expect(result.evaluatedCount).toBe(1);
    expect(result.eligibleCount).toBe(0);
  });

  test("returns a generic error on persistence failure and releases tensors", async () => {
    database.mocks.upsertPair.mockRejectedValueOnce(new Error("Private database details"));
    const response = await recommend();
    expect(response.status).toBe(500);
    expect((await response.json()).error).toBe("Não foi possível concluir a operação.");
    expect(context.studentVectors.dispose).toHaveBeenCalledTimes(1);
  });

  test("returns a generic error when connecting fails", async () => {
    database.mocks.connectDatabase.mockRejectedValueOnce(new Error("Connection failed"));
    const response = await recommend();
    expect(response.status).toBe(500);
    expect(database.mocks.upsertPair).not.toHaveBeenCalled();
  });

  test("serves the frontend without the old demonstration label", async () => {
    const response = await fetch(baseUrl);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("Possíveis duplas");
    expect(html).not.toContain("Recomendações mockadas");
    expect(html).toContain('id="recommendation-summary"');
  });
});


describe("training history endpoints", () => {
  test("lists metadata and reports without exposing weight buffers", async () => {
    const response = await fetch(`${baseUrl}/api/trained-models`);
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.iterations).toHaveLength(1);
    expect(data.iterations[0].id).toBe(trainedModelFixture.id);
    expect(data.iterations[0].active).toBe(true);
    expect(data.iterations[0].architecture).toEqual([4, 1]);
    expect(data.iterations[0].trainingReport.lossHistory).toHaveLength(2);
    expect(data.iterations[0].weightData).toBeUndefined();
    expect(data.iterations[0].artifact).toBeUndefined();
  });
  test("loads a single execution by its UUID", async () => {
    const response = await fetch(`${baseUrl}/api/trained-models/${trainedModelFixture.id}`);
    expect(response.status).toBe(200);
    expect((await response.json()).iteration.id).toBe(trainedModelFixture.id);
  });
  test("returns 400 for an invalid execution identifier", async () => {
    const response = await fetch(`${baseUrl}/api/trained-models/invalid`);
    expect(response.status).toBe(400);
    expect(database.mocks.connectDatabase).not.toHaveBeenCalled();
  });
  test("returns 404 for an unknown execution", async () => {
    database.mocks.trainedFirst.mockResolvedValueOnce(null);
    expect((await fetch(`${baseUrl}/api/trained-models/${trainedModelFixture.id}`)).status).toBe(404);
  });
  test("returns an empty history and reports query failures", async () => {
    database.mocks.trainedAll.mockResolvedValueOnce([]);
    expect((await (await fetch(`${baseUrl}/api/trained-models`)).json()).iterations).toEqual([]);
    database.mocks.trainedAll.mockRejectedValueOnce(new Error("Private model data"));
    const response = await fetch(`${baseUrl}/api/trained-models`);
    expect(response.status).toBe(500);
    expect((await response.json()).error).not.toContain("Private model data");
  });
  test("requires GET for history queries", async () => {
    for (const path of ["/api/trained-models", `/api/trained-models/${trainedModelFixture.id}`]) {
      const response = await fetch(`${baseUrl}${path}`, { method: "POST" });
      expect(response.status).toBe(405);
      expect(response.headers.get("allow")).toBe("GET");
    }
  });
  test("serves the training view and its script", async () => {
    const page = await fetch(`${baseUrl}/training`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Histórico de treinamentos");
    const script = await fetch(`${baseUrl}/training.js`);
    expect(script.status).toBe(200);
    expect(await script.text()).toContain("/api/trained-models");
  });
});


describe("pair creation endpoint", () => {
  const start = (body: unknown) => fetch(`${baseUrl}/api/pair-outcomes`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const payload = () => ({ userAId: dbUsersFixture[0].id, userBId: dbUsersFixture[1].id, contextVersion: context.contextVersion, modelId: trainedModelFixture.modelId });
  test("returns 201 for a new pair", async () => {
    const response = await start(payload());
    expect(response.status).toBe(201);
    const data = await response.json();
    expect(data.created).toBe(true);
    expect(data.outcome.modelId).toBe(trainedModelFixture.modelId);
    expect(database.mocks.outcomeCreate).toHaveBeenCalledTimes(1);
  });
  test("returns 200 with the existing pair for a reversed retry", async () => {
    database.mocks.outcomeFirst.mockResolvedValueOnce(pairOutcomeFixture);
    const values = payload();
    const response = await start({ ...values, userAId: values.userBId, userBId: values.userAId });
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.created).toBe(false); expect(data.outcome.id).toBe(pairOutcomeFixture.id);
    expect(database.mocks.outcomeCreate).not.toHaveBeenCalled();
  });
  test("rejects new pairs without an active trained model", async () => {
    database.mocks.trainedFirst.mockResolvedValueOnce(null);
    const response = await start(payload());
    expect(response.status).toBe(409);
    expect((await response.json()).error).toContain("Treine e ative");
    expect(database.mocks.outcomeCreate).not.toHaveBeenCalled();
  });
  test("rejects creation from recommendations without a model", async () => {
    const response = await start({ ...payload(), modelId: null });
    expect(response.status).toBe(409);
    expect(database.mocks.outcomeCreate).not.toHaveBeenCalled();
  });
  test("marks existing pairs and disallows creation for policy-only recommendations", async () => {
    database.mocks.outcomeAll.mockResolvedValueOnce([pairOutcomeFixture]);
    const response = await recommend(); const data = await response.json();
    expect(data.canStartPairs).toBe(false);
    expect(data.recommendations[0].outcomeId).toBe(pairOutcomeFixture.id);
  });
});

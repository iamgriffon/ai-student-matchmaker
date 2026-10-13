import { beforeEach, describe, expect, test } from "bun:test";
import contract from "../generated/contract.json" with { type: "json" };
import { database, dbUsersFixture, pairVectorFixture } from "./fixtutes/db.fixtures.ts";
import { pairOutcomeFixture } from "./fixtutes/pairOutcomes.fixtures.ts";
import { trainedModelFixture } from "./fixtutes/trainedModels.fixtures.ts";
import { makeVectorContext, resetVectorMocks } from "./fixtutes/vectorContext.fixtures.ts";
import { parseId } from "../../src/utils/idParser.ts";
const { startPairOutcome, getStartedPairPartners, PairOutcomeConflictError } = await import("../pairOutcomes.ts");
const { TrainedModelRequiredError, invalidateTrainedModelCaches } = await import("../trainedModels.ts");

let context = makeVectorContext();
const input = () => ({ userAId: dbUsersFixture[0].id, userBId: dbUsersFixture[1].id, contextVersion: context.contextVersion, modelId: trainedModelFixture.modelId });
beforeEach(() => {
  database.reset(); invalidateTrainedModelCaches();
  context = makeVectorContext(); resetVectorMocks(context);
  database.mocks.pairFirst.mockResolvedValue({ ...pairVectorFixture, contextVersion: context.contextVersion });
});
describe("db/pairOutcomes", () => {
  test("declares uniqueness for the ordered pair and rejects self-pairs", () => {
    const table = contract.storage.namespaces.public.entries.table.PairOutcomes;
    expect(table.uniques).toContainEqual({ columns: ["userAId", "userBId"] });
    expect(table.checks).toEqual(expect.arrayContaining([expect.objectContaining({ expression: '"userAId" < "userBId"' })]));
  });
  test("creates one pair using a verified active model and captured scores", async () => {
    const result = await startPairOutcome(input());
    expect(result.created).toBe(true);
    expect(result.outcome.modelId).toBe(trainedModelFixture.modelId);
    expect(database.mocks.outcomeCreate).toHaveBeenCalledWith(expect.objectContaining({
      userAId: dbUsersFixture[0].id, userBId: dbUsersFixture[1].id,
      modelId: trainedModelFixture.modelId, scoreBeforeA: 84, scoreBeforeB: 92,
    }));
    expect(database.mocks.transactionQuery).toHaveBeenCalledTimes(2);
    expect(context.studentVectors.dispose).toHaveBeenCalledTimes(1);
  });
  test("normalizes reversed members before looking up or creating a pair", async () => {
    const values = input();
    await startPairOutcome({ ...values, userAId: values.userBId, userBId: values.userAId });
    expect(database.mocks.outcomeUserAEq).toHaveBeenCalledWith(parseId(values.userAId));
    expect(database.mocks.outcomeUserBEq).toHaveBeenCalledWith(parseId(values.userBId));
    expect(database.mocks.outcomeCreate).toHaveBeenCalledWith(expect.objectContaining({ userAId: values.userAId, userBId: values.userBId }));
  });
  test("retries return the same pair without creating a new record", async () => {
    database.mocks.outcomeFirst.mockResolvedValue(pairOutcomeFixture);
    const first = await startPairOutcome(input());
    const values = input();
    const second = await startPairOutcome({ ...values, userAId: values.userBId, userBId: values.userAId });
    expect(first.created).toBe(false); expect(second.created).toBe(false);
    expect(first.outcome.id).toBe(second.outcome.id);
    expect(database.mocks.outcomeCreate).not.toHaveBeenCalled();
    expect(database.mocks.trainedFirst).not.toHaveBeenCalled();
    expect(database.mocks.all).not.toHaveBeenCalled();
  });
  test("keeps idempotence after completion, cohort changes or model deletion", async () => {
    database.mocks.outcomeFirst.mockResolvedValue({ ...pairOutcomeFixture, completedAt: "2026-10-13T20:00:00.000Z" });
    database.mocks.trainedFirst.mockResolvedValue(null);
    const result = await startPairOutcome({ ...input(), contextVersion: "old-context", modelId: null });
    expect(result.created).toBe(false); expect(result.outcome.id).toBe(pairOutcomeFixture.id);
    expect(database.mocks.outcomeCreate).not.toHaveBeenCalled();
  });
  test("serializes competing requests and creates only one record", async () => {
    let stored: typeof pairOutcomeFixture | null = null;
    let tail = Promise.resolve();
    database.mocks.transaction.mockImplementation((callback) => {
      const execution = tail.then(() => callback({ orm: database.db.orm, query: database.mocks.transactionQuery }));
      tail = execution.then(() => undefined, () => undefined);
      return execution;
    });
    database.mocks.outcomeFirst.mockImplementation(async () => stored);
    database.mocks.outcomeCreate.mockImplementation(async (values) => { stored = { ...pairOutcomeFixture, ...values }; return stored; });
    const values = input();
    const results = await Promise.all([startPairOutcome(values), startPairOutcome({ ...values, userAId: values.userBId, userBId: values.userAId })]);
    expect(results.map((result) => result.created)).toEqual([true, false]);
    expect(results[0]?.outcome.id).toBe(results[1]?.outcome.id);
    expect(database.mocks.outcomeCreate).toHaveBeenCalledTimes(1);
  });
  test("rejects creation without an active trained model", async () => {
    database.mocks.trainedFirst.mockResolvedValue(null);
    await expect(startPairOutcome(input())).rejects.toBeInstanceOf(TrainedModelRequiredError);
    expect(database.mocks.outcomeCreate).not.toHaveBeenCalled();
  });
  test("rejects incompatible active models", async () => {
    const current = await import("./fixtutes/trainedModels.fixtures.ts");
    database.mocks.trainedFirst.mockResolvedValue({ ...trainedModelFixture, trainingReport: null,
      artifact: { ...current.trainedArtifactFixture, metadata: { ...current.trainedArtifactFixture.metadata, encoderVersion: "old-encoder" } } });
    await expect(startPairOutcome(input())).rejects.toBeInstanceOf(TrainedModelRequiredError);
    expect(database.mocks.outcomeCreate).not.toHaveBeenCalled();
  });
  test("rejects forged or outdated model identifiers", async () => {
    await expect(startPairOutcome({ ...input(), modelId: "pair-ranker-bbbbbbbbbbbb" })).rejects.toBeInstanceOf(PairOutcomeConflictError);
    await expect(startPairOutcome({ ...input(), modelId: null })).rejects.toBeInstanceOf(PairOutcomeConflictError);
    expect(database.mocks.outcomeCreate).not.toHaveBeenCalled();
  });
  test("validates IDs and self-pairs before connecting", async () => {
    await expect(startPairOutcome({ ...input(), userAId: "invalid" })).rejects.toThrow();
    await expect(startPairOutcome({ ...input(), userBId: input().userAId })).rejects.toThrow();
    expect(database.mocks.connectDatabase).not.toHaveBeenCalled();
  });
  test("rejects stale contexts and releases the tensor", async () => {
    await expect(startPairOutcome({ ...input(), contextVersion: "old-context" })).rejects.toBeInstanceOf(PairOutcomeConflictError);
    expect(database.mocks.outcomeCreate).not.toHaveBeenCalled();
    expect(context.studentVectors.dispose).toHaveBeenCalledTimes(1);
  });
  test("rejects absent vectors or academically ineligible pairs", async () => {
    database.mocks.pairFirst.mockResolvedValueOnce(null);
    await expect(startPairOutcome(input())).rejects.toThrow("expirou");
    database.mocks.pairFirst.mockResolvedValueOnce({ ...pairVectorFixture, vector: [0.2, 0.4, 1, 1] });
    await expect(startPairOutcome(input())).rejects.toThrow("equilíbrio");
    expect(database.mocks.outcomeCreate).not.toHaveBeenCalled();
  });
  test("loads all started partners without the history limit", async () => {
    const thirdId = parseId("00000000-0000-4000-8000-000000000003");
    database.mocks.outcomeAll.mockResolvedValue([pairOutcomeFixture, { ...pairOutcomeFixture, userAId: thirdId, userBId: pairOutcomeFixture.userAId }]);
    const partners = await getStartedPairPartners(pairOutcomeFixture.userAId);
    expect(partners.get(pairOutcomeFixture.userBId)).toBe(pairOutcomeFixture.id);
    expect(partners.get(thirdId)).toBe(pairOutcomeFixture.id);
    expect(database.mocks.outcomeSelect).toHaveBeenCalledWith("id", "userAId", "userBId");
    expect(database.mocks.outcomeLimit).not.toHaveBeenCalled();
  });
});

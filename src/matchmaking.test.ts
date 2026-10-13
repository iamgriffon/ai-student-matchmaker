import { beforeEach, describe, expect, test } from "bun:test";
import * as tf from "@tensorflow/tfjs";
import { database, dbUsersFixture } from "../db/tests/fixtutes/db.fixtures.ts";
import {
  createContextMock,
  encodePairMock,
  makeVectorContext,
  resetVectorMocks,
} from "../db/tests/fixtutes/vectorContext.fixtures.ts";
import { parseId, type UserId } from "./utils/idParser.ts";
import {
  rankWithTrainedModelMock,
  resetRankerMock,
} from "../db/tests/fixtutes/ranker.fixtures.ts";
const { evaluatePair, recommendPartners, StudentNotFoundError } =
  await import("./matchmaking.ts");
const { invalidatePairVectorCaches } = await import("../db/pairVectors.ts");

const SELECTED_ID = parseId(dbUsersFixture[0].id);
const PARTNER_ID = parseId(dbUsersFixture[1].id);
const THIRD_STUDENT_ID = parseId("00000000-0000-4000-8000-000000000003");
const FOURTH_STUDENT_ID = parseId("00000000-0000-4000-8000-000000000004");
const FIFTH_STUDENT_ID = parseId("00000000-0000-4000-8000-000000000005");
const UNKNOWN_ID = parseId("00000000-0000-4000-8000-000000000099");
const MAX_RECOMMENDATION_LIMIT = 100;
const FIXTURE_MEAN = 0.5;
let context = makeVectorContext();

beforeEach(() => {
  database.reset();
  database.mocks.pairAll.mockResolvedValue([]);
  resetRankerMock();
  invalidatePairVectorCaches();
  context = makeVectorContext();
  resetVectorMocks(context);
});

function setCandidates(
  rows: readonly RowFixture[],
) {
  const template = context.users[0];
  if (typeof template == "undefined")
    throw new Error("Expected a fixture user");
  context.students = rows.map((row) => ({
    userId: row.id,
    features: {
      score: row.score,
      income: row.income,
      disability: row.disability,
    },
  }));
  context.users = rows.map((row) => ({
    ...template,
    id: row.id,
    score: row.score * 100,
    name: row.id,
    disability: Boolean(row.disability),
  }));
  context.cohortMeanScore = FIXTURE_MEAN;
  context.studentVectors.shape = [rows.length, 3];
  resetVectorMocks(context);
}

type RowFixture = {
  id: UserId;
  score: number;
  income: number;
  disability: number;
};

const RANKING_ROWS: RowFixture[] = [
  { id: SELECTED_ID, score: 0.5, income: 0, disability: 0 },
  { id: PARTNER_ID, score: 0.5, income: 0.2, disability: 0 },
  {
    id: FOURTH_STUDENT_ID,
    score: 0.5,
    income: 0.8,
    disability: 1,
  },
  {
    id: THIRD_STUDENT_ID,
    score: 0.5,
    income: 0.8,
    disability: 1,
  },
  {
    id: FIFTH_STUDENT_ID,
    score: 0.9,
    income: 1,
    disability: 1,
  },
];

describe("evaluatePair", () => {
  test("combines academic balance and diversity using the policy weights", () => {
    expect(evaluatePair([0, 0.5, 1, 1]).eligible).toBe(true);
    expect(evaluatePair([0, 0.5, 1, 1]).score).toBeCloseTo(1);
    expect(evaluatePair([0.05, 0.25, 0.5, 1]).score).toBeCloseTo(0.55);
  });

  test("excludes academically unbalanced pairs even with high diversity", () => {
    expect(evaluatePair([0.2, 0.4, 1, 1]).eligible).toBe(false);
  });

  test("accepts the boundary with the floating-point tolerance", () => {
    expect(evaluatePair([0.1 + 5e-7, 0, 0, 0]).eligible).toBe(true);
    expect(evaluatePair([0.1 + 2e-6, 0, 0, 0]).eligible).toBe(false);
  });

  test("keeps the academic gap informative rather than penalizing it", () => {
    expect(evaluatePair([0, 0, 0.5, 0]).score).toBe(
      evaluatePair([0, 1, 0.5, 0]).score,
    );
  });

  test.each([0, -1, NaN, Infinity])(
    "rejects invalid imbalance tolerance %p",
    (tolerance) => {
      expect(() => evaluatePair([0, 0, 0, 0], tolerance)).toThrow(
        "tolerância deve ser positiva",
      );
    },
  );
});

describe("recommendPartners", () => {
  test("excludes the selected student and returns scores, metrics, and context", async () => {
    const tensorCount = tf.memory().numTensors;
    const result = await recommendPartners(SELECTED_ID);
    expect(result.userId).toBe(SELECTED_ID);
    expect(result.contextVersion).toBe(context.contextVersion);
    expect(result.selectedScore).toBe(50);
    expect(result.cohortMeanScore).toBe(62.5);
    expect(result.evaluatedCount).toBe(1);
    expect(result.eligibleCount).toBe(1);
    expect(result.recommendations).toHaveLength(1);
    expect(result.recommendations[0]?.partner.id).toBe(PARTNER_ID);
    expect(result.recommendations[0]?.score).toBeCloseTo(0.95);
    expect(result.recommendations[0]?.metrics).toEqual({
      imbalance: 0,
      academicGap: 0.25,
      incomeDistance: 0.75,
      disabilityDifference: 1,
    });
    expect(context.studentVectors.dispose).toHaveBeenCalledTimes(1);
    expect(tf.memory().numTensors).toBe(tensorCount);
  });

  test("persists every evaluated pair before applying eligibility and the result limit", async () => {
    setCandidates(RANKING_ROWS);
    const result = await recommendPartners(SELECTED_ID, 1);
    expect(result.evaluatedCount).toBe(4);
    expect(result.eligibleCount).toBe(3);
    expect(result.recommendations).toHaveLength(1);
    expect(result.recommendations[0]?.partner.id).toBe(
      THIRD_STUDENT_ID,
    );
    expect(database.mocks.upsertPair).toHaveBeenCalledTimes(4);
    expect(database.mocks.transaction).toHaveBeenCalledTimes(1);
    expect(database.mocks.upsertPair).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          userBId: FIFTH_STUDENT_ID,
          contextVersion: context.contextVersion,
        }),
      }),
    );
  });

  test("ranks descending and breaks equal-score ties by partner ID", async () => {
    setCandidates(RANKING_ROWS);
    const result = await recommendPartners(SELECTED_ID);
    expect(result.recommendations.map((pair) => pair.partner.id)).toEqual([
      THIRD_STUDENT_ID,
      FOURTH_STUDENT_ID,
      PARTNER_ID,
    ]);
  });

  test("normalizes reversed pair membership in persistence", async () => {
    await recommendPartners(PARTNER_ID);
    expect(database.mocks.upsertPair).toHaveBeenCalledWith({
      create: {
        userAId: SELECTED_ID,
        userBId: PARTNER_ID,
        vector: [0, 0.25, 0.75, 1],
        contextVersion: context.contextVersion,
      },
      update: {
        vector: [0, 0.25, 0.75, 1],
        contextVersion: context.contextVersion,
      },
      conflictOn: { userAId: SELECTED_ID, userBId: PARTNER_ID },
    });
  });

  test("returns no recommendations when all pairs are ineligible but still saves them", async () => {
    setCandidates([
      { id: SELECTED_ID, score: 0.9, income: 0, disability: 0 },
      { id: PARTNER_ID, score: 0.8, income: 1, disability: 1 },
    ]);
    const result = await recommendPartners(SELECTED_ID);
    expect(result.recommendations).toEqual([]);
    expect(result.eligibleCount).toBe(0);
    expect(database.mocks.upsertPair).toHaveBeenCalledTimes(1);
  });

  test("handles a cohort containing only the selected student", async () => {
    setCandidates([{ id: SELECTED_ID, score: 0.5, income: 0, disability: 0 }]);
    const result = await recommendPartners(SELECTED_ID);
    expect(result.evaluatedCount).toBe(0);
    expect(result.recommendations).toEqual([]);
    expect(database.mocks.transaction).not.toHaveBeenCalled();
    expect(context.studentVectors.dispose).toHaveBeenCalledTimes(1);
  });

  test("throws a not-found error and disposes the context for an unknown student", async () => {
    await expect(recommendPartners(UNKNOWN_ID)).rejects.toBeInstanceOf(
      StudentNotFoundError,
    );
    expect(context.studentVectors.dispose).toHaveBeenCalledTimes(1);
    expect(database.mocks.upsertPair).not.toHaveBeenCalled();
  });

  test("rejects invalid IDs before connecting", async () => {
    await expect(recommendPartners("invalid-id")).rejects.toThrow();
    expect(database.mocks.connectDatabase).not.toHaveBeenCalled();
  });

  test.each([0, -1, MAX_RECOMMENDATION_LIMIT + 1, 1.5, NaN, Infinity])(
    "rejects invalid limit %p before connecting",
    async (limit) => {
      await expect(recommendPartners(SELECTED_ID, limit)).rejects.toThrow(
        "O limite deve ser um inteiro",
      );
      expect(database.mocks.connectDatabase).not.toHaveBeenCalled();
    },
  );

  test("propagates connection failures without creating a context", async () => {
    database.mocks.connectDatabase.mockRejectedValueOnce(
      new Error("Connection failed"),
    );
    await expect(recommendPartners(SELECTED_ID)).rejects.toThrow(
      "Connection failed",
    );
    expect(createContextMock).not.toHaveBeenCalled();
  });

  test("propagates context errors without attempting persistence", async () => {
    createContextMock.mockRejectedValueOnce(new Error("Invalid context"));
    await expect(recommendPartners(SELECTED_ID)).rejects.toThrow(
      "Invalid context",
    );
    expect(database.mocks.upsertPair).not.toHaveBeenCalled();
  });

  test("disposes the context and pair tensors when the encoder returns an invalid vector", async () => {
    const tensorCount = tf.memory().numTensors;
    encodePairMock.mockImplementationOnce(() => tf.tensor1d([0, 0, 0]));
    await expect(recommendPartners(SELECTED_ID)).rejects.toThrow(
      "4 valores finitos",
    );
    expect(context.studentVectors.dispose).toHaveBeenCalledTimes(1);
    expect(tf.memory().numTensors).toBe(tensorCount);
    expect(database.mocks.upsertPair).not.toHaveBeenCalled();
  });

  test("disposes the context when candidate details are missing", async () => {
    context.users = context.users.filter((user) => user.id === SELECTED_ID);
    await expect(recommendPartners(SELECTED_ID)).rejects.toThrow(
      "Dados do candidato não encontrados",
    );
    expect(context.studentVectors.dispose).toHaveBeenCalledTimes(1);
  });

  test("propagates persistence failures and disposes the context", async () => {
    database.mocks.upsertPair.mockRejectedValueOnce(new Error("Save failed"));
    await expect(recommendPartners(SELECTED_ID)).rejects.toThrow("Save failed");
    expect(context.studentVectors.dispose).toHaveBeenCalledTimes(1);
  });
});

describe("recommendPartners: persisted data and trained inference", () => {
  test("reuses a stored vector for the current context without encoding or writing", async () => {
    database.mocks.pairAll.mockResolvedValueOnce([
      {
        id: UNKNOWN_ID,
        userAId: SELECTED_ID,
        userBId: PARTNER_ID,
        vector: [0, 0.25, 0.75, 1],
        contextVersion: context.contextVersion,
        createdAt: "2026-10-13",
        updatedAt: "2026-10-13",
      },
    ]);
    const result = await recommendPartners(SELECTED_ID);
    expect(result.reusedCount).toBe(1);
    expect(result.calculatedCount).toBe(0);
    expect(encodePairMock).not.toHaveBeenCalled();
    expect(database.mocks.upsertPair).not.toHaveBeenCalled();
    expect(database.mocks.pairAll).toHaveBeenCalledTimes(1);
  });

  test("recalculates outdated context vectors", async () => {
    database.mocks.pairAll.mockResolvedValueOnce([
      {
        id: UNKNOWN_ID,
        userAId: SELECTED_ID,
        userBId: PARTNER_ID,
        vector: [0, 0.25, 0.75, 1],
        contextVersion: "old-context",
        createdAt: "2026-10-13",
        updatedAt: "2026-10-13",
      },
    ]);
    const result = await recommendPartners(SELECTED_ID);
    expect(result.reusedCount).toBe(0);
    expect(result.calculatedCount).toBe(1);
    expect(encodePairMock).toHaveBeenCalledTimes(1);
    expect(database.mocks.upsertPair).toHaveBeenCalledTimes(1);
  });

  test("saves only missing pairs in a partially populated context", async () => {
    setCandidates(RANKING_ROWS);
    const partner = RANKING_ROWS[1];
    if (typeof partner == "undefined") throw new Error("Expected a candidate");
    database.mocks.pairAll.mockResolvedValueOnce([
      {
        id: UNKNOWN_ID,
        userAId: SELECTED_ID,
        userBId: partner.id,
        vector: [0, 0, 0.2, 0],
        contextVersion: context.contextVersion,
        createdAt: "2026-10-13",
        updatedAt: "2026-10-13",
      },
    ]);
    const result = await recommendPartners(SELECTED_ID);
    expect(result.reusedCount).toBe(1);
    expect(result.calculatedCount).toBe(3);
    expect(database.mocks.upsertPair).toHaveBeenCalledTimes(3);
  });

  test("uses model predictions to rank while retaining the eligibility constraint", async () => {
    setCandidates(RANKING_ROWS);
    const metadata = {
      modelId: "fixture-model",
      encoderVersion: "pair-v1",
      policyVersion: "pair-policy-v1",
      labelSource: "policy-generated" as const,
      sourceContextVersion: context.contextVersion,
      trainedAt: "2026-10-13",
      sampleCount: 100,
      trainingCount: 80,
      validationCount: 20,
      epochs: 80,
      validationMeanAbsoluteError: 0.01,
      eligibleValidationMeanAbsoluteError: 0.01,
    };
    // The last candidate is ineligible despite having the highest predicted score.
    rankWithTrainedModelMock.mockResolvedValueOnce({
      scores: [0.95, 0.5, 0.4, 1],
      metadata,
    });
    const result = await recommendPartners(SELECTED_ID);
    expect(result.rankingSource).toBe("trained-policy-model");
    expect(result.model?.modelId).toBe("fixture-model");
    expect(result.recommendations[0]?.partner.id).toBe(
      PARTNER_ID,
    );
    expect(result.recommendations[0]?.score).toBe(0.95);
    expect(result.recommendations[0]?.policyScore).toBeLessThan(0.95);
    expect(result.recommendations).toHaveLength(3);
  });

  test("identifies the explicit policy when no compatible trained model exists", async () => {
    const result = await recommendPartners(SELECTED_ID);
    expect(result.rankingSource).toBe("policy");
    expect(result.model).toBeNull();
  });

  test("propagates inference failures and disposes the context", async () => {
    rankWithTrainedModelMock.mockRejectedValueOnce(new Error("Model failed"));
    expect(recommendPartners(SELECTED_ID)).rejects.toThrow("Model failed");
    expect(context.studentVectors.dispose).toHaveBeenCalledTimes(1);
  });
});

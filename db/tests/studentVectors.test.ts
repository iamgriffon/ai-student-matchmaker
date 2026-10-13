import { beforeEach, describe, expect, spyOn, test } from "bun:test";
import { database, dbUsersFixture } from "./fixtutes/db.fixtures.ts";
import { createContextFromUsersMock as createContext, makeVectorContext as makeContext, resetVectorMocks, STORED_VECTORS } from "./fixtutes/vectorContext.fixtures.ts";

const STUDENT_FEATURE_COUNT = 3;
const INVALID_FEATURE_COUNT = 4;
const DEFAULT_SEARCH_LIMIT = 10;
const MIN_SEARCH_LIMIT = 1;
const MAX_SEARCH_LIMIT = 100;
const QUERY_VECTOR = [0.5, 0.25, 1];
const SERIALIZED_QUERY_VECTOR = "[0.5,0.25,1]";

let context = makeContext();
const {
  refreshStudentVectors, findNearestStudentVectors,
  caches, invalidateStudentVectorCaches, STUDENT_VECTORS_CACHE_TTL_MS,
} = await import("../studentVectors.ts");
const { deleteUser } = await import("../users.ts");

beforeEach(() => {
  database.reset();
  invalidateStudentVectorCaches();
  context = makeContext();
  resetVectorMocks(context);
});

describe("db/studentVectors", () => {
  describe("refreshStudentVectors", () => {
    test("writes one vector per user in a transaction", async () => {
      await refreshStudentVectors();

      expect(database.mocks.connectDatabase).toHaveBeenCalledTimes(1);
      expect(createContext).toHaveBeenCalledTimes(1);
      expect(context.studentVectors.data).toHaveBeenCalledTimes(1);
      expect(database.mocks.transaction).toHaveBeenCalledTimes(1);
      expect(database.mocks.upsertVector).toHaveBeenCalledTimes(dbUsersFixture.length);
      for (const [index, user] of dbUsersFixture.entries()) {
        expect(database.mocks.upsertVector).toHaveBeenNthCalledWith(index + 1, {
          create: { userId: user.id, vector: STORED_VECTORS[index] },
          update: { vector: STORED_VECTORS[index] },
          conflictOn: { userId: user.id },
        });
      }
      expect(context.studentVectors.dispose).toHaveBeenCalledTimes(1);
    });

    test("rejects an incompatible feature count and disposes the tensor", async () => {
      context.studentVectors.shape = [dbUsersFixture.length, INVALID_FEATURE_COUNT];
      expect(refreshStudentVectors()).rejects.toThrow("Student vectors must have three features");
      expect(context.studentVectors.data).not.toHaveBeenCalled();
      expect(database.mocks.transaction).toHaveBeenCalledTimes(1);
      expect(context.studentVectors.dispose).toHaveBeenCalledTimes(1);
    });

    test("disposes the tensor when reading its values fails", async () => {
      context.studentVectors.data.mockRejectedValueOnce(new Error("Tensor read failed"));
      expect(refreshStudentVectors()).rejects.toThrow("Tensor read failed");
      expect(database.mocks.transaction).toHaveBeenCalledTimes(1);
      expect(context.studentVectors.dispose).toHaveBeenCalledTimes(1);
    });

    test("propagates transaction errors before creating the context", async () => {
      database.mocks.transaction.mockRejectedValueOnce(new Error("Transaction failed"));
      expect(refreshStudentVectors()).rejects.toThrow("Transaction failed");
      expect(database.mocks.upsertVector).not.toHaveBeenCalled();
      expect(createContext).not.toHaveBeenCalled();
      expect(context.studentVectors.dispose).not.toHaveBeenCalled();
    });

    test("stops writing when an upsert fails and disposes the tensor", async () => {
      database.mocks.upsertVector.mockRejectedValueOnce(new Error("Upsert failed"));
      expect(refreshStudentVectors()).rejects.toThrow("Upsert failed");
      expect(database.mocks.upsertVector).toHaveBeenCalledTimes(1);
      expect(context.studentVectors.dispose).toHaveBeenCalledTimes(1);
    });

    test("does not create a context when connecting fails", async () => {
      database.mocks.connectDatabase.mockRejectedValueOnce(new Error("Connection failed"));
      expect(refreshStudentVectors()).rejects.toThrow("Connection failed");
      expect(createContext).not.toHaveBeenCalled();
      expect(database.mocks.transaction).not.toHaveBeenCalled();
    });

    test("propagates context preparation errors from inside the transaction", async () => {
      createContext.mockImplementationOnce(() => { throw new Error("Nenhum aluno disponível"); });
      await expect(refreshStudentVectors()).rejects.toThrow("Nenhum aluno disponível");
      expect(database.mocks.transaction).toHaveBeenCalledTimes(1);
      // O contexto não foi retornado, então não há tensor sob responsabilidade do serviço.
      expect(context.studentVectors.dispose).not.toHaveBeenCalled();
    });
  });

  describe("findNearestStudentVectors", () => {
    test("builds a parameterized nearest-neighbor query excluding the selected user", async () => {
      const result = await findNearestStudentVectors(dbUsersFixture[0].id, QUERY_VECTOR);

      expect(result).toEqual(database.nearestRows);
      expect(database.mocks.connectDatabase).toHaveBeenCalledTimes(1);
      const sqlCall = database.mocks.sql.mock.calls[0];
      if (typeof sqlCall == 'undefined') throw new Error("Expected a SQL query");
      const [strings, ...parameters] = sqlCall;
      const sqlText = strings.join("?");
      expect(sqlText).toContain('FROM "public"."StudentVectors"');
      expect(sqlText).toContain('WHERE "userId" <> ?');
      expect(sqlText).toContain('ORDER BY "vector" <-> ?::vector(3), "userId"');
      expect(sqlText).toContain("LIMIT ?");
      expect(sqlText).not.toContain("discount");
      expect(parameters).toEqual([
        SERIALIZED_QUERY_VECTOR, dbUsersFixture[0].id,
        SERIALIZED_QUERY_VECTOR, DEFAULT_SEARCH_LIMIT,
      ]);
      expect(database.mocks.returnsRow).toHaveBeenCalledWith({
        userId: { codecId: "pg/text@1" },
        distance: { codecId: "pg/float8@1" },
      });
      expect(database.mocks.query).toHaveBeenCalledWith(database.queryPlan);
    });

    test.each([MIN_SEARCH_LIMIT, MAX_SEARCH_LIMIT])("accepts the boundary limit %i", async (limit) => {
      await findNearestStudentVectors(dbUsersFixture[0].id, QUERY_VECTOR, limit);
      const sqlCall = database.mocks.sql.mock.calls[0];
      if (typeof sqlCall == 'undefined') throw new Error("Expected a SQL query");
      expect(sqlCall.at(-1)).toBe(limit);
    });

    test.each([
      [[]], [[0.5, 0.25]], [[0.5, 0.25, 1, 0]],
      [[NaN, 0, 1]], [[Infinity, 0, 1]], [[-Infinity, 0, 1]],
    ])("rejects invalid vector %j before connecting", async (vector) => {
       expect(findNearestStudentVectors(dbUsersFixture[0].id, vector)).rejects.toThrow(
        "Query vectors must have three finite features",
      );
      expect(database.mocks.connectDatabase).not.toHaveBeenCalled();
      expect(database.mocks.query).not.toHaveBeenCalled();
    });

    test.each([0, -1, MAX_SEARCH_LIMIT + 1, 1.5, NaN, Infinity])("rejects invalid limit %s before connecting", async (limit) => {
       expect(findNearestStudentVectors(dbUsersFixture[0].id, QUERY_VECTOR, limit)).rejects.toThrow(
        "Search limit must be an integer between 1 and 100",
      );
      expect(database.mocks.connectDatabase).not.toHaveBeenCalled();
      expect(database.mocks.query).not.toHaveBeenCalled();
    });

    test("returns an empty result when the database has no candidates", async () => {
      database.mocks.query.mockResolvedValueOnce([]);
      expect(await findNearestStudentVectors(dbUsersFixture[0].id, QUERY_VECTOR)).toEqual([]);
    });

    test("propagates connection failures without building a query", async () => {
      database.mocks.connectDatabase.mockRejectedValueOnce(new Error("Connection failed"));
       expect(findNearestStudentVectors(dbUsersFixture[0].id, QUERY_VECTOR)).rejects.toThrow("Connection failed");
      expect(database.mocks.sql).not.toHaveBeenCalled();
    });

    test("propagates query failures", async () => {
      database.mocks.query.mockRejectedValueOnce(new Error("Query failed"));
       expect(findNearestStudentVectors(dbUsersFixture[0].id, QUERY_VECTOR)).rejects.toThrow("Query failed");
    });
  });

  const TEST_CLOCK_TIME_MS = 1_800_000_000_000;
  const DIFFERENT_QUERY_VECTOR = [0.75, 0.25, 1];
  const MODIFIED_DISTANCE = 999;
  const search = () => findNearestStudentVectors(dbUsersFixture[0].id, QUERY_VECTOR);

  describe("cache", () => {
    test("reuses an unexpired search without connecting or building SQL again", async () => {
      const initial = await search();
      expect(await search()).toEqual(initial);
      expect(database.mocks.connectDatabase).toHaveBeenCalledTimes(1);
      expect(database.mocks.sql).toHaveBeenCalledTimes(1);
      expect(database.mocks.query).toHaveBeenCalledTimes(1);
      expect(caches.nearest.size).toBe(1);
    });

    test("shares a key for separate arrays containing the same feature values", async () => {
      await search();
      await findNearestStudentVectors(dbUsersFixture[0].id, [...QUERY_VECTOR]);
      expect(database.mocks.query).toHaveBeenCalledTimes(1);
    });

    test("separates keys by excluded user, vector, and limit", async () => {
      await search();
      await findNearestStudentVectors(dbUsersFixture[1].id, QUERY_VECTOR);
      await findNearestStudentVectors(dbUsersFixture[0].id, DIFFERENT_QUERY_VECTOR);
      await findNearestStudentVectors(dbUsersFixture[0].id, QUERY_VECTOR, MIN_SEARCH_LIMIT);
      await search();
      expect(database.mocks.query).toHaveBeenCalledTimes(4);
      expect(caches.nearest.size).toBe(4);
    });

    test("refreshes the cache exactly at the one-hour expiration", async () => {
      const clock = spyOn(Date, "now").mockReturnValue(TEST_CLOCK_TIME_MS);
      try {
        await search();
        expect(caches.nearest.values().next().value?.expiresAt).toBe(TEST_CLOCK_TIME_MS + STUDENT_VECTORS_CACHE_TTL_MS);
        clock.mockReturnValue(TEST_CLOCK_TIME_MS + STUDENT_VECTORS_CACHE_TTL_MS);
        await search();
        expect(database.mocks.query).toHaveBeenCalledTimes(2);
        expect(caches.nearest.values().next().value?.expiresAt).toBe(TEST_CLOCK_TIME_MS + STUDENT_VECTORS_CACHE_TTL_MS * 2);
      } finally {
        clock.mockRestore();
      }
    });

    test("caches empty search results", async () => {
      database.mocks.query.mockResolvedValueOnce([]);
      expect(await search()).toEqual([]);
      expect(await search()).toEqual([]);
      expect(database.mocks.query).toHaveBeenCalledTimes(1);
    });

    test("does not cache failures and retries the next search", async () => {
      database.mocks.query.mockRejectedValueOnce(new Error("Query failed"));
      await expect(search()).rejects.toThrow("Query failed");
      expect(caches.nearest.size).toBe(0);
      expect(await search()).toEqual(database.nearestRows);
      expect(database.mocks.query).toHaveBeenCalledTimes(2);
    });

    test("does not allow callers to mutate cached arrays or rows", async () => {
      const initial = await search();
      const first = initial[0];
      if (typeof first == 'undefined') throw new Error("Expected a nearest result");
      first.distance = MODIFIED_DISTANCE;
      initial.pop();
      expect(await search()).toEqual(database.nearestRows);
      expect(database.mocks.query).toHaveBeenCalledTimes(1);
    });

    test("invalidates searches after a successful vector refresh", async () => {
      await search();
      await refreshStudentVectors();
      expect(caches.nearest.size).toBe(0);
      await search();
      expect(database.mocks.query).toHaveBeenCalledTimes(2);
    });

    test("preserves searches when refreshing vectors fails", async () => {
      await search();
      database.mocks.upsertVector.mockRejectedValueOnce(new Error("Upsert failed"));
      await expect(refreshStudentVectors()).rejects.toThrow("Upsert failed");
      await search();
      expect(database.mocks.query).toHaveBeenCalledTimes(1);
    });

    test("invalidates searches after a successful user deletion", async () => {
      await search();
      expect((await deleteUser(dbUsersFixture[0].id)).success).toBe(true);
      expect(caches.nearest.size).toBe(0);
      await search();
      expect(database.mocks.query).toHaveBeenCalledTimes(2);
    });

    test("preserves searches when deleting a user fails", async () => {
      await search();
      database.mocks.delete.mockRejectedValueOnce(new Error("Delete failed"));
      expect((await deleteUser(dbUsersFixture[0].id)).success).toBe(false);
      await search();
      expect(database.mocks.query).toHaveBeenCalledTimes(1);
    });

    test("does not cache a pending read after a refresh invalidates it", async () => {
      const started = Promise.withResolvers<void>();
      const pending = Promise.withResolvers<typeof database.nearestRows>();
      database.mocks.query.mockImplementationOnce(() => {
        started.resolve();
        return pending.promise;
      });
      const reading = search();
      await started.promise;
      await refreshStudentVectors();
      pending.resolve(database.nearestRows);
      await reading;
      expect(caches.nearest.size).toBe(0);
      await search();
      expect(database.mocks.query).toHaveBeenCalledTimes(2);
    });

    test("rejects a sparse vector before checking the cache or connecting", async () => {
      await expect(findNearestStudentVectors(dbUsersFixture[0].id, new Array<number>(STUDENT_FEATURE_COUNT))).rejects.toThrow("finite features");
      expect(database.mocks.connectDatabase).not.toHaveBeenCalled();
      expect(caches.nearest.size).toBe(0);
    });
  });
});

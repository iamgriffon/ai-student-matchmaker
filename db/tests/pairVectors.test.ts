import { beforeEach, describe, expect, spyOn, test } from "bun:test";
import contract from "../generated/contract.json" with { type: "json" };
import { database, dbUsersFixture, pairVectorFixture } from "./fixtutes/db.fixtures.ts";

const {
  getPairVectors, getPairVectorsById, getPairVectorByUsers, getPairVectorsForUser, getPairVectorsForContext, savePairVectors,
  caches, invalidatePairVectorCaches, PAIR_VECTORS_CACHE_TTL_MS,
} = await import("../pairVectors.ts");
const { deleteUser } = await import("../users.ts");
beforeEach(() => {
  database.reset();
  invalidatePairVectorCaches();
});

const PAIR_FEATURE_COUNT = 4;
const STUDENT_FEATURE_COUNT = 3;
const USER_ID_LENGTH = 36;
const publicStorage = contract.storage.namespaces.public;
const pairTable = publicStorage.entries.table.PairVectors;

// Estes testes verificam o contrato gerado. Não executam constraints ou
// cascatas no PostgreSQL; os serviços são testados com mocks abaixo.
describe("db/pairVectors", () => {
  describe("contract", () => {
    test("uses a native pgvector column with four dimensions", () => {
      expect(pairTable.columns.vector).toMatchObject({
        codecId: "pg/vector@1", dataType: "pgvector/vector", nullable: false, typeRef: "PairVector",
      });
      expect(contract.storage.types.PairVector.typeParams).toEqual({ length: PAIR_FEATURE_COUNT });
      expect(contract.storage.types.StudentVector.typeParams).toEqual({ length: STUDENT_FEATURE_COUNT });
    });

    test("requires two student identifiers", () => {
      for (const field of ["userAId", "userBId"] as const) {
        expect(pairTable.columns[field]).toMatchObject({
          nullable: false, typeParams: { length: USER_ID_LENGTH },
        });
      }
    });

    test("declares an ordered pair check that also prevents pairing a student with themselves", () => {
      expect(pairTable.checks).toEqual(expect.arrayContaining([
        expect.objectContaining({ expression: '"userAId" < "userBId"' }),
      ]));
    });

    test("declares uniqueness for the combination of students", () => {
      expect(pairTable.uniques).toContainEqual({ columns: ["userAId", "userBId"] });
    });

    test.each(["userAId", "userBId"])("links %s to Users with cascading deletion", (field) => {
      const foreignKey = pairTable.foreignKeys.find((key) => key.source.columns.includes(field));
      expect(foreignKey).toMatchObject({
        source: { columns: [field], tableName: "PairVectors", namespaceId: "public" },
        target: { columns: ["id"], tableName: "Users", namespaceId: "public" },
        onDelete: "cascade",
      });
    });

    test("indexes the second member so queries can find either side of a pair", () => {
      expect(pairTable.indexes).toEqual(expect.arrayContaining([
        expect.objectContaining({ columns: ["userBId"] }),
      ]));
    });

    test("requires a version for the feature-generation context", () => {
      expect(pairTable.columns.contextVersion).toMatchObject({ codecId: "pg/text@1", nullable: false });
    });

    test("does not store an individual discount or a single userId", () => {
      expect(pairTable.columns).not.toHaveProperty("discount");
      expect(pairTable.columns).not.toHaveProperty("userId");
    });

    test("declares a primary identifier and timestamps", () => {
      expect(pairTable.primaryKey).toEqual({ columns: ["id"] });
      expect(pairTable.columns.createdAt.nullable).toBe(false);
      expect(pairTable.columns.updatedAt.nullable).toBe(false);
    });
  });

  const CONTEXT_VERSION = pairVectorFixture.contextVersion;
  const UPDATED_CONTEXT_VERSION = "cohort-v2";
  const MIN_QUERY_LIMIT = 1;
  const MAX_QUERY_LIMIT = 100;
  const PAIR_LOOKUP_FILTER_COUNT = 3;
  const UPDATED_VECTOR = [0.025, 0.5, 0.125, 0];
  const validPair = {
    userAId: dbUsersFixture[0].id,
    userBId: dbUsersFixture[1].id,
    vector: pairVectorFixture.vector,
  };

  describe("getPairVectors", () => {
    test("lists all stored pairs without applying a limit", async () => {
      expect(await getPairVectors()).toEqual([pairVectorFixture]);
      expect(database.mocks.connectDatabase).toHaveBeenCalledTimes(1);
      expect(database.mocks.pairLimit).not.toHaveBeenCalled();
    });

    test.each([MIN_QUERY_LIMIT, MAX_QUERY_LIMIT])("accepts boundary limit %i", async (limit) => {
      expect(await getPairVectors(limit)).toEqual([pairVectorFixture]);
      expect(database.mocks.pairLimit).toHaveBeenCalledWith(limit);
    });

    test.each([0, -1, MAX_QUERY_LIMIT + 1, 1.5, NaN, Infinity])("rejects invalid limit %p before connecting", async (limit) => {
      await expect(getPairVectors(limit)).rejects.toThrow("O limite deve ser um inteiro");
      expect(database.mocks.connectDatabase).not.toHaveBeenCalled();
    });

    test("returns an empty list when no pairs exist", async () => {
      database.mocks.pairAll.mockResolvedValueOnce([]);
      expect(await getPairVectors()).toEqual([]);
    });

    test("propagates database failures", async () => {
      database.mocks.pairAll.mockRejectedValueOnce(new Error("List failed"));
      await expect(getPairVectors()).rejects.toThrow("List failed");
    });

    test("does not query when connecting fails", async () => {
      database.mocks.connectDatabase.mockRejectedValueOnce(new Error("Connection failed"));
      await expect(getPairVectors()).rejects.toThrow("Connection failed");
      expect(database.mocks.pairAll).not.toHaveBeenCalled();
    });
  });

  describe("getPairVectorsById", () => {
    test("queries by a validated identifier using an equality predicate", async () => {
      expect(await getPairVectorsById(` ${pairVectorFixture.id} `)).toEqual(pairVectorFixture);
      expect(database.mocks.pairWhere).toHaveBeenCalledWith(expect.any(Function));
      expect(database.mocks.pairIdEq).toHaveBeenCalledWith(pairVectorFixture.id);
    });

    test("returns null for an unknown identifier", async () => {
      database.mocks.pairFirst.mockResolvedValueOnce(null);
      expect(await getPairVectorsById(pairVectorFixture.id)).toBeNull();
    });

    test("rejects an invalid identifier before connecting", async () => {
      await expect(getPairVectorsById("invalid-id")).rejects.toThrow();
      expect(database.mocks.connectDatabase).not.toHaveBeenCalled();
      expect(database.mocks.pairWhere).not.toHaveBeenCalled();
    });

    test("propagates lookup failures", async () => {
      database.mocks.pairFirst.mockRejectedValueOnce(new Error("Lookup failed"));
      await expect(getPairVectorsById(pairVectorFixture.id)).rejects.toThrow("Lookup failed");
    });

    test("does not query when connecting fails", async () => {
      database.mocks.connectDatabase.mockRejectedValueOnce(new Error("Connection failed"));
      await expect(getPairVectorsById(pairVectorFixture.id)).rejects.toThrow("Connection failed");
      expect(database.mocks.pairWhere).not.toHaveBeenCalled();
    });
  });

  describe("getPairVectorByUsers", () => {
    test("normalizes member order and filters by the requested context", async () => {
      expect(await getPairVectorByUsers(validPair.userBId, validPair.userAId, ` ${CONTEXT_VERSION} `)).toEqual(pairVectorFixture);
      expect(database.mocks.pairUserAEq).toHaveBeenCalledWith(validPair.userAId);
      expect(database.mocks.pairUserBEq).toHaveBeenCalledWith(validPair.userBId);
      expect(database.mocks.pairContextEq).toHaveBeenCalledWith(CONTEXT_VERSION);
      expect(database.mocks.pairWhere).toHaveBeenCalledTimes(PAIR_LOOKUP_FILTER_COUNT);
    });

    test("returns null when no pair exists for the current context", async () => {
      database.mocks.pairFirst.mockResolvedValueOnce(null);
      expect(await getPairVectorByUsers(validPair.userAId, validPair.userBId, UPDATED_CONTEXT_VERSION)).toBeNull();
      expect(database.mocks.pairContextEq).toHaveBeenCalledWith(UPDATED_CONTEXT_VERSION);
    });

    test("rejects two occurrences of the same student", async () => {
      await expect(getPairVectorByUsers(validPair.userAId, validPair.userAId, CONTEXT_VERSION)).rejects.toThrow("dois alunos diferentes");
      expect(database.mocks.connectDatabase).not.toHaveBeenCalled();
    });

    test("rejects an invalid member identifier", async () => {
      await expect(getPairVectorByUsers("invalid-id", validPair.userBId, CONTEXT_VERSION)).rejects.toThrow();
      expect(database.mocks.connectDatabase).not.toHaveBeenCalled();
    });

    test("rejects a blank context version", async () => {
      await expect(getPairVectorByUsers(validPair.userAId, validPair.userBId, " ")).rejects.toThrow("versão do contexto");
      expect(database.mocks.connectDatabase).not.toHaveBeenCalled();
    });

    test("propagates lookup failures", async () => {
      database.mocks.pairFirst.mockRejectedValueOnce(new Error("Lookup failed"));
      await expect(getPairVectorByUsers(validPair.userAId, validPair.userBId, CONTEXT_VERSION)).rejects.toThrow("Lookup failed");
    });
  });

  describe("savePairVectors", () => {
    test("saves canonical member IDs, features, and context in a transaction", async () => {
      await savePairVectors([{ ...validPair, userAId: ` ${validPair.userBId} `, userBId: validPair.userAId }], ` ${CONTEXT_VERSION} `);
      expect(database.mocks.connectDatabase).toHaveBeenCalledTimes(1);
      expect(database.mocks.transaction).toHaveBeenCalledTimes(1);
      expect(database.mocks.upsertPair).toHaveBeenCalledWith({
        create: { ...validPair, contextVersion: CONTEXT_VERSION },
        update: { vector: validPair.vector, contextVersion: CONTEXT_VERSION },
        conflictOn: { userAId: validPair.userAId, userBId: validPair.userBId },
      });
    });

    test("updates the vector and context using the same conflict target", async () => {
      await savePairVectors([validPair], CONTEXT_VERSION);
      await savePairVectors([{ ...validPair, vector: UPDATED_VECTOR }], UPDATED_CONTEXT_VERSION);
      expect(database.mocks.upsertPair).toHaveBeenNthCalledWith(2, {
        create: { ...validPair, vector: UPDATED_VECTOR, contextVersion: UPDATED_CONTEXT_VERSION },
        update: { vector: UPDATED_VECTOR, contextVersion: UPDATED_CONTEXT_VERSION },
        conflictOn: { userAId: validPair.userAId, userBId: validPair.userBId },
      });
    });

    test("writes all pairs in one transaction", async () => {
      await savePairVectors([validPair, { ...validPair, userBId: pairVectorFixture.id }], CONTEXT_VERSION);
      expect(database.mocks.transaction).toHaveBeenCalledTimes(1);
      expect(database.mocks.upsertPair).toHaveBeenCalledTimes(2);
    });

    test("does not connect for an empty batch", async () => {
      await savePairVectors([], CONTEXT_VERSION);
      expect(database.mocks.connectDatabase).not.toHaveBeenCalled();
      expect(database.mocks.transaction).not.toHaveBeenCalled();
    });

    test("rejects a blank context even for an empty batch", async () => {
      await expect(savePairVectors([], " ")).rejects.toThrow("versão do contexto");
      expect(database.mocks.connectDatabase).not.toHaveBeenCalled();
    });

    test("rejects pairing a student with themselves after ID normalization", async () => {
      const id = "abcdef01-1234-4000-8000-000000000001";
      await expect(savePairVectors([{ ...validPair, userAId: id, userBId: ` ${id.toUpperCase()} ` }], CONTEXT_VERSION)).rejects.toThrow("dois alunos diferentes");
      expect(database.mocks.transaction).not.toHaveBeenCalled();
    });

    test("validates all member identifiers before any writes", async () => {
      await expect(savePairVectors([validPair, { ...validPair, userBId: "invalid-id" }], CONTEXT_VERSION)).rejects.toThrow();
      expect(database.mocks.connectDatabase).not.toHaveBeenCalled();
      expect(database.mocks.upsertPair).not.toHaveBeenCalled();
    });

    for (const [label, vector] of [
      ["empty vector", []], ["too few features", [0, 0, 0]],
      ["too many features", [0, 0, 0, 0, 0]], ["NaN", [NaN, 0, 0, 0]],
      ["infinity", [0, Infinity, 0, 0]], ["negative feature", [-0.1, 0, 0, 0]],
      ["feature above one", [0, 0, 1.1, 0]],
    ] as const) {
      test(`rejects ${label} before writing the batch`, async () => {
        await expect(savePairVectors([validPair, { ...validPair, vector }], CONTEXT_VERSION)).rejects.toThrow("valores finitos");
        expect(database.mocks.connectDatabase).not.toHaveBeenCalled();
        expect(database.mocks.upsertPair).not.toHaveBeenCalled();
      });
    }

    test("accepts normalized feature boundaries", async () => {
      const vector = [0, 1, 0, 1];
      await savePairVectors([{ ...validPair, vector }], CONTEXT_VERSION);
      expect(database.mocks.upsertPair).toHaveBeenCalledWith(expect.objectContaining({
        update: { vector, contextVersion: CONTEXT_VERSION },
      }));
    });

    test("rejects a sparse vector with missing values", async () => {
      const vector = new Array<number>(PAIR_FEATURE_COUNT);
      await expect(savePairVectors([{ ...validPair, vector }], CONTEXT_VERSION)).rejects.toThrow("valores finitos");
      expect(database.mocks.connectDatabase).not.toHaveBeenCalled();
    });

    test("does not write when connecting fails", async () => {
      database.mocks.connectDatabase.mockRejectedValueOnce(new Error("Connection failed"));
      await expect(savePairVectors([validPair], CONTEXT_VERSION)).rejects.toThrow("Connection failed");
      expect(database.mocks.upsertPair).not.toHaveBeenCalled();
    });

    test("propagates transaction failures", async () => {
      database.mocks.transaction.mockRejectedValueOnce(new Error("Transaction failed"));
      await expect(savePairVectors([validPair], CONTEXT_VERSION)).rejects.toThrow("Transaction failed");
      expect(database.mocks.upsertPair).not.toHaveBeenCalled();
    });

    test("propagates upsert failures and stops processing the batch", async () => {
      database.mocks.upsertPair.mockRejectedValueOnce(new Error("Upsert failed"));
      await expect(savePairVectors([validPair, { ...validPair, userBId: pairVectorFixture.id }], CONTEXT_VERSION)).rejects.toThrow("Upsert failed");
      expect(database.mocks.upsertPair).toHaveBeenCalledTimes(1);
    });
  });

  const TEST_CLOCK_TIME_MS = 1_800_000_000_000;
  const readAllCachedQueries = () => Promise.all([
    getPairVectors(),
    getPairVectorsById(pairVectorFixture.id),
    getPairVectorByUsers(validPair.userAId, validPair.userBId, CONTEXT_VERSION),
  ]);

  for (const { name, read, query, cache } of [
    { name: "list", read: () => getPairVectors(), query: database.mocks.pairAll, cache: caches.lists },
    { name: "ID", read: () => getPairVectorsById(pairVectorFixture.id), query: database.mocks.pairFirst, cache: caches.byId },
    {
      name: "members and context",
      read: () => getPairVectorByUsers(validPair.userAId, validPair.userBId, CONTEXT_VERSION),
      query: database.mocks.pairFirst, cache: caches.byUsers,
    },
  ]) {
    describe(`cache/${name}`, () => {
      test("reuses an unexpired entry without connecting again", async () => {
        const initial = await read();
        expect(await read()).toEqual(initial);
        expect(query).toHaveBeenCalledTimes(1);
        expect(database.mocks.connectDatabase).toHaveBeenCalledTimes(1);
        expect(cache.size).toBe(1);
      });

      test("refreshes an entry exactly at the one-hour expiration", async () => {
        const clock = spyOn(Date, "now").mockReturnValue(TEST_CLOCK_TIME_MS);
        try {
          await read();
          const entry = cache.values().next().value;
          expect(entry?.expiresAt).toBe(TEST_CLOCK_TIME_MS + PAIR_VECTORS_CACHE_TTL_MS);
          clock.mockReturnValue(TEST_CLOCK_TIME_MS + PAIR_VECTORS_CACHE_TTL_MS);
          await read();
          expect(query).toHaveBeenCalledTimes(2);
          expect(cache.values().next().value?.expiresAt).toBe(TEST_CLOCK_TIME_MS + PAIR_VECTORS_CACHE_TTL_MS * 2);
        } finally {
          clock.mockRestore();
        }
      });

      test("does not cache a query failure and retries the next call", async () => {
        query.mockRejectedValueOnce(new Error("Cache query failed"));
        await expect(read()).rejects.toThrow("Cache query failed");
        expect(cache.size).toBe(0);
        await read();
        expect(query).toHaveBeenCalledTimes(2);
        expect(cache.size).toBe(1);
      });
    });
  }

  describe("cache/keys and results", () => {
    test("keeps unlimited and differently limited lists separate", async () => {
      await getPairVectors();
      await getPairVectors(MIN_QUERY_LIMIT);
      await getPairVectors(MAX_QUERY_LIMIT);
      await getPairVectors(MIN_QUERY_LIMIT);
      expect(database.mocks.pairAll).toHaveBeenCalledTimes(3);
      expect(caches.lists.size).toBe(3);
    });

    test("keeps different record IDs separate", async () => {
      await getPairVectorsById(pairVectorFixture.id);
      await getPairVectorsById(validPair.userAId);
      await getPairVectorsById(pairVectorFixture.id);
      expect(database.mocks.pairFirst).toHaveBeenCalledTimes(2);
      expect(caches.byId.size).toBe(2);
    });

    test("shares a key for reversed members and whitespace-normalized context", async () => {
      await getPairVectorByUsers(validPair.userAId, validPair.userBId, CONTEXT_VERSION);
      await getPairVectorByUsers(validPair.userBId, validPair.userAId, ` ${CONTEXT_VERSION} `);
      expect(database.mocks.pairFirst).toHaveBeenCalledTimes(1);
      expect(caches.byUsers.size).toBe(1);
    });

    test("keeps different members and context versions separate", async () => {
      await getPairVectorByUsers(validPair.userAId, validPair.userBId, CONTEXT_VERSION);
      await getPairVectorByUsers(validPair.userAId, validPair.userBId, UPDATED_CONTEXT_VERSION);
      await getPairVectorByUsers(validPair.userAId, pairVectorFixture.id, CONTEXT_VERSION);
      expect(database.mocks.pairFirst).toHaveBeenCalledTimes(3);
      expect(caches.byUsers.size).toBe(3);
    });

    test("caches an empty list", async () => {
      database.mocks.pairAll.mockResolvedValueOnce([]);
      expect(await getPairVectors()).toEqual([]);
      expect(await getPairVectors()).toEqual([]);
      expect(database.mocks.pairAll).toHaveBeenCalledTimes(1);
    });

    test("caches missing results by ID and members", async () => {
      database.mocks.pairFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
      expect(await getPairVectorsById(pairVectorFixture.id)).toBeNull();
      expect(await getPairVectorByUsers(validPair.userAId, validPair.userBId, CONTEXT_VERSION)).toBeNull();
      expect(await getPairVectorsById(pairVectorFixture.id)).toBeNull();
      expect(await getPairVectorByUsers(validPair.userBId, validPair.userAId, CONTEXT_VERSION)).toBeNull();
      expect(database.mocks.pairFirst).toHaveBeenCalledTimes(2);
    });

    test("does not expose cached arrays or records to caller mutation", async () => {
      const listed = await getPairVectors();
      listed.pop();
      expect(await getPairVectors()).toEqual([pairVectorFixture]);

      const found = await getPairVectorsById(pairVectorFixture.id);
      if (!found) throw new Error("Expected a stored pair");
      found.contextVersion = "caller-modified-version";
      expect(await getPairVectorsById(pairVectorFixture.id)).toEqual(pairVectorFixture);
      expect(database.mocks.pairFirst).toHaveBeenCalledTimes(1);
    });
  });

  describe("cache/invalidation", () => {
    test("clears all query caches after a successful save", async () => {
      await readAllCachedQueries();
      await savePairVectors([validPair], CONTEXT_VERSION);
      expect(caches.lists.size).toBe(0);
      expect(caches.byId.size).toBe(0);
      expect(caches.byUsers.size).toBe(0);
      await readAllCachedQueries();
      expect(database.mocks.pairAll).toHaveBeenCalledTimes(2);
      expect(database.mocks.pairFirst).toHaveBeenCalledTimes(4);
    });

    test("preserves existing caches when a save fails", async () => {
      await readAllCachedQueries();
      database.mocks.upsertPair.mockRejectedValueOnce(new Error("Save failed"));
      await expect(savePairVectors([validPair], CONTEXT_VERSION)).rejects.toThrow("Save failed");
      await readAllCachedQueries();
      expect(database.mocks.pairAll).toHaveBeenCalledTimes(1);
      expect(database.mocks.pairFirst).toHaveBeenCalledTimes(2);
    });

    test("does not invalidate for an empty batch", async () => {
      await readAllCachedQueries();
      await savePairVectors([], CONTEXT_VERSION);
      await readAllCachedQueries();
      expect(database.mocks.pairAll).toHaveBeenCalledTimes(1);
      expect(database.mocks.pairFirst).toHaveBeenCalledTimes(2);
    });

    test("clears cached pairs after deleting a user", async () => {
      await readAllCachedQueries();
      expect((await deleteUser(validPair.userAId)).success).toBe(true);
      expect(caches.lists.size).toBe(0);
      expect(caches.byId.size).toBe(0);
      expect(caches.byUsers.size).toBe(0);
    });

    test("preserves cached pairs when deleting a user fails", async () => {
      await readAllCachedQueries();
      database.mocks.delete.mockRejectedValueOnce(new Error("Delete failed"));
      expect((await deleteUser(validPair.userAId)).success).toBe(false);
      await readAllCachedQueries();
      expect(database.mocks.pairAll).toHaveBeenCalledTimes(1);
      expect(database.mocks.pairFirst).toHaveBeenCalledTimes(2);
    });

    test("does not repopulate the cache from a read started before invalidation", async () => {
      const started = Promise.withResolvers<void>();
      const pending = Promise.withResolvers<typeof pairVectorFixture[]>();
      database.mocks.pairAll.mockImplementationOnce(() => {
        started.resolve();
        return pending.promise;
      });
      const reading = getPairVectors();
      await started.promise;
      await savePairVectors([validPair], CONTEXT_VERSION);
      pending.resolve([pairVectorFixture]);
      await reading;
      expect(caches.lists.size).toBe(0);
      await getPairVectors();
      expect(database.mocks.pairAll).toHaveBeenCalledTimes(2);
    });
  });
  describe("bulk queries", () => {
    test("loads both member positions in one query for the current context", async () => {
      expect(await getPairVectorsForUser(validPair.userAId, CONTEXT_VERSION)).toEqual([pairVectorFixture]);
      expect(database.mocks.pairUserAEq).toHaveBeenCalledWith(validPair.userAId);
      expect(database.mocks.pairUserBEq).toHaveBeenCalledWith(validPair.userAId);
      expect(database.mocks.pairContextEq).toHaveBeenCalledWith(CONTEXT_VERSION);
      expect(database.mocks.pairAll).toHaveBeenCalledTimes(1);
    });

    test("caches each student and context combination separately", async () => {
      await getPairVectorsForUser(validPair.userAId, CONTEXT_VERSION);
      await getPairVectorsForUser(validPair.userAId, CONTEXT_VERSION);
      await getPairVectorsForUser(validPair.userBId, CONTEXT_VERSION);
      await getPairVectorsForUser(validPair.userAId, UPDATED_CONTEXT_VERSION);
      expect(database.mocks.pairAll).toHaveBeenCalledTimes(3);
      expect(caches.byStudent.size).toBe(3);
    });

    test("caches the training dataset by its normalized context version", async () => {
      await getPairVectorsForContext(CONTEXT_VERSION);
      await getPairVectorsForContext(` ${CONTEXT_VERSION} `);
      expect(database.mocks.pairAll).toHaveBeenCalledTimes(1);
      expect(caches.byContext.size).toBe(1);
    });

    test("rejects invalid IDs and blank contexts before connecting", async () => {
      await expect(getPairVectorsForUser("invalid", CONTEXT_VERSION)).rejects.toThrow();
      await expect(getPairVectorsForContext(" ")).rejects.toThrow();
      expect(database.mocks.connectDatabase).not.toHaveBeenCalled();
    });

    test("does not cache failed bulk reads", async () => {
      database.mocks.pairAll.mockRejectedValueOnce(new Error("Bulk failed"));
      await expect(getPairVectorsForUser(validPair.userAId, CONTEXT_VERSION)).rejects.toThrow("Bulk failed");
      expect(caches.byStudent.size).toBe(0);
    });

    test("invalidates bulk caches after saving vectors", async () => {
      await getPairVectorsForUser(validPair.userAId, CONTEXT_VERSION);
      await getPairVectorsForContext(CONTEXT_VERSION);
      await savePairVectors([validPair], CONTEXT_VERSION);
      expect(caches.byStudent.size).toBe(0);
      expect(caches.byContext.size).toBe(0);
    });
  });

});

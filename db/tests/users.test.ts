import { beforeEach, describe, expect, mock, test } from "bun:test";
import {
  database,
  dbUsersFixture,
  validUserCreationFixture,
} from "./fixtutes/db.fixtures.ts";

const UNKNOWN_USER_ID = "00000000-0000-4000-8000-000000000003";

const seed = mock(async () => undefined);

mock.module("../seed.ts", () => ({ seed }));

const {
  assignDiscount,
  createUser,
  deleteUser,
  listUsers,
  caches,
  getAgeStats,
  getIncomeStats,
  getScoreStats,
  getUserById,
  getWeights,
  getCategoryWeights,
  getDiscountWeights,
} = await import("../users.ts");

beforeEach(() => {
  mock.clearAllMocks();
  database.reset();
  caches.score = undefined;
  caches.age = undefined;
  caches.income = undefined;
});

describe("db/users", () => {
  describe("queries and mutations", () => {
    test("lists users and converts database values to the API shape", async () => {
      const users = await listUsers(10);

      expect(users).toEqual([
        {
          id: dbUsersFixture[0].id,
          email: dbUsersFixture[0].email,
          age: 17,
          score: 84,
          income: "R$ 2.500,00",
          name: "Ana Souza",
          disability: false,
          discount: "partial_low",
          createdAt: dbUsersFixture[0].createdAt,
        },
        {
          id: dbUsersFixture[1].id,
          email: dbUsersFixture[1].email,
          age: 18,
          score: 92,
          income: "R$ 4.000,00",
          name: "Caio Lima",
          disability: true,
          discount: null,
          createdAt: dbUsersFixture[1].createdAt,
        },
      ]);
      expect(seed).toHaveBeenCalledTimes(0);
      expect(database.mocks.limit).toHaveBeenCalledWith(10);
    });

    test("uses the requested limit when listing users", async () => {
      await listUsers(3);

      expect(database.mocks.limit).toHaveBeenCalledWith(3);
    });

    test("assigns a discount to an existing user", async () => {
      const result = await assignDiscount(dbUsersFixture[0].id, "total");

      expect(result).toEqual({
        success: true,
        message: "Discount assigned successfully",
      });
      expect(database.mocks.where).toHaveBeenCalledTimes(2);
      expect(database.mocks.first).toHaveBeenCalledTimes(1);
      expect(database.mocks.update).toHaveBeenCalledWith({ discount: "total" });
    });

    test("returns a not-found result without updating a missing user", async () => {
      database.mocks.first.mockResolvedValueOnce(null);

      const result = await assignDiscount(UNKNOWN_USER_ID, "total");

      expect(result).toEqual({ success: false, message: "User not found" });
      expect(database.mocks.update).not.toHaveBeenCalled();
    });

    test("validates user input before writing to the database", async () => {
      const result = await createUser({
        ...validUserCreationFixture,
        email: "not-an-email",
      });

      expect(result.success).toBe(false);
      if (!result.success) expect(result.message).toContain("email:");
      expect(database.mocks.create).not.toHaveBeenCalled();
    });

    test("creates a user with numeric fields normalized for storage", async () => {
      const result = await createUser(validUserCreationFixture);

      expect(result).toEqual({
        success: true,
        message: "User created successfully",
      });
      expect(database.mocks.create).toHaveBeenCalledWith({
        ...validUserCreationFixture,
        age: 19n,
        score: 88n,
      });
    });

    test("deletes a user", async () => {
      const result = await deleteUser(dbUsersFixture[0].id);

      expect(result).toEqual({
        success: true,
        message: "User deleted successfully",
      });
      expect(database.mocks.where).toHaveBeenCalledWith(expect.any(Function));
      expect(database.mocks.idEq).toHaveBeenCalledWith(dbUsersFixture[0].id);
      expect(database.mocks.delete).toHaveBeenCalledTimes(1);
      expect(database.mocks.transaction).toHaveBeenCalledTimes(1);
      expect(database.mocks.vectorWhere).toHaveBeenCalledWith(expect.any(Function));
      expect(database.mocks.vectorUserIdEq).toHaveBeenCalledWith(dbUsersFixture[0].id);
      expect(database.mocks.deleteVector).toHaveBeenCalledTimes(1);
    });

    test("invalidate all caches on user creation", async () => {
      await Promise.all([getAgeStats(), getIncomeStats(), getScoreStats()]);
      await createUser(validUserCreationFixture);
      expect(caches.score).toBeUndefined();
      expect(caches.age).toBeUndefined();
      expect(caches.income).toBeUndefined();
    });

    test("invalidate all caches on user deletion", async () => {
      await Promise.all([getAgeStats(), getIncomeStats(), getScoreStats()]);
      await deleteUser(dbUsersFixture[0].id);
      expect(caches.score).toBeUndefined();
      expect(caches.income).toBeUndefined();
      expect(caches.age).toBeUndefined();
    });

    test("ensures the caching strategy works as expected when fetching average score", async () => {
      const firstAverage = await getScoreStats();
      const secondAverage = await getScoreStats();

      expect(firstAverage.avg).toBe(88);
      expect(secondAverage.avg).toBe(88);
      expect(database.mocks.select).toHaveBeenCalledTimes(1);
      expect(caches.score).toBeDefined();
      expect(caches.score?.value.min).toBe(84);
      expect(caches.score?.value.max).toBe(92);
      expect(caches.score?.value.avg).toBe(88);
    });

    test("ensures the caching strategy works as expected when fetching average age", async () => {
      const firstAverage = await getAgeStats();
      const secondAverage = await getAgeStats();

      expect(firstAverage.avg).toBe(17.5);
      expect(secondAverage.avg).toBe(17.5);
      expect(database.mocks.select).toHaveBeenCalledTimes(1);
      expect(caches.age).toBeDefined();
      expect(caches.age?.value.min).toBe(17);
      expect(caches.age?.value.max).toBe(18);
      expect(caches.age?.value.avg).toBe(17.5);
    });

    test("ensures the caching strategy works as expected when fetching average income", async () => {
      const firstAverage = await getIncomeStats();
      const secondAverage = await getIncomeStats();

      expect(firstAverage.avg).toBe(3250);
      expect(secondAverage.avg).toBe(3250);
      expect(database.mocks.select).toHaveBeenCalledTimes(1);
      expect(caches.income).toBeDefined();
      expect(caches.income?.value.min).toBe(2500);
      expect(caches.income?.value.max).toBe(4000);
      expect(caches.income?.value.avg).toBe(3250);
    });

    test("it should assign a cache value on fetching and then use it on subsequent calls", async () => {
      const firstAverage = await getAgeStats();
      const secondAverage = await getAgeStats();

      expect(firstAverage.avg).toBe(17.5);
      expect(secondAverage.avg).toBe(17.5);
      expect(database.mocks.select).toHaveBeenCalledTimes(1);
      expect(caches.age).toBeDefined();
      expect(caches.age?.value.avg).toBe(17.5);
      expect(caches.age?.value.min).toBe(17);
      expect(caches.age?.value.max).toBe(18);
    });

    test("it should assign a cache value on fetching and then invalidate it after deleting a user", async () => {
      const firstAverage = await getIncomeStats();
      const secondAverage = await getIncomeStats();

      expect(firstAverage.avg).toBe(3250);
      expect(secondAverage.avg).toBe(3250);
      expect(database.mocks.select).toHaveBeenCalledTimes(1);
      expect(caches.income).toBeDefined();
      expect(caches.income?.value.min).toBe(2500);
      expect(caches.income?.value.max).toBe(4000);
      expect(caches.income?.value.avg).toBe(3250);
      await deleteUser(dbUsersFixture[1].id);
      expect(caches.income).toBe(undefined);
    });
  });

  const EMPTY_STATS = { min: 0, max: 0, avg: 0 };
  const CACHE_DURATION_MS = 3_600_000;
  const EXPIRED_TIMESTAMP = 0;
  const CACHE_EXPIRATION_MARGIN_MS = 1_000;

  function populateCaches() {
    for (const field of ["age", "score", "income"]) {
      caches[field] = { value: EMPTY_STATS, expiresAt: Date.now() + CACHE_DURATION_MS };
    }
  }

  describe("queries and failures", () => {
    test("lists all users without applying a limit", async () => {
      expect(await listUsers()).toHaveLength(dbUsersFixture.length);
      expect(database.mocks.limit).not.toHaveBeenCalled();
    });

    test("returns an empty list when no users exist", async () => {
      database.mocks.all.mockResolvedValueOnce([]);
      expect(await listUsers()).toEqual([]);
    });

    test("propagates listing failures", async () => {
      database.mocks.all.mockRejectedValueOnce(new Error("List failed"));
      await expect(listUsers()).rejects.toThrow("List failed");
    });

    test("looks up one user and converts bigint fields", async () => {
      const user = await getUserById(dbUsersFixture[0].id);
      expect(database.mocks.where).toHaveBeenCalledWith(expect.any(Function));
      expect(database.mocks.idEq).toHaveBeenCalledWith(dbUsersFixture[0].id);
      expect(user).toEqual({ ...dbUsersFixture[0], age: 17, score: 84 });
    });

    test("returns null for an unknown user", async () => {
      database.mocks.first.mockResolvedValueOnce(null);
      expect(await getUserById(UNKNOWN_USER_ID)).toBeNull();
    });

    test("preserves null fields and normalizes an absent discount", async () => {
      database.mocks.first.mockResolvedValueOnce({
        ...dbUsersFixture[1], name: null, income: null, disability: null,
      });
      expect(await getUserById(dbUsersFixture[1].id)).toMatchObject({
        age: 18, score: 92, name: null, income: null, disability: null, discount: null,
      });
    });

    test("propagates lookup failures", async () => {
      database.mocks.first.mockRejectedValueOnce(new Error("Lookup failed"));
      await expect(getUserById(dbUsersFixture[0].id)).rejects.toThrow("Lookup failed");
    });

    test("returns discount update failures", async () => {
      database.mocks.update.mockRejectedValueOnce(new Error("Update failed"));
      expect(await assignDiscount(dbUsersFixture[0].id, "total")).toEqual({
        success: false, message: "Update failed",
      });
    });

    test("returns lookup failures before attempting a discount update", async () => {
      database.mocks.first.mockRejectedValueOnce("Lookup unavailable");
      expect(await assignDiscount(dbUsersFixture[0].id, "none")).toEqual({
        success: false, message: "Lookup unavailable",
      });
      expect(database.mocks.update).not.toHaveBeenCalled();
    });

    test("returns creation failures and preserves existing caches", async () => {
      populateCaches();
      database.mocks.create.mockRejectedValueOnce(new Error("Duplicate email"));
      expect(await createUser(validUserCreationFixture)).toEqual({
        success: false, message: "Duplicate email",
      });
      expect(caches.score).toBeDefined();
      expect(caches.age).toBeDefined();
      expect(caches.income).toBeDefined();
    });

    test("normalizes non-Error creation failures", async () => {
      database.mocks.create.mockRejectedValueOnce("Database unavailable");
      expect(await createUser(validUserCreationFixture)).toEqual({
        success: false, message: "Database unavailable",
      });
    });

    test("trims the student's name before storing it", async () => {
      await createUser({ ...validUserCreationFixture, name: "  Marina Costa  " });
      expect(database.mocks.create).toHaveBeenCalledWith(expect.objectContaining({ name: "Marina Costa" }));
    });

    test.each([
      ["name", { name: " " }],
      ["age", { age: 15 }],
      ["age", { age: 81 }],
      ["score", { score: -1 }],
      ["score", { score: 101 }],
      ["income", { income: " " }],
    ])("rejects invalid %s before creating a user", async (field, invalidFields) => {
      populateCaches();
      const result = await createUser({ ...validUserCreationFixture, ...invalidFields });
      expect(result.success).toBe(false);
      expect(result.message).toContain(`${field}:`);
      expect(database.mocks.create).not.toHaveBeenCalled();
      expect(caches.score).toBeDefined();
    });

    test("does not delete the user if removing its vectors fails", async () => {
      populateCaches();
      database.mocks.deleteVector.mockRejectedValueOnce(new Error("Vector delete failed"));
      expect(await deleteUser(dbUsersFixture[0].id)).toEqual({
        success: false, message: "Vector delete failed",
      });
      expect(database.mocks.delete).not.toHaveBeenCalled();
      expect(caches.score).toBeDefined();
      expect(caches.age).toBeDefined();
      expect(caches.income).toBeDefined();
    });

    test("returns user deletion failures", async () => {
      database.mocks.delete.mockRejectedValueOnce(new Error("User delete failed"));
      expect(await deleteUser(dbUsersFixture[0].id)).toEqual({
        success: false, message: "User delete failed",
      });
      expect(database.mocks.deleteVector).toHaveBeenCalledTimes(1);
    });

    test("returns transaction failures without deleting records", async () => {
      database.mocks.transaction.mockRejectedValueOnce("Transaction unavailable");
      expect(await deleteUser(dbUsersFixture[0].id)).toEqual({
        success: false, message: "Transaction unavailable",
      });
      expect(database.mocks.delete).not.toHaveBeenCalled();
      expect(database.mocks.deleteVector).not.toHaveBeenCalled();
    });
  });

  for (const [field, getStats] of [
    ["score", getScoreStats],
    ["age", getAgeStats],
    ["income", getIncomeStats],
  ] as const) {
    describe(`statistics/${field}`, () => {
      test("returns zero statistics for an empty dataset", async () => {
        database.mocks.all.mockResolvedValueOnce([]);
        expect(await getStats()).toEqual(EMPTY_STATS);
        expect(caches[field]?.value).toEqual(EMPTY_STATS);
      });

      test("uses a valid cache without querying the database", async () => {
        populateCaches();
        expect(await getStats()).toEqual(EMPTY_STATS);
        expect(database.mocks.select).not.toHaveBeenCalled();
      });

      test("replaces expired cache values", async () => {
        caches[field] = { value: EMPTY_STATS, expiresAt: EXPIRED_TIMESTAMP };
        const result = await getStats();
        expect(result).not.toEqual(EMPTY_STATS);
        expect(caches[field]?.value).toEqual(result);
        expect(caches[field]?.expiresAt).toBeGreaterThan(Date.now() + CACHE_DURATION_MS - CACHE_EXPIRATION_MARGIN_MS);
        expect(database.mocks.select).toHaveBeenCalledTimes(1);
      });

      test("handles a dataset containing one student", async () => {
        database.mocks.all.mockResolvedValueOnce([dbUsersFixture[0]]);
        const result = await getStats();
        expect(result.min).toBe(result.max);
        expect(result.avg).toBe(result.min);
      });

      test("propagates database failures without filling the cache", async () => {
        database.mocks.all.mockRejectedValueOnce(new Error("Stats unavailable"));
        await expect(getStats()).rejects.toThrow("Stats unavailable");
        expect(caches[field]).toBeUndefined();
      });
    });
  }

  describe("weights", () => {
    test("gets all weight fields and values", async () => {
      expect(await getWeights()).toEqual([
        { field: "category_income", value: 0.45 },
        { field: "discount_total", value: 0.76 },
      ]);
      expect(database.mocks.weightsSelect).toHaveBeenCalledWith("field", "value");
      expect(database.mocks.weightsWhere).not.toHaveBeenCalled();
    });

    test.each([
      ["category", getCategoryWeights, "category\\_%", { field: "category_income", value: 0.45 }],
      ["discount", getDiscountWeights, "discount\\_%", { field: "discount_total", value: 0.76 }],
    ])("queries %s weights with a literal underscore in the prefix", async (_name, getRows, pattern, row) => {
      database.mocks.weightsAll.mockResolvedValueOnce([row]);
      expect(await getRows()).toEqual([row]);
      expect(database.mocks.like).toHaveBeenCalledWith(pattern);
      expect(database.mocks.weightsSelect).toHaveBeenCalledWith("field", "value");
    });

    test.each([getWeights, getCategoryWeights, getDiscountWeights])("returns an empty weight result", async (getRows) => {
      database.mocks.weightsAll.mockResolvedValueOnce([]);
      expect(await getRows()).toEqual([]);
    });

    test.each([getWeights, getCategoryWeights, getDiscountWeights])("propagates weight query failures", async (getRows) => {
      database.mocks.weightsAll.mockRejectedValueOnce(new Error("Weights unavailable"));
      await expect(getRows()).rejects.toThrow("Weights unavailable");
    });
  });
});

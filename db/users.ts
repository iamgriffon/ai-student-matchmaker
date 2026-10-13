import { parseIncome } from "../src/utils/incomeParser.ts";
import { db } from "./db.ts";
import type { Discount, User } from "./types/index.ts";
import { userCreationSchema, type ZodUser } from "./validators/schema.ts";
import { parseId } from "../src/utils/idParser.ts";
import { invalidateVectorCaches, lockStudentMutations, synchronizeVectors } from "./vectorSync.ts";

const AVERAGES_CACHE_TTL_MS = 3_600_000; // 1 hour

type Cache =
  | {
      value: {
        min: number;
        max: number;
        avg: number;
      };
      expiresAt: number;
    }
  | undefined;

export var caches: Record<string, Cache> = {
  score: {
    value: { min: 0, max: 0, avg: 0 },
    expiresAt: 0,
  },
  age: {
    value: { min: 0, max: 0, avg: 0 },
    expiresAt: 0,
  },
  income: {
    value: { min: 0, max: 0, avg: 0 },
    expiresAt: 0,
  },
};

const invalidate = {
  scores: () => {
    caches.score = undefined;
  },
  ages: () => {
    caches.age = undefined;
  },
  incomes: () => {
    caches.income = undefined;
  },
  all: () => {
    caches.score = undefined;
    caches.age = undefined;
    caches.income = undefined;
  },
};

export { db };

export async function listUsers(limit?: number) {
  const query = db.orm.public.Users.select(
    "id",
    "email",
    "age",
    "name",
    "score",
    "income",
    "disability",
    "discount",
    "createdAt",
  );

  const users = limit ? await query.limit(limit).all() : await query.all();

  return users.map((user) => ({
    id: user.id,
    email: user.email,
    age: Number(user.age) ?? 0,
    score: Number(user.score) ?? 0,
    income: user.income ?? null,
    name: user.name ?? null,
    disability: user.disability ?? null,
    discount: user.discount ?? null,
    createdAt: user.createdAt,
  }));
}

export async function getUserById(userId: string) {
  const id = parseId(userId);
  const user = await db.orm.public.Users.select(
    "id",
    "email",
    "age",
    "name",
    "score",
    "income",
    "disability",
    "discount",
    "createdAt",
  ).where((u) => u.id.eq(id)).first();

  if (!user) {
    return null;
  }

  return {
    id: user.id,
    email: user.email,
    age: Number(user.age) ?? 0,
    score: Number(user.score) ?? 0,
    income: user.income ?? null,
    name: user.name ?? null,
    disability: user.disability ?? null,
    discount: user.discount ?? null,
    createdAt: user.createdAt,
  };
}

export async function getScoreStats() {
  const now = Date.now();

  if (caches.score && caches.score.expiresAt > now) {
    return caches.score.value;
  }

  const users = await db.orm.public.Users.select("score").all();
  const minScore =
    users.length === 0
      ? 0
      : Math.min(...users.map((user) => Number(user.score)));
  const maxScore =
    users.length === 0
      ? 0
      : Math.max(...users.map((user) => Number(user.score)));
  const averageScore =
    users.length === 0
      ? 0
      : users.reduce((total, user) => total + Number(user.score), 0) /
        users.length;

  const value = { min: minScore, max: maxScore, avg: averageScore };

  caches.score = {
    value,
    expiresAt: Date.now() + AVERAGES_CACHE_TTL_MS,
  };

  return value;
}

export async function getAgeStats() {
  const now = Date.now();

  if (caches.age && caches.age.expiresAt > now) {
    return caches.age.value;
  }

  const users = await db.orm.public.Users.select("age").all();
  const minAge =
    users.length === 0 ? 0 : Math.min(...users.map((user) => Number(user.age)));
  const maxAge =
    users.length === 0 ? 0 : Math.max(...users.map((user) => Number(user.age)));
  const averageAge =
    users.length === 0
      ? 0
      : users.reduce((total, user) => total + Number(user.age), 0) /
        users.length;

  const value = { min: minAge, max: maxAge, avg: averageAge };

  caches.age = {
    value,
    expiresAt: Date.now() + AVERAGES_CACHE_TTL_MS,
  };

  return value;
}

export async function getIncomeStats() {
  const now = Date.now();

  if (caches.income && caches.income.expiresAt > now) {
    return caches.income.value;
  }

  const users = await db.orm.public.Users.select("income").all();
  const maxIncome =
    users.length === 0
      ? 0
      : Math.max(...users.map((user) => parseIncome(user.income)));
  const minIncome =
    users.length === 0
      ? 0
      : Math.min(...users.map((user) => parseIncome(user.income)));
  const averageIncome =
    users.length === 0
      ? 0
      : users.reduce((total, user) => total + parseIncome(user.income), 0) /
        users.length;

  const value = {
    min: minIncome,
    max: maxIncome,
    avg: averageIncome,
  };

  caches.income = {
    value,
    expiresAt: Date.now() + AVERAGES_CACHE_TTL_MS,
  };

  return value;
}

export async function assignDiscount(id: string, discount: Discount) {
  try {
    const userId = parseId(id);
    const user = await db.orm.public.Users.where((u) => u.id.eq(userId)).first();
    if (!user) throw new Error("User not found");
    await db.orm.public.Users.where((u) => u.id.eq(userId)).update({ discount });
    return { success: true, message: "Discount assigned successfully" };
  } catch (error) {
    return {
      success: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function createUser(input: ZodUser) {
  const result = userCreationSchema.safeParse(input);

  if (!result.success) {
    const message = result.error.issues
      .map((issue) => `${issue.path.join(".") || "user"}: ${issue.message}`)
      .join("; ");

    return { success: false, message };
  }

  try {
    const normalizedUser: User = {
      ...result.data,
      age: BigInt(result.data.age),
      score: BigInt(result.data.score),
    };

    await db.transaction(async (tx) => {
      await lockStudentMutations(tx);
      await tx.orm.public.Users.create(normalizedUser);
      await synchronizeVectors(tx);
    });
    invalidateVectorCaches();
    invalidate.all();
    return { success: true, message: "User created successfully" };
  } catch (error) {
    return {
      success: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function updateUser(id: string, input: ZodUser) {
  const parsed = userCreationSchema.safeParse(input);
  if (!parsed.success) return { success: false, message: parsed.error.issues.map((issue) => issue.message).join("; ") };
  try {
    const userId = parseId(id);
    await db.transaction(async (tx) => {
      await lockStudentMutations(tx);
      const user = await tx.orm.public.Users.where((u) => u.id.eq(userId)).first();
      if (!user) throw new Error("Aluno não encontrado");
      await tx.orm.public.Users.where((u) => u.id.eq(userId)).update({
        ...parsed.data, age: BigInt(parsed.data.age), score: BigInt(parsed.data.score),
      });
      await synchronizeVectors(tx);
    });
    invalidateVectorCaches();
    invalidate.all();
    return { success: true, message: "User updated successfully" };
  } catch (error) {
    return { success: false, message: error instanceof Error ? error.message : String(error) };
  }
}

export async function deleteUser(id: string) {
  try {
    const userId = parseId(id);
    await db.transaction(async (tx) => {
      await lockStudentMutations(tx);
      await tx.orm.public.StudentVectors.where((u) => u.userId.eq(userId)).delete();
      await tx.orm.public.Users.where((u) => u.id.eq(userId)).delete();
      await synchronizeVectors(tx);
    });
    invalidateVectorCaches();
    invalidate.all();

    return { success: true, message: "User deleted successfully" };
  } catch (error) {
    return {
      success: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function getWeights() {
  return db.orm.public.Weights.select("field", "value").all();
}

export async function getCategoryWeights() {
  return db.orm.public.Weights.select("field", "value")
    .where((w) => w.field.like("category\\_%"))
    .all();
}

export async function getDiscountWeights() {
  return db.orm.public.Weights.select("field", "value")
    .where((w) => w.field.like("discount\\_%"))
    .all();
}
export type StarterUser = Awaited<ReturnType<typeof listUsers>>[number];

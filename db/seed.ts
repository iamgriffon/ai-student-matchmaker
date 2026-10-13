import Bun from "bun";
import { parseIncome } from "../src/utils/incomeParser.ts";
import { connectDatabase, db } from "./db.ts";
import { refreshStudentVectors } from "./studentVectors.ts";
import { Discount, type User } from "./types/index.ts";
import { getWeights } from "./users.ts";

const MINIMUM_WAGE_REFERENCE = 1_500;
const DISCOUNT_WEIGHT_FIELDS = {
  income: "category_income",
  disability: "category_disability",
  score: "category_score",
} as const;

const DISCOUNT_THRESHOLDS: Record<Discount, number> = {
  total: 0.76,
  partial_high: 0.51,
  partial_low: 0.26,
  none: 0,
} as const;

type DiscountWeights = {
  income: number;
  disability: number;
  score: number;
};

type DiscountThresholds = Record<Discount, number>;

const DISCOUNT_THRESHOLD_FIELDS: Record<Discount, string> = {
  total: "discount_total",
  partial_high: "discount_partial_high",
  partial_low: "discount_partial_low",
  none: "discount_none",
};

const DISCOUNT_THRESHOLD_ROWS = (Object.keys(Discount) as Discount[]).map(
  (discount) => ({
    field: DISCOUNT_THRESHOLD_FIELDS[discount],
    value: DISCOUNT_THRESHOLDS[discount],
  }),
);

function incomeNeed(income: string): number {
  const cleanedIncome = income.trim().replace(/[^\d,.-]/g, "");
  if (!cleanedIncome || !/\d/.test(cleanedIncome)) {
    throw new Error(`Invalid income value: ${income}`);
  }

  const amount = parseIncome(income);
  if (!Number.isFinite(amount) || amount < 0) {
    throw new Error(`Invalid income value: ${income}`);
  }

  if (amount <= 3 * MINIMUM_WAGE_REFERENCE) return 1;
  if (amount <= 10 * MINIMUM_WAGE_REFERENCE) return 0.5;
  return 0;
}

function loadDiscountWeights(
  rows: { field: string; value: number }[],
): DiscountWeights {
  const values = new Map(
    rows.map(({ field, value }) => [field, Number(value)]),
  );
  const income = values.get(DISCOUNT_WEIGHT_FIELDS.income);
  const disability = values.get(DISCOUNT_WEIGHT_FIELDS.disability);
  const score = values.get(DISCOUNT_WEIGHT_FIELDS.score);

  if (income === undefined || disability === undefined || score === undefined) {
    throw new Error("Discount weights are missing or invalid in the database");
  }

  const requiredWeights = [income, disability, score];
  if (
    requiredWeights.some((weight) => !Number.isFinite(weight) || weight < 0)
  ) {
    throw new Error("Discount weights are missing or invalid in the database");
  }

  const totalWeight = income + disability + score;
  if (totalWeight <= 0) {
    throw new Error("At least one discount weight must be greater than zero");
  }

  // Treat database weights as relative weights so the priority remains in [0, 1].
  return {
    income: income / totalWeight,
    disability: disability / totalWeight,
    score: score / totalWeight,
  };
}

function loadDiscountThresholds(
  rows: { field: string; value: number }[],
): DiscountThresholds {
  const values = new Map(
    rows.map(({ field, value }) => [field.toLowerCase(), Number(value)]),
  );
  const total = values.get("discount_total");
  const partial_high = values.get("discount_partial_high");
  const partial_low = values.get("discount_partial_low");
  const none = values.get("discount_none");

  if (
    total === undefined ||
    partial_high === undefined ||
    partial_low === undefined ||
    none === undefined ||
    ![total, partial_high, partial_low, none].every(
      (threshold) =>
        Number.isFinite(threshold) && threshold >= 0 && threshold <= 1,
    )
  ) {
    throw new Error(
      "Discount thresholds are missing or invalid in the database",
    );
  }

  if (
    !(total > partial_high && partial_high > partial_low && partial_low > none)
  ) {
    throw new Error("Discount thresholds must be ordered from total to none");
  }

  return { total, partial_high, partial_low, none };
}

export function calculateDiscountPriority(
  user: User,
  weights: DiscountWeights,
): number {
  const score = Number(user.score);
  if (!Number.isFinite(score) || score < 0 || score > 100) {
    throw new Error(`Invalid user score: ${user.score}`);
  }

  return (
    weights.income * incomeNeed(user.income) +
    weights.disability * Number(user.disability) +
    weights.score * (score / 100)
  );
}

function discountForPriority(
  priority: number,
  thresholds: DiscountThresholds,
): Discount {
  if (priority >= thresholds.total) return "total";
  if (priority >= thresholds.partial_high) return "partial_high";
  if (priority >= thresholds.partial_low) return "partial_low";
  if (priority >= thresholds.none) return "none";
  throw new Error(
    `Priority is below the minimum discount threshold: ${priority}`,
  );
}

const users = await Bun.file(
  new URL("./dataset/users.csv", import.meta.url),
).text();
const weights = await Bun.file(
  new URL("./dataset/weights.csv", import.meta.url),
).text();

const userRows = users
  .trimEnd()
  .split(/\r?\n/)
  .slice(1)
  .map((row) => row.split(","));

const weightRows = weights
  .trimEnd()
  .split(/\r?\n/)
  .slice(1)
  .map((row) => row.split(","));

const normalizedUserRows = userRows
  .filter((row) => row.some((value) => value.trim() !== ""))
  .map((row) => {
    const [_id, name, age, score, family_income, disability, email] = row;
    const normalizedIncome = new Intl.NumberFormat("pt-BR", {
      style: "currency",
      currency: "BRL",
    }).format(Number(family_income || 0));

    const hasDisability = disability?.trim() === "Sim";
    const normalizedUser: User = {
      name: name!,
      age: BigInt(age!),
      score: BigInt(score!),
      income: normalizedIncome,
      disability: hasDisability,
      email: email || "",
    };
    return normalizedUser;
  }) as User[];

let pendingSeed: Promise<void> | undefined;

async function runSeed(): Promise<void> {
  await connectDatabase();

  const normalizedWeightRows = weightRows
    .filter((row) => row.some((value) => value.trim() !== ""))
    .map((row) => {
      const [field, value] = row;
      return { field: field!, value: Number(value!) };
    })
    .concat(DISCOUNT_THRESHOLD_ROWS);

  for (const weight of normalizedWeightRows) {
    await db.orm.public.Weights.upsert({
      create: {
        field: weight.field,
        value: weight.value,
      },
      update: { value: weight.value },
      conflictOn: { field: weight.field },
    });
  }

  const storedWeights = await getWeights();
  const discountWeights = loadDiscountWeights(storedWeights);
  const discountThresholds = loadDiscountThresholds(storedWeights);

  for (const user of normalizedUserRows) {
    const priority = calculateDiscountPriority(user, discountWeights);
    const userDiscount = discountForPriority(priority, discountThresholds);

    await db.orm.public.Users.upsert({
      create: {
        name: user.name,
        age: user.age,
        score: user.score,
        income: user.income,
        disability: user.disability,
        email: user.email,
        discount: userDiscount,
      },
      update: { discount: userDiscount },
      conflictOn: { email: user.email },
    });
  }

  await refreshStudentVectors();
}

export function seed(): Promise<void> {
  pendingSeed ??= runSeed().catch((error: unknown) => {
    pendingSeed = undefined;
    throw error;
  });
  return pendingSeed;
}

await seed();

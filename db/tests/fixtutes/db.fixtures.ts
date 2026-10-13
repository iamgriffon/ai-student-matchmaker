import { mock } from "bun:test";
import { createPairOutcomesMock } from "./pairOutcomes.fixtures.ts";
import { createTrainedModelsMock } from "./trainedModels.fixtures.ts";
import type { Discount } from "../../types/index.ts";
import type { ZodUser } from "../../validators/schema.ts";
import { parseId, type UserId } from "../../../src/utils/idParser.ts";

type DbUser = {
  id: string;
  email: string;
  age: number | bigint;
  name: string | null;
  score: number | bigint;
  income: string | null;
  disability: boolean | null;
  discount?: string | null;
  createdAt: string;
};

export const dbUsersFixture = [
  {
    id: "00000000-0000-4000-8000-000000000001",
    email: "ana@example.com",
    age: 17n,
    name: "Ana Souza",
    score: 84n,
    income: "R$ 2.500,00",
    disability: false,
    discount: "partial_low",
    createdAt: "2026-10-09T12:00:00.000Z",
  },
  {
    id: "00000000-0000-4000-8000-000000000002",
    email: "caio@example.com",
    age: 18n,
    name: "Caio Lima",
    score: 92n,
    income: "R$ 4.000,00",
    disability: true,
    createdAt: "2026-10-09T13:00:00.000Z",
  },
] as const;

export const validUserCreationFixture: ZodUser = {
  name: "Marina Costa",
  email: "marina@example.com",
  age: 19,
  score: 88,
  income: "R$ 3.200,00",
  disability: false,
};

type DbPairVector = {
  id: UserId;
  userAId: UserId;
  userBId: UserId;
  vector: number[];
  contextVersion: string;
  createdAt: string;
  updatedAt: string;
};

export const pairVectorFixture: DbPairVector = {
  id: parseId("00000000-0000-4000-8000-000000000003"),
  userAId: parseId(dbUsersFixture[0].id),
  userBId: parseId(dbUsersFixture[1].id),
  vector: [0.05, 0.25, 0.75, 1],
  contextVersion: "cohort-v1",
  createdAt: "2026-10-10T12:00:00.000Z",
  updatedAt: "2026-10-10T12:00:00.000Z",
};

export function createDbMock() {
  const trainedModels = createTrainedModelsMock();
  const pairOutcomes = createPairOutcomesMock();
  const all = mock(async (): Promise<DbUser[]> => [...dbUsersFixture]);
  const first = mock(async (): Promise<DbUser | null> => dbUsersFixture[0]);
  const update = mock(async (_values: { discount: Discount }) => undefined);
  const deleteRecord = mock(async () => undefined);
  const idEq = mock((_id: string) => true);
  const where = mock((filter: unknown) => {
    if (typeof filter === "function") filter({ id: { eq: idEq } });
    return { first, update, delete: deleteRecord };
  });
  const limit = mock((_value: number) => ({ all }));
  const select = mock((..._fields: string[]) => ({ limit, all, where }));
  const create = mock(async (_values: unknown) => undefined);

  const weightsAll = mock(async () => [
    { field: "category_income", value: 0.45 },
    { field: "discount_total", value: 0.76 },
  ]);
  const like = mock((_pattern: string) => true);
  const weightsWhere = mock((predicate: (fields: { field: { like: typeof like } }) => unknown) => {
    predicate({ field: { like } });
    return { all: weightsAll };
  });
  const weightsSelect = mock((..._fields: string[]) => ({ all: weightsAll, where: weightsWhere }));
  const upsertWeight = mock(async (_values: unknown) => undefined);

  const upsertVector = mock(async (_values: unknown) => undefined);
  const deleteVector = mock(async () => undefined);
  const vectorUserIdEq = mock((_id: string) => true);
  const vectorWhere = mock((filter: unknown) => {
    if (typeof filter === "function") filter({ userId: { eq: vectorUserIdEq } });
    return { delete: deleteVector };
  });
  const pairAll = mock(async () => [pairVectorFixture]);
  const pairFirst = mock(async (): Promise<typeof pairVectorFixture | null> => pairVectorFixture);
  const pairLimit = mock((_limit: number) => ({ all: pairAll }));
  const pairIdEq = mock((_id: string) => true);
  const pairIdIsNotNull = mock(() => true);
  const deletePairs = mock(async () => 0);
  const pairUserAEq = mock((_id: string) => true);
  const pairUserBEq = mock((_id: string) => true);
  const pairContextEq = mock((_version: string) => true);
  type PairFields = {
    id: { eq: typeof pairIdEq; isNotNull: typeof pairIdIsNotNull };
    userAId: { eq: typeof pairUserAEq };
    userBId: { eq: typeof pairUserBEq };
    contextVersion: { eq: typeof pairContextEq };
  };
  type PairQuery = {
    where: (predicate: (fields: PairFields) => unknown) => PairQuery;
    first: typeof pairFirst;
    all: typeof pairAll;
    deleteAndCount: typeof deletePairs;
  };
  const pairWhere = mock((predicate: (fields: PairFields) => unknown): PairQuery => {
    predicate({
      id: { eq: pairIdEq, isNotNull: pairIdIsNotNull }, userAId: { eq: pairUserAEq },
      userBId: { eq: pairUserBEq }, contextVersion: { eq: pairContextEq },
    });
    return { where: pairWhere, first: pairFirst, all: pairAll, deleteAndCount: deletePairs };
  });
  const upsertPair = mock(async (_values: unknown) => undefined);
  const orm = {
    public: {
      TrainedModels: trainedModels.table,
      PairOutcomes: pairOutcomes.table,
      Users: { all, select, where, create },
      Weights: { select: weightsSelect, upsert: upsertWeight },
      StudentVectors: { upsert: upsertVector, where: vectorWhere },
      PairVectors: { all: pairAll, limit: pairLimit, where: pairWhere, upsert: upsertPair },
    },
  };
  const transactionQuery = mock(async (_plan: unknown) => []);
  const transaction = mock(async (callback: (tx: { orm: typeof orm; query: typeof transactionQuery }) => Promise<unknown>) => callback({ orm, query: transactionQuery }));
  const connectDatabase = mock(async () => undefined);

  const queryPlan = { kind: "mock-query-plan" };
  const build = mock(() => queryPlan);
  const returnsRow = mock((_codecs: unknown) => ({ build }));
  const sql = mock((_strings: TemplateStringsArray, ..._parameters: unknown[]) => ({ returnsRow }));
  const nearestRows = [{ userId: dbUsersFixture[1].id, distance: 0.25 }];
  const query = mock(async (_plan: unknown) => nearestRows);
  const runtime = mock(() => ({ query }));

  const mocks = {
    ...trainedModels.mocks,
    ...pairOutcomes.mocks,
    all, limit, select, first, update, delete: deleteRecord, where, idEq, create,
    weightsAll, weightsWhere, weightsSelect, like, upsertWeight,
    upsertVector, deleteVector, vectorWhere, vectorUserIdEq, transaction, connectDatabase,
    pairAll, pairFirst, pairLimit, pairIdEq, pairUserAEq, pairUserBEq, pairContextEq, pairWhere, upsertPair,
    sql, returnsRow, build, runtime, query, transactionQuery, pairIdIsNotNull, deletePairs,
  };

  function reset() {
    trainedModels.reset();
    pairOutcomes.reset();
    // Limpar apenas o histórico não remove respostas temporárias de testes anteriores.
    for (const fn of Object.values(mocks)) fn.mockClear();
    all.mockReset().mockImplementation(async () => [...dbUsersFixture]);
    first.mockReset().mockImplementation(async () => dbUsersFixture[0]);
    update.mockReset().mockImplementation(async () => undefined);
    deleteRecord.mockReset().mockImplementation(async () => undefined);
    create.mockReset().mockImplementation(async () => undefined);
    weightsAll.mockReset().mockImplementation(async () => [
      { field: "category_income", value: 0.45 },
      { field: "discount_total", value: 0.76 },
    ]);
    upsertVector.mockReset().mockImplementation(async () => undefined);
    deleteVector.mockReset().mockImplementation(async () => undefined);
    pairAll.mockReset().mockImplementation(async () => [pairVectorFixture]);
    pairFirst.mockReset().mockImplementation(async () => pairVectorFixture);
    transactionQuery.mockReset().mockImplementation(async () => []);
    deletePairs.mockReset().mockImplementation(async () => 0);
    upsertPair.mockReset().mockImplementation(async () => undefined);
    transaction.mockReset().mockImplementation(async (callback) => callback({ orm, query: transactionQuery }));
    connectDatabase.mockReset().mockImplementation(async () => undefined);
    query.mockReset().mockImplementation(async () => nearestRows);
  }

  return { db: { orm, transaction, raw: { sql }, runtime }, mocks, reset, queryPlan, nearestRows };
}

// Bun compartilha mocks de módulos entre arquivos. Todas as suítes usam a mesma
// instância e restauram suas respostas antes de cada teste.
export const database = createDbMock();
mock.module("../../db.ts", () => ({
  db: database.db,
  connectDatabase: database.mocks.connectDatabase,
}));

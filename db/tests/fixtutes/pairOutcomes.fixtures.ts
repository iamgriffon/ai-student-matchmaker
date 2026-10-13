import { mock } from "bun:test";
import { parseId, type UserId } from "../../../src/utils/idParser.ts";
import { trainedArtifactFixture } from "./trainedModels.fixtures.ts";

type PairOutcomeRow = {
  id: UserId; userAId: UserId; userBId: UserId; vector: number[]; contextVersion: string;
  encoderVersion: string; policyVersion: string; modelId: string | null;
  scoreBeforeA: number; scoreBeforeB: number; scoreAfterA: number | null; scoreAfterB: number | null;
  participationA: number | null; participationB: number | null; feedbackA: number | null; feedbackB: number | null;
  notes: string | null; startedAt: string; completedAt: string | null;
};
export const pairOutcomeFixture: PairOutcomeRow = {
  id: parseId("00000000-0000-4000-8000-000000000060"),
  userAId: parseId("00000000-0000-4000-8000-000000000001"),
  userBId: parseId("00000000-0000-4000-8000-000000000002"),
  vector: [0, 0.25, 0.75, 1], contextVersion: "fixture-context-v1", encoderVersion: "pair-v1", policyVersion: "pair-policy-v1",
  modelId: trainedArtifactFixture.metadata.modelId, scoreBeforeA: 50, scoreBeforeB: 75,
  scoreAfterA: null, scoreAfterB: null, participationA: null, participationB: null,
  feedbackA: null, feedbackB: null, notes: null, startedAt: "2026-10-13T19:00:00.000Z", completedAt: null,
};
export function createPairOutcomesMock() {
  const outcomeAll = mock(async (): Promise<PairOutcomeRow[]> => []);
  const outcomeFirst = mock(async (): Promise<PairOutcomeRow | null> => null);
  const outcomeCreate = mock(async (input: Partial<PairOutcomeRow>): Promise<PairOutcomeRow> => ({ ...structuredClone(pairOutcomeFixture), ...input }));
  const outcomeUpdate = mock(async (_input: unknown) => undefined);
  const outcomeIdEq = mock((_value: string) => true);
  const outcomeUserAEq = mock((_value: string) => true);
  const outcomeUserBEq = mock((_value: string) => true);
  const outcomeDesc = mock(() => true);
  const fields = { id: { eq: outcomeIdEq }, userAId: { eq: outcomeUserAEq }, userBId: { eq: outcomeUserBEq }, startedAt: { desc: outcomeDesc } };
  type Query = { first: typeof outcomeFirst; all: typeof outcomeAll; update: typeof outcomeUpdate; where: (predicate: (values: typeof fields) => unknown) => Query; orderBy: (order: unknown) => Query; limit: (limit: number) => Query };
  const outcomeWhere = mock((predicate: (values: typeof fields) => unknown): Query => { predicate(fields); return query; });
  const outcomeOrderBy = mock((_order: unknown): Query => query);
  const outcomeLimit = mock((_limit: number): Query => query);
  const query: Query = { first: outcomeFirst, all: outcomeAll, update: outcomeUpdate, where: outcomeWhere, orderBy: outcomeOrderBy, limit: outcomeLimit };
  const outcomeSelect = mock((..._fields: string[]) => query);
  const mocks = { outcomeAll, outcomeFirst, outcomeCreate, outcomeUpdate, outcomeIdEq, outcomeUserAEq, outcomeUserBEq, outcomeDesc, outcomeWhere, outcomeOrderBy, outcomeLimit, outcomeSelect };
  function reset() {
    for (const fn of Object.values(mocks)) fn.mockClear();
    outcomeAll.mockReset().mockImplementation(async () => []);
    outcomeFirst.mockReset().mockImplementation(async () => null);
    outcomeCreate.mockReset().mockImplementation(async (input) => ({ ...structuredClone(pairOutcomeFixture), ...input }));
    outcomeUpdate.mockReset().mockImplementation(async () => undefined);
  }
  return { table: { ...query, create: outcomeCreate, select: outcomeSelect }, mocks, reset };
}

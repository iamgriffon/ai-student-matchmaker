import { mock } from "bun:test";
import { dbUsersFixture } from "./db.fixtures.ts";
import { parseId, type UserId } from "../../../src/utils/idParser.ts";

const realVectors = await import("../../../src/vectors.ts");
const actualEncodePair = realVectors.encodePair;
export const STORED_VECTORS = [[0.5, 0.25, 0], [0.75, 1, 1]];
const STUDENT_FEATURE_COUNT = 3;
const SCORE_SCALE = 100;

type FixtureUser = {
  id: UserId; email: string; age: number; name: string; score: number;
  income: string; disability: boolean; discount: string | null; createdAt: string;
};

export function makeVectorContext() {
  const students = dbUsersFixture.map((user, index) => {
    const vector = STORED_VECTORS[index];
    const [score, income, disability] = vector ?? [];
    if (typeof score == 'undefined' || typeof income == 'undefined' || typeof disability == 'undefined') {
      throw new Error("Missing fixture features");
    }
    return { userId: parseId(user.id), features: { score, income, disability } };
  });
  const users: FixtureUser[] = dbUsersFixture.map((user, index) => ({
      ...user, id: parseId(user.id), age: Number(user.age),
      score: (students[index]?.features.score ?? 0) * SCORE_SCALE,
      discount: "discount" in user ? user.discount : null,
  }));
  return {
    users,
    students,
    cohortMeanScore: 0.625,
    contextVersion: "fixture-context-v1",
    incomeScale: { minLogIncome: 0, maxLogIncome: Math.log1p(4000) },
    studentVectors: {
      shape: [dbUsersFixture.length, STUDENT_FEATURE_COUNT],
      data: mock(async () => new Float32Array(STORED_VECTORS.flat())),
      dispose: mock(() => undefined),
    },
  };
}

// Um único mock de módulo é compartilhado pelas suítes. O encoder real mantém
// o cálculo e a liberação dos tensores sob teste, sem consultar o banco real.
export const createContextMock = mock(async () => makeVectorContext());
export const createContextFromUsersMock = mock((_users: Parameters<typeof realVectors.createContextFromUsers>[0]) => makeVectorContext());
export const encodePairMock = mock(actualEncodePair);
export function resetVectorMocks(context = makeVectorContext()) {
  createContextMock.mockReset().mockImplementation(async () => context);
  createContextFromUsersMock.mockReset().mockImplementation(() => context);
  encodePairMock.mockReset().mockImplementation(actualEncodePair);
}
mock.module("../../../src/vectors.ts", () => ({
  ...realVectors,
  createContext: createContextMock,
  createContextFromUsers: createContextFromUsersMock,
  encodePair: encodePairMock,
}));

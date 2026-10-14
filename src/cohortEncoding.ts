import { createContextVersion } from "./utils/contextVersion.ts";
import { parseIncome } from "./utils/incomeParser.ts";
import { PAIR_ENCODER_VERSION } from "./vectorSchema.ts";
import { readPairFeatures } from "./pairPolicy.ts";

export type StudentProfile = { id: string; score: number; income: string; disability: boolean };
const MAX_EXAM_SCORE = 100;
const PAIR_MEMBER_COUNT = 2;
export function contextFromUsers<T extends StudentProfile>(users: T[], revision: number, generation: number) {
  const prepared = users.map((user) => ({ ...user, parsedIncome: parseIncome(user.income) })).sort((a, b) => a.id.localeCompare(b.id));
  const logs = prepared.map((user) => Math.log1p(user.parsedIncome));
  const minLogIncome = logs.length ? Math.min(...logs) : 0;
  const maxLogIncome = logs.length ? Math.max(...logs) : 0;
  const incomeScale = { minLogIncome, maxLogIncome };
  const students = prepared.map((user) => ({ userId: user.id, features: {
    score: user.score / MAX_EXAM_SCORE,
    income: maxLogIncome === minLogIncome ? 0 : (Math.log1p(user.parsedIncome) - minLogIncome) / (maxLogIncome - minLogIncome),
    disability: user.disability ? 1 : 0,
  } }));
  const cohortMeanScore = students.length ? students.reduce((sum, student) => sum + student.features.score, 0) / students.length : 0;
  const contextVersion = createContextVersion({ encoderVersion: PAIR_ENCODER_VERSION, students, cohortMeanScore, incomeScale });
  return { users, students, revision, generation, contextVersion, cohortMeanScore };
}
export type Cohort = ReturnType<typeof contextFromUsers>;
export function pairFeatures(a: Cohort["students"][number], b: Cohort["students"][number], mean: number) {
  return readPairFeatures([
    Math.abs((a.features.score + b.features.score) / PAIR_MEMBER_COUNT - mean),
    Math.abs(a.features.score - b.features.score), Math.abs(a.features.income - b.features.income),
    Math.abs(a.features.disability - b.features.disability),
  ]);
}

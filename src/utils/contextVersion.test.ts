import { describe, expect, test } from "bun:test";
import { createContextVersion, type ContextVersionInput } from "./contextVersion.ts";

const SHA256_HEX_LENGTH = 64;
const FIRST_STUDENT_ID = "00000000-0000-4000-8000-000000000001";
const SECOND_STUDENT_ID = "00000000-0000-4000-8000-000000000002";
const THIRD_STUDENT_ID = "00000000-0000-4000-8000-000000000003";

function makeContext(): ContextVersionInput {
  return {
    encoderVersion: "pair-v1",
    students: [
      { userId: FIRST_STUDENT_ID, features: { score: 0.5, income: 0, disability: 0 } },
      { userId: SECOND_STUDENT_ID, features: { score: 0.7, income: 1, disability: 1 } },
    ],
    cohortMeanScore: 0.6,
    incomeScale: { minLogIncome: 0, maxLogIncome: Math.log1p(5000) },
  };
}

function firstStudent(context: ContextVersionInput) {
  const student = context.students[0];
  if (typeof student == 'undefined') throw new Error("Expected a fixture student");
  return student;
}

const changes: { label: string; apply: (context: ContextVersionInput) => void }[] = [
  { label: "score", apply: (context) => { firstStudent(context).features.score = 0.8; } },
  { label: "income", apply: (context) => { firstStudent(context).features.income = 0.25; } },
  { label: "PCD indicator", apply: (context) => { firstStudent(context).features.disability = 1; } },
  { label: "student ID", apply: (context) => { firstStudent(context).userId = THIRD_STUDENT_ID; } },
  { label: "cohort membership", apply: (context) => { context.students = context.students.slice(1); } },
  { label: "cohort mean", apply: (context) => { context.cohortMeanScore = 0.65; } },
  { label: "minimum log income", apply: (context) => { context.incomeScale.minLogIncome = 1; } },
  { label: "maximum log income", apply: (context) => { context.incomeScale.maxLogIncome = Math.log1p(10000); } },
  { label: "encoder version", apply: (context) => { context.encoderVersion = "pair-v2"; } },
];

describe("createContextVersion", () => {
  test("produces a stable SHA-256 hexadecimal hash", () => {
    const version = createContextVersion(makeContext());
    expect(version).toHaveLength(SHA256_HEX_LENGTH);
    expect(version).toMatch(/^[0-9a-f]+$/);
    expect(createContextVersion(makeContext())).toBe(version);
  });

  test("ignores student order without mutating the input", () => {
    const initial = makeContext();
    const reversed = { ...initial, students: [...initial.students].reverse() };
    expect(createContextVersion(reversed)).toBe(createContextVersion(initial));
    expect(reversed.students.map((student) => student.userId)).toEqual([SECOND_STUDENT_ID, FIRST_STUDENT_ID]);
  });

  test("ignores the insertion order of feature properties", () => {
    const initial = makeContext();
    const reordered = {
      ...initial,
      students: initial.students.map(({ userId, features }) => ({
        userId,
        features: { disability: features.disability, income: features.income, score: features.score },
      })),
    };
    expect(createContextVersion(reordered)).toBe(createContextVersion(initial));
  });

  for (const { label, apply } of changes) {
    test(`changes when ${label} changes`, () => {
      const initial = makeContext();
      const modified = makeContext();
      apply(modified);
      expect(createContextVersion(modified)).not.toBe(createContextVersion(initial));
    });
  }

  test("ignores metadata that does not contribute to vectors", () => {
    const initial = makeContext();
    const enriched = {
      ...initial,
      createdAt: "2026-10-13T12:00:00Z",
      rankingWeights: { balance: 0.9 },
      students: initial.students.map((student) => ({ ...student, name: "Updated name", discount: "total" })),
    };
    expect(createContextVersion(enriched)).toBe(createContextVersion(initial));
  });

  test("normalizes surrounding whitespace in the encoder version", () => {
    const initial = makeContext();
    expect(createContextVersion({ ...initial, encoderVersion: " pair-v1 " })).toBe(createContextVersion(initial));
  });

  test("rejects a blank encoder version", () => {
    expect(() => createContextVersion({ ...makeContext(), encoderVersion: " " })).toThrow("versão do encoder");
  });

  test("rejects a nonfinite mean instead of hashing a JSON null", () => {
    expect(() => createContextVersion({ ...makeContext(), cohortMeanScore: NaN })).toThrow("numéricas finitas");
  });

  test("rejects a nonfinite income scale", () => {
    const context = makeContext();
    context.incomeScale.maxLogIncome = Infinity;
    expect(() => createContextVersion(context)).toThrow("numéricas finitas");
  });

  test("rejects a nonfinite student feature", () => {
    const context = makeContext();
    firstStudent(context).features.score = -Infinity;
    expect(() => createContextVersion(context)).toThrow("numéricas finitas");
  });
});

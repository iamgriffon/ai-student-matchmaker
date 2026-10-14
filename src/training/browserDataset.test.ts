import { describe, expect, test } from "bun:test";
import { browserDataset, type BrowserContext } from "./browserDataset.ts";
import { splitStudentIds } from "../utils/studentSplit.ts";

const STUDENT_COUNT = 1000;
const context: BrowserContext = {
  contextVersion: "test", cohortMeanScore: 0.5,
  students: Array.from({ length: STUDENT_COUNT }, (_, index) => ({
    userId: "00000000-0000-4000-8000-" + String(index + 1).padStart(12, "0"),
    features: { score: (index % 101) / 100, income: (index % 10) / 10, disability: index % 2 },
  })),
};
describe("training/browserDataset", () => {
  test("preserves the server's student-disjoint split and bounds both partitions", async () => {
    const dataset = await browserDataset(context);
    const split = splitStudentIds(context.students.map((student) => student.userId));
    expect(dataset.trainingStudents).toBe(800);
    expect(dataset.validationStudents).toBe(200);
    expect(dataset.training.length).toBeLessThanOrEqual(3000);
    expect(dataset.validation.length).toBeLessThanOrEqual(1000);
    for (const sample of dataset.training) {
      expect(split.trainingIds.has(sample.userAId!)).toBe(true);
      expect(split.trainingIds.has(sample.userBId!)).toBe(true);
    }
    for (const sample of dataset.validation) {
      expect(split.validationIds.has(sample.userAId!)).toBe(true);
      expect(split.validationIds.has(sample.userBId!)).toBe(true);
    }
    expect(new Set(dataset.training.map((sample) => sample.userAId + ":" + sample.userBId)).size).toBe(dataset.training.length);
  });
  test("is deterministic regardless of input order", async () => {
    expect(await browserDataset({ ...context, students: [...context.students].reverse() })).toEqual(await browserDataset(context));
  });
  test("rejects a dataset that cannot support student-disjoint validation", async () => {
    await expect(browserDataset({ ...context, students: context.students.slice(0, 10) })).rejects.toThrow("Not enough study pairs");
  });
});

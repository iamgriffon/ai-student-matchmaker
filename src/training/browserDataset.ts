import { DEFAULT_CATEGORY_WEIGHTS, type CategoryWeights } from "../categoryWeights.ts";
import { evaluatePair, readPairFeatures } from "../pairPolicy.ts";
import type { TrainingSample } from "./types.ts";

export type BrowserContext = {
  contextVersion: string; cohortMeanScore: number;
  students: { userId: string; features: { score: number; income: number; disability: number } }[];
};
const VALIDATION_STRIDE = 5;
const ANCHORS_PER_GROUP = 2;
const MAX_TRAINING_PAIRS = 3000;
const MAX_VALIDATION_PAIRS = 1000;
const MIN_PARTITION_PAIRS = 200;

export async function browserDataset(context: BrowserContext, categoryWeights: CategoryWeights = DEFAULT_CATEGORY_WEIGHTS) {
  const keyed = await Promise.all(context.students.map(async (student) => {
    const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(student.userId));
    return { student, key: Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("") };
  }));
  keyed.sort((a, b) => a.key.localeCompare(b.key) || a.student.userId.localeCompare(b.student.userId));
  const trainingStudents = keyed.filter((_, index) => index % VALIDATION_STRIDE !== 0).map(({ student }) => student);
  const validationStudents = keyed.filter((_, index) => index % VALIDATION_STRIDE === 0).map(({ student }) => student);
  const samples = (students: typeof context.students, limit: number) => {
    const result = new Map<string, TrainingSample>();
    for (const a of students.slice(0, ANCHORS_PER_GROUP)) {
      for (const b of students) {
        if (a.userId === b.userId) continue;
        const [userAId, userBId] = [a.userId, b.userId].sort();
        const features = readPairFeatures([
          Math.abs((a.features.score + b.features.score) / 2 - context.cohortMeanScore),
          Math.abs(a.features.score - b.features.score),
          Math.abs(a.features.income - b.features.income),
          Math.abs(a.features.disability - b.features.disability),
        ]);
        const policy = evaluatePair(features, undefined, categoryWeights);
        result.set(userAId + ":" + userBId, { userAId, userBId, features, target: policy.score, eligible: policy.eligible });
      }
    }
    return [...result.values()].slice(0, limit);
  };
  const training = samples(trainingStudents, MAX_TRAINING_PAIRS);
  const validation = samples(validationStudents, MAX_VALIDATION_PAIRS);
  if (training.length < MIN_PARTITION_PAIRS || validation.length < MIN_PARTITION_PAIRS) throw new Error("Not enough study pairs. Add more students before training.");
  return { training, validation, trainingStudents: trainingStudents.length, validationStudents: validationStudents.length };
}

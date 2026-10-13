import { createContextFromUsers } from "../src/vectors.ts";
import { db } from "./db.ts";
import { invalidatePairVectorCaches } from "./pairVectors.ts";
import { invalidateStudentVectorCaches } from "./studentVectorCache.ts";

export type VectorTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
const VECTOR_MUTATION_LOCK = 637891;
const STUDENT_FEATURE_COUNT = 3;

export async function lockStudentMutations(tx: VectorTransaction) {
  // O lock pertence à transação e serializa alterações da turma entre processos.
  const plan = db.raw.sql`SELECT 1 AS "locked" FROM pg_advisory_xact_lock(${VECTOR_MUTATION_LOCK}::bigint)`
    .returnsRow({ locked: { codecId: "pg/int4@1" } }).build();
  await tx.query(plan);
}

export async function synchronizeVectors(tx: VectorTransaction) {
  const rows = await tx.orm.public.Users.all();
  // Média e limites de renda podem mudar para TODOS. Duplas serão recriadas sob demanda.
  await tx.orm.public.PairVectors.where((v) => v.id.isNotNull()).deleteAndCount();
  if (!rows.length) return;
  const context = createContextFromUsers(rows.map((user) => ({
    ...user, age: Number(user.age), score: Number(user.score),
  })));
  try {
    const dimensions = context.studentVectors.shape[1];
    if (dimensions !== STUDENT_FEATURE_COUNT) throw new Error("Student vectors must have three features");
    const values = await context.studentVectors.data();
    for (const [index, student] of context.students.entries()) {
      const offset = index * STUDENT_FEATURE_COUNT;
      const vector = Array.from(values.subarray(offset, offset + STUDENT_FEATURE_COUNT));
      await tx.orm.public.StudentVectors.upsert({
        create: { userId: student.userId, vector }, update: { vector },
        conflictOn: { userId: student.userId },
      });
    }
  } finally { context.studentVectors.dispose(); }
}

export function invalidateVectorCaches() {
  invalidatePairVectorCaches();
  invalidateStudentVectorCaches();
}

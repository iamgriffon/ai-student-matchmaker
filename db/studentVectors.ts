import { connectDatabase, db } from "./db.ts";
import { readCachedStudentVectors } from "./studentVectorCache.ts";

export { caches, invalidateStudentVectorCaches, STUDENT_VECTORS_CACHE_TTL_MS } from "./studentVectorCache.ts";

import { invalidateVectorCaches, lockStudentMutations, synchronizeVectors } from "./vectorSync.ts";

const STUDENT_FEATURE_COUNT = 3;
const DEFAULT_SEARCH_LIMIT = 10;
const MIN_SEARCH_LIMIT = 1;
const MAX_SEARCH_LIMIT = 100;

export async function refreshStudentVectors(): Promise<void> {
  await connectDatabase();
  await db.transaction(async (tx) => {
    await lockStudentMutations(tx);
    await synchronizeVectors(tx);
  });
  invalidateVectorCaches();
}

export async function findNearestStudentVectors(
  userId: string,
  vector: number[],
  limit = DEFAULT_SEARCH_LIMIT,
) {
  if (vector.length !== STUDENT_FEATURE_COUNT || !Array.from(vector).every(Number.isFinite)) {
    throw new Error("Query vectors must have three finite features");
  }
  if (!Number.isInteger(limit) || limit < MIN_SEARCH_LIMIT || limit > MAX_SEARCH_LIMIT) {
    throw new Error(`Search limit must be an integer between ${MIN_SEARCH_LIMIT} and ${MAX_SEARCH_LIMIT}`);
  }

  const queryVector = `[${vector.join(",")}]`;
  const key = JSON.stringify([userId, queryVector, limit]);
  return await readCachedStudentVectors(key, async () => {
    await connectDatabase();
    const plan = db.raw.sql`
    SELECT "userId", "vector" <-> ${queryVector}::vector(3) AS "distance"
    FROM "public"."StudentVectors"
    WHERE "userId" <> ${userId}
    ORDER BY "vector" <-> ${queryVector}::vector(3), "userId"
    LIMIT ${limit}
    `.returnsRow({
      userId: { codecId: "pg/text@1" },
      distance: { codecId: "pg/float8@1" },
    }).build();

    return await db.runtime().query(plan);
  });
}

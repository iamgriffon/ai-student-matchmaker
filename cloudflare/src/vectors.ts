import { z } from "zod";
import { database, HttpError, APP_STATE_ID, VECTOR_BATCH_SIZE, type Database } from "./database.ts";
import { encodeVectorizeValues } from "./vectorizeEncoding.ts";
import { contextFromUsers, type Cohort } from "./cohortEncoding.ts";
export { contextFromUsers, pairFeatures, type Cohort } from "./cohortEncoding.ts";

const CONTEXT_ATTEMPTS = 3;
export function parseUserId(value: string) { return z.uuid().parse(value.trim()).toLowerCase(); }
export function orderedMembers(a: string, b: string) {
  const first = parseUserId(a), second = parseUserId(b);
  if (first === second) throw new HttpError(400, "A study pair needs two different students.");
  return first < second ? { userAId: first, userBId: second } : { userAId: second, userBId: first };
}
export async function cohort(db: Database) {
  for (let attempt = 0; attempt < CONTEXT_ATTEMPTS; attempt++) {
    const before = await db.appState.findUniqueOrThrow({ where: { id: APP_STATE_ID } });
    const users = await db.user.findMany({ orderBy: { id: "asc" } });
    const after = await db.appState.findUniqueOrThrow({ where: { id: APP_STATE_ID } });
    if (before.revision !== after.revision || before.vectorGeneration !== after.vectorGeneration) continue;
    return contextFromUsers(users, after.revision, after.vectorGeneration);
  }
  throw new HttpError(409, "The cohort changed. Please try again.");
}
export function pairNamespace(context: Cohort) { return `p-${context.generation}-${context.contextVersion.slice(0, 48)}`; }

async function vectorId(key: string) {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function synchronizeStudentVectors(env: Env, context: Cohort) {
  for (let offset = 0; offset < context.students.length; offset += VECTOR_BATCH_SIZE) {
    const students = await Promise.all(context.students.slice(offset, offset + VECTOR_BATCH_SIZE).map(async (student) => ({ ...student, vectorId: await vectorId(`${context.revision}:${context.contextVersion}:${student.userId}`) })));
    await env.STUDENT_INDEX.upsert(students.map((student) => ({
      id: student.vectorId, metadata: { userId: student.userId }, namespace: context.contextVersion,
      values: encodeVectorizeValues([student.features.score, student.features.income, student.features.disability]),
    })));
    await env.DB.batch(students.map((student) => env.DB.prepare(`
      INSERT INTO StudentVectors (id, userId, contextVersion) SELECT ?, ?, ? FROM AppState WHERE id = ? AND revision = ?
      ON CONFLICT(userId) DO UPDATE SET id = excluded.id, contextVersion = excluded.contextVersion
    `).bind(student.vectorId, student.userId, context.contextVersion, APP_STATE_ID, context.revision)));
  }
}
export async function savePairFeatures(env: Env, context: Cohort, pairs: readonly { userAId: string; userBId: string; features: readonly number[] }[]) {
  const db = database(env);
  for (let offset = 0; offset < pairs.length; offset += VECTOR_BATCH_SIZE) {
    const prepared = await Promise.all(pairs.slice(offset, offset + VECTOR_BATCH_SIZE).map(async (pair) => ({ ...pair, vectorId: await vectorId(`${context.generation}:${context.revision}:${context.contextVersion}:${Object.values(orderedMembers(pair.userAId, pair.userBId)).join(":")}`) })));
    const existing = await db.pairVector.findMany({ where: {
      contextVersion: context.contextVersion, generation: context.generation,
      OR: prepared.map((pair) => orderedMembers(pair.userAId, pair.userBId)),
    } });
    const existingByMembers = new Map(existing.map((row) => [`${row.userAId}:${row.userBId}`, row]));
    const batch = prepared.filter((pair) => {
      const members = orderedMembers(pair.userAId, pair.userBId);
      const stored = existingByMembers.get(`${members.userAId}:${members.userBId}`);
      return !stored?.uploaded || stored.vectorId !== pair.vectorId;
    });
    if (!batch.length) continue;
    await env.DB.batch(batch.map((pair) => {
      const members = orderedMembers(pair.userAId, pair.userBId);
      return env.DB.prepare(`INSERT INTO PairVectors (id, vectorId, userAId, userBId, contextVersion, generation)
        SELECT ?, ?, ?, ?, ?, ? FROM AppState WHERE id = ? AND revision = ? AND vectorGeneration = ?
        ON CONFLICT(userAId, userBId) DO UPDATE SET uploaded = CASE WHEN PairVectors.vectorId = excluded.vectorId THEN PairVectors.uploaded ELSE 0 END, vectorId = excluded.vectorId, contextVersion = excluded.contextVersion, generation = excluded.generation
      `).bind(crypto.randomUUID(), pair.vectorId, members.userAId, members.userBId, context.contextVersion, context.generation, APP_STATE_ID, context.revision, context.generation);
    }));
    const stored = await db.pairVector.findMany({ where: {
      contextVersion: context.contextVersion, generation: context.generation,
      OR: batch.map((pair) => orderedMembers(pair.userAId, pair.userBId)),
    } });
    const byMembers = new Map(batch.map((pair) => {
      const members = orderedMembers(pair.userAId, pair.userBId);
      return [`${members.userAId}:${members.userBId}`, pair.features];
    }));
    await env.PAIR_INDEX.upsert(stored.map((row) => {
      const values = byMembers.get(`${row.userAId}:${row.userBId}`);
      if (typeof values == 'undefined') throw new Error("Pair features missing.");
      return { id: row.vectorId, values: encodeVectorizeValues(values), namespace: pairNamespace(context) };
    }));
  }
}

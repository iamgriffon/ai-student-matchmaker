import type { PrismaClient as PostgresClient } from "./generated/postgres/client.ts";
import type { RuntimeEnv as Env } from "./runtimeEnv.ts";
import { PrismaD1 } from "@prisma/adapter-d1";
import { PrismaClient } from "./generated/prisma/client.ts";

const localDatabases = new WeakMap<object, Database>();
export function registerLocalDatabase(env: object, client: Database) {
  localDatabases.set(env, client);
}
export function database(env: Env) {
  const local = localDatabases.get(env);
  if (typeof local != 'undefined') return local;
  // Each invocation uses its own adapter; no request-bound bindings are cached globally.
  if (!("withSession" in env.DB)) throw new Error("Local database has not been registered.");
  return new PrismaClient({ adapter: new PrismaD1(env.DB) });
}
export type Database = PrismaClient | PostgresClient;
export class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
export const APP_STATE_ID = "main";
export const ACTIVE_OPERATION_KEY = "training";
export const ACTIVE_MODEL_KIND = "pair-ranker";
export const VECTOR_BATCH_SIZE = 40;

export async function flushVectorDeletions(env: Env) {
  const db = database(env);
  for (const index of ["student", "pair"] as const) {
    while (true) {
      const rows = await db.vectorDeletion.findMany({ where: { index }, take: VECTOR_BATCH_SIZE });
      if (!rows.length) break;
      await (index === "student" ? env.STUDENT_INDEX : env.PAIR_INDEX).deleteByIds(rows.map((row) => row.vectorId));
      await db.vectorDeletion.deleteMany({ where: { id: { in: rows.map((row) => row.id) } } });
    }
  }
}

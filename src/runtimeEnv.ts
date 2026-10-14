import type { PostgresStatements } from "./local/sql.ts";
import type { PostgresVectorIndex } from "./local/vectorIndex.ts";

// Infrastructure varies; routes and domain logic consume the same application ports.
export type RuntimeEnv = {
  DB: D1Database | PostgresStatements;
  STUDENT_INDEX: Pick<VectorizeIndex, "upsert" | "query" | "getByIds" | "deleteByIds"> | PostgresVectorIndex;
  PAIR_INDEX: Pick<VectorizeIndex, "upsert" | "query" | "getByIds" | "deleteByIds"> | PostgresVectorIndex;
  ASSETS: { fetch(request: Request): Promise<Response> };
  TRAINING?: Env["TRAINING"];
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  ADMIN_EMAIL?: string;
  LOCAL_DEVELOPMENT?: string;
};

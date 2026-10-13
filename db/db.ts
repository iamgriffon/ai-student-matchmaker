import postgres from "@prisma/orm-postgres/runtime";
import pgvector from "@prisma/orm-extension-pgvector/runtime";

import "temporal-polyfill/global";

import service from "../service.ts";
import type { Contract } from "./generated/contract";
import contractJson from "./generated/contract.json" with { type: "json" };

function loadComposerDatabaseUrl() {
  try {
    return service.load().database.url;
  } catch {
    return undefined;
  }
}

export const db = postgres<Contract>({
  contractJson,
  url: loadComposerDatabaseUrl() ?? process.env.DATABASE_URL,
  extensions: [pgvector],
});

let connection: Promise<void> | undefined;

export function connectDatabase(): Promise<void> {
  connection ??= db
    .connect()
    .then(() => undefined)
    .catch((error: unknown) => {
      connection = undefined;
      throw error;
    });
  return connection;
}

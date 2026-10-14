import { Pool } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/postgres/client.ts";
import handler from "../index.ts";
import { registerLocalDatabase } from "../database.ts";
import { PostgresStatements } from "./sql.ts";
import { PostgresVectorIndex } from "./vectorIndex.ts";
import { resolve, sep } from "node:path";

const connectionString = process.env.DATABASE_URL;
if (typeof connectionString == 'undefined') throw new Error("Set DATABASE_URL for local PostgreSQL.");
const DEFAULT_PORT = 3000;
const pool = new Pool({ connectionString, options: "-c search_path=matchmaker,public" });
const client = new PrismaClient({ adapter: new PrismaPg(pool, { schema: "matchmaker" }) });
const publicRoot = resolve(import.meta.dir, "../../public");
const env = {
  LOCAL_DEVELOPMENT: "true",
  DB: new PostgresStatements(pool),
  STUDENT_INDEX: new PostgresVectorIndex(pool, "student"),
  PAIR_INDEX: new PostgresVectorIndex(pool, "pair"),
  ASSETS: {
    async fetch(request: Request) {
      let path = decodeURIComponent(new URL(request.url).pathname);
      if (path === "/") path = "/index.html";
      if (path === "/training") path = "/training.html";
      const filePath = resolve(publicRoot, "." + path);
      if (!filePath.startsWith(publicRoot + sep)) return new Response("Not found", { status: 404 });
      const file = Bun.file(filePath);
      return await file.exists() ? new Response(file) : new Response("Not found", { status: 404 });
    },
  },
};
registerLocalDatabase(env, client);
const server = Bun.serve({
  hostname: "127.0.0.1", port: Number(process.env.PORT ?? DEFAULT_PORT),
  fetch(request) {
    return handler.fetch(request, env, {
      waitUntil(promise: Promise<unknown>) { promise.catch((error) => console.error("Background operation failed:", error)); },
    });
  },
});
console.log(`Local PostgreSQL app: ${server.url} (schema: matchmaker)`);

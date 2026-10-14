import { Pool } from "pg";
import { readFile } from "node:fs/promises";

const connectionString = process.env.DATABASE_URL;
if (typeof connectionString == 'undefined') throw new Error("Set DATABASE_URL for local PostgreSQL.");
const pool = new Pool({ connectionString });
const client = await pool.connect();
try {
  await client.query("BEGIN");
  await client.query("CREATE EXTENSION IF NOT EXISTS vector");
  // Keep the previous Prisma 8 tables untouched. This schema belongs to the shared API.
  await client.query("CREATE SCHEMA IF NOT EXISTS matchmaker");
  await client.query("SET LOCAL search_path TO matchmaker, public");
  await client.query('CREATE TABLE IF NOT EXISTS "_Migrations" (id text PRIMARY KEY)');
  const applied = await client.query('SELECT id FROM "_Migrations" WHERE id=$1', ["001"]);
  if (!applied.rowCount) {
    const tables = (await readFile("migrations/0001_schema.sql", "utf8"))
      .replaceAll("DATETIME", "TIMESTAMP(3)").replaceAll(" REAL", " DOUBLE PRECISION");
    await client.query(tables);
    await client.query(await readFile("scripts/local/invariants.sql", "utf8"));
    await client.query('INSERT INTO "_Migrations" (id) VALUES ($1)', ["001"]);
    const previous = await client.query("SELECT to_regclass('public.\"Users\"') AS name");
    if (previous.rows[0]?.name) {
      await client.query(`INSERT INTO "Users" ("id","age","name","email","score","income","disability","createdAt","updatedAt")
        SELECT id::text,age,name,email,score,income::text,disability,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP FROM public."Users"
        ON CONFLICT DO NOTHING`);
      console.log("Imported existing students into the matchmaker schema; original tables were preserved.");
    }
  }
  await client.query("COMMIT");
  console.log("Local PostgreSQL schema ready.");
} catch (error) { await client.query("ROLLBACK"); throw error; }
finally { client.release(); await pool.end(); }

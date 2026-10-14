import type { Pool, PoolClient } from "pg";

// Only the small raw-SQL subset used by the shared API crosses this adapter.
// ORM queries use Prisma's PostgreSQL client directly.
export function postgresSql(sql: string) {
  let position = 0;
  const ignoreConflict = /INSERT OR IGNORE/i.test(sql);
  sql = sql.replace(/INSERT OR IGNORE/i, "INSERT");
  sql = sql.replace(/json_extract\(options, '\$\.lastHeartbeat'\)/g, '(options->>\'lastHeartbeat\')::bigint');
  sql = sql.replace(/ELSE 0 END/g, "ELSE false END");
  // Camel-case identifiers require quoting in PostgreSQL. Leave literals intact.
  sql = sql.replace(/'(?:''|[^'])*'|"[^"]*"|[A-Za-z_][A-Za-z_0-9]*|\?/g, (token) => {
    if (token === "?") return "$" + (++position);
    if (token.startsWith("'") || token.startsWith('"')) return token;
    if (/[a-z][A-Z]|^[A-Z][a-z]/.test(token)) return '"' + token + '"';
    return token;
  });
  if (ignoreConflict) sql = sql.trim().replace(/;$/, "") + " ON CONFLICT DO NOTHING";
  return sql;
}
class Statement {
  constructor(readonly pool: Pool, readonly sql: string, readonly values: unknown[] = []) {}
  bind(...values: unknown[]) { return new Statement(this.pool, this.sql, values); }
  async execute(client: Pool | PoolClient = this.pool) {
    const result = await client.query(postgresSql(this.sql), this.values);
    return { results: result.rows, success: true, meta: { changes: result.rowCount ?? 0 } };
  }
  run() { return this.execute(); }
}
export class PostgresStatements {
  constructor(private readonly pool: Pool) {}
  prepare(sql: string) { return new Statement(this.pool, sql); }
  async batch(statements: Statement[]) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const results = [];
      for (const statement of statements) results.push(await statement.execute(client));
      await client.query("COMMIT");
      return results;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  }
}

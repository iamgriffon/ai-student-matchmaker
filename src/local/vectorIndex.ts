import type { Pool } from "pg";

const VECTOR_DIMENSIONS = 32;
type Vector = { id: string; values: number[]; namespace?: string; metadata?: Record<string, unknown> };
function literal(values: number[]) {
  if (values.length !== VECTOR_DIMENSIONS || !values.every(Number.isFinite)) throw new Error("Invalid vector.");
  return "[" + values.join(",") + "]";
}
export class PostgresVectorIndex {
  constructor(private readonly pool: Pool, private readonly kind: "student" | "pair") {}
  async upsert(vectors: Vector[]) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      for (const vector of vectors) await client.query(
        'INSERT INTO "VectorIndex" (kind,id,namespace,values,metadata) VALUES ($1,$2,$3,$4::vector,$5::jsonb) ON CONFLICT(kind,id) DO UPDATE SET namespace=excluded.namespace,values=excluded.values,metadata=excluded.metadata',
        [this.kind, vector.id, vector.namespace ?? "", literal(vector.values), JSON.stringify(vector.metadata ?? {})],
      );
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
    return { mutationId: crypto.randomUUID() };
  }
  async query(values: number[], options: { namespace?: string; topK?: number }) {
    const rows = await this.pool.query(
      'SELECT id,metadata,values <-> $1::vector AS distance FROM "VectorIndex" WHERE kind=$2 AND namespace=$3 ORDER BY distance,id LIMIT $4',
      [literal(values), this.kind, options.namespace ?? "", options.topK ?? 50],
    );
    return { matches: rows.rows.map((row) => ({ id: row.id, metadata: row.metadata, score: Number(row.distance) })), count: rows.rowCount };
  }
  async getByIds(ids: string[]) {
    const rows = await this.pool.query('SELECT id,values::text,namespace,metadata FROM "VectorIndex" WHERE kind=$1 AND id=ANY($2::text[])', [this.kind, ids]);
    return rows.rows.map((row) => ({ ...row, values: JSON.parse(row.values) }));
  }
  async deleteByIds(ids: string[]) {
    await this.pool.query('DELETE FROM "VectorIndex" WHERE kind=$1 AND id=ANY($2::text[])', [this.kind, ids]);
    return { mutationId: crypto.randomUUID() };
  }
}

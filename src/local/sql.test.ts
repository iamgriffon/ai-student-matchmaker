import { describe, expect, test } from "bun:test";
import { postgresSql } from "./sql.ts";
describe("local/postgresSql", () => {
  test("binds parameters and quotes identifiers without modifying literals", () => {
    expect(postgresSql("UPDATE TrainingJob SET activeKey = ?, message = 'Keep MyText ?' WHERE id = ?"))
      .toBe('UPDATE "TrainingJob" SET "activeKey" = $1, message = \'Keep MyText ?\' WHERE id = $2');
  });
  test("preserves pair idempotency with PostgreSQL conflict handling", () => {
    expect(postgresSql("INSERT OR IGNORE INTO PairOutcomes (userAId) SELECT ?"))
      .toBe('INSERT INTO "PairOutcomes" ("userAId") SELECT $1 ON CONFLICT DO NOTHING');
  });
  test("reads numeric heartbeat timestamps from JSONB", () => {
    expect(postgresSql("SELECT coalesce(json_extract(options, '$.lastHeartbeat'), 0) < ?"))
      .toBe("SELECT coalesce((options->>'lastHeartbeat')::bigint, 0) < $1");
  });
  test("uses a boolean when invalidating an uploaded vector", () => {
    expect(postgresSql("CASE WHEN PairVectors.vectorId = excluded.vectorId THEN PairVectors.uploaded ELSE 0 END"))
      .toBe('CASE WHEN "PairVectors"."vectorId" = excluded."vectorId" THEN "PairVectors".uploaded ELSE false END');
  });
});

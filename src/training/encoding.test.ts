import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { encodeBase64, decodeBase64, modelHash } from "./encoding.ts";
describe("training/encoding", () => {
  test("preserves all weight bytes in base64", () => {
    const bytes = Uint8Array.from({ length: 256 }, (_, index) => index);
    expect(decodeBase64(encodeBase64(bytes))).toEqual(bytes);
  });
  test("preserves model IDs produced by the previous Node serializer", async () => {
    const topology = { layers: [128, 64, 32, 1] };
    const weights = new Uint8Array([0, 128, 255, 1]);
    expect(await modelHash(topology, weights)).toBe(createHash("sha256").update(JSON.stringify(topology)).update(weights).digest("hex"));
  });
});

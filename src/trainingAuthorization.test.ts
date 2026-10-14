import { describe, expect, test } from "bun:test";
import { requireTrainingAuthorization } from "./trainingAuthorization.ts";

const env = { LOCAL_DEVELOPMENT: "true" };
describe("training/authorization", () => {
  test("permits same-origin browser training only in explicit local development", async () => {
    await expect(requireTrainingAuthorization(new Request("http://localhost:8787/api/train", {
      headers: { origin: "http://localhost:8787" },
    }), env)).resolves.toBeUndefined();
  });
  test("rejects cross-origin requests even in local development", async () => {
    await expect(requireTrainingAuthorization(new Request("http://localhost:8787/api/train", {
      headers: { origin: "https://untrusted.example" },
    }), env)).rejects.toThrow("same-origin");
  });
  test("does not apply the local bypass to deployed hostnames", async () => {
    await expect(requireTrainingAuthorization(new Request("https://vestibulandos.example/api/train", {
      headers: { origin: "https://vestibulandos.example" },
    }), env)).rejects.toThrow("Configure");
  });
  test("requires Access when the local flag is absent", async () => {
    await expect(requireTrainingAuthorization(new Request("http://localhost:8787/api/train"), {
      ACCESS_TEAM_DOMAIN: "https://test.cloudflareaccess.com", ACCESS_AUD: "test",
    })).rejects.toThrow("Sign in");
  });
});

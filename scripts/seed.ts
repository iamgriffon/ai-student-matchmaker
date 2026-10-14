import { readFile, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

const target = process.argv.includes("--remote") ? "--remote" : "--local";
const sqlString = (value: string) => `'${value.replaceAll("'", "''")}'`;
const deterministicId = (key: string) => {
  const hash = createHash("sha256").update(key).digest("hex");
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
};
const users = (await readFile(new URL("../dataset/users.csv", import.meta.url), "utf8")).trim().split(/\r?\n/).slice(1);
const weights = (await readFile(new URL("../dataset/weights.csv", import.meta.url), "utf8")).trim().split(/\r?\n/).slice(1);
const now = new Date().toISOString();
const statements: string[] = [];
for (const line of users) {
  const [sourceId, name, age, score, income, disability, email] = line.split(",");
  if (typeof sourceId == 'undefined' || typeof name == 'undefined' || typeof email == 'undefined' || typeof income == 'undefined') throw new Error("Invalid student CSV row.");
  const ageValue = Number(age), scoreValue = Number(score);
  if (!Number.isInteger(ageValue) || !Number.isInteger(scoreValue) || !Number.isFinite(Number(income))) throw new Error("Invalid numeric student fields.");
  const id = deterministicId(`student:${sourceId}:${email}`);
  statements.push(`INSERT INTO Users (id, name, age, score, income, disability, email, createdAt, updatedAt) VALUES (${sqlString(id)}, ${sqlString(name)}, ${ageValue}, ${scoreValue}, ${sqlString(income)}, ${disability === "Sim" ? 1 : 0}, ${sqlString(email)}, ${sqlString(now)}, ${sqlString(now)}) ON CONFLICT(email) DO NOTHING;`);
}
for (const line of weights) {
  const [field, rawValue] = line.split(",");
  const value = Number(rawValue);
  if (typeof field == 'undefined' || !Number.isFinite(value)) throw new Error("Invalid weight CSV row.");
  statements.push(`INSERT INTO Weights (id, field, value) VALUES (${sqlString(deterministicId(`weight:${field}`))}, ${sqlString(field)}, ${value}) ON CONFLICT(field) DO NOTHING;`);
}
const directory = await mkdtemp(join(tmpdir(), "vestibulandos-d1-seed-"));
try {
  const file = join(directory, "seed.sql");
  await writeFile(file, statements.join("\n"));
  // Wrangler uses its Node shebang; forcing the CLI to run under Bun is unsupported.
  const result = Bun.spawn(["node", "node_modules/wrangler/bin/wrangler.js", "d1", "execute", "vestibulandos", target, "--file", file], { cwd: new URL("../", import.meta.url).pathname, stdout: "inherit", stderr: "inherit" });
  if (await result.exited !== 0) throw new Error("D1 seed failed.");
  console.log(`Seeded ${users.length} students and ${weights.length} weights. Vectorize is populated on the first training or recommendation request.`);
} finally { await rm(directory, { recursive: true, force: true }); }

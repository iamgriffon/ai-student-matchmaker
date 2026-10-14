import { readFile, mkdir, writeFile } from "node:fs/promises";

// One domain schema; only the provider, runtime and output differ.
const source = await readFile("prisma/schema.prisma", "utf8");
const postgres = source.replace('provider = "sqlite"', 'provider = "postgresql"')
  .replace('runtime = "cloudflare"', 'runtime = "nodejs"')
  .replace('output = "../src/generated/prisma"', 'output = "../../src/generated/postgres"');
await mkdir("prisma/generated", { recursive: true });
await writeFile("prisma/generated/postgres.prisma", postgres);
const child = Bun.spawn(["node", "node_modules/prisma/build/index.js", "generate", "--schema", "prisma/generated/postgres.prisma"], {
  stdin: "inherit", stdout: "inherit", stderr: "inherit",
});
process.exit(await child.exited);

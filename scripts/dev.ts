import { fileURLToPath } from "node:url";

const PROJECT_ROOT = fileURLToPath(new URL("../", import.meta.url));
const WRANGLER = fileURLToPath(new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url));
const DEFAULT_PORT = "8787";

async function wrangler(args: string[]) {
  const child = Bun.spawn(["node", WRANGLER, ...args], {
    cwd: PROJECT_ROOT, stdin: "inherit", stdout: "inherit", stderr: "inherit",
  });
  const stop = () => child.kill("SIGTERM");
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  try { return await child.exited; }
  finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}

const args = process.argv.slice(2);
if (args.includes("--local")) {
  for (const script of ["scripts/local/generate.ts", "scripts/local/migrate.ts"]) {
    const child = Bun.spawn([process.execPath, script], { cwd: PROJECT_ROOT, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
    const code = await child.exited;
    if (code !== 0) process.exit(code);
  }
  const child = Bun.spawn([process.execPath, "--watch", "src/local/server.ts"], { cwd: PROJECT_ROOT, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  process.on("SIGINT", () => child.kill("SIGTERM"));
  process.on("SIGTERM", () => child.kill("SIGTERM"));
  process.exit(await child.exited);
}
const migrationExit = await wrangler(["d1", "migrations", "apply", "vestibulandos", "--local"]);
if (migrationExit !== 0) process.exit(migrationExit);
process.exit(await wrangler(["dev", "--ip", "127.0.0.1", "--var", "LOCAL_DEVELOPMENT:true", "--port", DEFAULT_PORT, ...args]));

import { fileURLToPath } from "node:url";

const PROJECT_ROOT = fileURLToPath(new URL("../", import.meta.url));
const CLOUDFLARE_ROOT = fileURLToPath(new URL("../cloudflare/", import.meta.url));
const SUPPORTED_COMMANDS = new Set(["build", "deploy", "dev"]);
const command = process.argv[2];
if (typeof command == 'undefined' || !SUPPORTED_COMMANDS.has(command)) {
  throw new Error("Use build, deploy or dev for the Cloudflare target.");
}
let child: ReturnType<typeof Bun.spawn> | null = null;
process.once("SIGINT", () => child?.kill("SIGINT"));
process.once("SIGTERM", () => child?.kill("SIGTERM"));
process.once("exit", () => child?.kill());
async function run(args: string[]) {
  child = Bun.spawn([process.execPath, ...args], {
    cwd: PROJECT_ROOT, stdin: "inherit", stdout: "inherit", stderr: "inherit",
  });
  const code = await child.exited;
  child = null;
  if (code !== 0) process.exit(code);
}

// CI installs the root package only. The D1 target has its own Prisma version and lockfile.
await run(["install", "--cwd", CLOUDFLARE_ROOT, "--frozen-lockfile"]);
await run(["run", "--cwd", CLOUDFLARE_ROOT, command]);

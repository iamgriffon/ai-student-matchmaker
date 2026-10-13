import { watch, type FSWatcher } from "node:fs";
import { extname, basename } from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = fileURLToPath(new URL("../", import.meta.url));
const WATCHED_DIRECTORIES = ["src", "db", "scripts", "public"];
const WATCHED_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".json", ".html", ".css", ".toml"]);
const RESTART_DEBOUNCE_MS = 250;
const SERVER_STOP_TIMEOUT_MS = 5000;
const SERVER_ENTRYPOINT = "src/index.ts";
const watchers: FSWatcher[] = [];
let child: ReturnType<typeof Bun.spawn> | null = null;
let restartTimer: ReturnType<typeof setTimeout> | null = null;
let restarting = false;
let restartPending = false;
let stopping = false;

function shouldWatch(filename: string) {
  const segments = filename.split(/[\\/]/);
  if (segments.some((segment) => ["node_modules", "tests", "dist", ".git"].includes(segment))) return false;
  if (/\.(test|spec)\.[^.]+$/.test(filename)) return false;
  const name = basename(filename);
  return WATCHED_EXTENSIONS.has(extname(name)) || name === "bun.lock" || name === ".env" || name.startsWith(".env.");
}

function startServer() {
  child = Bun.spawn([process.execPath, "run", SERVER_ENTRYPOINT], {
    cwd: PROJECT_ROOT, env: process.env, stdin: "inherit", stdout: "inherit", stderr: "inherit",
  });
  const current = child;
  current.exited.then((code) => {
    if (child !== current) return;
    child = null;
    if (!stopping && !restarting) console.log(`[dev] Servidor encerrado (${code}). Aguardando alterações…`);
  });
}

async function stopServer() {
  const current = child;
  if (!current) return;
  current.kill("SIGTERM");
  const timeout = setTimeout(() => current.kill("SIGKILL"), SERVER_STOP_TIMEOUT_MS);
  try { await current.exited; }
  finally { clearTimeout(timeout); }
}

async function restartServer() {
  if (stopping) return;
  if (restarting) { restartPending = true; return; }
  restarting = true;
  try {
    do {
      restartPending = false;
      await stopServer();
      if (!stopping) startServer();
    } while (restartPending && !stopping);
  } finally { restarting = false; }
}

function scheduleRestart(filename: string) {
  if (stopping || !shouldWatch(filename)) return;
  // O --watch do próprio launcher já reinicia este arquivo.
  if (filename === "scripts/dev.ts") return;
  if (restartTimer) clearTimeout(restartTimer);
  restartTimer = setTimeout(() => {
    console.log(`[dev] ${filename} alterado. Reiniciando servidor…`);
    void restartServer();
  }, RESTART_DEBOUNCE_MS);
}

async function shutdown() {
  if (stopping) return;
  stopping = true;
  if (restartTimer) clearTimeout(restartTimer);
  for (const watcher of watchers) watcher.close();
  await stopServer();
  process.exit(0);
}

for (const directory of WATCHED_DIRECTORIES) {
  watchers.push(watch(new URL(`../${directory}/`, import.meta.url), { recursive: true }, (_, filename) => {
    if (filename !== null) scheduleRestart(`${directory}/${filename}`);
  }));
}
// Configurações na raiz também contam; dependências e arquivos gerados fora dos módulos ficam de fora.
watchers.push(watch(PROJECT_ROOT, (_, filename) => {
  if (filename !== null) scheduleRestart(filename);
}));
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
process.once("exit", () => child?.kill());
console.log(`[dev] Observando ${WATCHED_DIRECTORIES.join(", ")} e configurações da raiz.`);
startServer();

/**
 * `bun run start:prod` — the documented production start command (B1).
 *
 *   1. builds the standalone server if it is missing,
 *   2. runs database migrations (with automatic pre-upgrade backup),
 *   3. serves on LESTER_PORT (default 8090), bound to LESTER_BIND
 *      (default 127.0.0.1 — loopback only until an operator opts in),
 *   4. shuts down gracefully on SIGINT/SIGTERM: stops accepting connections,
 *      lets in-flight writes finish, WAL-checkpoints and closes the database.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { LESTER } from "../src/lib/env";

const ROOT = path.join(import.meta.dir, "..");
const standalone = path.join(ROOT, ".next", "standalone", "server.js");

function log(msg: string) {
  console.log(`[lester] ${msg}`);
}

// 1 — build if needed
if (!existsSync(standalone)) {
  log("no production build found — building (one time)…");
  const build = spawnSync("bun", ["run", "build"], { cwd: ROOT, stdio: "inherit", env: process.env });
  if (build.status !== 0) {
    console.error("[lester] build failed — cannot start.");
    process.exit(1);
  }
}

// 2 — migrations (never destructive; auto-backup before upgrades)
const migrate = spawnSync("bun", ["run", "migrate"], { cwd: ROOT, stdio: "inherit", env: process.env });
if (migrate.status !== 0) {
  console.error("[lester] migrations failed — refusing to start on a possibly inconsistent database.");
  process.exit(1);
}

// 3 — serve with explicit bind + port
const env = {
  ...process.env,
  NODE_ENV: "production",
  NEXT_TELEMETRY_DISABLED: "1", // no telemetry, ever — including Next's own
  PORT: String(LESTER.port),
  HOSTNAME: LESTER.bind, // the Next standalone server reads HOSTNAME for binding
} as NodeJS.ProcessEnv;

log(`serving on http://${LESTER.bind}:${LESTER.port} (loopback-only unless LESTER_BIND is set — see docs/guide.md)`);

const server = spawn("bun", [standalone], {
  cwd: path.join(ROOT, ".next", "standalone"),
  stdio: "inherit",
  env,
});

let shuttingDown = false;
function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`${signal} received — shutting down gracefully (finishing in-flight writes)…`);
  server.kill(signal as NodeJS.Signals);
}
server.on("close", (code) => {
  log(`server exited (code ${code ?? 0})`);
  process.exit(code ?? 0);
});
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

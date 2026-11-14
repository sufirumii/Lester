/**
 * Playwright webServer helper — two modes in one file:
 *
 *   bun tests/e2e/server.ts                → the real Lester production server
 *                                             (fresh temp database, fake engine
 *                                             auto-detected, setup completed)
 *   bun tests/e2e/server.ts --engine-only  → just the deterministic fake engine
 *                                             on the standard Ollama port 11434
 *
 * v1.0.2 consolidation: absorbs fake-engine-server.ts, and fixes a latent
 * v1.0.1 path bug (the server.js path is now absolute — with a relative path
 * and cwd=.next/standalone, bun could not resolve the entry file).
 */
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { startFakeEngine } from "../helpers";

const ROOT = path.join(import.meta.dir, "..", "..");
const PORT = 8787;

// ── engine-only mode (was tests/e2e/fake-engine-server.ts) ────────────────────
if (process.argv.includes("--engine-only")) {
  const engine = startFakeEngine({ port: 11434 });
  console.log(`[e2e] fake engine on http://127.0.0.1:11434/v1 (${engine.server.url})`);
  process.on("SIGTERM", () => {
    engine.stop();
    process.exit(0);
  });
  // keep alive
  setInterval(() => undefined, 60_000);
} else {
  // ── app server mode (was tests/e2e/server.ts) ────────────────────────────────
  const dir = mkdtempSync(path.join(tmpdir(), "lester-e2e-"));
  const dbUrl = `file:${path.join(dir, "lester.db")}?connection_limit=1`;

  execFileSync("bunx", ["prisma", "migrate", "deploy"], {
    cwd: ROOT,
    env: { ...process.env, DATABASE_URL: dbUrl },
    stdio: "pipe",
    timeout: 90_000,
  });

  const server = spawn("bun", [path.join(ROOT, ".next", "standalone", "server.js")], {
    cwd: path.join(ROOT, ".next", "standalone"),
    env: {
      ...process.env,
      NODE_ENV: "production",
      PORT: String(PORT),
      HOSTNAME: "127.0.0.1",
      DATABASE_URL: dbUrl,
      LESTER_DATA_DIR: dir,
      LESTER_ENGINE: "auto",
    },
    stdio: "inherit",
  });

  async function ready(): Promise<boolean> {
    for (let i = 0; i < 120; i++) {
      try {
        const r = await fetch(`http://127.0.0.1:${PORT}/api/health-live`);
        if (r.ok) return true;
      } catch {
        /* booting */
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    return false;
  }

  ready().then(async (ok) => {
    if (!ok) {
      console.error("[e2e] server failed to become healthy");
      server.kill("SIGTERM");
      process.exit(1);
    }
    // complete first-run setup against the fake engine
    const res = await fetch(`http://127.0.0.1:${PORT}/api/setup/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        adminUsername: "admin",
        adminPassword: "e2e-password-123",
        workspaceName: "E2E",
        engineUrl: "http://127.0.0.1:11434/v1",
        engineAdapter: "generic",
      }),
    });
    if (!res.ok) {
      console.error("[e2e] setup failed:", await res.text());
      server.kill("SIGTERM");
      process.exit(1);
    }
    console.log(`[e2e] Lester ready on http://127.0.0.1:${PORT} (setup complete)`);
  });

  process.on("SIGTERM", () => {
    server.kill("SIGTERM");
    process.exit(0);
  });
  setInterval(() => undefined, 60_000);
}

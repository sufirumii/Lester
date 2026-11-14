import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright end-to-end smoke tests. These complement the bun test suite
 * (which already exercises the real server + OpenAI SDK) with browser-level
 * flows. Run in CI or locally:
 *
 *   bunx playwright install --with-deps   # once
 *   bunx playwright test --config tests/playwright.config.ts
 *
 * A deterministic fake engine and a fresh database are spun up per run
 * (webServer below) — no network, no real model needed.
 */
export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: "http://127.0.0.1:8787",
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      command: "bun e2e/server.ts --engine-only",
      port: 11434,
      reuseExistingServer: true,
    },
    {
      command: "bun e2e/server.ts",
      port: 8787,
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
});

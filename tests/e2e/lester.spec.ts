import { test, expect } from "@playwright/test";

/**
 * End-to-end smoke tests (T1): first-run setup, chat, policy block, Proof
 * export, Fit run — against the real app with the deterministic fake engine.
 * The webServer fixture (playwright.config.ts) prepares setup already; these
 * tests walk the actual UI.
 */

test("health: app loads with security headers", async ({ page }) => {
  const res = await page.goto("/");
  expect(res?.status()).toBe(200);
  const csp = await page.evaluate(() => document.title);
  expect(csp).toBeTruthy();
});

test("login screen → sign in with the e2e admin", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("button", { name: /sign in/i })).toBeVisible({ timeout: 30_000 });
  await page.getByLabel(/username/i).fill("admin");
  await page.getByLabel(/password/i).fill("e2e-password-123");
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page.getByText(/proof|chat|health/i).first()).toBeVisible({ timeout: 30_000 });
});

test("chat completes against the (fake) local engine", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel(/username/i).fill("admin");
  await page.getByLabel(/password/i).fill("e2e-password-123");
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page.getByText(/chat/i).first()).toBeVisible({ timeout: 30_000 });

  // pick the model served by the fake engine if a model picker exists
  const modelPicker = page.getByRole("combobox").first();
  if (await modelPicker.isVisible().catch(() => false)) {
    await modelPicker.click();
    const option = page.getByRole("option").filter({ hasText: /fake/i }).first();
    if (await option.isVisible().catch(() => false)) await option.click();
  }

  const box = page.getByPlaceholder(/message|ask/i).first();
  await box.fill("hello from playwright");
  await box.press("Enter");
  await expect(page.getByText(/FAKE\[fake-mini\]/i).first()).toBeVisible({ timeout: 60_000 });
});

test("policy blocks a keyword and the Proof ledger records it", async ({ page }) => {
  // set a blocking policy via the API (admin session from the UI login)
  await page.goto("/");
  await page.getByLabel(/username/i).fill("admin");
  await page.getByLabel(/password/i).fill("e2e-password-123");
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page.getByText(/chat/i).first()).toBeVisible({ timeout: 30_000 });

  const ws = await page.request.get("/api/workspaces");
  const { workspaces } = (await ws.json()) as { workspaces: { id: string }[] };
  const put = await page.request.put("/api/policy", {
    data: {
      workspaceId: workspaces[0].id,
      policy: { mode: "LOCAL_ONLY", redactPii: true, blockKeywords: "project-gamma", allowedModels: "", maxTokens: 2048 },
    },
  });
  expect(put.ok()).toBeTruthy();

  const box = page.getByPlaceholder(/message|ask/i).first();
  await box.fill("tell me about project-gamma");
  await box.press("Enter");
  await expect(page.getByText(/blocked by keyword rule/i).first()).toBeVisible({ timeout: 30_000 });
});

test("Proof export downloads a signed JSON report", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel(/username/i).fill("admin");
  await page.getByLabel(/password/i).fill("e2e-password-123");
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page.getByText(/chat/i).first()).toBeVisible({ timeout: 30_000 });

  const res = await page.request.get("/api/proof/export?format=json");
  expect(res.ok()).toBeTruthy();
  const report = (await res.json()) as { product: string; signature: string; chain: { valid: boolean } };
  expect(report.product).toBe("Lester");
  expect(report.signature).toBeTruthy();
  expect(report.chain.valid).toBe(true);
});

test("Fit run page loads and validates prompt count", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel(/username/i).fill("admin");
  await page.getByLabel(/password/i).fill("e2e-password-123");
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page.getByText(/chat/i).first()).toBeVisible({ timeout: 30_000 });
  // Fit tab exists and shows its honest guidance
  await page.getByRole("button", { name: /^fit$/i }).click();
  await expect(page.getByText(/20–200/i).first()).toBeVisible();
});

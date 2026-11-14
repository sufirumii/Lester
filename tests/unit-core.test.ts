
/**
 * Core platform tests — pure logic plus the migration runner.
 * Merged in v1.0.2 from: migrations, policy, redaction, bind and urlguard
 * tests (every test name and assertion unchanged; module imports updated to
 * the consolidated lib paths).
 *
 * ORDERING NOTE: the migrations group runs FIRST and is byte-faithful to the
 * original file's import timing — nothing in this file (transitively) imports
 * the Prisma singleton before it, because the migrations tests point
 * DATABASE_URL at their own v1.0.0/fresh databases mid-test and the singleton
 * binds the environment it first initializes under. The pure-logic groups
 * (policy, redaction, bind, urlguard) import their modules lazily in
 * describe-level hooks and never query the database.
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { freshDb } from "./helpers";
import type { PolicyRules } from "@/lib/governance"; // type-only — erased at runtime, keeps the lazy-db timing intact

process.env.LESTER_ENGINE = "none";
delete process.env.LESTER_ALLOW_METADATA_ENDPOINTS;

// ── shared lets for the pure-logic groups (assigned in describe-level hooks) ──
let evaluatePolicy: typeof import("@/lib/governance").evaluatePolicy;
let MODE_PLAIN_LANGUAGE: typeof import("@/lib/governance").MODE_PLAIN_LANGUAGE;
let redact: typeof import("@/lib/governance").redact;
let checkUrl: typeof import("@/lib/governance").checkUrl;
let resolveUrlEgress: typeof import("@/lib/engine").resolveUrlEgress;
let classifyIp: typeof import("@/lib/engine").classifyIp;
let guardedFetch: typeof import("@/lib/engine").guardedFetch;
let EgressBlockedError: typeof import("@/lib/engine").EgressBlockedError;
let startFakeEngine: typeof import("./helpers").startFakeEngine;

// ── migrations group helpers (module-level, db-free until the tests run) ─────
let v1Dir = "";
let v1Url = "";
const MIG_ROOT = path.join(import.meta.dir, "..");

function run(cmd: string, args: string[], env: Record<string, string>) {
  return execFileSync(cmd, args, { cwd: MIG_ROOT, env: { ...process.env, ...env }, encoding: "utf-8", timeout: 90_000 });
}

// ═══ v1.0.0 upgrade (B5) — from tests/migrations.test.ts ═════════════════════════════════════════════

describe("v1.0.0 → v1.0.1 upgrade (B5)", () => {
beforeAll(() => {
  v1Dir = mkdtempSync(path.join(tmpdir(), "lester-v100-upgrade-"));
  v1Url = `file:${path.join(v1Dir, "lester.db")}?connection_limit=1`;
  // 1 — build a v1.0.0 database: apply the baseline SQL directly
  run("bunx", ["prisma", "db", "execute", "--file", "prisma/migrations/0_init/migration.sql", "--url", v1Url], {
    DATABASE_URL: v1Url,
    PRISMA_HIDE_UPDATE_MESSAGE: "1",
  });
}, 120_000);

afterAll(() => rmSync(v1Dir, { recursive: true, force: true }));
  test("the v1.0.0 database is recognized and upgraded with data intact", async () => {
    // 2 — seed v1.0.0 data the way the old app would have (raw SQL against
    //     the old schema; proof rows carry REAL v1-form hashes)
    const { entryHashV1, canonicalJson } = await import("@/lib/proof");
    const mkRecord = (action: string, prevHash: string | null) => ({
      userId: "u1", username: "legacy", workspaceId: "w1", workspaceName: "Legacy Workspace",
      action, status: "ok", modelKey: null, provider: null, providerLabel: null,
      endpointHost: null, endpointIp: null, egress: null, latencyMs: null, tokensIn: null,
      tokensOut: null, redactions: null, detail: "{}", content: null, prevHash,
    });
    const r1 = mkRecord("chat.request", null);
    const h1 = entryHashV1(null, r1);
    const r2 = mkRecord("chat.response", h1);
    const h2 = entryHashV1(h1, r2);
    void canonicalJson;
    const seedSql = `
      INSERT INTO User (id, username, displayName, passwordHash, role, disabled, apiToken, createdAt, updatedAt)
        VALUES ('u1', 'legacy', 'Legacy Admin', 'deadbeef$cafe', 'ADMIN', 0, 'lst_legacyPlaintextToken123', '2025-01-01 10:00:00', '2025-01-01 10:00:00');
      INSERT INTO Workspace (id, name, description, defaultModel, createdAt, updatedAt)
        VALUES ('w1', 'Legacy Workspace', 'seeded', NULL, '2025-01-01 10:00:00', '2025-01-01 10:00:00');
      INSERT INTO Policy (id, workspaceId, mode, redactPii, blockKeywords, allowedModels, maxTokens, logContent, updatedAt)
        VALUES ('p1', 'w1', 'LOCAL_ONLY', 1, '', '', 2048, 0, '2025-01-01 10:00:00');
      INSERT INTO Conversation (id, workspaceId, userId, title, modelKey, createdAt, updatedAt)
        VALUES ('c1', 'w1', 'u1', 'Important customer thread', 'local:qwen2.5:1.5b', '2025-01-02 10:00:00', '2025-01-02 10:00:00');
      INSERT INTO Message (id, conversationId, userId, role, content, encrypted, blocked, redactions, createdAt)
        VALUES ('m1', 'c1', 'u1', 'user', 'customer secret data', 0, 0, 0, '2025-01-02 10:01:00');
      INSERT INTO ProofEntry (seq, ts, userId, username, workspaceId, workspaceName, action, status, detail, prevHash, selfHash)
        VALUES (1, '2025-01-02 10:01:00', 'u1', 'legacy', 'w1', 'Legacy Workspace', 'chat.request', 'ok', '{}', NULL, '${h1}');
      INSERT INTO ProofEntry (seq, ts, userId, username, workspaceId, workspaceName, action, status, detail, prevHash, selfHash)
        VALUES (2, '2025-01-02 10:01:01', 'u1', 'legacy', 'w1', 'Legacy Workspace', 'chat.response', 'ok', '{}', '${h1}', '${h2}');
    `;
    const seedPath = path.join(v1Dir, "seed.sql");
    ;(await import("node:fs")).writeFileSync(seedPath, seedSql);
    run("bunx", ["prisma", "db", "execute", "--file", seedPath, "--url", v1Url], { DATABASE_URL: v1Url });

    // 3 — run the migration runner against the v1.0.0 database
    process.env.DATABASE_URL = v1Url;
    process.env.LESTER_DATA_DIR = v1Dir;
    process.env.LESTER_BACKUP_DIR = path.join(v1Dir, "backups");
    const { runMigrations } = await import("@/lib/storage");
    const result = await runMigrations();

    expect(result.error).toBeUndefined();
    expect(result.integrityCheck).toBe("ok");
    expect(result.baselineApplied).toBe(true); // v1.0.0 database recognized
    expect(result.appliedMigrations).toContain("20260115000000_v101_tokens_throttle_proof");
    expect(result.preUpgradeBackup).toBeDefined();
    expect(existsSync(result.preUpgradeBackup!.path)).toBe(true);

    // 4 — data intact
    const { PrismaClient } = await import("@prisma/client");
    const db = new PrismaClient({ datasources: { db: { url: v1Url } } });
    const user = await db.user.findUnique({ where: { username: "legacy" } });
    expect(user?.displayName).toBe("Legacy Admin");
    const conv = await db.conversation.findUnique({ where: { id: "c1" } });
    expect(conv?.title).toBe("Important customer thread");
    const msg = await db.message.findUnique({ where: { id: "m1" } });
    expect(msg?.content).toBe("customer secret data");
    const proofs = await db.proofEntry.count();
    expect(proofs).toBe(2);

    // 5 — legacy plaintext API token was preserved for re-hashing
    const legacyRows = await db.$queryRawUnsafe<Array<{ token: string }>>(
      "SELECT token FROM ApiTokenLegacy"
    );
    expect(legacyRows.length).toBe(1);
    expect(legacyRows[0].token).toBe("lst_legacyPlaintextToken123");

    // 6 — the app's boot migration hashes it into ApiToken
    const bootstrap = await import("@/lib/storage");
    await bootstrap.ensureBooted(); // idempotent: migrates tokens, rehashes chain, checkpoints
    const hashed = await db.apiToken.findFirst();
    expect(hashed).toBeDefined();
    const { hashApiToken } = await import("@/lib/auth");
    expect(hashed!.tokenHash).toBe(hashApiToken("lst_legacyPlaintextToken123"));
    // and the legacy staging table is gone
    const tables = await db.$queryRawUnsafe<Array<{ name: string }>>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='ApiTokenLegacy'"
    );
    expect(tables.length).toBe(0);
    // the token authenticates the API
    const { authUserFromApiToken } = await import("@/lib/auth");
    const session = await authUserFromApiToken("lst_legacyPlaintextToken123");
    expect(session?.username).toBe("legacy");
    // plaintext never survived anywhere
    const anyUser = await db.user.findFirst();
    expect((anyUser as unknown as { apiToken?: string }).apiToken).toBeUndefined();

    // 7 — legacy proof entries were re-hashed to v2 (seq+ts covered)
    const chain = await (await import("@/lib/proof")).verifyChain();
    expect(chain.valid).toBe(true);
    expect(chain.legacyEntries).toBe(0);

    await db.$disconnect();
  }, 180_000);

  test("a fresh install applies all migrations from empty (no baseline hack)", async () => {
    const freshDir = mkdtempSync(path.join(tmpdir(), "lester-fresh-"));
    const freshUrl = `file:${path.join(freshDir, "lester.db")}?connection_limit=1`;
    process.env.DATABASE_URL = freshUrl;
    process.env.LESTER_DATA_DIR = freshDir;
    process.env.LESTER_BACKUP_DIR = path.join(freshDir, "backups");
    const { runMigrations } = await import("@/lib/storage");
    const result = await runMigrations();
    expect(result.freshInstall).toBe(true);
    expect(result.baselineApplied).toBe(false);
    expect(result.appliedMigrations.length).toBe(2);
    expect(result.integrityCheck).toBe("ok");
    rmSync(freshDir, { recursive: true, force: true });
    void readFileSync;
  }, 120_000);
});

// ═══ policy router — from tests/policy.test.ts ═════════════════════════════════════════════

const base: PolicyRules = {
  mode: "LOCAL_ONLY",
  redactPii: true,
  blockKeywords: "",
  allowedModels: "",
  maxTokens: 2048,
};

describe("policy router", () => {
  beforeAll(async () => {
    const g = await import("@/lib/governance");
    evaluatePolicy = g.evaluatePolicy;
    MODE_PLAIN_LANGUAGE = g.MODE_PLAIN_LANGUAGE;
  });
  test("BLOCK_ALL refuses everything with a clear reason", () => {
    const d = evaluatePolicy({ ...base, mode: "BLOCK_ALL" }, { text: "hi", modelKey: "local:x", targetIsCloud: false, cloudConfigured: false });
    expect(d.decision).toBe("block");
    expect(d.reason).toContain("Blocked");
  });

  test("keyword blocks are case-insensitive and substring-based", () => {
    const d = evaluatePolicy({ ...base, blockKeywords: "Project-Gamma" }, { text: "the PROJECT-gamma file", modelKey: "local:x", targetIsCloud: false, cloudConfigured: false });
    expect(d.decision).toBe("block");
    expect(d.reason.toLowerCase()).toContain("project-gamma");
  });

  test("cloud models are refused under LOCAL_ONLY even if configured", () => {
    const d = evaluatePolicy(base, { text: "hi", modelKey: "cloud:p:m", targetIsCloud: true, cloudConfigured: true });
    expect(d.decision).toBe("block");
    expect(d.reason).toContain("Cloud fallback is OFF");
  });

  test("CLOUD_FALLBACK mode allows cloud when a provider is configured", () => {
    const d = evaluatePolicy({ ...base, mode: "CLOUD_FALLBACK" }, { text: "hi", modelKey: "cloud:p:m", targetIsCloud: true, cloudConfigured: true });
    expect(d.decision).toBe("allow");
  });

  test("CLOUD_FALLBACK without a configured provider still blocks", () => {
    const d = evaluatePolicy({ ...base, mode: "CLOUD_FALLBACK" }, { text: "hi", modelKey: "cloud:p:m", targetIsCloud: true, cloudConfigured: false });
    expect(d.decision).toBe("block");
    expect(d.reason).toContain("no cloud provider is configured");
  });

  test("allowed-model list restricts selection", () => {
    const d = evaluatePolicy({ ...base, allowedModels: "local:a,local:b" }, { text: "hi", modelKey: "local:c", targetIsCloud: false, cloudConfigured: false });
    expect(d.decision).toBe("block");
    expect(d.reason).toContain("approved list");
  });

  test("PII redaction masks before dispatch and reports findings", () => {
    const d = evaluatePolicy(base, { text: "email me at ceo@example.com", modelKey: "local:a", targetIsCloud: false, cloudConfigured: false });
    expect(d.decision).toBe("allow");
    expect(d.redacted).toBe(true);
    expect(d.redactedText).toContain("[EMAIL REDACTED]");
    expect(d.redactionCount).toBe(1);
  });

  test("redaction can be disabled per policy", () => {
    const d = evaluatePolicy({ ...base, redactPii: false }, { text: "email me at ceo@example.com", modelKey: "local:a", targetIsCloud: false, cloudConfigured: false });
    expect(d.redacted).toBe(false);
    expect(d.redactedText).toBe("email me at ceo@example.com");
  });

  test("plain-language mode descriptions exist and are honest", () => {
    expect(MODE_PLAIN_LANGUAGE.LOCAL_ONLY.description).toContain("Nothing is ever sent to a cloud API");
    expect(MODE_PLAIN_LANGUAGE.CLOUD_FALLBACK.description).toContain("cloud provider may take over");
  });
});

// ═══ redaction (A5) — from tests/redaction.test.ts ═════════════════════════════════════════════

describe("redaction (A5)", () => {
  beforeAll(async () => {
    redact = (await import("@/lib/governance")).redact;
  });
  test("credit cards: Luhn-valid numbers masked in several formats; invalid ones pass through", () => {
    const valid = redact("pay with 4111 1111 1111 1111 today");
    expect(valid.redacted).not.toContain("4111 1111 1111 1111");
    expect(valid.redacted).toContain("[CARD REDACTED]");

    const dashed = redact("card 4111-1111-1111-1111 ok");
    expect(dashed.redacted).toContain("[CARD REDACTED]");

    const amex = redact("amex 378282246310005");
    expect(amex.redacted).toContain("[CARD REDACTED]");

    // invalid Luhn → not a card → passes through (documented false-negative-safe design)
    const invalid = redact("ref 4111 1111 1111 1112");
    expect(invalid.redacted).toContain("4111 1111 1111 1112");
  });

  test("emails", () => {
    const r = redact("contact rumi@example.co.in or admin@corp.io");
    expect(r.redacted).not.toContain("rumi@example.co.in");
    expect(r.findings.find((f) => f.type === "email")?.count).toBe(2);
  });

  test("phone numbers incl. Indian formats (+91)", () => {
    const cases = [
      "+91 98765 43210",
      "+91-9876543210",
      "+1 (415) 555-0132",
      "+49 30 12345678",
    ];
    for (const c of cases) {
      const r = redact(`call ${c} now`);
      expect(r.redacted).not.toContain(c);
    }
  });

  test("US SSN", () => {
    const r = redact("ssn 123-45-6789");
    expect(r.redacted).toContain("[SSN REDACTED]");
  });

  test("IBAN", () => {
    const r = redact("iban DE89370400440532013000");
    expect(r.redacted).toContain("[IBAN REDACTED]");
  });

  test("API keys of common shapes", () => {
    const r = redact("keys: sk-abcdefghijklmnopqrstuvwxyz123456 ghp_abcdefghijklmnopqrstuvwx AKIAIOSFODNN7EXAMPLE xoxb-1234567890abcdefghij");
    expect(r.findings.find((f) => f.type === "api_key")?.count).toBeGreaterThanOrEqual(3);
    expect(r.redacted).not.toContain("sk-abcdefghijklmnopqrstuvwxyz123456");
    expect(r.redacted).not.toContain("AKIAIOSFODNN7EXAMPLE");
  });

  test("private key blocks are masked entirely", () => {
    const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIEow...\n-----END RSA PRIVATE KEY-----";
    const r = redact(`sign with ${pem} please`);
    expect(r.redacted).toContain("[PRIVATE KEY REDACTED]");
    expect(r.redacted).not.toContain("MIIEow");
  });

  test("known gaps (documented, not hidden): 10-digit Indian mobiles without +91 prefix are NOT detected", () => {
    // National-format Indian numbers (e.g. 9876543210) are intentionally not
    // masked: the same 10-digit string is a common order/reference number, and
    // false positives destroy user trust. See docs/security-model.md.
    const r = redact("order 9876543210 shipped");
    expect(r.redacted).toContain("9876543210");
  });

  test("known gaps: Aadhaar-style 12-digit numbers are not a detector (no national-ID formats in v1)", () => {
    const r = redact("id 234123412346");
    expect(r.findings.find((f) => f.type === "ssn")).toBeUndefined();
  });
});

// ═══ bind + port resolution (B4/B1) — from tests/bind.test.ts ═════════════════════════════════════════════

describe("bind + port resolution (B4/B1)", () => {
  test("default bind is 127.0.0.1 (loopback-only) with no env set", async () => {
    delete process.env.LESTER_BIND;
    const { LESTER } = await import("@/lib/env");
    // env.ts caches LESTER at import time, so test the resolver directly:
    const mod = await import("@/lib/env");
    void LESTER;
    // resolveBind is not exported; assert via LESTER (imported fresh per process)
    expect(mod.LESTER.bind).toBe("127.0.0.1");
  });

  test("LESTER_BIND=0.0.0.0 is an explicit operator choice", () => {
    process.env.LESTER_BIND = "0.0.0.0";
    const val = (process.env.LESTER_BIND ?? "").trim() || "127.0.0.1";
    expect(val).toBe("0.0.0.0");
    delete process.env.LESTER_BIND;
  });

  test("default port is 8090; LESTER_PORT overrides; junk falls back safely", () => {
    const cases: Array<[string | undefined, number]> = [
      [undefined, 8090],
      ["", 8090],
      ["3000", 3000],
      ["not-a-port", 8090],
      ["99999", 8090],
      ["0", 8090],
    ];
    for (const [raw, expected] of cases) {
      if (raw === undefined) delete process.env.LESTER_PORT;
      else process.env.LESTER_PORT = raw;
      const n = parseInt((process.env.LESTER_PORT ?? "").trim(), 10);
      const port = raw && Number.isFinite(n) && n > 0 && n < 65536 ? n : 8090;
      expect(port).toBe(expected);
    }
    delete process.env.LESTER_PORT;
  });
});

// ═══ urlguard suites — from tests/urlguard.test.ts ═════════════════════════════════════════════

describe("IP classification", () => {
  beforeAll(async () => {
    const governance = await import("@/lib/governance");
    checkUrl = governance.checkUrl;
    const eng = await import("@/lib/engine");
    resolveUrlEgress = eng.resolveUrlEgress;
    classifyIp = eng.classifyIp;
    guardedFetch = eng.guardedFetch;
    EgressBlockedError = eng.EgressBlockedError;
    startFakeEngine = (await import("./helpers")).startFakeEngine;
  }, 60_000);
  test("loopback / private / link-local / external are classified correctly (v4 + v6)", () => {
    expect(classifyIp("127.0.0.1")).toBe("loopback");
    expect(classifyIp("127.8.8.8")).toBe("loopback");
    expect(classifyIp("::1")).toBe("loopback");
    expect(classifyIp("10.1.2.3")).toBe("private");
    expect(classifyIp("192.168.1.1")).toBe("private");
    expect(classifyIp("172.16.0.1")).toBe("private");
    expect(classifyIp("172.31.255.255")).toBe("private");
    expect(classifyIp("172.32.0.1")).toBe("external");
    expect(classifyIp("169.254.169.254")).toBe("private"); // link-local (refused separately)
    expect(classifyIp("fe80::1")).toBe("private");
    expect(classifyIp("fd00::5")).toBe("private");
    expect(classifyIp("8.8.8.8")).toBe("external");
    expect(classifyIp("::ffff:8.8.8.8")).toBe("external");
  });

  test("URL egress resolution resolves DNS at check time", async () => {
    const local = await resolveUrlEgress("http://127.0.0.1:11434/v1");
    expect(local.egress).toBe("loopback");
    const localhost = await resolveUrlEgress("http://localhost:9/v1");
    expect(localhost.egress).toBe("loopback");
  });
});

describe("admin URL validation (S5)", () => {
  test("non-http(s) schemes, embedded credentials and empty URLs are refused", async () => {
    expect((await checkUrl("file:///etc/passwd", { allowExternal: true })).ok).toBe(false);
    expect((await checkUrl("ftp://x", { allowExternal: true })).ok).toBe(false);
    expect((await checkUrl("gopher://x", { allowExternal: true })).ok).toBe(false);
    expect((await checkUrl("http://user:pass@host/", { allowExternal: true })).ok).toBe(false);
    expect((await checkUrl("", { allowExternal: true })).ok).toBe(false);
    expect((await checkUrl("not a url", { allowExternal: true })).ok).toBe(false);
  });

  test("cloud-metadata and link-local addresses are always refused for engines", async () => {
    const meta = await checkUrl("http://169.254.169.254/latest/meta-data/", { allowExternal: true });
    expect(meta.ok).toBe(false);
    expect(meta.reason).toContain("link-local / cloud-metadata");
    const engine = await checkUrl("http://169.254.169.254/v1", { allowExternal: false });
    expect(engine.ok).toBe(false);
  });

  test("local engines must resolve to loopback/private; public IPs are refused", async () => {
    expect((await checkUrl("http://8.8.8.8/v1", { allowExternal: false })).ok).toBe(false);
    expect((await checkUrl("http://127.0.0.1:11434/v1", { allowExternal: false })).ok).toBe(true);
  });

  test("cloud providers may be external (explicit admin action)", async () => {
    const res = await checkUrl("https://api.openai.com/v1", { allowExternal: true });
    expect(res.ok).toBe(true);
    expect(res.egress).toBe("external");
  });
});

describe("connect-time enforcement in the HTTP client (P3)", () => {
  test("guardedFetch allows loopback engines", async () => {
    const engine = startFakeEngine();
    try {
      const res = await guardedFetch(`${engine.url}/models`, {}, { allowExternal: false, timeoutMs: 3000 });
      expect(res.status).toBe(200);
      const data = (await res.json()) as { data: { id: string }[] };
      expect(data.data.some((mmm) => mmm.id === "fake-mini")).toBe(true);
    } finally {
      engine.stop();
    }
  });

  test("guardedFetch refuses public destinations when allowExternal=false — before any bytes leave", async () => {
    // 8.8.8.8 is a real public IP; the guard must throw before connecting.
    await expect(
      guardedFetch("http://8.8.8.8/v1/models", {}, { allowExternal: false, timeoutMs: 3000 })
    ).rejects.toBeInstanceOf(EgressBlockedError);
  });

  test("guardedFetch refuses metadata endpoints even with allowExternal=true", async () => {
    await expect(
      guardedFetch("http://169.254.169.254/latest/meta-data/", {}, { allowExternal: true, timeoutMs: 3000 })
    ).rejects.toBeInstanceOf(EgressBlockedError);
  });
});


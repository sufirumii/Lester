/**
 * Pipeline tests — the Proof ledger (hash v2, tamper detection, checkpoints,
 * v1→v2 upgrade), the real chat pipeline against the deterministic fake engine,
 * and the official OpenAI SDK against a real server. Merged in v1.0.2 from:
 * proof, pipeline and openai-api tests (every test name and assertion
 * unchanged). The proof and pipeline groups share one fresh database (their
 * assertions are relative); the OpenAI-SDK group is fully self-contained (own
 * server, own database, own fake engine) and is skipped when no production
 * build exists. Two leftover DEBUG console.log lines from the v1.0.1 SDK test
 * were removed; no assertion changed.
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { freshDb, startFakeEngine, type FakeEngine } from "./helpers";

process.env.LESTER_ENGINE = "none";
const dbh = freshDb("lester-pipeline-");
process.env.DATABASE_URL = dbh.url;
process.env.LESTER_DATA_DIR = dbh.dir;

const ROOT = path.join(import.meta.dir, "..");
const STANDALONE = path.join(ROOT, ".next", "standalone", "server.js");
const hasBuild = existsSync(STANDALONE);

let db: typeof import("@/lib/db").db;
let initDurability: typeof import("@/lib/db").initDurability;
let appendProof: typeof import("@/lib/proof").appendProof;
let verifyChain: typeof import("@/lib/proof").verifyChain;
let rehashLegacyChain: typeof import("@/lib/proof").rehashLegacyChain;
let createCheckpoint: typeof import("@/lib/proof").createCheckpoint;
let listCheckpoints: typeof import("@/lib/proof").listCheckpoints;
let entryHashV1: typeof import("@/lib/proof").entryHashV1;
let runChatTurn: typeof import("@/lib/chat").runChatTurn;
let saveSettings: typeof import("@/lib/env").saveSettings;
let engine: FakeEngine;
let workspaceId: string;
const user = { id: "u-test", username: "tester", displayName: "Tester", role: "ADMIN" as const };

beforeAll(async () => {
  const dbmod = await import("@/lib/db");
  db = dbmod.db;
  initDurability = dbmod.initDurability;
  const proof = await import("@/lib/proof");
  appendProof = proof.appendProof;
  verifyChain = proof.verifyChain;
  rehashLegacyChain = proof.rehashLegacyChain;
  createCheckpoint = proof.createCheckpoint;
  listCheckpoints = proof.listCheckpoints;
  entryHashV1 = proof.entryHashV1;
  runChatTurn = (await import("@/lib/chat")).runChatTurn;
  saveSettings = (await import("@/lib/env")).saveSettings;

  engine = startFakeEngine();
  await initDurability();
  await saveSettings({
    engine: { type: "openai-compat", url: engine.url, label: "Fake engine", adapter: "generic" },
  });
  const ws = await db.workspace.create({
    data: { name: "Test", policy: { create: { mode: "LOCAL_ONLY", redactPii: true } } },
  });
  workspaceId = ws.id;
  await db.modelEntry.create({
    data: {
      key: "local:fake-mini", name: "Fake Mini", provider: "LOCAL_ENGINE",
      installed: true, approved: true, enabled: true, installedAt: new Date(),
      meta: JSON.stringify({ engineModel: "fake-mini" }),
    },
  });
}, 60_000);

afterAll(async () => {
  engine?.stop();
  await db?.$disconnect().catch(() => undefined);
  dbh.cleanup();
});

async function seed(n: number) {
  for (let i = 0; i < n; i++) {
    await appendProof({ username: "u", action: `seed.${i}`, status: "ok", detail: { i } });
  }
}

async function turn(content: string, policyPatch?: Record<string, unknown>) {
  if (policyPatch) {
    const ws = await db.workspace.findUnique({ where: { id: workspaceId }, include: { policy: true } });
    await db.policy.update({ where: { id: ws!.policy!.id }, data: policyPatch });
  }
  const events: Record<string, unknown>[] = [];
  for await (const ev of runChatTurn({
    user, workspaceId, modelKey: "local:fake-mini", history: [], content,
    useKnowledge: false, persist: false,
  })) {
    events.push(ev as unknown as Record<string, unknown>);
  }
  return events;
}

// ═══ Proof ledger (P1/P2) — from tests/proof.test.ts ═════════════════════════════════════════════

describe("hash v2 (P1)", () => {
  test("chain verifies when untouched", async () => {
    await seed(4);
    const chain = await verifyChain();
    expect(chain.valid).toBe(true);
    expect(chain.legacyEntries).toBe(0);
    expect(chain.headHash).toHaveLength(64);
  });

  test("EDITING an entry is detected", async () => {
    const victim = await db.proofEntry.findFirst({ orderBy: { seq: "desc" } });
    expect(victim).toBeDefined();
    await db.proofEntry.update({ where: { seq: victim!.seq }, data: { detail: '{"tampered":true}' } });
    const chain = await verifyChain();
    expect(chain.valid).toBe(false);
    expect(chain.firstBrokenSeq).toBe(victim!.seq);
    expect(chain.brokenReason).toContain("modified");
    await db.proofEntry.update({ where: { seq: victim!.seq }, data: { detail: victim!.detail } });
    expect((await verifyChain()).valid).toBe(true);
  });

  test("DELETING a middle entry is detected", async () => {
    const victim = await db.proofEntry.findFirst({ orderBy: { seq: "asc" }, skip: 2 });
    const copy = JSON.parse(JSON.stringify(victim));
    await db.proofEntry.delete({ where: { seq: victim!.seq } });
    const chain = await verifyChain();
    expect(chain.valid).toBe(false);
    expect(chain.firstBrokenSeq).toBe(victim!.seq + 1);
    // restore by recreating the identical row
    delete copy.id;
    await db.proofEntry.create({ data: copy as never });
    expect((await verifyChain()).valid).toBe(true);
  });

  test("REORDERING (timestamp edit) is detected — v2 covers seq+ts", async () => {
    const entries = await db.proofEntry.findMany({ orderBy: { seq: "asc" } });
    expect(entries.length).toBeGreaterThanOrEqual(4);
    const a = entries[1];
    const b = entries[2];
    await db.proofEntry.update({ where: { seq: a.seq }, data: { ts: b.ts } });
    const chain = await verifyChain();
    expect(chain.valid).toBe(false);
    expect(chain.brokenReason).toContain("timestamp");
    await db.proofEntry.update({ where: { seq: a.seq }, data: { ts: a.ts } });
    expect((await verifyChain()).valid).toBe(true);
  });

  test("TRUNCATION is caught by signed checkpoints even though the shortened chain self-verifies", async () => {
    // pin the current head with a checkpoint first
    const cp = await createCheckpoint();
    const last = await db.proofEntry.findFirst({ orderBy: { seq: "desc" } });
    expect(cp.seq).toBe(last!.seq);
    // an attacker with disk access deletes the tail and rebuilds a consistent chain
    await db.proofEntry.delete({ where: { seq: last!.seq } });
    const after = await verifyChain();
    // internally consistent (the attacker re-hashed it) or not — either way:
    const checkpoints = await listCheckpoints(5);
    const pinned = checkpoints.find((c) => c.seq === last!.seq);
    expect(pinned).toBeDefined();
    expect(pinned!.headHash).toBe(cp.headHash);
    // the on-node chain no longer contains that head:
    const headNow = await db.proofEntry.findFirst({ orderBy: { seq: "desc" } });
    expect(headNow!.seq).toBeLessThan(last!.seq);
    // → an auditor with the exported checkpoint detects the truncation.
    expect(after.checked).toBe(last!.seq - 1);
  });
});

describe("legacy v1 upgrade (P1 migration strategy)", () => {
  test("a valid v1 chain rehashes to v2; a broken v1 chain is refused untouched", async () => {
    const rows = [
      { action: "legacy.a", status: "ok", detail: "{}" },
      { action: "legacy.b", status: "ok", detail: "{}" },
    ];
    // v1 rows must chain from the CURRENT head (a real legacy ledger's first
    // entry chains from whatever existed before it — here, the v2 entries above)
    const head = await db.proofEntry.findFirst({ orderBy: { seq: "desc" } });
    let prev: string | null = head?.selfHash ?? null;
    for (const r of rows) {
      const record = {
        userId: null, username: "legacy", workspaceId: null, workspaceName: null,
        action: r.action, status: r.status, modelKey: null, provider: null, providerLabel: null,
        endpointHost: null, endpointIp: null, egress: null, latencyMs: null, tokensIn: null,
        tokensOut: null, redactions: null, detail: r.detail, content: null, prevHash: prev,
      };
      const selfHash = entryHashV1(prev, record);
      await db.proofEntry.create({ data: { ...record, selfHash, hashVersion: "v1" } as never });
      prev = selfHash;
    }

    let chain = await verifyChain();
    expect(chain.valid).toBe(true);
    expect(chain.legacyEntries).toBe(2);

    const res = await rehashLegacyChain();
    expect(res.upgraded).toBe(2);
    expect(res.refused).toBeUndefined();
    chain = await verifyChain();
    expect(chain.valid).toBe(true);
    expect(chain.legacyEntries).toBe(0);
    expect(await db.proofEntry.findFirst({ where: { action: "proof.rehash" } })).toBeDefined();

    // Now corrupt one legacy-form row and confirm a re-run REFUSES to touch it.
    const bad = await db.proofEntry.findFirst({ where: { action: "legacy.b" } });
    await db.proofEntry.update({ where: { seq: bad!.seq }, data: { hashVersion: "v1", selfHash: "0".repeat(64) } });
    const refused = await rehashLegacyChain();
    expect(refused.upgraded).toBe(0);
    expect(refused.refused).toBeTruthy();
    expect(refused.refused).toContain("does not verify");

    // recovery: truncate the corrupted tail (documented last-resort repair) so
    // later tests continue on a valid chain
    const all = await db.proofEntry.findMany({ orderBy: { seq: "asc" } });
    const firstBadSeq = all.find((e) => e.action === "legacy.a")!.seq;
    await db.proofEntry.deleteMany({ where: { seq: { gte: firstBadSeq } } });
    expect((await verifyChain()).valid).toBe(true);
  });
});

describe("signed checkpoints (P2)", () => {
  test("checkpoint records seq, head hash, key id — and its signature verifies", async () => {
    await seed(2);
    const cp = await createCheckpoint();
    expect(cp.seq).toBeGreaterThan(0);
    expect(cp.headHash).toHaveLength(64);
    expect(cp.keyId).toHaveLength(16);
    expect(cp.signature.length).toBeGreaterThan(40);
    const list = await listCheckpoints(5);
    expect(list.some((c) => c.id === cp.id)).toBe(true);
    // the signature must verify against the node key with the exact payload form
    const { verifyBytes, proofSigningKey, nodeId } = await import("@/lib/auth");
    const payload = `lester-checkpoint:${nodeId()}:${cp.seq}:${cp.headHash}:${cp.ts}`;
    expect(verifyBytes(payload, cp.signature, proofSigningKey().publicPem)).toBe(true);
    // and the exported form (listCheckpoints) carries the signature too
    const exported = list.find((c) => c.id === cp.id)!;
    expect(exported.signature).toBe(cp.signature);
  });
});

// ═══ chat pipeline (A6) — from tests/pipeline.test.ts ═════════════════════════════════════════════

describe("chat pipeline (A6)", () => {
  test("allowed request: streams, records chat.request + chat.response with measured loopback egress", async () => {
    const events = await turn("hello world");
    const done = events.find((e) => e.type === "done") as { proofSeq: number; usage: { completionTokens: number } } | undefined;
    expect(done).toBeDefined();
    expect(done!.usage.completionTokens).toBeGreaterThan(0);

    const request = await db.proofEntry.findFirst({ where: { action: "chat.request" }, orderBy: { seq: "desc" } });
    const response = await db.proofEntry.findFirst({ where: { action: "chat.response" }, orderBy: { seq: "desc" } });
    expect(request?.egress).toBe("loopback"); // measured, not configured
    expect(request?.endpointIp).toBe("127.0.0.1");
    expect(response?.status).toBe("ok");
    expect(response?.tokensOut).toBeGreaterThan(0);
    expect((JSON.parse(response!.detail) as { policyMode: string }).policyMode).toBe("LOCAL_ONLY");
  });

  test("BLOCK_ALL policy: request refused, Proof records status=blocked with egress=none", async () => {
    const events = await turn("anything", { mode: "BLOCK_ALL" });
    const blocked = events.find((e) => e.type === "policy" && (e as { blocked: boolean }).blocked);
    expect(blocked).toBeDefined();
    const request = await db.proofEntry.findFirst({ where: { action: "chat.request", status: "blocked" }, orderBy: { seq: "desc" } });
    expect(request?.egress).toBe("none");
    await turn("restore", { mode: "LOCAL_ONLY" });
  });

  test("keyword block: Proof records the reason; nothing reaches the engine", async () => {
    await turn("this mentions project-gamma", { blockKeywords: "project-gamma" });
    const request = await db.proofEntry.findFirst({ where: { action: "chat.request", status: "blocked" }, orderBy: { seq: "desc" } });
    const detail = JSON.parse(request!.detail) as { reason: string };
    expect(detail.reason).toContain("project-gamma");
    const engineCallsBefore = engine.requests.filter((r) => r.path === "/v1/chat/completions").length;
    await turn("still blocked project-gamma");
    const engineCallsAfter = engine.requests.filter((r) => r.path === "/v1/chat/completions").length;
    expect(engineCallsAfter).toBe(engineCallsBefore); // engine never saw it
    await turn("restore", { blockKeywords: "" });
  });

  test("PII redaction: card number masked BEFORE dispatch; Proof records status=redacted", async () => {
    const events = await turn("my card is 4111 1111 1111 1111 please help");
    const policy = events.find((e) => e.type === "policy") as { redactions: number; findings: { type: string }[] } | undefined;
    expect(policy?.redactions).toBe(1);
    expect(policy?.findings[0]?.type).toBe("credit_card");
    const response = await db.proofEntry.findFirst({ where: { action: "chat.response", status: "redacted" }, orderBy: { seq: "desc" } });
    expect(response?.redactions).toBe(1);
    // the engine saw the MASKED text
    const lastCall = engine.requests.filter((r) => r.path === "/v1/chat/completions").pop();
    const msgs = (lastCall?.body as { messages: { content: string }[] }).messages;
    const sent = msgs.map((mmm) => mmm.content).join(" ");
    expect(sent).toContain("[CARD REDACTED]");
    expect(sent).not.toContain("4111 1111 1111 1111");
  });

  test("engine down: failed request still Proof-records with honest error status", async () => {
    await saveSettings({ engine: { type: "openai-compat", url: "http://127.0.0.1:9/v1", label: "dead", adapter: "generic" } });
    const events = await turn("are you there");
    const err = events.find((e) => e.type === "error") as { code: string } | undefined;
    expect(err?.code).toBe("engine_unreachable");
    const response = await db.proofEntry.findFirst({ where: { action: "chat.response", status: "error" }, orderBy: { seq: "desc" } });
    expect(response).toBeDefined();
    expect((JSON.parse(response!.detail) as { error: string }).error).toBe("engine_unreachable");
    // restore the real fake engine
    await saveSettings({ engine: { type: "openai-compat", url: engine.url, label: "Fake engine", adapter: "generic" } });
  });

  test("an engine that resolves to a PUBLIC ip is refused at the HTTP layer, even though policy allows local engines (P3)", async () => {
    // A "local" engine URL that (re)resolves to a public address — e.g. via
    // DNS rebinding or a stale config — must never receive bytes.
    await saveSettings({ engine: { type: "openai-compat", url: "http://8.8.8.8/v1", label: "Rebound", adapter: "generic" } });
    const events: Record<string, unknown>[] = [];
    for await (const ev of runChatTurn({
      user, workspaceId, modelKey: "local:fake-mini", history: [], content: "hello",
      useKnowledge: false, persist: false,
    })) {
      events.push(ev as unknown as Record<string, unknown>);
    }
    const err = events.find((e) => e.type === "error") as { code: string } | undefined;
    expect(err?.code).toBe("egress_blocked");
    const response = await db.proofEntry.findFirst({ where: { action: "chat.response", status: "error" }, orderBy: { seq: "desc" } });
    expect((JSON.parse(response!.detail) as { error: string }).error).toBe("egress_blocked");
    // restore the loopback fake engine
    await saveSettings({ engine: { type: "openai-compat", url: engine.url, label: "Fake engine", adapter: "generic" } });
  });

  test("the chain stays valid across every scenario above", async () => {
    const chain = await (await import("@/lib/proof")).verifyChain();
    expect(chain.valid).toBe(true);
    expect(chain.checked).toBeGreaterThan(5);
  });
});

// ═══ OpenAI SDK against /api/v1 — from tests/openai-api.test.ts ═════════════════════════════════════════════

describe.skipIf(!hasBuild)("OpenAI SDK against /api/v1 (real server)", () => {
  let engine: FakeEngine;
  let server: ReturnType<typeof spawn>;
  let port: number;
  let baseUrl: string;
  let dir: string;
  let cookie = "";
  let apiToken = "";
  let modelKey = "";
  let OpenAI: typeof import("openai").default;

  beforeAll(async () => {
    if (!hasBuild) throw new Error("standalone build missing — run `bun run build` first");
    OpenAI = (await import("openai")).default;
    engine = startFakeEngine();

    dir = mkdtempSync(path.join(tmpdir(), "lester-openai-e2e-"));
    const dbUrl = `file:${path.join(dir, "lester.db")}?connection_limit=1`;
    execFileSync("bunx", ["prisma", "migrate", "deploy"], {
      cwd: ROOT, env: { ...process.env, DATABASE_URL: dbUrl }, stdio: "pipe", timeout: 90_000,
    });

    port = 3000 + Math.floor(Math.random() * 2000);
    baseUrl = `http://127.0.0.1:${port}`;
    server = spawn("bun", [STANDALONE], {
      cwd: path.join(ROOT, ".next", "standalone"),
      env: {
        ...process.env,
        NODE_ENV: "production",
        PORT: String(port),
        HOSTNAME: "127.0.0.1",
        DATABASE_URL: dbUrl,
        LESTER_DATA_DIR: dir,
        LESTER_BIND: "127.0.0.1",
        LESTER_ENGINE: "none",
      },
      stdio: "pipe",
    });

    // wait for liveness
    for (let i = 0; i < 60; i++) {
      try {
        const r = await fetch(`${baseUrl}/api/health-live`);
        if (r.ok) break;
      } catch {
        /* not up yet */
      }
      await new Promise((r) => setTimeout(r, 500));
      if (i === 59) throw new Error("server did not become healthy");
    }

    // first-run setup (no Origin header → allowed by the CSRF middleware)
    const setup = await fetch(`${baseUrl}/api/setup/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        adminUsername: "admin",
        adminPassword: "e2e-password-123",
        workspaceName: "E2E",
        engineUrl: engine.url,
        engineAdapter: "generic",
      }),
    });
    if (!setup.ok) throw new Error(`setup failed: ${await setup.text()}`);
    cookie = (setup.headers.get("set-cookie") ?? "").split(";")[0];

    // create an API token
    const tok = await fetch(`${baseUrl}/api/tokens`, {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie },
      body: JSON.stringify({ name: "e2e" }),
    });
    const tokBody = (await tok.json()) as { token: string };
    apiToken = tokBody.token;
    expect(apiToken.startsWith("lst_")).toBe(true);

    // the setup registered the engine's models; find one
    const models = await fetch(`${baseUrl}/api/v1/models`, {
      headers: { Authorization: `Bearer ${apiToken}` },
    });
    const modelsBody = (await models.json()) as { data: { id: string }[] };
    modelKey = modelsBody.data[0]?.id ?? "";
    expect(modelKey).toContain("fake");
  }, 120_000);

  afterAll(() => {
    engine?.stop();
    server?.kill("SIGTERM");
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  test("official SDK: non-streaming completion works end to end", async () => {
    const client = new OpenAI({ baseURL: `${baseUrl}/api/v1`, apiKey: apiToken });
    const res = await client.chat.completions.create({
      model: modelKey,
      messages: [{ role: "user", content: "what is the answer" }],
    });
    expect(res.object).toBe("chat.completion");
    expect(res.choices[0]?.message?.content).toContain("FAKE[fake-mini]");
    expect(res.usage?.total_tokens).toBeGreaterThan(0);
  });

  test("official SDK: streaming completion works end to end", async () => {
    const client = new OpenAI({ baseURL: `${baseUrl}/api/v1`, apiKey: apiToken });
    const stream = await client.chat.completions.create({
      model: modelKey,
      messages: [{ role: "user", content: "stream me the answer" }],
      stream: true,
    });
    let text = "";
    let usage = null as null | { total_tokens: number };
    for await (const chunk of stream) {
      text += chunk.choices[0]?.delta?.content ?? "";
      const u = (chunk as unknown as { usage?: { total_tokens: number } }).usage;
      if (u) usage = u;
    }
    expect(text).toContain("FAKE[fake-mini]");
    expect(text).toContain("42");
    expect(usage?.total_tokens).toBeGreaterThan(0);
  });

  test("invalid token is rejected with 401", async () => {
    const client = new OpenAI({ baseURL: `${baseUrl}/api/v1`, apiKey: "lst_invalid" });
    let threw = false;
    let status = 0;
    try {
      await client.chat.completions.create({ model: modelKey, messages: [{ role: "user", content: "x" }] });
    } catch (e) {
      threw = true;
      status = (e as Error & { status?: number }).status ?? 0;
    }
    expect(threw).toBe(true);
    expect(status).toBe(401);
  });

  test("policy-blocked content returns a clear error through the SDK", async () => {
    // set a keyword block on the workspace via the admin API
    const ws = await fetch(`${baseUrl}/api/workspaces`, { headers: { cookie } });
    const wsBody = (await ws.json()) as { workspaces: { id: string }[] };
    const workspaceId = wsBody.workspaces[0].id;
    const policy = await fetch(`${baseUrl}/api/policy`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", cookie },
      body: JSON.stringify({
        workspaceId,
        policy: { mode: "LOCAL_ONLY", redactPii: true, blockKeywords: "project-gamma", allowedModels: "", maxTokens: 2048 },
      }),
    });
    expect(policy.ok).toBe(true);

    const client = new OpenAI({ baseURL: `${baseUrl}/api/v1`, apiKey: apiToken });
    try {
      await client.chat.completions.create({
        model: modelKey,
        messages: [{ role: "user", content: "tell me about project-gamma" }],
      });
      throw new Error("expected a rejection but the call succeeded");
    } catch (e) {
      const err = e as Error & { status?: number; message: string };
      expect(err.message).toMatch(/blocked/i);
    }
  });
});


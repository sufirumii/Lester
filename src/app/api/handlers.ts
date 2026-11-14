/**
 * Every Lester API handler in one module — served through the single route
 * file (src/app/api/route.ts; every /api/* URL is mapped onto it by a rewrite
 * in next.config.ts, and the route rebuilds the catch-all params from the
 * original request URL — see the v1.0.4 notes in route.ts and next.config.ts)
 * with an internal router keyed on method + path. v1.0.2
 * repository consolidation: the 29 v1.0.1
 * route files merged here unchanged
 * (same URLs, methods, status codes, header shapes, cookies, streaming and
 * auth rules; only module paths and private helper names differ).
 *
 * Sections (v1.0.1 route files):
 *   1. /api/auth/login
 *   2. /api/auth/logout
 *   3. /api/auth/session
 *   4. /api/auth/sessions
 *   5. /api/chat
 *   6. /api/conversations
 *   7. /api/conversations/:id
 *   8. /api/engines/detect
 *   9. /api/fit
 *  10. /api/fit/:id
 *  11. /api/hardware
 *  12. /api/health
 *  13. /api/health-live
 *  14. /api/knowledge
 *  15. /api/knowledge/search
 *  16. /api/license
 *  17. /api/models
 *  18. /api/policy
 *  19. /api/proof
 *  20. /api/proof/export
 *  21. /api/settings
 *  22. /api/setup/complete
 *  23. /api/setup/status
 *  24. /api/tokens
 *  25. /api/tokens/:id
 *  26. /api/users
 *  27. /api/v1/chat/completions
 *  28. /api/v1/models
 *  29. /api/workspaces
 */

import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { aesDecrypt, aesEncrypt, authUserFromApiToken, checkPasswordStrength, clearLoginFailures, clientIpFromHeaders, createSession, destroySession, generateApiToken, getSessionUser, hashPassword, listSessions, nodeId, recordLoginFailure, requireAnyUser, requireUser, revokeAllSessions, revokeSessionById, sha256hex, throttleState, verifyPassword } from "@/lib/auth";
import { ChatEvent, decryptMessage, runChatTurn } from "@/lib/chat";
import { db } from "@/lib/db";
import { assessFit, ChatMsg, detectEngines, engineStatus, guardedFetch, LOCAL_MODEL_CATALOG, pingCompat, recommendModels, registerEngineModels } from "@/lib/engine";
import { CloudProvider, dataPaths, ENGINE_PRESETS, EngineAdapter, getSettings, LESTER, LesterSettings, saveSettings } from "@/lib/env";
import { cancelFitRun, FitConfig, startFitRun } from "@/lib/fit";
import { checkUrl, evaluatePolicy, PolicyRules } from "@/lib/governance";
import { detectHardware } from "@/lib/hardware";
import { ApiFail, failResponse, readJsonWith } from "@/lib/http";
import { chunkText, invalidateIndex, isSupportedUpload, search } from "@/lib/knowledge";
import { activateLicense, checkUserQuota, checkWorkspaceQuota, licenseInfo } from "@/lib/license";
import { appendProof, buildReport, listCheckpoints, renderProofPdf, verifyChain } from "@/lib/proof";
import { backupStatus, cachedChain, dbPath, ensureBooted, listBackups } from "@/lib/storage";
import { existsSync, statSync } from "node:fs";

export type ApiParams = Record<string, string>;

// ═══ /api/auth/login ═════════════════════════════════════════════════════════
// merged from src/app/api/auth/login/route.ts

const auth_login__LoginBody = z.object({
  username: z.string().trim().min(1).max(64),
  password: z.string().min(1).max(200),
});

function auth_login__requestIsSecure(req: Request): boolean {
  if (new URL(req.url).protocol === "https:") return true;
  // Behind a trusted reverse proxy, the proxy tells us the real scheme.
  if (LESTER.trustProxy) {
    const proto = req.headers.get("x-forwarded-proto");
    return proto?.split(",")[0].trim() === "https";
  }
  return false;
}

async function auth_login__POST(req: Request) {
  try {
    await ensureBooted();
    const body = await readJsonWith(req, auth_login__LoginBody);
    const username = body.username.toLowerCase();
    const password = body.password;
    const ip = clientIpFromHeaders(req.headers);

    // S2: persisted, username+IP keyed, progressive delays — no hard lockout.
    const { failures, delayMs } = await throttleState(username, ip);
    if (delayMs > 0) {
      await appendProof({
        username,
        action: "auth.throttled",
        status: "error",
        detail: { ip, failures, waitMs: delayMs },
      });
      throw new ApiFail(429, "rate_limited", `Too many failed attempts from this client. Try again in ${Math.ceil(delayMs / 1000)}s.`, { retryAfterMs: delayMs });
    }

    const user = await db.user.findUnique({ where: { username } });
    if (!user || user.disabled || !verifyPassword(password, user.passwordHash)) {
      await recordLoginFailure(username, ip);
      await appendProof({
        username,
        action: "auth.fail",
        status: "error",
        detail: { reason: user ? "bad password" : "unknown user", ip, attempt: failures + 1 },
      });
      throw new ApiFail(401, "bad_credentials", "Incorrect username or password.");
    }

    await clearLoginFailures(username, ip);
    const { token, expiresAt } = await createSession(user.id);
    await appendProof({
      userId: user.id,
      username: user.username,
      action: "auth.login",
      status: "ok",
      detail: { role: user.role, ip },
    });
    const res = NextResponse.json({
      ok: true,
      user: { id: user.id, username: user.username, displayName: user.displayName, role: user.role },
    });
    res.cookies.set(LESTER.sessionCookie, token, {
      httpOnly: true,
      sameSite: "strict",
      path: "/",
      expires: expiresAt,
      secure: auth_login__requestIsSecure(req),
    });
    return res;
  } catch (e) {
    return failResponse(e);
  }
}

// ═══ /api/auth/logout ════════════════════════════════════════════════════════
// merged from src/app/api/auth/logout/route.ts

async function auth_logout__POST() {
  const store = await cookies();
  const token = store.get(LESTER.sessionCookie)?.value;
  if (token) await destroySession(token);
  const res = NextResponse.json({ ok: true });
  res.cookies.set(LESTER.sessionCookie, "", { httpOnly: true, path: "/", maxAge: 0 });
  return res;
}

// ═══ /api/auth/session ═══════════════════════════════════════════════════════
// merged from src/app/api/auth/session/route.ts

async function auth_session__GET() {
  await ensureBooted();
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ user: null }, { status: 401 });
  return NextResponse.json({ user });
}

// ═══ /api/auth/sessions ══════════════════════════════════════════════════════
// merged from src/app/api/auth/sessions/route.ts

const auth_sessions__DeleteBody = z.object({ id: z.string().min(4).max(24).optional(), all: z.boolean().optional() });

async function auth_sessions__GET() {
  try {
    const user = await getSessionUser();
    if (!user) return NextResponse.json({ error: { code: "auth_required", message: "Sign in to continue." } }, { status: 401 });
    return NextResponse.json({ sessions: await listSessions(user.id) });
  } catch (e) {
    return failResponse(e);
  }
}

async function auth_sessions__DELETE(req: Request) {
  try {
    const user = await getSessionUser();
    if (!user) throw new ApiFail(401, "auth_required", "Sign in to continue.");
    const body = await readJsonWith(req, auth_sessions__DeleteBody).catch(() => ({}) as z.infer<typeof auth_sessions__DeleteBody>);
    if (body.all) {
      const n = await revokeAllSessions(user.id);
      await appendProof({ userId: user.id, username: user.username, action: "auth.revoke_all", status: "ok", detail: { sessions: n } });
      return NextResponse.json({ ok: true, revoked: n });
    }
    if (body.id) {
      const ok = await revokeSessionById(body.id, user.id);
      if (!ok) throw new ApiFail(404, "not_found", "Session not found.");
      await appendProof({ userId: user.id, username: user.username, action: "auth.revoke", status: "ok", detail: { session: body.id } });
      return NextResponse.json({ ok: true, revoked: 1 });
    }
    throw new ApiFail(400, "bad_request", "Provide { id } or { all: true }.");
  } catch (e) {
    return failResponse(e);
  }
}

// ═══ /api/chat ═══════════════════════════════════════════════════════════════
// merged from src/app/api/chat/route.ts

const chat__HistoryMsg = z.object({
  role: z.enum(["user", "assistant", "system"]),
  content: z.string().max(100_000),
});

const chat__ChatBody = z.object({
  conversationId: z.string().trim().max(40).optional(),
  workspaceId: z.string().trim().min(1).max(40),
  modelKey: z.string().trim().min(1).max(120),
  content: z.string().min(1).max(100_000),
  useKnowledge: z.boolean().optional(),
  history: z.array(chat__HistoryMsg).max(40).optional(),
});

async function chat__POST(req: Request) {
  try {
    await ensureBooted();
    const user = await requireAnyUser();
    if (user.role === "AUDITOR") {
      throw new ApiFail(403, "forbidden", "Auditor accounts are read-only — they can inspect Proof, not chat.");
    }
    const body = await readJsonWith(req, chat__ChatBody);
    if (!body.content.trim()) {
      throw new ApiFail(400, "bad_request", "content must not be empty.");
    }

    // A1 — a MEMBER may only continue their own conversation.
    if (body.conversationId) {
      const conv = await db.conversation.findUnique({ where: { id: body.conversationId } });
      if (!conv) throw new ApiFail(404, "not_found", "Conversation not found.");
      if (conv.userId !== user.id && user.role !== "ADMIN") throw new ApiFail(403, "forbidden", "This conversation belongs to another user.");
      if (conv.workspaceId !== body.workspaceId) throw new ApiFail(400, "bad_request", "Conversation does not belong to this workspace.");
    }

    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const send = (ev: ChatEvent) => {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(ev)}\n\n`));
        };
        try {
          const history: ChatMsg[] = (body.history ?? []).slice(-20);
          for await (const ev of runChatTurn({
            user,
            workspaceId: body.workspaceId,
            modelKey: body.modelKey,
            history,
            content: body.content,
            useKnowledge: Boolean(body.useKnowledge),
            conversationId: body.conversationId,
            signal: req.signal,
            persist: true,
          })) {
            send(ev);
          }
        } catch (e) {
          send({
            type: "error",
            code: "internal",
            message: e instanceof Error ? e.message : "Unexpected error during chat.",
          });
        } finally {
          controller.close();
        }
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        "X-Accel-Buffering": "no",
      },
    });
  } catch (e) {
    return failResponse(e);
  }
}

// ═══ /api/conversations ══════════════════════════════════════════════════════
// merged from src/app/api/conversations/route.ts

const conversations__CreateBody = z.object({
  workspaceId: z.string().trim().min(1).max(40),
  modelKey: z.string().trim().min(1).max(120),
  title: z.string().trim().max(80).optional(),
});

async function conversations__GET(req: Request) {
  try {
    const user = await requireUser(["ADMIN", "MEMBER"]);
    const url = new URL(req.url);
    const workspaceId = url.searchParams.get("workspaceId") ?? "";
    const q = (url.searchParams.get("q") ?? "").trim().slice(0, 200);
    if (!workspaceId) return NextResponse.json({ conversations: [] });
    const conversations = await db.conversation.findMany({
      where: {
        workspaceId,
        ...(user.role === "ADMIN" ? {} : { userId: user.id }),
        ...(q ? {
          OR: [{ title: { contains: q } }, { messages: { some: { content: { contains: q } } } }],
        } : {}),
      },
      orderBy: { updatedAt: "desc" },
      take: 100,
      include: { _count: { select: { messages: true } } },
    });
    return NextResponse.json({
      conversations: conversations.map((c) => ({
        id: c.id,
        title: c.title,
        modelKey: c.modelKey,
        updatedAt: c.updatedAt.toISOString(),
        messageCount: c._count.messages,
      })),
    });
  } catch (e) {
    return failResponse(e);
  }
}

async function conversations__POST(req: Request) {
  try {
    const user = await requireUser(["ADMIN", "MEMBER"]);
    const body = await readJsonWith(req, conversations__CreateBody);
    const ws = await db.workspace.findUnique({ where: { id: body.workspaceId } });
    if (!ws) throw new ApiFail(404, "not_found", "Workspace not found.");
    const conv = await db.conversation.create({
      data: {
        workspaceId: body.workspaceId,
        userId: user.id,
        modelKey: body.modelKey,
        title: (body.title ?? "New conversation").slice(0, 60),
      },
    });
    return NextResponse.json({ ok: true, id: conv.id });
  } catch (e) {
    return failResponse(e);
  }
}

// ═══ /api/conversations/:id ══════════════════════════════════════════════════
// merged from src/app/api/conversations/[id]/route.ts

async function conversations_id__getOwnedConversation(id: string, userId: string, isAdmin: boolean) {
  const conv = await db.conversation.findUnique({ where: { id }, include: { messages: { orderBy: { createdAt: "asc" } } } });
  if (!conv) throw new ApiFail(404, "not_found", "Conversation not found.");
  if (conv.userId !== userId && !isAdmin) throw new ApiFail(403, "forbidden", "This conversation belongs to another user.");
  return conv;
}

const conversations_id__PatchBody = z.object({ title: z.string().trim().min(1).max(80) });

async function conversations_id__GET(_req: Request, params: { id: string }) {
  try {
    const user = await requireUser(["ADMIN", "MEMBER"]);
    const { id } = params;
    const conv = await conversations_id__getOwnedConversation(id, user.id, user.role === "ADMIN");
    return NextResponse.json({
      conversation: {
        id: conv.id,
        title: conv.title,
        modelKey: conv.modelKey,
        workspaceId: conv.workspaceId,
        updatedAt: conv.updatedAt.toISOString(),
        messages: conv.messages.map((m) => ({
          id: m.id,
          role: m.role,
          content: decryptMessage(m.content, m.encrypted),
          modelKey: m.modelKey,
          provider: m.provider,
          latencyMs: m.latencyMs,
          tokensIn: m.tokensIn,
          tokensOut: m.tokensOut,
          redactions: m.redactions,
          blocked: m.blocked,
          citations: m.citations ? JSON.parse(m.citations) : null,
          createdAt: m.createdAt.toISOString(),
        })),
      },
    });
  } catch (e) {
    return failResponse(e);
  }
}

async function conversations_id__PATCH(req: Request, params: { id: string }) {
  try {
    const user = await requireUser(["ADMIN", "MEMBER"]);
    const { id } = params;
    const conv = await conversations_id__getOwnedConversation(id, user.id, user.role === "ADMIN");
    const body = await readJsonWith(req, conversations_id__PatchBody);
    await db.conversation.update({ where: { id: conv.id }, data: { title: body.title } });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return failResponse(e);
  }
}

async function conversations_id__DELETE(_req: Request, params: { id: string }) {
  try {
    const user = await requireUser(["ADMIN", "MEMBER"]);
    const { id } = params;
    const conv = await conversations_id__getOwnedConversation(id, user.id, user.role === "ADMIN");
    await db.conversation.delete({ where: { id: conv.id } });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return failResponse(e);
  }
}

// ═══ /api/engines/detect ═════════════════════════════════════════════════════
// merged from src/app/api/engines/detect/route.ts

const engines_detect__ConnectBody = z.object({
  url: z.string().trim().url().max(300),
  adapter: z.enum(["ollama", "llamacpp", "lmstudio", "vllm", "generic"]),
  label: z.string().trim().max(60).optional(),
});

async function engines_detect__GET() {
  try {
    await requireUser();
    const detection = await detectEngines();
    return NextResponse.json({
      detection,
      adapterGuide: Object.values(ENGINE_PRESETS).map((p) => ({ id: p.id, label: p.label, note: p.note })),
    });
  } catch (e) {
    return failResponse(e);
  }
}

async function engines_detect__POST(req: Request) {
  try {
    const user = await requireUser(["ADMIN"]);
    const body = await readJsonWith(req, engines_detect__ConnectBody);

    let url = body.url.replace(/\/$/, "");
    // Normalize bare roots to /v1 for OpenAI-compat chats, except Ollama's native API usage
    if (!/\/v\d$/.test(url) && !url.includes("/v1/")) url = `${url}/v1`;

    const check = await checkUrl(url, { allowExternal: false });
    if (!check.ok) throw new ApiFail(400, "bad_url", check.reason ?? "URL refused.");

    const detection = await detectEngines();
    const ping = detection.find((d) => d.url === url);
    if (!ping?.reachable) {
      throw new ApiFail(502, "engine_unreachable", `No OpenAI-compatible engine answered at ${url}. Start the engine first, then connect.`);
    }

    await saveSettings({
      engine: { type: "openai-compat", url, label: body.label ?? ENGINE_PRESETS[body.adapter === "generic" ? "generic" : body.adapter].label, adapter: body.adapter },
    });
    const added = await registerEngineModels(url, ping.models, { id: user.id, username: user.username });
    await appendProof({
      userId: user.id,
      username: user.username,
      action: "settings.engine_connect",
      status: "ok",
      provider: "local-engine",
      endpointHost: new URL(url).hostname,
      detail: { engine: url, adapter: body.adapter, models: added },
    });
    return NextResponse.json({ ok: true, models: ping.models, registered: added });
  } catch (e) {
    return failResponse(e);
  }
}

// ═══ /api/fit ════════════════════════════════════════════════════════════════
// merged from src/app/api/fit/route.ts

const fit__FitConfigSchema = z.object({
  requestsPerMonth: z.number().int().min(1).max(100_000_000),
  pricePerMillionIn: z.number().min(0).max(10_000),
  pricePerMillionOut: z.number().min(0).max(10_000),
  hardwareMonthlyCost: z.number().min(0).max(1_000_000),
  judge: z.boolean().optional(),
});

const fit__StartBody = z.object({
  prompts: z.array(z.string().trim().min(1).max(20_000)).min(1).max(200),
  candidates: z.array(z.string().trim().min(1).max(120)).min(1).max(10),
  config: fit__FitConfigSchema,
});

async function fit__GET() {
  try {
    const user = await requireUser(["ADMIN", "MEMBER"]);
    await ensureBooted();
    const runs = await db.fitRun.findMany({
      where: user.role === "ADMIN" ? {} : { userId: user.id },
      orderBy: { createdAt: "desc" },
      take: 30,
    });
    return NextResponse.json({
      runs: runs.map((r) => ({
        id: r.id,
        status: r.status,
        progress: r.progress,
        total: r.total,
        prompts: (JSON.parse(r.prompts) as string[]).length,
        candidates: JSON.parse(r.candidates) as string[],
        createdAt: r.createdAt.toISOString(),
        error: r.error,
      })),
    });
  } catch (e) {
    return failResponse(e);
  }
}

async function fit__POST(req: Request) {
  try {
    const user = await requireUser(["ADMIN", "MEMBER"]);
    const body = await readJsonWith(req, fit__StartBody);
    const config: FitConfig = {
      requestsPerMonth: body.config.requestsPerMonth,
      pricePerMillionIn: body.config.pricePerMillionIn,
      pricePerMillionOut: body.config.pricePerMillionOut,
      hardwareMonthlyCost: body.config.hardwareMonthlyCost,
      judge: body.config.judge !== false,
    };
    const id = await startFitRun({
      userId: user.id,
      username: user.username,
      prompts: body.prompts,
      candidates: body.candidates,
      config,
    });
    return NextResponse.json({ ok: true, id });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Could not start the evaluation.";
    return NextResponse.json({ error: { code: "fit_invalid", message: msg } }, { status: 400 });
  }
}

// ═══ /api/fit/:id ════════════════════════════════════════════════════════════
// merged from src/app/api/fit/[id]/route.ts

async function fit_id__getOwnedRun(id: string, userId: string, isAdmin: boolean) {
  const run = await db.fitRun.findUnique({ where: { id } });
  if (!run) throw new ApiFail(404, "not_found", "Run not found.");
  if (run.userId !== userId && !isAdmin) throw new ApiFail(403, "forbidden", "This evaluation belongs to another user.");
  return run;
}

async function fit_id__GET(_req: Request, params: { id: string }) {
  try {
    const user = await requireUser(["ADMIN", "MEMBER"]);
    const { id } = params;
    const run = await fit_id__getOwnedRun(id, user.id, user.role === "ADMIN");
    return NextResponse.json({
      run: {
        id: run.id,
        status: run.status,
        progress: run.progress,
        total: run.total,
        prompts: JSON.parse(run.prompts),
        candidates: JSON.parse(run.candidates),
        config: JSON.parse(run.config),
        results: JSON.parse(run.results),
        samples: JSON.parse(run.samples),
        summary: JSON.parse(run.summary),
        error: run.error,
        createdAt: run.createdAt.toISOString(),
      },
    });
  } catch (e) {
    return failResponse(e);
  }
}

async function fit_id__DELETE(_req: Request, params: { id: string }) {
  try {
    const user = await requireUser(["ADMIN", "MEMBER"]);
    const { id } = params;
    await fit_id__getOwnedRun(id, user.id, user.role === "ADMIN");
    const ok = cancelFitRun(id);
    return NextResponse.json({ ok });
  } catch (e) {
    return failResponse(e);
  }
}

// ═══ /api/hardware ═══════════════════════════════════════════════════════════
// merged from src/app/api/hardware/route.ts

async function hardware__GET() {
  try {
    await requireUser(["ADMIN", "MEMBER"]);
    return NextResponse.json(await detectHardware());
  } catch (e) {
    return failResponse(e);
  }
}

// ═══ /api/health ═════════════════════════════════════════════════════════════
// merged from src/app/api/health/route.ts

async function health__GET(req: Request) {
  try {
    // AUDITOR gets Health (read-only) — part of the documented role matrix.
    await requireUser();
    const boot = await ensureBooted();
    const url = new URL(req.url);
    const reverify = url.searchParams.get("verify") === "1";
    const [hardware, engine, backups] = await Promise.all([detectHardware(), engineStatus(), listBackups()]);
    const chain = reverify ? await verifyChain() : boot.chain;
    const checkpoints = await listCheckpoints(5);

    const dbFile = dbPath();
    const dbSize = existsSync(dbFile) ? statSync(dbFile).size : 0;
    const walSize = existsSync(`${dbFile}-wal`) ? statSync(`${dbFile}-wal`).size : 0;

    const [conversations, messages, documents, proofs, users, models] = await Promise.all([
      db.conversation.count(),
      db.message.count(),
      db.document.count(),
      db.proofEntry.count(),
      db.user.count(),
      db.modelEntry.count({ where: { installed: true } }),
    ]);

    // Real throughput from the last 50 assistant turns in the ledger
    const recent = await db.proofEntry.findMany({
      where: { action: "chat.response", latencyMs: { not: null } },
      orderBy: { seq: "desc" },
      take: 50,
    });
    const totalMs = recent.reduce((a, e) => a + (e.latencyMs ?? 0), 0);
    const totalOut = recent.reduce((a, e) => a + (e.tokensOut ?? 0), 0);
    const tokensPerSec = totalMs > 0 ? +((totalOut / totalMs) * 1000).toFixed(1) : 0;
    const avgLatency = recent.length ? Math.round(totalMs / recent.length) : 0;

    const mem = process.memoryUsage();
    return NextResponse.json({
      version: boot.version,
      startedAt: boot.startedAt,
      uptimeHours: +((Date.now() - new Date(boot.startedAt).getTime()) / 3600_000).toFixed(2),
      durability: boot.durability,
      migrations: { applied: boot.migrations.appliedMigrations, baseline: boot.migrations.baselineApplied },
      chain,
      checkpoints,
      engine,
      hardware,
      bind: LESTER.bind,
      port: LESTER.port,
      storage: { dbBytes: dbSize, walBytes: walSize, dbPath: dbFile },
      counts: { conversations, messages, documents, proofs, users, models },
      throughput: { tokensPerSec, avgLatencyMs: avgLatency, sampledTurns: recent.length },
      backups: backups.slice(0, 5),
      backupScheduler: backupStatus(),
      process: { rssMb: Math.round(mem.rss / 1024 / 1024), node: process.version },
    });
  } catch (e) {
    return failResponse(e);
  }
}

// ═══ /api/health-live ════════════════════════════════════════════════════════
// merged from src/app/api/health-live/route.ts

async function health_live__GET () {
  return NextResponse.json({ ok: true, product: "Lester", version: LESTER.version });
}

// ═══ /api/knowledge ══════════════════════════════════════════════════════════
// merged from src/app/api/knowledge/route.ts

const knowledge__MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

const knowledge__MAX_DOCS_PER_WORKSPACE = 500;

function knowledge__sanitizeFileName(name: string): string {
  const base = name.split(/[/\\]/).pop() ?? "file";
  return base.replace(/[\u0000-\u001f<>:"|?*]/g, "_").slice(0, 120) || "file";
}

async function knowledge__GET(req: Request) {
  try {
    await requireUser(["ADMIN", "MEMBER"]);
    const workspaceId = z.string().trim().max(40).parse(new URL(req.url).searchParams.get("workspaceId") ?? "");
    const docs = await db.document.findMany({
      where: { workspaceId },
      orderBy: { createdAt: "desc" },
      include: { _count: { select: { chunks: true } } },
    });
    return NextResponse.json({
      documents: docs.map((d) => ({
        id: d.id,
        name: d.name,
        mime: d.mime,
        sizeBytes: d.sizeBytes,
        chunkCount: d._count.chunks,
        sha256: d.sha256,
        createdAt: d.createdAt.toISOString(),
      })),
    });
  } catch (e) {
    if (e instanceof z.ZodError) return NextResponse.json({ error: { code: "bad_request", message: "workspaceId is required." } }, { status: 400 });
    return failResponse(e);
  }
}

async function knowledge__POST(req: Request) {
  try {
    const user = await requireUser(["ADMIN", "MEMBER"]);
    const form = await req.formData().catch(() => {
      throw new ApiFail(400, "bad_form", "Expected multipart/form-data with a 'file' field.");
    });
    const file = form.get("file");
    const workspaceId = String(form.get("workspaceId") ?? "").trim();
    if (!(file instanceof File)) throw new ApiFail(400, "no_file", "Attach a file field named 'file'.");
    if (!workspaceId) throw new ApiFail(400, "no_workspace", "workspaceId is required.");
    const ws = await db.workspace.findUnique({ where: { id: workspaceId } });
    if (!ws) throw new ApiFail(404, "not_found", "Workspace not found.");
    const existing = await db.document.count({ where: { workspaceId } });
    if (existing >= knowledge__MAX_DOCS_PER_WORKSPACE) {
      throw new ApiFail(413, "too_many", `This workspace already holds ${knowledge__MAX_DOCS_PER_WORKSPACE} documents — the v1 limit.`);
    }
    if (file.size > knowledge__MAX_UPLOAD_BYTES) throw new ApiFail(413, "too_large", "Files up to 5 MB are supported in v1.");
    const safeName = knowledge__sanitizeFileName(file.name);
    if (!isSupportedUpload(safeName, file.type)) {
      throw new ApiFail(415, "unsupported_type", "Supported formats: TXT, MD, CSV, JSON, LOG. PDF text extraction is not part of v1 — paste or convert to text first.");
    }
    const raw = await file.text().catch(() => {
      throw new ApiFail(422, "unreadable", "The file could not be decoded as UTF-8 text.");
    });
    if (raw.length > knowledge__MAX_UPLOAD_BYTES * 4) throw new ApiFail(413, "too_large", "File too large after decoding.");
    if (raw.trim().length === 0) throw new ApiFail(422, "empty", "The file contains no extractable text.");
    const chunks = chunkText(raw);
    const doc = await db.document.create({
      data: {
        workspaceId,
        name: safeName,
        mime: file.type || "text/plain",
        sizeBytes: file.size,
        chunkCount: chunks.length,
        sha256: sha256hex(raw),
      },
    });
    await db.chunk.createMany({
      data: chunks.map((content, idx) => ({ documentId: doc.id, idx, content })),
    });
    invalidateIndex(workspaceId);
    await appendProof({
      userId: user.id,
      username: user.username,
      workspaceId,
      workspaceName: ws.name,
      action: "knowledge.upload",
      status: "ok",
      egress: "none",
      detail: { name: safeName, sizeBytes: file.size, chunks: chunks.length },
    });
    return NextResponse.json({ ok: true, id: doc.id, chunks: chunks.length });
  } catch (e) {
    return failResponse(e);
  }
}

async function knowledge__DELETE(req: Request) {
  try {
    const user = await requireUser(["ADMIN", "MEMBER"]);
    const id = z.string().trim().max(40).parse(new URL(req.url).searchParams.get("id") ?? "");
    const doc = await db.document.findUnique({ where: { id } });
    if (!doc) throw new ApiFail(404, "not_found", "Document not found.");
    await db.document.delete({ where: { id } });
    invalidateIndex(doc.workspaceId);
    await appendProof({
      userId: user.id,
      username: user.username,
      workspaceId: doc.workspaceId,
      action: "knowledge.delete",
      status: "ok",
      egress: "none",
      detail: { name: doc.name },
    });
    return NextResponse.json({ ok: true });
  } catch (e) {
    if (e instanceof z.ZodError) return NextResponse.json({ error: { code: "bad_request", message: "id is required." } }, { status: 400 });
    return failResponse(e);
  }
}

// ═══ /api/knowledge/search ═══════════════════════════════════════════════════
// merged from src/app/api/knowledge/search/route.ts

async function knowledge_search__POST(req: Request) {
  try {
    const user = await requireUser(["ADMIN", "MEMBER"]);
    const body = await readJsonWith(req, z.object({ workspaceId: z.string().trim().min(1).max(40), query: z.string().max(2000), k: z.number().int().min(1).max(10).optional() }));
    const t0 = Date.now();
    const hits = await search(body.workspaceId, body.query ?? "", Math.min(Math.max(body.k ?? 5, 1), 10));
    await appendProof({
      userId: user.id,
      username: user.username,
      workspaceId: body.workspaceId,
      action: "knowledge.search",
      status: "ok",
      egress: "none",
      latencyMs: Date.now() - t0,
      detail: { hits: hits.length },
    });
    return NextResponse.json({ hits, tookMs: Date.now() - t0 });
  } catch (e) {
    return failResponse(e);
  }
}

// ═══ /api/license ════════════════════════════════════════════════════════════
// merged from src/app/api/license/route.ts

async function license__GET() {
  try {
    await requireUser();
    await ensureBooted();
    return NextResponse.json({ license: await licenseInfo() });
  } catch (e) {
    return failResponse(e);
  }
}

async function license__POST(req: Request) {
  try {
    const user = await requireUser(["ADMIN"]);
    const body = await readJsonWith(req, z.object({ key: z.string().trim().min(5).max(2000) }));
    const info = await activateLicense(body.key ?? "", { id: user.id, username: user.username });
    return NextResponse.json({ ok: true, license: info });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Activation failed.";
    return NextResponse.json({ error: { code: "license_invalid", message: msg } }, { status: 400 });
  }
}

// ═══ /api/models ═════════════════════════════════════════════════════════════
// merged from src/app/api/models/route.ts

const models__ModelAction = z.object({
  action: z.enum(["install", "uninstall", "approve", "disapprove", "enable", "disable", "syncCloud"]),
  key: z.string().trim().max(120).optional(),
  providerId: z.string().trim().max(40).optional(),
});

async function models__GET() {
  try {
    await requireUser(["ADMIN", "MEMBER"]);
    await ensureBooted();
    const [entries, hw, engine, settings] = await Promise.all([
      db.modelEntry.findMany({ orderBy: [{ provider: "asc" }, { name: "asc" }] }),
      detectHardware(),
      engineStatus(),
      getSettings(),
    ]);
    const installed = entries.map((e) => {
      const fit = e.provider === "LOCAL_ENGINE" ? assessFit(e.ramReqMb, hw) : null;
      return {
        key: e.key,
        name: e.name,
        family: e.family,
        paramsB: e.paramsB,
        quant: e.quant,
        sizeMb: e.sizeMb,
        ramReqMb: e.ramReqMb,
        provider: e.provider,
        installed: e.installed,
        approved: e.approved,
        enabled: e.enabled,
        meta: JSON.parse(e.meta || "{}"),
        fit,
      };
    });
    return NextResponse.json({
      installed,
      catalog: LOCAL_MODEL_CATALOG.map((c) => {
        const existing = entries.find((e) => e.key === c.key);
        return { ...c, installed: existing?.installed ?? false, fit: assessFit(c.ramReqMb, hw) };
      }),
      engine,
      cloudProviders: settings.cloudProviders.map((p) => ({ id: p.id, label: p.label, baseUrl: p.baseUrl, enabled: p.enabled, hasKey: Boolean(p.apiKeyEnc), defaultModel: p.defaultModel })),
    });
  } catch (e) {
    return failResponse(e);
  }
}

async function models__POST(req: Request) {
  try {
    const user = await requireUser(["ADMIN"]);
    const body = await readJsonWith(req, models__ModelAction);
    const settings = await getSettings();

    if (body.action === "install" && body.key) {
      const cat = LOCAL_MODEL_CATALOG.find((c) => c.key === body.key);
      if (!cat) throw new ApiFail(400, "unknown_model", "Model is not in the catalog.");
      if (settings.engine.type === "none" || !settings.engine.url) {
        throw new ApiFail(400, "engine_required", "Installing model files needs a local engine (Ollama or any OpenAI-compatible runtime). Connect one in Settings → Engine or via the Models tab detection.");
      }
      // Pull through the engine's native API (Ollama). The guarded client
      // resolves the destination at connect time and refuses public IPs.
      const base = settings.engine.url.replace(/\/v1\/?$/, "");
      const check = await checkUrl(`${base}/api/pull`, { allowExternal: false });
      if (!check.ok) throw new ApiFail(400, "bad_url", check.reason ?? "Engine URL refused.");
      let pullError: string | null = null;
      try {
        await guardedFetch(
          `${base}/api/pull`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name: cat.ollamaTag, stream: false }),
          },
          { allowExternal: false, timeoutMs: 15 * 60_000 }
        );
      } catch (e) {
        pullError = e instanceof Error ? e.message : "pull failed";
      }
      await db.modelEntry.upsert({
        where: { key: cat.key },
        update: { installed: !pullError, installedAt: pullError ? null : new Date() },
        create: {
          key: cat.key,
          name: cat.name,
          family: cat.family,
          paramsB: cat.paramsB,
          quant: cat.quant,
          sizeMb: cat.sizeMb,
          ramReqMb: cat.ramReqMb,
          provider: "LOCAL_ENGINE",
          installed: !pullError,
          approved: true,
          enabled: true,
          installedAt: pullError ? null : new Date(),
          meta: JSON.stringify({ ollamaTag: cat.ollamaTag, note: cat.note }),
        },
      });
      await appendProof({
        userId: user.id,
        username: user.username,
        action: "model.install",
        status: pullError ? "error" : "ok",
        modelKey: cat.key,
        provider: "local-engine",
        endpointHost: new URL(base).hostname,
        egress: "loopback",
        detail: { model: cat.name, tag: cat.ollamaTag, error: pullError },
      });
      if (pullError) throw new ApiFail(502, "pull_failed", `Model download failed: ${pullError}`);
      return NextResponse.json({ ok: true });
    }

    if (body.action === "uninstall" && body.key) {
      const entry = await db.modelEntry.findUnique({ where: { key: body.key } });
      if (!entry) throw new ApiFail(404, "unknown_model", "Model not found.");
      await db.modelEntry.update({ where: { key: body.key }, data: { installed: false, installedAt: null } });
      await appendProof({ userId: user.id, username: user.username, action: "model.uninstall", status: "ok", modelKey: body.key, provider: entry.provider.toLowerCase() });
      return NextResponse.json({ ok: true });
    }

    if (["approve", "disapprove", "enable", "disable"].includes(body.action) && body.key) {
      const entry = await db.modelEntry.findUnique({ where: { key: body.key } });
      if (!entry) throw new ApiFail(404, "unknown_model", "Model not found.");
      const patch =
        body.action === "approve" ? { approved: true } :
        body.action === "disapprove" ? { approved: false } :
        body.action === "enable" ? { enabled: true } :
        { enabled: false };
      await db.modelEntry.update({ where: { key: body.key }, data: patch });
      await appendProof({
        userId: user.id,
        username: user.username,
        action: "model.approval",
        status: "ok",
        modelKey: body.key,
        detail: { ...patch },
      });
      return NextResponse.json({ ok: true });
    }

    if (body.action === "syncCloud" && body.providerId) {
      const provider = settings.cloudProviders.find((p) => p.id === body.providerId);
      if (!provider) throw new ApiFail(404, "unknown_provider", "Cloud provider not configured.");
      const key = provider.apiKeyEnc ? aesDecrypt(provider.apiKeyEnc) : undefined;
      const ping = await pingCompat(provider.baseUrl, key, 6000, true); // explicit admin action → external allowed
      if (!ping.reachable) throw new ApiFail(502, "provider_unreachable", `Cloud endpoint unreachable: ${ping.error}`);
      let added = 0;
      for (const modelId of ping.models.slice(0, 200)) {
        const modelKey = `cloud:${provider.id}:${modelId}`;
        await db.modelEntry.upsert({
          where: { key: modelKey },
          update: { installed: true },
          create: {
            key: modelKey,
            name: `${provider.label} · ${modelId}`,
            family: provider.label,
            provider: "CLOUD",
            endpoint: provider.baseUrl,
            installed: true,
            approved: false, // cloud models start NOT approved — an admin must approve them
            enabled: true,
            meta: JSON.stringify({ providerId: provider.id, modelId }),
          },
        });
        added++;
      }
      await appendProof({
        userId: user.id,
        username: user.username,
        action: "model.sync",
        status: "ok",
        provider: "cloud",
        endpointHost: new URL(provider.baseUrl).hostname,
        egress: "external",
        detail: { provider: provider.label, models: added },
      });
      return NextResponse.json({ ok: true, added });
    }

    throw new ApiFail(400, "bad_action", "Unsupported action.");
  } catch (e) {
    return failResponse(e);
  }
}

// ═══ /api/policy ═════════════════════════════════════════════════════════════
// merged from src/app/api/policy/route.ts

async function policy__loadPolicy(workspaceId: string) {
  const ws = await db.workspace.findUnique({ where: { id: workspaceId }, include: { policy: true } });
  if (!ws) throw new ApiFail(404, "not_found", "Workspace not found.");
  if (ws.policy) return ws.policy;
  const policy = await db.policy.create({ data: { workspaceId } });
  return policy;
}

const policy__PolicyRulesSchema = z.object({
  mode: z.enum(["LOCAL_ONLY", "CLOUD_FALLBACK", "BLOCK_ALL"]),
  redactPii: z.boolean(),
  blockKeywords: z.string().max(500),
  allowedModels: z.string().max(1000),
  maxTokens: z.number().int().min(128).max(8192),
});

const policy__PutBody = z.object({
  workspaceId: z.string().trim().min(1).max(40),
  policy: policy__PolicyRulesSchema,
});

const policy__TestBody = z.object({
  workspaceId: z.string().trim().min(1).max(40),
  text: z.string().max(10_000),
  modelKey: z.string().trim().max(120).optional(),
});

async function policy__GET(req: Request) {
  try {
    await requireUser(["ADMIN", "MEMBER"]);
    const workspaceId = z.string().trim().min(1).max(40).parse(new URL(req.url).searchParams.get("workspaceId") ?? "");
    const policy = await policy__loadPolicy(workspaceId);
    return NextResponse.json({ policy });
  } catch (e) {
    if (e instanceof z.ZodError) return NextResponse.json({ error: { code: "bad_request", message: "workspaceId is required." } }, { status: 400 });
    return failResponse(e);
  }
}

async function policy__PUT(req: Request) {
  try {
    const user = await requireUser(["ADMIN"]);
    const body = await readJsonWith(req, policy__PutBody);
    const current = await policy__loadPolicy(body.workspaceId);
    const p = body.policy;
    await db.policy.update({
      where: { id: current.id },
      data: {
        mode: p.mode,
        redactPii: Boolean(p.redactPii),
        blockKeywords: p.blockKeywords,
        allowedModels: p.allowedModels,
        maxTokens: p.maxTokens,
      },
    });
    await appendProof({
      userId: user.id,
      username: user.username,
      workspaceId: body.workspaceId,
      action: "policy.update",
      status: "ok",
      detail: { mode: p.mode, redactPii: p.redactPii, blockKeywords: p.blockKeywords, allowedModels: p.allowedModels, maxTokens: p.maxTokens },
    });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return failResponse(e);
  }
}

async function policy__POST(req: Request) {
  try {
    await requireUser(["ADMIN", "MEMBER"]);
    const body = await readJsonWith(req, policy__TestBody);
    const policy = await policy__loadPolicy(body.workspaceId);
    const settings = await getSettings();
    const modelKey = body.modelKey || policy.allowedModels.split(",").map((s) => s.trim()).find(Boolean) || "local:none";
    const decision = evaluatePolicy(
      {
        mode: policy.mode as PolicyRules["mode"],
        redactPii: policy.redactPii,
        blockKeywords: policy.blockKeywords,
        allowedModels: policy.allowedModels,
        maxTokens: policy.maxTokens,
      },
      {
        text: body.text,
        modelKey,
        targetIsCloud: modelKey.startsWith("cloud:"),
        cloudConfigured: settings.cloudProviders.some((p) => p.enabled),
      }
    );
    return NextResponse.json({ decision, modelKey });
  } catch (e) {
    return failResponse(e);
  }
}

// ═══ /api/proof ══════════════════════════════════════════════════════════════
// merged from src/app/api/proof/route.ts

async function proof__GET(req: Request) {
  try {
    const user = await requireUser();
    const url = new URL(req.url);
    const page = Math.max(1, parseInt(url.searchParams.get("page") ?? "1", 10) || 1);
    const pageSize = Math.min(100, Math.max(10, parseInt(url.searchParams.get("pageSize") ?? "50", 10) || 50));
    const action = (url.searchParams.get("action") ?? "").trim().slice(0, 60);
    const status = (url.searchParams.get("status") ?? "").trim().slice(0, 20);
    const egress = (url.searchParams.get("egress") ?? "").trim().slice(0, 20);
    const q = (url.searchParams.get("q") ?? "").trim().slice(0, 100);

    const where: Prisma.ProofEntryWhereInput = {
      ...(user.role === "MEMBER" ? { userId: user.id } : {}),
      ...(action ? { action: { contains: action } } : {}),
      ...(status ? { status } : {}),
      ...(egress ? { egress } : {}),
      ...(q ? {
        OR: [{ username: { contains: q } }, { modelKey: { contains: q } }, { workspaceName: { contains: q } }, { providerLabel: { contains: q } }],
      } : {}),
    };

    const [total, entries, checkpoints] = await Promise.all([
      db.proofEntry.count({ where }),
      db.proofEntry.findMany({
        where,
        orderBy: { seq: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      listCheckpoints(5),
    ]);
    const chain = cachedChain() ?? (await verifyChain());
    return NextResponse.json({
      entries: entries.map((e) => ({
        seq: e.seq,
        ts: e.ts.toISOString(),
        username: e.username,
        workspaceName: e.workspaceName,
        action: e.action,
        status: e.status,
        modelKey: e.modelKey,
        provider: e.provider,
        providerLabel: e.providerLabel,
        endpointHost: e.endpointHost,
        endpointIp: e.endpointIp,
        egress: e.egress,
        latencyMs: e.latencyMs,
        tokensIn: e.tokensIn,
        tokensOut: e.tokensOut,
        redactions: e.redactions,
        detail: JSON.parse(e.detail || "{}"),
        prevHash: e.prevHash ? `${e.prevHash.slice(0, 10)}…` : null,
        selfHash: e.selfHash ? `${e.selfHash.slice(0, 10)}…` : null,
      })),
      total,
      page,
      pageSize,
      chain,
      checkpoints,
      scope: user.role === "MEMBER" ? "own" : "all",
    });
  } catch (e) {
    return failResponse(e);
  }
}

// ═══ /api/proof/export ═══════════════════════════════════════════════════════
// merged from src/app/api/proof/export/route.ts

async function proof_export__GET(req: Request) {
  try {
    const user = await requireUser();
    if (user.role === "MEMBER") throw new ApiFail(403, "forbidden", "Signed Proof exports are available to admins and auditors.");
    const url = new URL(req.url);
    const format = url.searchParams.get("format") ?? "json";
    const from = url.searchParams.get("from");
    const to = url.searchParams.get("to");
    const fd = from && !isNaN(Date.parse(from)) ? new Date(from) : undefined;
    const td = to && !isNaN(Date.parse(to)) ? new Date(to) : undefined;
    const report = await buildReport(fd, td);

    if (format === "pdf") {
      const pdf = await renderProofPdf(report);
      return new NextResponse(new Uint8Array(pdf), {
        headers: {
          "Content-Type": "application/pdf",
          "Content-Disposition": `attachment; filename="lester-proof-${new Date().toISOString().slice(0, 10)}.pdf"`,
        },
      });
    }

    return new NextResponse(JSON.stringify(report, null, 2), {
      headers: {
        "Content-Type": "application/json",
        "Content-Disposition": `attachment; filename="lester-proof-${new Date().toISOString().slice(0, 10)}.json"`,
      },
    });
  } catch (e) {
    return failResponse(e);
  }
}

// ═══ /api/settings ═══════════════════════════════════════════════════════════
// merged from src/app/api/settings/route.ts

function settings__maskProviders(settings: LesterSettings) {
  return settings.cloudProviders.map((p) => ({
    id: p.id,
    label: p.label,
    baseUrl: p.baseUrl,
    enabled: p.enabled,
    hasKey: Boolean(p.apiKeyEnc),
    defaultModel: p.defaultModel,
  }));
}

const settings__EnginePatch = z.object({
  type: z.enum(["none", "openai-compat"]).optional(),
  url: z.string().trim().max(300).optional(),
  label: z.string().trim().max(60).optional(),
  adapter: z.enum(["ollama", "llamacpp", "lmstudio", "vllm", "generic"]).optional(),
});

const settings__ProviderPatch = z.object({
  id: z.string().trim().min(1).max(40),
  label: z.string().trim().min(1).max(60).optional(),
  baseUrl: z.string().trim().max(300).optional(),
  enabled: z.boolean().optional(),
  defaultModel: z.string().trim().max(120).optional(),
  apiKeyPlain: z.string().max(400).optional(),
  keepKey: z.boolean().optional(),
});

const settings__SettingsPatch = z.object({
  engine: settings__EnginePatch.optional(),
  contentLogging: z.boolean().optional(),
  encryptAtRest: z.boolean().optional(),
  backup: z.object({
    enabled: z.boolean().optional(),
    hour: z.number().int().min(0).max(23).optional(),
    keep: z.number().int().min(1).max(365).optional(),
  }).optional(),
  sessionTtlHours: z.number().int().min(1).max(720).optional(),
  cloudProviders: z.array(settings__ProviderPatch).max(10).optional(),
});

async function settings__GET() {
  try {
    await requireUser(["ADMIN", "MEMBER"]);
    await ensureBooted();
    const [settings, engine, license] = await Promise.all([getSettings(), engineStatus(), licenseInfo()]);
    return NextResponse.json({
      settings: { ...settings, cloudProviders: settings__maskProviders(settings) },
      engine,
      license,
      nodeId: nodeId(),
      paths: dataPaths(),
      bind: LESTER.bind,
      port: LESTER.port,
      version: LESTER.version,
    });
  } catch (e) {
    return failResponse(e);
  }
}

async function settings__PUT(req: Request) {
  try {
    const user = await requireUser(["ADMIN"]);
    const patch = await readJsonWith(req, settings__SettingsPatch);
    const current = await getSettings();
    const next: Partial<LesterSettings> = {};

    if (patch.engine) {
      const type = patch.engine.type ?? current.engine.type;
      let url = (patch.engine.url ?? current.engine.url).trim();
      if (type === "openai-compat" && url) {
        if (!/\/v\d$/.test(url) && !url.includes("/v1/")) url = url.replace(/\/$/, "") + "/v1";
        const check = await checkUrl(url, { allowExternal: false });
        if (!check.ok) throw new ApiFail(400, "bad_url", check.reason ?? "Engine URL refused.");
      }
      next.engine = {
        type,
        url: type === "none" ? "" : url,
        label: patch.engine.label ?? current.engine.label,
        adapter: (patch.engine.adapter ?? current.engine.adapter) as EngineAdapter,
      };
    }
    if (patch.contentLogging !== undefined) next.contentLogging = Boolean(patch.contentLogging);
    if (patch.encryptAtRest !== undefined) next.encryptAtRest = Boolean(patch.encryptAtRest);
    if (patch.backup) next.backup = { ...current.backup, ...patch.backup };
    if (patch.sessionTtlHours) next.sessionTtlHours = patch.sessionTtlHours;

    if (patch.cloudProviders) {
      // S5: every cloud provider URL is validated before it is stored.
      for (const p of patch.cloudProviders) {
        if (p.baseUrl !== undefined) {
          const check = await checkUrl(p.baseUrl, { allowExternal: true });
          if (!check.ok) throw new ApiFail(400, "bad_url", `Provider "${p.label ?? p.id}": ${check.reason}`);
        }
      }
      next.cloudProviders = patch.cloudProviders.map((p) => {
        const existing = current.cloudProviders.find((e) => e.id === p.id);
        let apiKeyEnc = existing?.apiKeyEnc ?? "";
        if (p.apiKeyPlain) {
          apiKeyEnc = aesEncrypt(p.apiKeyPlain);
        } else if (p.keepKey === false) {
          apiKeyEnc = "";
        }
        return {
          id: p.id,
          label: (p.label ?? existing?.label ?? "Cloud provider").slice(0, 60),
          baseUrl: (p.baseUrl ?? existing?.baseUrl ?? "").trim(),
          enabled: p.enabled ?? existing?.enabled ?? false,
          defaultModel: (p.defaultModel ?? existing?.defaultModel ?? "").trim(),
          apiKeyEnc,
        };
      });
    }

    const saved = await saveSettings(next);
    await appendProof({
      userId: user.id,
      username: user.username,
      action: "settings.update",
      status: "ok",
      detail: { fields: Object.keys(patch) },
    });
    return NextResponse.json({ ok: true, settings: { ...saved, cloudProviders: settings__maskProviders(saved) } });
  } catch (e) {
    return failResponse(e);
  }
}

// ═══ /api/setup/complete ═════════════════════════════════════════════════════
// merged from src/app/api/setup/complete/route.ts

const setup_complete__CompleteBody = z.object({
  adminUsername: z.string().trim().min(3).max(32),
  adminDisplayName: z.string().trim().max(64).optional(),
  adminPassword: z.string().min(1).max(200),
  workspaceName: z.string().trim().max(60).optional(),
  modelKey: z.string().trim().max(120).optional(), // optional: engines can be configured later
  engineUrl: z.string().trim().max(300).optional(),
  engineAdapter: z.enum(["ollama", "llamacpp", "lmstudio", "vllm", "generic"]).optional(),
});

function setup_complete__requestIsSecure(req: Request): boolean {
  if (new URL(req.url).protocol === "https:") return true;
  if (LESTER.trustProxy) {
    const proto = req.headers.get("x-forwarded-proto");
    return proto?.split(",")[0].trim() === "https";
  }
  return false;
}

async function setup_complete__POST(req: Request) {
  try {
    await ensureBooted();
    const body = await readJsonWith(req, setup_complete__CompleteBody);
    const username = body.adminUsername.toLowerCase();
    const password = body.adminPassword;

    if (!/^[a-z0-9_.-]{3,32}$/.test(username)) {
      throw new ApiFail(400, "invalid_username", "Username: 3–32 chars, letters/numbers/._- only.");
    }
    const pwProblem = checkPasswordStrength(password, username);
    if (pwProblem) throw new ApiFail(400, "weak_password", pwProblem);
    if ((await db.user.count({ where: { role: "ADMIN" } })) > 0) {
      throw new ApiFail(409, "already_setup", "Lester is already set up. Sign in instead.");
    }

    // Engine (optional): connect a detected engine now, or skip and configure later.
    let connectedModels = 0;
    if (body.engineUrl && body.engineAdapter) {
      let url = body.engineUrl.replace(/\/$/, "");
      if (!/\/v\d$/.test(url) && !url.includes("/v1/")) url = `${url}/v1`;
      const ping = await pingCompat(url, undefined, 2500);
      if (ping.reachable) {
        const adapterLabel: Record<string, string> = {
          ollama: "Ollama", lmstudio: "LM Studio", llamacpp: "llama.cpp llama-server", vllm: "vLLM", generic: "Local engine",
        };
        await saveSettings({
          engine: { type: "openai-compat", url, label: adapterLabel[body.engineAdapter] ?? "Local engine", adapter: body.engineAdapter },
        });
        connectedModels = await registerEngineModels(url, ping.models);
      } else {
        throw new ApiFail(400, "engine_unreachable", `No engine answered at ${url}${ping.error ? ` (${ping.error})` : ""}. Check that it is running, then retry — or continue without an engine and configure it later in Settings.`);
      }
    }

    // Model (optional when no engine is connected yet)
    let model: { key: string; name: string; provider: string } | null = null;
    if (body.modelKey) {
      const entry = await db.modelEntry.findUnique({ where: { key: body.modelKey } });
      if (entry) {
        model = { key: entry.key, name: entry.name, provider: entry.provider };
      } else if (body.modelKey.startsWith("local:")) {
        const cat = LOCAL_MODEL_CATALOG.find((c) => c.key === body.modelKey);
        if (cat) {
          const created = await db.modelEntry.create({
            data: {
              key: cat.key,
              name: cat.name,
              family: cat.family,
              paramsB: cat.paramsB,
              quant: cat.quant,
              sizeMb: cat.sizeMb,
              ramReqMb: cat.ramReqMb,
              provider: "LOCAL_ENGINE",
              installed: false,
              approved: true,
              enabled: true,
              meta: JSON.stringify({ ollamaTag: cat.ollamaTag, note: cat.note }),
            },
          });
          model = { key: created.key, name: created.name, provider: created.provider };
        }
      }
      if (!model) throw new ApiFail(400, "model_missing", `Unknown model ${body.modelKey}.`);
    }

    const admin = await db.user.create({
      data: {
        username,
        displayName: body.adminDisplayName?.trim() || username,
        passwordHash: hashPassword(password),
        role: "ADMIN",
      },
    });

    const settings = await getSettings();
    const workspace = await db.workspace.create({
      data: {
        name: body.workspaceName?.trim() || "General",
        description: "Default workspace created during first-run setup.",
        defaultModel: model?.key ?? null,
        policy: {
          create: {
            mode: "LOCAL_ONLY",
            redactPii: true,
            blockKeywords: "",
            allowedModels: "",
            maxTokens: 2048,
          },
        },
      },
      include: { policy: true },
    });

    await appendProof({
      userId: admin.id,
      username: admin.username,
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      action: "setup.complete",
      status: "ok",
      modelKey: model?.key ?? null,
      provider: "local-engine",
      detail: {
        admin: admin.username,
        workspace: workspace.name,
        model: model?.name ?? "(none yet)",
        engine: settings.engine.type === "openai-compat" ? settings.engine.url : "not configured",
        engineModels: connectedModels,
      },
    });

    const { token, expiresAt } = await createSession(admin.id);
    const res = NextResponse.json({
      ok: true,
      user: { id: admin.id, username: admin.username, displayName: admin.displayName, role: admin.role },
      workspaceId: workspace.id,
    });
    res.cookies.set(LESTER.sessionCookie, token, {
      httpOnly: true,
      sameSite: "strict",
      path: "/",
      expires: expiresAt,
      secure: setup_complete__requestIsSecure(req),
    });
    return res;
  } catch (e) {
    return failResponse(e);
  }
}

// ═══ /api/setup/status ═══════════════════════════════════════════════════════
// merged from src/app/api/setup/status/route.ts

async function setup_status__GET() {
  await ensureBooted();
  const adminExists = (await db.user.count({ where: { role: "ADMIN" } })) > 0;
  const [hardware, engine, license, detection] = await Promise.all([
    detectHardware(),
    engineStatus(),
    licenseInfo(),
    detectEngines().catch(() => []),
  ]);
  return NextResponse.json({
    setupComplete: adminExists,
    hardware,
    engine,
    license,
    detection,
    adapterGuide: Object.values(ENGINE_PRESETS).map((p) => ({ id: p.id, label: p.label, note: p.note })),
    recommendations: recommendModels(hardware).slice(0, 4),
    version: LESTER.version,
  });
}

// ═══ /api/tokens ═════════════════════════════════════════════════════════════
// merged from src/app/api/tokens/route.ts

const tokens__CreateBody = z.object({ name: z.string().trim().min(1).max(60) });

async function tokens__GET() {
  try {
    const user = await requireUser(["ADMIN", "MEMBER"]);
    const tokens = await db.apiToken.findMany({
      where: { userId: user.id, revokedAt: null },
      orderBy: { createdAt: "desc" },
    });
    return NextResponse.json({
      tokens: tokens.map((t) => ({
        id: t.id,
        name: t.name,
        prefix: t.prefix,
        createdAt: t.createdAt.toISOString(),
        lastUsedAt: t.lastUsedAt?.toISOString() ?? null,
      })),
    });
  } catch (e) {
    return failResponse(e);
  }
}

async function tokens__POST(req: Request) {
  try {
    const user = await requireUser(["ADMIN", "MEMBER"]);
    const body = await readJsonWith(req, tokens__CreateBody);
    const count = await db.apiToken.count({ where: { userId: user.id, revokedAt: null } });
    if (count >= 20) throw new ApiFail(400, "too_many_tokens", "At most 20 active tokens per user — revoke one first.");
    const { raw, hash, prefix } = generateApiToken();
    const row = await db.apiToken.create({
      data: { userId: user.id, name: body.name, tokenHash: hash, prefix },
    });
    await appendProof({
      userId: user.id,
      username: user.username,
      action: "token.create",
      status: "ok",
      detail: { tokenId: row.id, name: body.name },
    });
    return NextResponse.json({ ok: true, id: row.id, token: raw, name: body.name }); // raw shown once
  } catch (e) {
    return failResponse(e);
  }
}

// ═══ /api/tokens/:id ═════════════════════════════════════════════════════════
// merged from src/app/api/tokens/[id]/route.ts

async function tokens_id__DELETE(_req: Request, params: { id: string }) {
  try {
    const user = await requireUser(["ADMIN", "MEMBER"]);
    const { id } = params;
    const token = await db.apiToken.findUnique({ where: { id } });
    if (!token || token.revokedAt) throw new ApiFail(404, "not_found", "Token not found.");
    if (token.userId !== user.id && user.role !== "ADMIN") throw new ApiFail(403, "forbidden", "You can only revoke your own tokens.");
    await db.apiToken.update({ where: { id }, data: { revokedAt: new Date() } });
    await appendProof({
      userId: user.id,
      username: user.username,
      action: "token.revoke",
      status: "ok",
      detail: { tokenId: id, name: token.name },
    });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return failResponse(e);
  }
}

// ═══ /api/users ══════════════════════════════════════════════════════════════
// merged from src/app/api/users/route.ts

const users__CreateBody = z.object({
  username: z.string().trim().min(3).max(32),
  displayName: z.string().trim().max(64).optional(),
  password: z.string().min(1).max(200),
  role: z.enum(["ADMIN", "MEMBER", "AUDITOR"]),
});

const users__PatchBody = z.object({
  id: z.string().trim().min(1).max(40),
  disabled: z.boolean().optional(),
  role: z.enum(["ADMIN", "MEMBER", "AUDITOR"]).optional(),
  password: z.string().min(1).max(200).optional(),
});

async function users__GET() {
  try {
    await requireUser(["ADMIN"]);
    const users = await db.user.findMany({ orderBy: { createdAt: "asc" } });
    const counts = await db.apiToken.groupBy({ by: ["userId"], where: { revokedAt: null }, _count: { _all: true } });
    const tokenCount = (id: string) => counts.find((c) => c.userId === id)?._count._all ?? 0;
    return NextResponse.json({
      users: users.map((u) => ({
        id: u.id,
        username: u.username,
        displayName: u.displayName,
        role: u.role,
        disabled: u.disabled,
        activeTokens: tokenCount(u.id),
        createdAt: u.createdAt.toISOString(),
      })),
    });
  } catch (e) {
    return failResponse(e);
  }
}

async function users__POST(req: Request) {
  try {
    const admin = await requireUser(["ADMIN"]);
    const body = await readJsonWith(req, users__CreateBody);
    const username = body.username.toLowerCase();
    if (!/^[a-z0-9_.-]{3,32}$/.test(username)) throw new ApiFail(400, "invalid_username", "Username: 3–32 chars, letters/numbers/._- only.");
    const pwProblem = checkPasswordStrength(body.password, username);
    if (pwProblem) throw new ApiFail(400, "weak_password", pwProblem);
    const quota = await checkUserQuota();
    if (!quota.allowed) {
      throw new ApiFail(402, "quota", `User limit reached (${quota.limit}) on this license tier. Activate a team license to add more users.`);
    }
    if (await db.user.findUnique({ where: { username } })) throw new ApiFail(409, "exists", "That username is taken.");
    const user = await db.user.create({
      data: {
        username,
        displayName: body.displayName?.trim() || username,
        passwordHash: hashPassword(body.password),
        role: body.role,
      },
    });
    await appendProof({
      userId: admin.id,
      username: admin.username,
      action: "user.create",
      status: "ok",
      detail: { newUsername: username, role: body.role },
    });
    return NextResponse.json({ ok: true, id: user.id });
  } catch (e) {
    return failResponse(e);
  }
}

async function users__PATCH(req: Request) {
  try {
    const admin = await requireUser(["ADMIN"]);
    const body = await readJsonWith(req, users__PatchBody);
    const target = await db.user.findUnique({ where: { id: body.id } });
    if (!target) throw new ApiFail(404, "not_found", "User not found.");
    if (target.id === admin.id && body.disabled === true) throw new ApiFail(400, "self_disable", "You cannot disable your own account.");
    if (target.role === "ADMIN" && body.disabled === true) {
      const admins = await db.user.count({ where: { role: "ADMIN", disabled: false } });
      if (admins <= 1) throw new ApiFail(400, "last_admin", "At least one enabled admin must remain.");
    }
    if (body.password) {
      const pwProblem = checkPasswordStrength(body.password, target.username);
      if (pwProblem) throw new ApiFail(400, "weak_password", pwProblem);
    }
    await db.user.update({
      where: { id: body.id },
      data: {
        ...(body.disabled !== undefined ? { disabled: body.disabled } : {}),
        ...(body.role ? { role: body.role } : {}),
        ...(body.password ? { passwordHash: hashPassword(body.password) } : {}),
      },
    });
    // S4 — password change or disable invalidates every session immediately.
    if (body.disabled || body.password) {
      await revokeAllSessions(body.id);
    }
    await appendProof({
      userId: admin.id,
      username: admin.username,
      action: "user.update",
      status: "ok",
      detail: { target: target.username, fields: Object.keys(body).filter((k) => k !== "id"), sessionsRevoked: Boolean(body.disabled || body.password) },
    });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return failResponse(e);
  }
}

async function users__DELETE(req: Request) {
  try {
    const admin = await requireUser(["ADMIN"]);
    const id = new URL(req.url).searchParams.get("id") ?? "";
    const target = await db.user.findUnique({ where: { id } });
    if (!target) throw new ApiFail(404, "not_found", "User not found.");
    if (target.id === admin.id) throw new ApiFail(400, "self_delete", "You cannot delete your own account.");
    if (target.role === "ADMIN") {
      const admins = await db.user.count({ where: { role: "ADMIN" } });
      if (admins <= 1) throw new ApiFail(400, "last_admin", "At least one admin must remain.");
    }
    await db.user.delete({ where: { id } });
    await appendProof({
      userId: admin.id,
      username: admin.username,
      action: "user.delete",
      status: "ok",
      detail: { deleted: target.username },
    });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return failResponse(e);
  }
}

// ═══ /api/v1/chat/completions ════════════════════════════════════════════════
// merged from src/app/api/v1/chat/completions/route.ts

const v1_chat_completions__Message = z.object({
  role: z.enum(["system", "user", "assistant"]),
  content: z.string().max(100_000),
});

const v1_chat_completions__Body = z.object({
  model: z.string().trim().max(120).optional(),
  messages: z.array(v1_chat_completions__Message).min(1).max(100),
  stream: z.boolean().optional(),
  workspace: z.string().trim().max(40).optional(),
});

async function v1_chat_completions__defaultWorkspaceId(): Promise<string> {
  const first = await db.workspace.findFirst({ orderBy: { createdAt: "asc" } });
  if (first) return first.id;
  const created = await db.workspace.create({
    data: { name: "API", description: "Default workspace for OpenAI-compatible API requests.", policy: { create: { mode: "LOCAL_ONLY", redactPii: true } } },
  });
  return created.id;
}

async function v1_chat_completions__resolveModelKey(model: string | undefined): Promise<string | null> {
  if (!model) {
    const first = await db.modelEntry.findFirst({ where: { installed: true, enabled: true, approved: true }, orderBy: [{ provider: "desc" }, { name: "asc" }] });
    return first?.key ?? null;
  }
  const exact = await db.modelEntry.findUnique({ where: { key: model } });
  if (exact) return exact.key;
  const byName = await db.modelEntry.findFirst({ where: { installed: true, name: { contains: model } } });
  return byName?.key ?? null;
}

function v1_chat_completions__openaiError(status: number, message: string, code: string) {
  return NextResponse.json({ error: { message, type: "lester_error", code } }, { status });
}

async function v1_chat_completions__POST(req: Request) {
  await ensureBooted();
  const authHeader = req.headers.get("authorization");
  const user = await authUserFromApiToken(authHeader?.startsWith("Bearer ") ? authHeader.slice(7).trim() : null);
  if (!user) return v1_chat_completions__openaiError(401, "Invalid or missing API token. Generate one in Lester Console → Settings → API tokens.", "invalid_token");
  if (user.role === "AUDITOR") return v1_chat_completions__openaiError(403, "Auditor accounts cannot use the inference API.", "forbidden");

  let body: z.infer<typeof v1_chat_completions__Body>;
  try {
    body = v1_chat_completions__Body.parse(await req.json());
  } catch (e) {
    const first = e instanceof z.ZodError ? e.issues[0] : null;
    return v1_chat_completions__openaiError(400, first ? `${first.path.join(".")}: ${first.message}` : "v1_chat_completions__Body must be a valid chat.completions request.", "bad_request");
  }
  const messages: ChatMsg[] = body.messages;
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  if (!lastUser) return v1_chat_completions__openaiError(400, "'messages' must contain at least one user message.", "bad_messages");

  const modelKey = await v1_chat_completions__resolveModelKey(body.model);
  if (!modelKey) {
    return v1_chat_completions__openaiError(404, `Model '${body.model ?? "(default)"}' is not installed. GET /api/v1/models lists what's available.`, "model_not_found");
  }

  const workspaceId = body.workspace ?? (await v1_chat_completions__defaultWorkspaceId());
  const history = messages.slice(0, messages.length - 1);

  const id = `chatcmpl-lester-${Date.now().toString(36)}`;
  const created = Math.floor(Date.now() / 1000);

  if (body.stream) {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const send = (obj: unknown) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
        try {
          let usage = { promptTokens: 0, completionTokens: 0 };
          let blocked = false;
          for await (const ev of runChatTurn({
            user,
            workspaceId,
            modelKey,
            history,
            content: lastUser.content,
            useKnowledge: false,
            signal: req.signal,
            persist: false,
          })) {
            if (ev.type === "delta") {
              send({ id, object: "chat.completion.chunk", created, model: modelKey, choices: [{ index: 0, delta: { content: ev.text }, finish_reason: null }] });
            } else if (ev.type === "policy" && ev.blocked) {
              blocked = true;
              send({ error: { message: ev.reason, type: "lester_error", code: "blocked_by_policy" } });
            } else if (ev.type === "error") {
              send({ error: { message: ev.message, type: "lester_error", code: ev.code } });
            } else if (ev.type === "done") {
              usage = ev.usage;
            }
          }
          if (!blocked) {
            send({ id, object: "chat.completion.chunk", created, model: modelKey, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: usage.promptTokens, completion_tokens: usage.completionTokens, total_tokens: usage.promptTokens + usage.completionTokens } });
          }
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        } catch (e) {
          send({ error: { message: e instanceof Error ? e.message : "stream failed", type: "lester_error", code: "internal" } });
        } finally {
          controller.close();
        }
      },
    });
    return new Response(stream, {
      headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no" },
    });
  }

  // Non-streaming
  let full = "";
  let usage = { promptTokens: 0, completionTokens: 0 };
  let blockedReason: string | null = null;
  let errorEvent: Extract<ChatEvent, { type: "error" }> | null = null;
  for await (const ev of runChatTurn({
    user,
    workspaceId,
    modelKey,
    history,
    content: lastUser.content,
    useKnowledge: false,
    persist: false,
  })) {
    if (ev.type === "delta") full += ev.text;
    else if (ev.type === "policy" && ev.blocked) blockedReason = ev.reason;
    else if (ev.type === "error") errorEvent = ev;
    else if (ev.type === "done") usage = ev.usage;
  }
  if (blockedReason) return v1_chat_completions__openaiError(403, blockedReason, "blocked_by_policy");
  if (errorEvent) return v1_chat_completions__openaiError(502, `${errorEvent.message} ${errorEvent.recovery ?? ""}`.trim(), errorEvent.code);

  return NextResponse.json({
    id,
    object: "chat.completion",
    created,
    model: modelKey,
    choices: [{ index: 0, message: { role: "assistant", content: full }, finish_reason: "stop" }],
    usage: { prompt_tokens: usage.promptTokens, completion_tokens: usage.completionTokens, total_tokens: usage.promptTokens + usage.completionTokens },
    lester: { node: "on-premises", pipeline: "policy → redaction → engine → proof" },
  });
}

async function v1_chat_completions__GET() {
  return v1_chat_completions__openaiError(405, "Use POST for chat completions. GET /api/v1/models lists installed models.", "method_not_allowed");
}

// ═══ /api/v1/models ══════════════════════════════════════════════════════════
// merged from src/app/api/v1/models/route.ts

async function v1_models__GET(req: Request) {
  const header = req.headers.get("authorization");
  if (!header?.startsWith("Bearer ")) {
    return NextResponse.json({ error: { message: "Invalid or missing API token.", code: "invalid_token" } }, { status: 401 });
  }
  const user = await authUserFromApiToken(header.slice(7).trim());
  if (!user) {
    return NextResponse.json({ error: { message: "Invalid API token.", code: "invalid_token" } }, { status: 401 });
  }
  const models = await db.modelEntry.findMany({ where: { installed: true, enabled: true, approved: true } });
  return NextResponse.json({
    object: "list",
    data: models.map((m) => ({
      id: m.key,
      object: "model",
      created: Math.floor((m.installedAt?.getTime() ?? Date.now()) / 1000),
      owned_by: m.provider === "CLOUD" ? "cloud" : "local-engine",
    })),
  });
}

// ═══ /api/workspaces ═════════════════════════════════════════════════════════
// merged from src/app/api/workspaces/route.ts

async function workspaces__GET() {
  try {
    await requireUser();
    const workspaces = await db.workspace.findMany({
      orderBy: { createdAt: "asc" },
      include: {
        _count: { select: { documents: true, conversations: true } },
        policy: true,
      },
    });
    return NextResponse.json({
      workspaces: workspaces.map((w) => ({
        id: w.id,
        name: w.name,
        description: w.description,
        defaultModel: w.defaultModel,
        createdAt: w.createdAt.toISOString(),
        documents: w._count.documents,
        conversations: w._count.conversations,
        policyMode: w.policy?.mode ?? "LOCAL_ONLY",
      })),
    });
  } catch (e) {
    return failResponse(e);
  }
}

async function workspaces__POST(req: Request) {
  try {
    const user = await requireUser(["ADMIN"]);
    const body = await readJsonWith(req, z.object({ name: z.string().trim().min(1).max(60), description: z.string().trim().max(400).optional(), defaultModel: z.string().trim().max(120).optional() }));
    const name = body.name;
    if (name.length < 1 || name.length > 60) throw new ApiFail(400, "bad_name", "Workspace name: 1–60 characters.");
    const quota = await checkWorkspaceQuota();
    if (!quota.allowed) {
      throw new ApiFail(402, "quota", `Workspace limit reached (${quota.limit}) on the current license tier. Activate a team license to add more.`);
    }
    const workspace = await db.workspace.create({
      data: {
        name,
        description: (body.description ?? "").trim(),
        defaultModel: body.defaultModel,
        policy: { create: { mode: "LOCAL_ONLY", redactPii: true } },
      },
    });
    await appendProof({
      userId: user.id,
      username: user.username,
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      action: "workspace.create",
      status: "ok",
      detail: { name },
    });
    return NextResponse.json({ ok: true, id: workspace.id });
  } catch (e) {
    return failResponse(e);
  }
}

async function workspaces__PATCH(req: Request) {
  try {
    const user = await requireUser(["ADMIN"]);
    const body = await readJsonWith(req, z.object({ id: z.string().trim().min(1).max(40), name: z.string().trim().min(1).max(60).optional(), description: z.string().trim().max(400).optional(), defaultModel: z.string().trim().max(120).optional() }));
    const ws = await db.workspace.findUnique({ where: { id: body.id } });
    if (!ws) throw new ApiFail(404, "not_found", "Workspace not found.");
    await db.workspace.update({
      where: { id: body.id },
      data: {
        ...(body.name !== undefined ? { name: body.name.trim() } : {}),
        ...(body.description !== undefined ? { description: body.description.trim() } : {}),
        ...(body.defaultModel !== undefined ? { defaultModel: body.defaultModel } : {}),
      },
    });
    await appendProof({
      userId: user.id,
      username: user.username,
      workspaceId: ws.id,
      workspaceName: body.name ?? ws.name,
      action: "workspace.update",
      status: "ok",
      detail: { fields: Object.keys(body).filter((k) => k !== "id") },
    });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return failResponse(e);
  }
}

async function workspaces__DELETE(req: Request) {
  try {
    const user = await requireUser(["ADMIN"]);
    const id = new URL(req.url).searchParams.get("id") ?? "";
    const ws = await db.workspace.findUnique({ where: { id } });
    if (!ws) throw new ApiFail(404, "not_found", "Workspace not found.");
    const count = await db.workspace.count();
    if (count <= 1) throw new ApiFail(400, "last_workspace", "At least one workspace must remain.");
    await db.workspace.delete({ where: { id } });
    await appendProof({
      userId: user.id,
      username: user.username,
      action: "workspace.delete",
      status: "ok",
      detail: { name: ws.name },
    });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return failResponse(e);
  }
}

// ═══ Router (method + path → handler) ════════════════════════════════════════

interface RouteDef {
  method: string;
  parts: string[];
  handler: (req: Request, params: ApiParams) => Promise<Response> | Response;
}

const ROUTES: RouteDef[] = [
  { method: "POST", parts: ["auth", "login"], handler: (req) => auth_login__POST(req) },
  { method: "POST", parts: ["auth", "logout"], handler: () => auth_logout__POST() },
  { method: "GET", parts: ["auth", "session"], handler: () => auth_session__GET() },
  { method: "GET", parts: ["auth", "sessions"], handler: () => auth_sessions__GET() },
  { method: "DELETE", parts: ["auth", "sessions"], handler: (req) => auth_sessions__DELETE(req) },
  { method: "POST", parts: ["chat"], handler: (req) => chat__POST(req) },
  { method: "GET", parts: ["conversations"], handler: (req) => conversations__GET(req) },
  { method: "POST", parts: ["conversations"], handler: (req) => conversations__POST(req) },
  { method: "GET", parts: ["conversations", ":id"], handler: (req, p) => conversations_id__GET(req, p as { id: string }) },
  { method: "PATCH", parts: ["conversations", ":id"], handler: (req, p) => conversations_id__PATCH(req, p as { id: string }) },
  { method: "DELETE", parts: ["conversations", ":id"], handler: (req, p) => conversations_id__DELETE(req, p as { id: string }) },
  { method: "GET", parts: ["engines", "detect"], handler: () => engines_detect__GET() },
  { method: "POST", parts: ["engines", "detect"], handler: (req) => engines_detect__POST(req) },
  { method: "GET", parts: ["fit"], handler: () => fit__GET() },
  { method: "POST", parts: ["fit"], handler: (req) => fit__POST(req) },
  { method: "GET", parts: ["fit", ":id"], handler: (req, p) => fit_id__GET(req, p as { id: string }) },
  { method: "DELETE", parts: ["fit", ":id"], handler: (req, p) => fit_id__DELETE(req, p as { id: string }) },
  { method: "GET", parts: ["hardware"], handler: () => hardware__GET() },
  { method: "GET", parts: ["health"], handler: (req) => health__GET(req) },
  { method: "GET", parts: ["health-live"], handler: () => health_live__GET() },
  { method: "GET", parts: ["knowledge"], handler: (req) => knowledge__GET(req) },
  { method: "POST", parts: ["knowledge"], handler: (req) => knowledge__POST(req) },
  { method: "DELETE", parts: ["knowledge"], handler: (req) => knowledge__DELETE(req) },
  { method: "POST", parts: ["knowledge", "search"], handler: (req) => knowledge_search__POST(req) },
  { method: "GET", parts: ["license"], handler: () => license__GET() },
  { method: "POST", parts: ["license"], handler: (req) => license__POST(req) },
  { method: "GET", parts: ["models"], handler: () => models__GET() },
  { method: "POST", parts: ["models"], handler: (req) => models__POST(req) },
  { method: "GET", parts: ["policy"], handler: (req) => policy__GET(req) },
  { method: "PUT", parts: ["policy"], handler: (req) => policy__PUT(req) },
  { method: "POST", parts: ["policy"], handler: (req) => policy__POST(req) },
  { method: "GET", parts: ["proof"], handler: (req) => proof__GET(req) },
  { method: "GET", parts: ["proof", "export"], handler: (req) => proof_export__GET(req) },
  { method: "GET", parts: ["settings"], handler: () => settings__GET() },
  { method: "PUT", parts: ["settings"], handler: (req) => settings__PUT(req) },
  { method: "POST", parts: ["setup", "complete"], handler: (req) => setup_complete__POST(req) },
  { method: "GET", parts: ["setup", "status"], handler: () => setup_status__GET() },
  { method: "GET", parts: ["tokens"], handler: () => tokens__GET() },
  { method: "POST", parts: ["tokens"], handler: (req) => tokens__POST(req) },
  { method: "DELETE", parts: ["tokens", ":id"], handler: (req, p) => tokens_id__DELETE(req, p as { id: string }) },
  { method: "GET", parts: ["users"], handler: () => users__GET() },
  { method: "POST", parts: ["users"], handler: (req) => users__POST(req) },
  { method: "PATCH", parts: ["users"], handler: (req) => users__PATCH(req) },
  { method: "DELETE", parts: ["users"], handler: (req) => users__DELETE(req) },
  { method: "POST", parts: ["v1", "chat", "completions"], handler: (req) => v1_chat_completions__POST(req) },
  { method: "GET", parts: ["v1", "chat", "completions"], handler: () => v1_chat_completions__GET() },
  { method: "GET", parts: ["v1", "models"], handler: (req) => v1_models__GET(req) },
  { method: "GET", parts: ["workspaces"], handler: () => workspaces__GET() },
  { method: "POST", parts: ["workspaces"], handler: (req) => workspaces__POST(req) },
  { method: "PATCH", parts: ["workspaces"], handler: (req) => workspaces__PATCH(req) },
  { method: "DELETE", parts: ["workspaces"], handler: (req) => workspaces__DELETE(req) },
];

/** Does any handler exist for this path (any method)? */
export function routeExists(segments: string[]): boolean {
  return ROUTES.some((r) => r.parts.length === segments.length && r.parts.every((p, i) => p.startsWith(":") || p === segments[i]));
}

export interface ApiContext {
  params: Promise<{ route?: string[] }>;
}

/**
 * Dispatches an API request. Unknown paths get the same 404 shape Next serves
 * for unmatched /api routes; known paths with an unsupported method get the
 * same empty 405. HEAD falls back to GET (Next's documented behavior).
 */
export async function handleApi(req: Request, ctx: ApiContext): Promise<Response> {
  const { route } = await ctx.params;
  const segments = route ?? [];
  const method = req.method.toUpperCase() === "HEAD" ? "GET" : req.method.toUpperCase();
  for (const r of ROUTES) {
    if (r.method !== method) continue;
    if (r.parts.length !== segments.length) continue;
    const params: ApiParams = {};
    let ok = true;
    for (let i = 0; i < r.parts.length; i++) {
      const p = r.parts[i];
      if (p.startsWith(":")) params[p.slice(1)] = segments[i];
      else if (p !== segments[i]) { ok = false; break; }
    }
    if (ok) return r.handler(req, params);
  }
  if (routeExists(segments)) {
    // Same shape Next produces for a defined route + unsupported method:
    // 405, empty body, no content-type.
    return new Response(null, { status: 405 });
  }
  // Same shape Next produces for unknown /api paths: 404 HTML page.
  return new NextResponse(
    `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/><title>404: This page could not be found.</title></head><body style="font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#fff;color:#000"><div style="text-align:center"><h1 style="font-size:56px;margin:0">404</h1><p style="margin:8px 0 0">This page could not be found.</p></div></body></html>`,
    { status: 404, headers: { "content-type": "text/html; charset=utf-8" } }
  );
}

/**
 * Shared test helpers: fresh migrated temp databases and the deterministic
 * fake local engine (loopback-only OpenAI-compatible server).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

/** Fresh migrated temp database. Returns { url, dir, cleanup }. */
export function freshDb(prefix = "lester-test-") {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  const url = `file:${path.join(dir, "test.db")}?connection_limit=1`;
  execFileSync("bunx", ["prisma", "migrate", "deploy"], {
    cwd: path.join(import.meta.dir, ".."), // helpers.ts lives in tests/ — root is one level up
    env: { ...process.env, DATABASE_URL: url, PRISMA_HIDE_UPDATE_MESSAGE: "1" },
    stdio: "pipe",
    timeout: 60_000,
  });
  return {
    url,
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}


// ═══ Deterministic fake engine (merged from tests/helpers/fake-engine.ts) ══════
/**
 * Deterministic fake local engine — an OpenAI-compatible server (like
 * Ollama/LM Studio/llama.cpp/vLLM expose) used by tests and the smoke run.
 * No network beyond loopback; fully deterministic responses.
 */
export interface FakeEngine {
  port: number;
  url: string; // base url with /v1
  ollamaBase: string; // base url without /v1 (native API)
  server: ReturnType<typeof Bun.serve>;
  stop: () => void;
  requests: { path: string; body: unknown }[];
}

export function startFakeEngine(opts?: { port?: number; streamChunkCount?: number; streamDelayMs?: number }): FakeEngine {
  const port = opts?.port ?? 0;
  const requests: { path: string; body: unknown }[] = [];
  const server = Bun.serve({
    port,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      // read the body exactly ONCE (a request body is single-use)
      const rawBody = req.method === "POST" ? await req.json().catch(() => ({})) : null;
      requests.push({ path: url.pathname, body: rawBody });

      if (req.method === "GET" && url.pathname === "/v1/models") {
        return Response.json({
          object: "list",
          data: [
            { id: "fake-mini", object: "model", created: 1, owned_by: "lester-test" },
            { id: "fake-tiny", object: "model", created: 1, owned_by: "lester-test" },
          ],
        });
      }

      if (req.method === "GET" && url.pathname === "/api/tags") {
        return Response.json({
          models: [
            { name: "fake-mini:latest", size: 12345 },
            { name: "fake-tiny:latest", size: 6789 },
          ],
        });
      }

      if (req.method === "POST" && url.pathname === "/api/pull") {
        return Response.json({ status: "success" });
      }

      if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
        const body = (rawBody ?? {}) as {
          model?: string;
          messages?: { role: string; content: string }[];
          stream?: boolean;
        };
        const lastUser = [...(body.messages ?? [])].reverse().find((mm) => mm.role === "user");
        const prompt = lastUser?.content ?? "";
        const reply = `FAKE[${body.model ?? "?"}]: ${prompt.replace(/\s+/g, " ").slice(0, 80)} — deterministic answer 42.`;
        const usage = { prompt_tokens: Math.max(1, Math.ceil(prompt.length / 4)), completion_tokens: Math.ceil(reply.length / 4) };

        if (!body.stream) {
          return Response.json({
            id: "chatcmpl-fake",
            object: "chat.completion",
            created: 1,
            model: body.model ?? "fake",
            choices: [{ index: 0, message: { role: "assistant", content: reply }, finish_reason: "stop" }],
            usage,
          });
        }

        const chunks = reply.match(/.{1,8}/g) ?? [reply];
        const count = opts?.streamChunkCount ?? chunks.length;
        const delay = opts?.streamDelayMs ?? 5;
        const stream = new ReadableStream({
          async start(controller) {
            const enc = new TextEncoder();
            const send = (obj: unknown) => controller.enqueue(enc.encode(`data: ${JSON.stringify(obj)}\n\n`));
            for (let i = 0; i < count; i++) {
              if (delay > 0) await new Promise((r) => setTimeout(r, delay));
              send({
                id: "chatcmpl-fake",
                object: "chat.completion.chunk",
                created: 1,
                model: body.model ?? "fake",
                choices: [{ index: 0, delta: { content: chunks[i] ?? "…" }, finish_reason: null }],
              });
            }
            send({
              id: "chatcmpl-fake",
              object: "chat.completion.chunk",
              created: 1,
              model: body.model ?? "fake",
              choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
              usage,
            });
            controller.enqueue(enc.encode("data: [DONE]\n\n"));
            controller.close();
          },
        });
        return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
      }

      return new Response("not found", { status: 404 });
    },
  });

  const actualPort = server.port ?? 0;
  return {
    port: actualPort,
    url: `http://127.0.0.1:${actualPort}/v1`,
    ollamaBase: `http://127.0.0.1:${actualPort}`,
    server,
    stop: () => server.stop(true),
    requests,
  };
}

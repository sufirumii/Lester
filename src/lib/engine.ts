/**
 * Engine adapters & egress enforcement: OpenAI-compatible client for every runtime (Ollama/LM Studio/llama.cpp/vLLM/generic/cloud), DNS-resolved egress classification, auto-detection, routing, and the local model catalog/registry.
 *
 * Merged module (v1.0.2 repository consolidation — zero behavior change).
 * Sections:
 *   1. Types
 *   2. Guarded OpenAI-compatible client + egress classification
 *   3. Detection, routing, chat execution, engine status
 *   4. Model catalog, hardware fit, registry sync
 */

import { lookup } from "node:dns/promises";
import { db } from "@/lib/db";
import { aesDecrypt } from "@/lib/auth";
import { ENGINE_PRESETS, engineHint, extraEngineCandidates, getSettings, LESTER } from "@/lib/env";
import { ApiFail } from "@/lib/http";
import { HardwareProfile } from "@/lib/hardware";


// ═══ Types ═══════════════════════════════════════════════════════════════════════
// merged from src/lib/inference/types.ts

export interface ChatMsg {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
}

export interface StreamChunk {
  delta?: string;
  usage?: TokenUsage;
}

export interface ChatOnceResult {
  content: string;
  usage: TokenUsage;
  latencyMs: number;
}

/** Where a request will actually be executed. */
export interface EngineTarget {
  kind: "local" | "cloud";
  modelKey: string; // registry key
  modelId: string; // id the endpoint understands
  label: string; // human label for Proof
  baseUrl: string; // endpoint URL (host recorded for Proof)
  apiKey?: string;
  provider: string; // local-engine | cloud
  adapter?: string; // ollama | llamacpp | lmstudio | vllm | generic | cloud
}

export type EgressClass = "loopback" | "private" | "external";

export interface EgressInfo {
  host: string;
  ip: string;
  egress: EgressClass;
}

// ═══ Guarded OpenAI-compatible client + egress classification ════════════════════
// merged from src/lib/inference/openai-compat.ts

export class EngineUnreachableError extends Error {
  constructor(public endpoint: string, public cause: unknown) {
    super(`Engine unreachable at ${endpoint}. ${cause instanceof Error ? cause.message : String(cause)}`);
  }
}
export class EngineHttpError extends Error {
  constructor(public endpoint: string, public status: number, public bodySnippet: string) {
    super(`Engine at ${endpoint} returned HTTP ${status}: ${bodySnippet.slice(0, 300)}`);
  }
}
export class EgressBlockedError extends Error {
  constructor(public info: EgressInfo, public url: string) {
    super(
      `Refused to connect to ${info.host} (${info.ip}) — the destination is ${info.egress}, and this request is not allowed to leave the machine. No bytes were sent.`
    );
  }
}

// ─── IP classification (no dependencies; handles v4 and v6) ─────────────────

function parseIPv4(ip: string): number[] | null {
  const m = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return null;
  const oct = m.slice(1).map(Number);
  if (oct.some((n) => n > 255)) return null;
  return oct;
}

export function classifyIp(ip: string): EgressClass {
  const v4 = parseIPv4(ip);
  if (v4) {
    const [a, b] = v4;
    if (a === 127) return "loopback";
    if (a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31)) return "private";
    if (a === 169 && b === 254) return "private"; // link-local — treated as private, but engines there are refused below
    return "external";
  }
  const low = ip.toLowerCase();
  if (low === "::1" || low === "::") return "loopback";
  if (low.startsWith("fe80")) return "private"; // v6 link-local
  if (low.startsWith("fc") || low.startsWith("fd")) return "private"; // ULA
  if (low.startsWith("::ffff:")) return classifyIp(low.slice(7)); // v4-mapped
  return "external";
}

export function isLinkLocalOrMetadata(ip: string): boolean {
  const v4 = parseIPv4(ip);
  if (v4) {
    const [a, b] = v4;
    if (a === 169 && b === 254) return true; // link-local incl. cloud metadata 169.254.169.254
    return false;
  }
  return ip.toLowerCase().startsWith("fe80");
}

/** Resolve a URL's host and classify the destination. Called fresh, per request. */
export async function resolveUrlEgress(rawUrl: string): Promise<EgressInfo> {
  let host: string;
  try {
    host = new URL(rawUrl).hostname;
  } catch {
    return { host: rawUrl, ip: "unknown", egress: "external" };
  }
  if (host === "localhost") return { host, ip: "127.0.0.1", egress: "loopback" };
  const isV4 = parseIPv4(host) !== null;
  const isV6 = host.includes(":");
  if (isV4 || isV6) return { host, ip: host, egress: classifyIp(host) };
  try {
    const res = await lookup(host, { family: 0 });
    return { host, ip: res.address, egress: classifyIp(res.address) };
  } catch {
    // DNS failure → the request itself will fail; classify honestly as unknown/external
    return { host, ip: "unresolved", egress: "external" };
  }
}

// ─── Guarded fetch (the only network path to engines/providers) ──────────────

const ALLOW_METADATA = (process.env.LESTER_ALLOW_METADATA_ENDPOINTS ?? "").trim() === "true";

export interface GuardOptions {
  /** false → refuse any destination that resolves outside loopback/private space. */
  allowExternal: boolean;
  timeoutMs?: number;
}

export async function guardedFetch(url: string, init: RequestInit, guard: GuardOptions): Promise<Response> {
  const info = await resolveUrlEgress(url);
  if (isLinkLocalOrMetadata(info.ip) && !ALLOW_METADATA) {
    throw new EgressBlockedError({ ...info, egress: "private" }, url);
  }
  if (!guard.allowExternal && info.egress === "external") {
    throw new EgressBlockedError(info, url);
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), guard.timeoutMs ?? 120_000);
  const onOuterAbort = () => controller.abort();
  (init.signal as AbortSignal | undefined)?.addEventListener("abort", onOuterAbort, { once: true });
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new EngineHttpError(url, res.status, text);
    }
    return res;
  } catch (e) {
    if (e instanceof EngineHttpError) throw e;
    throw new EngineUnreachableError(url, e);
  } finally {
    clearTimeout(timeout);
    (init.signal as AbortSignal | undefined)?.removeEventListener("abort", onOuterAbort);
  }
}

// ─── SSE parsing ─────────────────────────────────────────────────────────────

async function* readSseResponse(res: Response, signal?: AbortSignal): AsyncGenerator<StreamChunk> {
  if (!res.body) throw new EngineHttpError(res.url, res.status ?? 0, "empty body");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const usage = { promptTokens: 0, completionTokens: 0 };
  let usageSeen = false;
  try {
    while (true) {
      if (signal?.aborted) {
        await reader.cancel().catch(() => undefined);
        return;
      }
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (payload === "[DONE]") continue;
        try {
          const evt = JSON.parse(payload);
          if (evt?.usage) {
            usage.promptTokens = evt.usage.prompt_tokens ?? usage.promptTokens;
            usage.completionTokens = evt.usage.completion_tokens ?? usage.completionTokens;
            usageSeen = true;
          }
          const delta: string | undefined = evt?.choices?.[0]?.delta?.content ?? evt?.choices?.[0]?.message?.content;
          if (typeof delta === "string" && delta.length > 0) yield { delta };
        } catch {
          // partial line
        }
      }
    }
  } finally {
    reader.releaseLock?.();
  }
  if (usageSeen || usage.promptTokens || usage.completionTokens) {
    yield { usage };
  }
}

export interface CompatConfig {
  baseUrl: string;
  model: string;
  apiKey?: string;
  timeoutMs?: number;
  allowExternal?: boolean; // default false — only CLOUD_FALLBACK policy paths pass true
}

async function postChat(
  cfg: CompatConfig,
  messages: ChatMsg[],
  stream: boolean,
  opts?: { maxTokens?: number; signal?: AbortSignal }
): Promise<Response> {
  return guardedFetch(
    `${cfg.baseUrl.replace(/\/$/, "")}/chat/completions`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: cfg.model,
        messages,
        stream,
        ...(opts?.maxTokens ? { max_tokens: opts.maxTokens } : {}),
      }),
      signal: opts?.signal,
    },
    { allowExternal: cfg.allowExternal ?? false, timeoutMs: cfg.timeoutMs }
  );
}

export async function* compatChatStream(
  cfg: CompatConfig,
  messages: ChatMsg[],
  opts?: { maxTokens?: number; signal?: AbortSignal }
): AsyncGenerator<StreamChunk> {
  const res = await postChat(cfg, messages, true, opts);
  for await (const chunk of readSseResponse(res, opts?.signal)) {
    yield chunk;
  }
}

export async function compatChatOnce(cfg: CompatConfig, messages: ChatMsg[], opts?: { maxTokens?: number }): Promise<ChatOnceResult> {
  const t0 = Date.now();
  const res = await postChat(cfg, messages, false, { maxTokens: opts?.maxTokens });
  const data = await res.json();
  return {
    content: data?.choices?.[0]?.message?.content ?? "",
    usage: {
      promptTokens: data?.usage?.prompt_tokens ?? 0,
      completionTokens: data?.usage?.completion_tokens ?? 0,
    },
    latencyMs: Date.now() - t0,
  };
}

/** Ping an OpenAI-compatible endpoint. Returns reachable + advertised models.
 *  `allowExternal` is true only for admin-configured cloud providers (an
 *  explicit external action); engine pings stay loopback/private-only and
 *  link-local/metadata addresses are always refused. */
export async function pingCompat(
  baseUrl: string,
  apiKey?: string,
  timeoutMs = 2500,
  allowExternal = false
): Promise<{ reachable: boolean; models: string[]; error?: string }> {
  try {
    const res = await guardedFetch(
      `${baseUrl.replace(/\/$/, "")}/models`,
      { headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {} },
      { allowExternal, timeoutMs }
    );
    const data = await res.json();
    const models: string[] = (data?.data ?? []).map((m: { id: string }) => m.id).filter(Boolean);
    return { reachable: true, models };
  } catch (e) {
    if (e instanceof EgressBlockedError) return { reachable: false, models: [], error: e.message };
    return { reachable: false, models: [], error: e instanceof Error ? e.message : String(e) };
  }
}

// ═══ Detection, routing, chat execution, engine status ═══════════════════════════
// merged from src/lib/inference/index.ts


// ─── Engine auto-detection (first-run friendliness, B2) ──────────────────────

export interface EngineCandidate {
  adapter: string; // ollama | llamacpp | lmstudio | vllm | generic
  label: string;
  url: string;
  reachable: boolean;
  models: string[];
  error?: string;
}

/** Probe a URL list and report which engines answer. Loopback/private only. */
export async function detectEngines(): Promise<EngineCandidate[]> {
  const hint = LESTER.engineHint;
  const urls: { adapter: string; label: string; url: string }[] = [];

  if (hint.url) {
    urls.push({ adapter: hint.preset?.id ?? "generic", label: hint.preset?.label ?? "Configured endpoint", url: hint.url });
  }
  const presetOrder: Array<keyof typeof ENGINE_PRESETS> = ["ollama", "lmstudio", "llamacpp", "vllm"];
  for (const id of presetOrder) {
    const preset = ENGINE_PRESETS[id];
    for (const url of preset.candidates) {
      if (!urls.some((u) => u.url === url)) urls.push({ adapter: preset.id, label: preset.label, url });
    }
  }
  for (const url of extraEngineCandidates()) {
    if (!urls.some((u) => u.url === url)) urls.push({ adapter: "generic", label: "Custom endpoint", url });
  }

  const results = await Promise.all(
    urls.map(async (u) => {
      const ping = await pingCompat(u.url, undefined, 1500);
      return { adapter: u.adapter, label: u.label, url: u.url, ...ping };
    })
  );
  return results;
}

// ─── Routing ─────────────────────────────────────────────────────────────────

export async function resolveTarget(modelKey: string): Promise<EngineTarget> {
  const settings = await getSettings();
  const entry = await db.modelEntry.findUnique({ where: { key: modelKey } });
  if (!entry) throw new ApiFail(400, "model_missing", `Model ${modelKey} is not in the registry.`);
  if (!entry.enabled) throw new ApiFail(400, "model_disabled", `Model ${entry.name} is disabled.`);
  if (!entry.installed) throw new ApiFail(400, "model_not_installed", `Model ${entry.name} is not installed.`);

  if (modelKey.startsWith("local:")) {
    if (settings.engine.type === "none" || !settings.engine.url) {
      throw new ApiFail(
        400,
        "engine_unavailable",
        "No local engine is configured yet. Open Settings → Engine to connect Ollama, LM Studio, llama.cpp or vLLM — or run the detection from the Models tab."
      );
    }
    const meta = JSON.parse(entry.meta || "{}") as { ollamaTag?: string };
    return {
      kind: "local",
      modelKey,
      modelId: meta.ollamaTag ?? entry.key.replace("local:", ""),
      label: entry.name,
      baseUrl: settings.engine.url,
      provider: "local-engine",
      adapter: settings.engine.adapter,
    };
  }

  // cloud:<providerId>:<modelId>
  const parts = modelKey.split(":");
  if (parts[0] === "cloud") {
    const providerId = parts[1] ?? "";
    const provider = settings.cloudProviders.find((p) => p.id === providerId);
    if (!provider || !provider.enabled) {
      throw new ApiFail(400, "provider_disabled", "Cloud provider is not configured or is disabled. Cloud fallback is OFF by default.");
    }
    return {
      kind: "cloud",
      modelKey,
      modelId: parts.slice(2).join(":") || "default",
      label: `${provider.label} · ${parts.slice(2).join(":")}`,
      baseUrl: provider.baseUrl,
      apiKey: provider.apiKeyEnc ? aesDecrypt(provider.apiKeyEnc) : undefined,
      provider: "cloud",
      adapter: "cloud",
    };
  }

  throw new ApiFail(400, "model_key_invalid", `Unrecognized model key ${modelKey}.`);
}

// ─── Chat execution ──────────────────────────────────────────────────────────

export async function* chatStream(
  target: EngineTarget,
  messages: ChatMsg[],
  opts?: { maxTokens?: number; signal?: AbortSignal; allowExternal?: boolean }
): AsyncGenerator<StreamChunk> {
  yield* compatChatStream(
    { baseUrl: target.baseUrl, model: target.modelId, apiKey: target.apiKey, allowExternal: opts?.allowExternal },
    messages,
    opts
  );
}

export async function chatOnce(
  target: EngineTarget,
  messages: ChatMsg[],
  opts?: { maxTokens?: number; allowExternal?: boolean }
): Promise<ChatOnceResult> {
  return compatChatOnce(
    { baseUrl: target.baseUrl, model: target.modelId, apiKey: target.apiKey, allowExternal: opts?.allowExternal },
    messages,
    opts
  );
}

// ─── Engine status ───────────────────────────────────────────────────────────

export type ConfiguredEngineType = "none" | "openai-compat";

export interface EngineStatus {
  type: ConfiguredEngineType;
  adapter: string; // ollama | llamacpp | lmstudio | vllm | generic | none
  label: string;
  url: string;
  reachable: boolean;
  models: string[];
  error?: string;
}

export async function engineStatus(): Promise<EngineStatus> {
  const settings = await getSettings();
  if (settings.engine.type === "none" || !settings.engine.url) {
    return {
      type: "none",
      adapter: "none",
      label: "No engine",
      url: "—",
      reachable: false,
      models: [],
      error: "No local engine configured. Settings → Engine, or the Models tab, can detect one.",
    };
  }
  const ping = await pingCompat(settings.engine.url, undefined, 3000);
  return {
    type: "openai-compat",
    adapter: settings.engine.adapter,
    label: settings.engine.label || "Local engine",
    url: settings.engine.url,
    reachable: ping.reachable,
    models: ping.models,
    error: ping.error,
  };
}

// ═══ Model catalog, hardware fit, registry sync ══════════════════════════════════
// merged from src/lib/catalog.ts

export interface CatalogModel {
  key: string; // local:<ollama-tag>
  name: string;
  family: string;
  paramsB: number;
  quant: string;
  sizeMb: number; // download size (approx, from the public model library)
  ramReqMb: number; // size + KV cache + runtime overhead
  ollamaTag: string;
  note: string;
}

/**
 * Real small-model catalog (Ollama library tags, Q4_K_M quants).
 * Sizes are the published download sizes; RAM needs include context/KV overhead.
 */
export const LOCAL_MODEL_CATALOG: CatalogModel[] = [
  { key: "local:qwen2.5:0.5b", name: "Qwen 2.5 · 0.5B", family: "Qwen 2.5", paramsB: 0.5, quant: "Q4_K_M", sizeMb: 400, ramReqMb: 1300, ollamaTag: "qwen2.5:0.5b-instruct-q4_K_M", note: "Fastest tier — drafting, classification, extraction." },
  { key: "local:llama3.2:1b", name: "Llama 3.2 · 1B", family: "Llama 3.2", paramsB: 1.2, quant: "Q4_K_M", sizeMb: 810, ramReqMb: 1900, ollamaTag: "llama3.2:1b-instruct-q4_K_M", note: "Balanced tiny model for short-form assistance." },
  { key: "local:qwen2.5:1.5b", name: "Qwen 2.5 · 1.5B", family: "Qwen 2.5", paramsB: 1.5, quant: "Q4_K_M", sizeMb: 1000, ramReqMb: 2200, ollamaTag: "qwen2.5:1.5b-instruct-q4_K_M", note: "Strong small generalist; good multilingual coverage." },
  { key: "local:gemma2:2b", name: "Gemma 2 · 2B", family: "Gemma 2", paramsB: 2.6, quant: "Q4_K_M", sizeMb: 1600, ramReqMb: 3100, ollamaTag: "gemma2:2b-instruct-q4_K_M", note: "Google's compact instruct model." },
  { key: "local:qwen2.5:3b", name: "Qwen 2.5 · 3B", family: "Qwen 2.5", paramsB: 3.1, quant: "Q4_K_M", sizeMb: 1900, ramReqMb: 3600, ollamaTag: "qwen2.5:3b-instruct-q4_K_M", note: "Best quality/size ratio for serious local workloads." },
  { key: "local:llama3.2:3b", name: "Llama 3.2 · 3B", family: "Llama 3.2", paramsB: 3.2, quant: "Q4_K_M", sizeMb: 2000, ramReqMb: 3800, ollamaTag: "llama3.2:3b-instruct-q4_K_M", note: "Solid reasoning for the size; long-context capable." },
  { key: "local:phi3.5:3.8b", name: "Phi 3.5 · 3.8B", family: "Phi 3.5", paramsB: 3.8, quant: "Q4_K_M", sizeMb: 2200, ramReqMb: 4100, ollamaTag: "phi3.5:3.8b-mini-instruct-q4_K_M", note: "Punchy reasoner; strong on structured tasks." },
];

// ─── Hardware fit ────────────────────────────────────────────────────────────

export type FitLevel = "fit" | "tight" | "no";

export interface FitAssessment {
  level: FitLevel;
  label: string;
  reason: string;
}

export function assessFit(ramReqMb: number, hw: HardwareProfile): FitAssessment {
  const freeHeadroom = hw.ram.freeMb * 0.8; // leave headroom for the OS + app
  if (ramReqMb <= freeHeadroom) {
    return { level: "fit", label: "Fits", reason: `Needs ≈${(ramReqMb / 1024).toFixed(1)} GB RAM with context; ${Math.round(hw.ram.freeMb / 1024)} GB currently free.` };
  }
  if (ramReqMb <= hw.ram.totalMb * 0.85) {
    return { level: "tight", label: "Tight", reason: `Needs ≈${(ramReqMb / 1024).toFixed(1)} GB RAM; close other workloads first (${Math.round(hw.ram.freeMb / 1024)} GB free of ${Math.round(hw.ram.totalMb / 1024)} GB).` };
  }
  return { level: "no", label: "Won't fit", reason: `Needs ≈${(ramReqMb / 1024).toFixed(1)} GB RAM; this machine has ${Math.round(hw.ram.totalMb / 1024)} GB total.` };
}

export function recommendModels(hw: HardwareProfile): { catalogModel: CatalogModel; fit: FitAssessment }[] {
  const scored = LOCAL_MODEL_CATALOG.map((m) => ({ catalogModel: m, fit: assessFit(m.ramReqMb, hw) }));
  const order: Record<FitLevel, number> = { fit: 0, tight: 1, no: 2 };
  return scored.sort((a, b) => order[a.fit.level] - order[b.fit.level] || b.catalogModel.paramsB - a.catalogModel.paramsB);
}

// ─── DB sync of the model registry ───────────────────────────────────────────

/** Register models the engine already serves (used on engine connect/setup). */
export async function registerEngineModels(
  engineUrl: string,
  modelIds: string[],
  actor?: { id: string; username: string }
): Promise<number> {
  let added = 0;
  for (const modelId of modelIds) {
    const key = `local:${modelId}`;
    const existing = await db.modelEntry.findUnique({ where: { key } });
    if (!existing) {
      await db.modelEntry.create({
        data: {
          key,
          name: modelId,
          family: modelId.split(":")[0],
          provider: "LOCAL_ENGINE",
          endpoint: engineUrl,
          installed: true,
          approved: true,
          enabled: true,
          installedAt: new Date(),
          meta: JSON.stringify({ engineModel: modelId, note: "Discovered from the local engine." }),
        },
      });
      added++;
    } else if (!existing.installed) {
      await db.modelEntry.update({ where: { key }, data: { installed: true, installedAt: new Date(), endpoint: engineUrl } });
      added++;
    }
  }
  if (added > 0 && actor) {
    const { appendProof } = await import("./proof");
    await appendProof({
      userId: actor.id,
      username: actor.username,
      action: "model.sync",
      status: "ok",
      provider: "local-engine",
      detail: { engine: engineUrl, models: added },
    });
  }
  return added;
}

/** Remove v1.0.0 "builtin:" rows and any stale BUILTIN provider entries. */
export async function purgeBuiltinModels(): Promise<number> {
  const stale = await db.modelEntry.findMany({ where: { OR: [{ key: { startsWith: "builtin:" } }, { provider: "BUILTIN" }] } });
  for (const m of stale) {
    await db.modelEntry.delete({ where: { id: m.id } }).catch(() => undefined);
  }
  return stale.length;
}

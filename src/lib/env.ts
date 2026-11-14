/**
 * Lester runtime configuration: env resolution, engine presets, and the settings store.
 *
 * Merged module (v1.0.2 repository consolidation — zero behavior change).
 * Sections:
 *   1. Env & engine presets
 *   2. Settings store (DB-backed)
 */

import { default as path } from "node:path";
import { db } from "./db";


// ═══ Env & engine presets ════════════════════════════════════════════════════════
// merged from src/lib/env.ts

export type EngineKind = "auto" | "ollama" | "llamacpp" | "lmstudio" | "vllm" | "openai-compat" | "none";

export function resolveDataDir(): string {
  const fromEnv = process.env.LESTER_DATA_DIR;
  if (fromEnv) return fromEnv;
  // static string form keeps turbopack tracing scoped
  return /*turbopackIgnore: true*/ path.join(process.cwd(), "db");
}

/** Bind address. Default loopback-only; 0.0.0.0 must be an explicit choice. */
export function resolveBind(): string {
  const raw = (process.env.LESTER_BIND ?? "").trim();
  if (raw) return raw;
  return "127.0.0.1";
}

/** One port variable, everywhere. */
export function resolvePort(): number {
  const raw = (process.env.LESTER_PORT ?? "").trim();
  const n = parseInt(raw, 10);
  if (raw && Number.isFinite(n) && n > 0 && n < 65536) return n;
  return 8090;
}

/**
 * Local engine presets. Every adapter speaks the OpenAI-compatible HTTP API;
 * the preset only supplies the default port, URL path and a friendly label.
 * Ollama additionally offers its native /api endpoints for model installs.
 */
export interface EnginePreset {
  id: "ollama" | "llamacpp" | "lmstudio" | "vllm" | "generic";
  label: string;
  /** default base URLs probed in order during auto-detection */
  candidates: string[];
  note: string;
}

const LOOPBACK = "http://127.0.0.1";

export const ENGINE_PRESETS: Record<"ollama" | "llamacpp" | "lmstudio" | "vllm" | "generic", EnginePreset> = {
  ollama: {
    id: "ollama",
    label: "Ollama",
    candidates: [
      `${LOOPBACK}:11434/v1`,
      // Docker: sidecar service name, then host Ollama (extra_hosts maps it on Linux)
      "http://ollama:11434/v1",
      "http://host.docker.internal:11434/v1",
    ],
    note: "https://ollama.com — after installing, `ollama pull qwen2.5:1.5b-instruct-q4_K_M` gives you a first model.",
  },
  llamacpp: {
    id: "llamacpp",
    label: "llama.cpp llama-server",
    candidates: [`${LOOPBACK}:8080/v1`, `${LOOPBACK}:8081/v1`],
    note: "https://github.com/ggml-org/llama.cpp — run `llama-server -m model.gguf --port 8080`.",
  },
  lmstudio: {
    id: "lmstudio",
    label: "LM Studio",
    candidates: [`${LOOPBACK}:1234/v1`],
    note: "https://lmstudio.ai — start the local server (Developer tab), default port 1234.",
  },
  vllm: {
    id: "vllm",
    label: "vLLM",
    candidates: [`${LOOPBACK}:8000/v1`],
    note: "https://docs.vllm.ai — `vllm serve <model>`; the OpenAI server defaults to port 8000.",
  },
  generic: {
    id: "generic",
    label: "OpenAI-compatible endpoint",
    candidates: [],
    note: "Any server that implements POST /v1/chat/completions and GET /v1/models.",
  },
};

export function parseEngineEnv(): EngineKind {
  const raw = (process.env.LESTER_ENGINE ?? "auto").trim().toLowerCase();
  const valid: EngineKind[] = ["auto", "ollama", "llamacpp", "lmstudio", "vllm", "openai-compat", "none"];
  return (valid as string[]).includes(raw) ? (raw as EngineKind) : "auto";
}

/** Boot-time engine hint: which preset (if any) + optional explicit URL. */
export function engineHint(): { kind: EngineKind; preset: EnginePreset | null; url: string | null } {
  const kind = parseEngineEnv();
  const url = (process.env.LESTER_ENGINE_URL ?? "").trim() || null;
  if (kind === "none") return { kind, preset: null, url: null };
  if (kind === "auto") return { kind, preset: null, url };
  if (kind === "openai-compat") return { kind, preset: ENGINE_PRESETS.generic, url };
  return { kind, preset: ENGINE_PRESETS[kind], url };
}

/** Extra detection URLs (comma-separated) for non-standard setups. */
export function extraEngineCandidates(): string[] {
  return (process.env.LESTER_ENGINE_CANDIDATES ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export const LESTER = {
  version: "1.0.1",
  dataDir: resolveDataDir(),
  keysDir: path.join(resolveDataDir(), "keys"),
  backupsDir: path.join(process.env.LESTER_BACKUP_DIR?.trim() || path.join(resolveDataDir(), "backups")),
  bind: resolveBind(),
  port: resolvePort(),
  engineHint: engineHint(),
  sessionCookie: "lester_session",
  /** Trusted reverse proxy (sets X-Forwarded-*) — required for the Secure cookie
   *  flag to be set correctly behind TLS termination. */
  trustProxy: (process.env.LESTER_TRUST_PROXY ?? "").trim() === "true",
  /** Prompt-content audit logging is opt-in only, default off everywhere. */
  telemetry: "disabled — Lester never transmits telemetry",
} as const;

export function dataPaths() {
  return {
    db: process.env.DATABASE_URL ?? "",
    dataDir: LESTER.dataDir,
    keys: LESTER.keysDir,
    backups: LESTER.backupsDir,
  };
}

// ═══ Settings store (DB-backed) ══════════════════════════════════════════════════
// merged from src/lib/settings.ts

export type EngineType = "none" | "openai-compat";
export type EngineAdapter = "ollama" | "llamacpp" | "lmstudio" | "vllm" | "generic";

export interface CloudProvider {
  id: string;
  label: string;
  baseUrl: string;
  apiKeyEnc: string; // AES-256-GCM at rest
  enabled: boolean;
  defaultModel: string; // model used for cloud fallback
}

export interface LesterSettings {
  engine: { type: EngineType; url: string; label: string; adapter: EngineAdapter };
  cloudProviders: CloudProvider[];
  network: { bindAddress: string; note: string };
  contentLogging: boolean;
  encryptAtRest: boolean;
  backup: { enabled: boolean; hour: number; keep: number };
  sessionTtlHours: number;
}

// ─── Defaults (secure by default: no cloud, loopback bind, no content logs) ──

export function defaultSettings(): LesterSettings {
  return {
    engine: {
      type: LESTER.engineHint.kind === "none" ? "none" : LESTER.engineHint.url ? "openai-compat" : "none",
      url: LESTER.engineHint.url ?? "",
      label: LESTER.engineHint.preset?.label ?? "Local engine",
      adapter: LESTER.engineHint.preset?.id ?? "generic",
    },
    cloudProviders: [],
    network: {
      bindAddress: LESTER.bind,
      note: `Lester binds to ${LESTER.bind} (loopback-only by default). To expose it to the LAN, set LESTER_BIND=0.0.0.0 in the environment and restart — this is a deliberate operator action, never a Console toggle. Put TLS in front before you do.`,
    },
    contentLogging: false,
    encryptAtRest: false,
    backup: { enabled: true, hour: 3, keep: 14 },
    sessionTtlHours: 72,
  };
}

// ─── Storage ─────────────────────────────────────────────────────────────────

const KEY = "settings";

export async function getSettings(): Promise<LesterSettings> {
  const row = await db.setting.findUnique({ where: { key: KEY } });
  const defaults = defaultSettings();
  if (!row) return defaults;
  try {
    const stored = JSON.parse(row.value) as Partial<LesterSettings>;
    const merged: LesterSettings = {
      ...defaults,
      ...stored,
      engine: { ...defaults.engine, ...stored.engine },
      network: { ...defaults.network, ...stored.network },
      backup: { ...defaults.backup, ...stored.backup },
    };
    // v1.0.0 compatibility: engine.type "builtin" no longer exists.
    if ((merged.engine as { type?: string }).type === "builtin") {
      merged.engine = { ...defaults.engine };
    }
    // The bind address is env-truth, not a stored value.
    merged.network.bindAddress = LESTER.bind;
    return merged;
  } catch {
    return defaults;
  }
}

export async function saveSettings(patch: Partial<LesterSettings>): Promise<LesterSettings> {
  const current = await getSettings();
  const next: LesterSettings = {
    ...current,
    ...patch,
    engine: { ...current.engine, ...(patch.engine ?? {}) },
    network: { ...current.network, ...(patch.network ?? {}), bindAddress: LESTER.bind },
    backup: { ...current.backup, ...(patch.backup ?? {}) },
    cloudProviders: patch.cloudProviders ?? current.cloudProviders,
  };
  await db.setting.upsert({
    where: { key: KEY },
    update: { value: JSON.stringify(next) },
    create: { key: KEY, value: JSON.stringify(next) },
  });
  return next;
}

"use client";

/**
 * Browser-side Lester client: typed API helpers (fetch + SSE) and the console state store.
 *
 * Merged module (v1.0.2 repository consolidation — zero behavior change).
 * Sections:
 *   1. Typed API client
 *   2. Console state store
 */

import { create } from "zustand";


// ═══ Typed API client ════════════════════════════════════════════════════════════
// merged from src/lib/client/api.ts

export interface SessionUser {
  id: string;
  username: string;
  displayName: string;
  role: "ADMIN" | "MEMBER" | "AUDITOR";
}

export interface HardwareProfile {
  os: string;
  arch: string;
  cpu: { model: string; cores: number; speedMhz: number };
  ram: { totalMb: number; freeMb: number; usedPct: number };
  disk: { totalGb: number; freeGb: number; usedPct: number; path: string };
  gpus: { name: string; vramMb: number | null }[];
  npuDetected: boolean;
  scannedAt: string;
}

export type EngineAdapter = "ollama" | "llamacpp" | "lmstudio" | "vllm" | "generic" | "none";

export interface EngineStatus {
  type: "none" | "openai-compat";
  adapter: EngineAdapter;
  label: string;
  url: string;
  reachable: boolean;
  models: string[];
  error?: string;
}

export interface EngineCandidate {
  adapter: string;
  label: string;
  url: string;
  reachable: boolean;
  models: string[];
  error?: string;
}

export interface FitAssessment {
  level: "fit" | "tight" | "no";
  label: string;
  reason: string;
}

export interface CatalogModel {
  key: string;
  name: string;
  family: string;
  paramsB: number;
  quant: string;
  sizeMb: number;
  ramReqMb: number;
  ollamaTag: string;
  note: string;
  installed?: boolean;
  fit?: FitAssessment;
}

export interface InstalledModel {
  key: string;
  name: string;
  family: string;
  paramsB: number;
  quant: string;
  sizeMb: number;
  ramReqMb: number;
  provider: "LOCAL_ENGINE" | "CLOUD";
  installed: boolean;
  approved: boolean;
  enabled: boolean;
  meta: Record<string, unknown>;
  fit: FitAssessment | null;
}

export interface ModelsResponse {
  installed: InstalledModel[];
  catalog: CatalogModel[];
  engine: EngineStatus;
  cloudProviders: { id: string; label: string; baseUrl: string; enabled: boolean; hasKey: boolean; defaultModel: string }[];
}

export interface WorkspaceInfo {
  id: string;
  name: string;
  description: string;
  defaultModel: string | null;
  createdAt: string;
  documents: number;
  conversations: number;
  policyMode: string;
}

export interface PolicyRules {
  mode: "LOCAL_ONLY" | "CLOUD_FALLBACK" | "BLOCK_ALL";
  redactPii: boolean;
  blockKeywords: string;
  allowedModels: string;
  maxTokens: number;
}

export interface PolicyDecision {
  decision: "allow" | "block";
  reason: string;
  redactedText: string;
  findings: { type: string; count: number }[];
  redactionCount: number;
  redacted: boolean;
}

export interface ProofEntry {
  seq: number;
  ts: string;
  username: string | null;
  workspaceName: string | null;
  action: string;
  status: "ok" | "blocked" | "redacted" | "error";
  modelKey: string | null;
  provider: string | null;
  providerLabel: string | null;
  endpointHost: string | null;
  endpointIp: string | null;
  egress: "loopback" | "private" | "external" | "none" | null;
  latencyMs: number | null;
  tokensIn: number | null;
  tokensOut: number | null;
  redactions: number | null;
  detail: Record<string, unknown>;
  prevHash: string | null;
  selfHash: string | null;
}

export interface ChainVerification {
  valid: boolean;
  checked: number;
  headHash: string | null;
  firstBrokenSeq: number | null;
  brokenReason: string | null;
}

export interface ProofListResponse {
  entries: ProofEntry[];
  total: number;
  page: number;
  pageSize: number;
  chain: ChainVerification;
  checkpoints?: { id: string; seq: number; headHash: string; ts: string; keyId: string; signature: string }[];
  scope?: "own" | "all";
}

export interface ConversationInfo {
  id: string;
  title: string;
  modelKey: string;
  updatedAt: string;
  messageCount: number;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  modelKey: string | null;
  provider: string | null;
  latencyMs: number | null;
  tokensIn: number | null;
  tokensOut: number | null;
  redactions: number;
  blocked: boolean;
  citations: { docName: string; snippet: string; score: number }[] | null;
  createdAt: string;
}

export interface DocumentInfo {
  id: string;
  name: string;
  mime: string;
  sizeBytes: number;
  chunkCount: number;
  sha256: string;
  createdAt: string;
}

export interface HealthData {
  version: string;
  startedAt: string;
  uptimeHours: number;
  durability: { journal: string; synchronous: string };
  chain: ChainVerification;
  engine: EngineStatus;
  hardware: HardwareProfile;
  storage: { dbBytes: number; walBytes: number; dbPath: string };
  counts: { conversations: number; messages: number; documents: number; proofs: number; users: number; models: number };
  throughput: { tokensPerSec: number; avgLatencyMs: number; sampledTurns: number };
  backups: BackupInfo[];
  backupScheduler: { schedulerRunning: boolean; lastAuto: string | null };
  process: { rssMb: number; node: string };
}

export interface BackupInfo {
  id: string;
  path: string;
  fileName: string;
  sizeBytes: number;
  sha256: string;
  kind: "manual" | "auto" | "pre-restore" | "pre-upgrade";
  entries: number;
  createdAt: string;
}

export interface LicenseInfo {
  tier: "free" | "team";
  customer: string;
  users: number;
  workspaces: number;
  nodeId: string;
  expiresAt: string | null;
  valid: boolean;
}

export interface ApiTokenInfo {
  id: string;
  name: string;
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
}

export interface SessionInfo {
  id: string;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
}

export interface UserInfo {
  id: string;
  username: string;
  displayName: string;
  role: "ADMIN" | "MEMBER" | "AUDITOR";
  disabled: boolean;
  activeTokens: number;
  createdAt: string;
}

export interface SetupStatus {
  setupComplete: boolean;
  hardware: HardwareProfile;
  engine: EngineStatus;
  license: LicenseInfo;
  detection: EngineCandidate[];
  adapterGuide: { id: string; label: string; note: string }[];
  recommendations: { catalogModel: CatalogModel; fit: FitAssessment }[];
  version: string;
}

export interface LesterSettingsDto {
  engine: { type: "none" | "openai-compat"; url: string; label: string; adapter: EngineAdapter };
  cloudProviders: { id: string; label: string; baseUrl: string; enabled: boolean; hasKey: boolean; defaultModel: string }[];
  network: { bindAddress: string; note: string };
  contentLogging: boolean;
  encryptAtRest: boolean;
  backup: { enabled: boolean; hour: number; keep: number };
  sessionTtlHours: number;
}

export interface FitRunInfo {
  id: string;
  status: "queued" | "running" | "done" | "error" | "cancelled";
  progress: number;
  total: number;
  prompts: string[];
  candidates: string[];
  config: {
    requestsPerMonth: number;
    pricePerMillionIn: number;
    pricePerMillionOut: number;
    hardwareMonthlyCost: number;
    judge: boolean;
  };
  results: {
    modelKey: string;
    label: string;
    provider: string;
    egress: string;
    ok: number;
    failed: number;
    avgLatencyMs: number;
    p95LatencyMs: number;
    tokensPerSec: number;
    avgTokensIn: number;
    avgTokensOut: number;
    avgQuality: number | null;
    successRate: number;
  }[];
  samples: {
    promptIdx: number;
    modelKey: string;
    ok: boolean;
    latencyMs: number;
    tokensIn: number;
    tokensOut: number;
    chars: number;
    quality: number | null;
    error?: string;
  }[];
  summary: {
    measured: {
      prompts: number;
      avgTokensIn: number;
      avgTokensOut: number;
      avgLatencyMs: number;
      tokensPerSec: number;
      avgQuality: number | null;
      successRate: number;
    };
    assumptions: {
      requestsPerMonth: number;
      pricePerMillionIn: number;
      pricePerMillionOut: number;
      hardwareMonthlyCost: number;
      judge: boolean;
    };
    monthlyCloudCost: number;
    monthlyLocalCost: number;
    monthlySaved: number;
    verdict: string;
  } | null;
  error: string | null;
  createdAt: string;
}

// ─── Fetch helpers ──────────────────────────────────────────────────────────

export class ApiError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function handle<T>(res: Response): Promise<T> {
  if (res.ok) {
    const ct = res.headers.get("content-type") ?? "";
    if (ct.includes("application/json")) return (await res.json()) as T;
    return {} as T;
  }
  let code = `http_${res.status}`;
  let message = `Request failed (${res.status})`;
  try {
    const body = await res.json();
    if (body?.error) {
      code = body.error.code ?? code;
      message = body.error.message ?? message;
    }
  } catch {
    /* ignore */
  }
  throw new ApiError(res.status, code, message);
}

export async function apiGet<T>(path: string): Promise<T> {
  return handle<T>(await fetch(path, { cache: "no-store", credentials: "same-origin" }));
}

export async function apiSend<T>(method: string, path: string, body?: unknown): Promise<T> {
  return handle<T>(
    await fetch(path, {
      method,
      credentials: "same-origin",
      headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
  );
}

export const apiPost = <T>(path: string, body?: unknown) => apiSend<T>("POST", path, body);
export const apiPut = <T>(path: string, body?: unknown) => apiSend<T>("PUT", path, body);
export const apiPatch = <T>(path: string, body?: unknown) => apiSend<T>("PATCH", path, body);
export const apiDelete = <T>(path: string) => apiSend<T>("DELETE", path);

/** Stream SSE `data:` events from a POST request. */
export async function ssePost(
  path: string,
  body: unknown,
  onEvent: (ev: Record<string, unknown>) => void,
  signal?: AbortSignal
): Promise<void> {
  const res = await fetch(path, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok || !res.body) {
    let message = `Request failed (${res.status})`;
    try {
      const errBody = await res.json();
      if (errBody?.error?.message) message = errBody.error.message;
    } catch {
      /* ignore */
    }
    throw new ApiError(res.status, "http_error", message);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf("\n\n")) >= 0) {
      const raw = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      for (const line of raw.split("\n")) {
        if (!line.startsWith("data:")) continue;
        try {
          onEvent(JSON.parse(line.slice(5).trim()));
        } catch {
          /* skip malformed */
        }
      }
    }
  }
}

// ═══ Console state store ═════════════════════════════════════════════════════════
// merged from src/lib/client/store.ts

export type Screen =
  | "chat"
  | "knowledge"
  | "models"
  | "fit"
  | "policy"
  | "proof"
  | "users"
  | "health"
  | "settings";

interface LesterState {
  user: SessionUser | null;
  workspaces: WorkspaceInfo[];
  workspaceId: string | null;
  engine: EngineStatus | null;
  screen: Screen;
  version: string;
  setUser: (u: SessionUser | null) => void;
  setWorkspaces: (w: WorkspaceInfo[]) => void;
  setWorkspaceId: (id: string | null) => void;
  setEngine: (e: EngineStatus | null) => void;
  setScreen: (s: Screen) => void;
  setVersion: (v: string) => void;
}

export const useLester = create<LesterState>((set) => ({
  user: null,
  workspaces: [],
  workspaceId: null,
  engine: null,
  screen: "chat",
  version: "",
  setUser: (user) => set({ user }),
  setWorkspaces: (workspaces) =>
    set((s) => ({
      workspaces,
      workspaceId:
        s.workspaceId && workspaces.some((w) => w.id === s.workspaceId)
          ? s.workspaceId
          : workspaces[0]?.id ?? null,
    })),
  setWorkspaceId: (workspaceId) => set({ workspaceId }),
  setEngine: (engine) => set({ engine }),
  setScreen: (screen) => set({ screen }),
  setVersion: (version) => set({ version }),
}));

export const SCREEN_META: Record<Screen, { label: string; desc: string }> = {
  chat: { label: "Chat", desc: "Talk to your approved local models" },
  knowledge: { label: "Knowledge", desc: "Documents indexed on this device" },
  models: { label: "Models", desc: "Registry, hardware fit, approvals" },
  fit: { label: "Fit", desc: "Evaluate local models on your own prompts" },
  policy: { label: "Policy", desc: "Routing and redaction rules" },
  proof: { label: "Proof", desc: "The data-stayed-local ledger" },
  users: { label: "Users", desc: "Accounts and roles" },
  health: { label: "Health", desc: "Live vitals of this node" },
  settings: { label: "Settings", desc: "Engine, backups, network, license" },
};

"use client";

/**
 * Governance screens: workspace Policy rules and the Knowledge base.
 *
 * Merged module (v1.0.2 repository consolidation — zero behavior change).
 * Sections:
 *   1. Policy screen
 *   2. Knowledge screen
 */

import { type ChangeEvent, type DragEvent, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { apiDelete, apiGet, apiPost, apiPut, type DocumentInfo, type PolicyDecision, type PolicyRules, useLester } from "@/lib/client";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, Badge, Button, Input, Label, Skeleton, Switch, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, Textarea, Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui";
import { toast } from "sonner";
import { Ban, Check, Cloud, Database, FileText, Laptop, Loader2, Lock, Play, Save, Scale, Search, SearchCheck, ShieldAlert, ShieldCheck, ShieldQuestion, Trash2, Upload } from "lucide-react";


// ═══ Policy screen ═══════════════════════════════════════════════════════════════
// merged from src/components/console/PolicyScreen.tsx

const DEFAULT_POLICY: PolicyRules = {
  mode: "LOCAL_ONLY",
  redactPii: true,
  blockKeywords: "",
  allowedModels: "",
  maxTokens: 4096,
};

const MODES: { value: PolicyRules["mode"]; title: string; desc: string; icon: typeof Laptop }[] = [
  {
    value: "LOCAL_ONLY",
    title: "Local only",
    desc: "Requests run on this machine's engine. Nothing is ever sent to a cloud API. Cloud models are refused even if someone selects one.",
    icon: Laptop,
  },
  {
    value: "CLOUD_FALLBACK",
    title: "Local first, cloud fallback",
    desc: "Requests try the local engine first. If the local engine fails, a configured cloud provider may take over — and the Proof ledger records every byte that left.",
    icon: Cloud,
  },
  {
    value: "BLOCK_ALL",
    title: "Blocked",
    desc: "All model requests in this workspace are refused. Useful for freeze, investigation, or audit windows.",
    icon: Ban,
  },
];

const REDACTED_TOKEN_RE = /\[[^\]\n]*REDACTED[^\]\n]*\]/i;

/** Wrap `[... REDACTED]` tokens in amber <mark>-styled spans so masks stand out. */
function withRedactionHighlights(text: string): ReactNode[] {
  return text.split(/(\[[^\]\n]*REDACTED[^\]\n]*\])/i).map((part, i) =>
    REDACTED_TOKEN_RE.test(part) ? (
      <mark
        key={i}
        className="rounded-sm bg-amber-400/25 px-0.5 font-mono text-[11px] font-medium text-amber-800 dark:text-amber-300"
      >
        {part}
      </mark>
    ) : (
      <span key={i}>{part}</span>
    )
  );
}

interface RouterResult {
  decision: PolicyDecision;
  modelKey: string;
}

export function PolicyScreen() {
  const { user, workspaceId } = useLester();
  const isAdmin = user?.role === "ADMIN";

  const [policy, setPolicy] = useState<PolicyRules | null>(null);
  const [draft, setDraft] = useState<PolicyRules>(DEFAULT_POLICY);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const [text, setText] = useState("");
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<RouterResult | null>(null);

  useEffect(() => {
    if (!workspaceId) return;
    let cancelled = false;
    setLoading(true);
    setResult(null);
    apiGet<{ policy: PolicyRules }>(`/api/policy?workspaceId=${workspaceId}`)
      .then((r) => {
        if (cancelled) return;
        setPolicy(r.policy);
        setDraft(r.policy);
      })
      .catch(() => {
        if (!cancelled) toast.error("Could not load this workspace's policy.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  const dirty = useMemo(
    () => policy !== null && JSON.stringify(draft) !== JSON.stringify(policy),
    [draft, policy]
  );

  async function save() {
    if (!workspaceId || !dirty || saving) return;
    setSaving(true);
    try {
      await apiPut<{ ok: boolean }>("/api/policy", { workspaceId, policy: draft });
      setPolicy(draft);
      toast.success("Policy saved — recorded in the Proof ledger.");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Save failed.");
    } finally {
      setSaving(false);
    }
  }

  async function run() {
    if (!workspaceId || !text.trim() || testing) return;
    setTesting(true);
    setResult(null);
    try {
      const r = await apiPost<{ decision: PolicyDecision; modelKey: string }>("/api/policy", {
        workspaceId,
        text,
      });
      setResult(r);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Evaluation failed.");
    } finally {
      setTesting(false);
    }
  }

  if (!workspaceId) {
    return (
      <div className="h-full flex items-center justify-center p-6 overflow-y-auto scrollbar-thin">
        <div className="text-center space-y-3 max-w-sm">
          <div className="mx-auto size-12 rounded-full bg-muted flex items-center justify-center">
            <Scale className="size-6 text-muted-foreground" aria-hidden />
          </div>
          <p className="text-sm font-medium">Create a workspace first.</p>
          <p className="text-xs leading-relaxed text-muted-foreground">
            Policy applies per workspace — pick or create one to configure routing and redaction rules.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full min-h-0 grid grid-cols-1 lg:grid-cols-[1fr_1fr] lg:grid-rows-1 overflow-y-auto lg:overflow-hidden scrollbar-thin">
      {/* ── LEFT · Routing rules ─────────────────────────────────────────── */}
      <section
        aria-label="Routing rules"
        className="flex flex-col min-h-0 border-b lg:border-b-0 lg:border-r"
      >
        <header className="shrink-0 px-4 sm:px-6 py-4 border-b">
          <h2 className="text-sm font-semibold">Routing rules</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            How every model request in this workspace is routed and filtered.
          </p>
        </header>

        <div className="flex-1 min-h-0 lg:overflow-y-auto scrollbar-thin px-4 sm:px-6 py-5 space-y-7">
          {loading ? (
            <>
              <Skeleton className="h-28 w-full rounded-lg" />
              <Skeleton className="h-28 w-full rounded-lg" />
              <Skeleton className="h-28 w-full rounded-lg" />
              <Skeleton className="h-14 w-full rounded-lg" />
              <Skeleton className="h-14 w-full rounded-lg" />
              <Skeleton className="h-14 w-full rounded-lg" />
              <Skeleton className="h-10 w-40 rounded-md" />
            </>
          ) : (
            <>
              {/* Mode selector */}
              <div role="radiogroup" aria-label="Routing mode" className="space-y-2.5">
                {MODES.map((m) => {
                  const active = draft.mode === m.value;
                  const Icon = m.icon;
                  return (
                    <button
                      key={m.value}
                      type="button"
                      role="radio"
                      aria-checked={active}
                      disabled={!isAdmin}
                      onClick={() => setDraft((d) => ({ ...d, mode: m.value }))}
                      className={`w-full text-left rounded-lg border p-4 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                        active
                          ? "border-primary/60 bg-primary/5"
                          : "border-border hover:bg-accent/50 disabled:hover:bg-transparent"
                      }`}
                    >
                      <span className="flex items-start gap-3">
                        <span
                          className={`flex size-9 shrink-0 items-center justify-center rounded-md ${
                            active ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground"
                          }`}
                          aria-hidden
                        >
                          <Icon className="size-4" />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="flex items-center gap-2">
                            <span className="text-sm font-medium">{m.title}</span>
                            {active && <Check className="size-3.5 text-primary" aria-hidden />}
                          </span>
                          <span className="mt-1 block text-xs leading-relaxed text-muted-foreground">
                            {m.desc}
                          </span>
                        </span>
                      </span>
                    </button>
                  );
                })}
              </div>

              {/* Redaction switch */}
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0 space-y-1">
                  <Label htmlFor="redact-pii" className="text-sm">
                    PII &amp; secret redaction
                  </Label>
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    Masks credit cards (Luhn-validated), SSN, IBAN, emails, phone numbers and API keys BEFORE
                    dispatch.
                  </p>
                </div>
                <Switch
                  id="redact-pii"
                  checked={draft.redactPii}
                  disabled={!isAdmin}
                  onCheckedChange={(v) => setDraft((d) => ({ ...d, redactPii: v }))}
                  aria-label="PII and secret redaction"
                />
              </div>

              {/* Block keywords */}
              <div className="space-y-1.5">
                <Label htmlFor="block-keywords" className="text-sm">
                  Block keywords
                </Label>
                <Input
                  id="block-keywords"
                  value={draft.blockKeywords}
                  disabled={!isAdmin}
                  onChange={(e) => setDraft((d) => ({ ...d, blockKeywords: e.target.value }))}
                  placeholder="internal, roadmap, acquisition"
                  className="h-9"
                  aria-describedby="block-keywords-hint"
                />
                <p id="block-keywords-hint" className="text-xs text-muted-foreground">
                  Requests containing any keyword are refused. Case-insensitive.
                </p>
              </div>

              {/* Allowed models */}
              <div className="space-y-1.5">
                <Label htmlFor="allowed-models" className="text-sm">
                  Allowed models
                </Label>
                <Input
                  id="allowed-models"
                  value={draft.allowedModels}
                  disabled={!isAdmin}
                  onChange={(e) => setDraft((d) => ({ ...d, allowedModels: e.target.value }))}
                  placeholder="llama3.1:8b, mistral:7b"
                  className="h-9 font-mono text-xs"
                  aria-describedby="allowed-models-hint"
                />
                <p id="allowed-models-hint" className="text-xs text-muted-foreground">
                  Empty = every approved model. Comma-separated keys.
                </p>
              </div>

              {/* Max tokens */}
              <div className="space-y-1.5">
                <Label htmlFor="max-tokens" className="text-sm">
                  Max tokens
                </Label>
                <Input
                  id="max-tokens"
                  type="number"
                  min={0}
                  step={256}
                  value={draft.maxTokens}
                  disabled={!isAdmin}
                  onChange={(e) =>
                    setDraft((d) => ({ ...d, maxTokens: Math.max(0, Math.floor(Number(e.target.value) || 0)) }))
                  }
                  className="h-9 sm:max-w-48 tabular"
                  aria-describedby="max-tokens-hint"
                />
                <p id="max-tokens-hint" className="text-xs text-muted-foreground">
                  Upper bound for a single model request.
                </p>
              </div>
            </>
          )}
        </div>

        <footer className="shrink-0 border-t px-4 sm:px-6 py-3 bg-card/60">
          {isAdmin ? (
            <div className="flex items-center justify-between gap-3">
              <p className="text-xs text-muted-foreground" aria-live="polite">
                {saving ? "Saving…" : dirty ? "Unsaved changes" : policy ? "All changes saved" : ""}
              </p>
              <Button onClick={() => void save()} disabled={!dirty || saving || loading} className="h-9">
                {saving ? (
                  <Loader2 className="size-4 animate-spin" aria-hidden />
                ) : (
                  <Save className="size-4" aria-hidden />
                )}
                Save policy
              </Button>
            </div>
          ) : (
            <p className="flex items-center gap-2 text-xs text-muted-foreground">
              <Lock className="size-3.5 shrink-0" aria-hidden />
              Read-only — ask an admin to change this workspace&apos;s policy.
            </p>
          )}
        </footer>
      </section>

      {/* ── RIGHT · Try the router ───────────────────────────────────────── */}
      <section aria-label="Try the router" className="flex flex-col min-h-0">
        <header className="shrink-0 px-4 sm:px-6 py-4 border-b">
          <h2 className="text-sm font-semibold">Try the router</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Dry-run any request against this workspace&apos;s saved rules — verdict before dispatch.
          </p>
        </header>

        <div className="flex-1 min-h-0 lg:overflow-y-auto scrollbar-thin px-4 sm:px-6 py-5 space-y-5">
          <div className="space-y-2">
            <Label htmlFor="router-input" className="text-sm">
              Paste a request…
            </Label>
            <Textarea
              id="router-input"
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="e.g. Email jane@acme.com — her card is 4111 1111 1111 1111 and her SSN is 402-11-9876."
              className="min-h-28 max-h-72 resize-none scrollbar-thin"
              disabled={testing}
              aria-describedby="router-note"
            />
          </div>

          <div className="flex items-center gap-3">
            <Button onClick={() => void run()} disabled={!text.trim() || testing} className="h-9">
              {testing ? (
                <Loader2 className="size-4 animate-spin" aria-hidden />
              ) : (
                <Play className="size-4" aria-hidden />
              )}
              Run through policy
            </Button>
            <p id="router-note" className="hidden sm:block text-[11px] leading-relaxed text-muted-foreground">
              This runs the exact same evaluation every chat request passes through — nothing is sent to any
              model.
            </p>
          </div>

          {testing && (
            <div className="space-y-3">
              <Skeleton className="h-20 w-full rounded-lg" />
              <Skeleton className="h-24 w-full rounded-lg" />
            </div>
          )}

          {!result && !testing && (
            <div className="rounded-lg border border-dashed p-6 text-center">
              <ShieldQuestion className="mx-auto size-6 text-muted-foreground/70" aria-hidden />
              <p className="mt-2 text-xs text-muted-foreground">
                Run a request to see the verdict, redaction preview and findings.
              </p>
            </div>
          )}

          {result && !testing && (
            <div className="space-y-4">
              {/* Decision banner */}
              <div
                className={`rounded-lg border p-4 ${
                  result.decision.decision === "allow"
                    ? "border-success/40 bg-success/5"
                    : "border-destructive/40 bg-destructive/5"
                }`}
                role="status"
              >
                <div className="flex items-center gap-2.5">
                  {result.decision.decision === "allow" ? (
                    <ShieldCheck className="size-5 shrink-0 text-success" aria-hidden />
                  ) : (
                    <ShieldAlert className="size-5 shrink-0 text-destructive" aria-hidden />
                  )}
                  <p
                    className={`text-sm font-semibold ${
                      result.decision.decision === "allow" ? "text-success" : "text-destructive"
                    }`}
                  >
                    {result.decision.decision === "allow" ? "Would be allowed" : "Would be blocked"}
                  </p>
                </div>
                {result.decision.reason && (
                  <p className="mt-2 text-sm leading-relaxed">{result.decision.reason}</p>
                )}
              </div>

              {/* Before → after */}
              {result.decision.redacted && (
                <div className="space-y-3">
                  <div className="space-y-1.5">
                    <p className="text-xs font-medium text-muted-foreground">Before</p>
                    <div className="rounded-lg border bg-muted/40 p-3 text-sm leading-relaxed whitespace-pre-wrap break-words">
                      {text}
                    </div>
                  </div>
                  <div className="flex justify-center" aria-hidden>
                    <span className="text-muted-foreground text-xs">↓ redaction ↓</span>
                  </div>
                  <div className="space-y-1.5">
                    <p className="text-xs font-medium text-muted-foreground">
                      After redaction · {result.decision.redactionCount} value
                      {result.decision.redactionCount === 1 ? "" : "s"} masked
                    </p>
                    <div className="rounded-lg border border-amber-500/40 bg-amber-400/5 p-3 text-sm leading-relaxed whitespace-pre-wrap break-words">
                      {withRedactionHighlights(result.decision.redactedText)}
                    </div>
                  </div>
                </div>
              )}

              {/* Findings chips */}
              {result.decision.findings.length > 0 && (
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-xs text-muted-foreground">Findings:</span>
                  {result.decision.findings.map((f) => (
                    <Badge
                      key={f.type}
                      variant="outline"
                      className="border-amber-500/40 bg-amber-400/10 text-amber-700 dark:text-amber-400"
                    >
                      {f.type} ×{f.count}
                    </Badge>
                  ))}
                </div>
              )}

              {result.modelKey && (
                <p className="text-xs text-muted-foreground">
                  Model in scope: <span className="font-mono">{result.modelKey}</span>
                </p>
              )}

              <p className="text-[11px] leading-relaxed text-muted-foreground sm:hidden">
                This runs the exact same evaluation every chat request passes through — nothing is sent to any
                model.
              </p>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

// ═══ Knowledge screen ════════════════════════════════════════════════════════════
// merged from src/components/console/KnowledgeScreen.tsx

interface SearchHit {
  docId: string;
  docName: string;
  chunkIdx: number;
  snippet: string;
  score: number;
}

interface SearchResult {
  hits: SearchHit[];
  tookMs: number;
}

const SUPPORTED_EXTENSIONS = ["txt", "md", "csv", "json", "log"];
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDay(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

export function KnowledgeScreen() {
  const { user, workspaceId } = useLester();
  const role = user?.role ?? "MEMBER";
  const canEdit = role !== "AUDITOR";

  const [documents, setDocuments] = useState<DocumentInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<DocumentInfo | null>(null);

  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [result, setResult] = useState<SearchResult | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    if (!workspaceId) {
      setDocuments([]);
      setLoading(false);
      return;
    }
    try {
      const r = await apiGet<{ documents: DocumentInfo[] }>(
        `/api/knowledge?workspaceId=${encodeURIComponent(workspaceId)}`
      );
      setDocuments(r.documents);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not load documents.");
    } finally {
      setLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => {
    setLoading(true);
    setResult(null);
    void load();
  }, [load]);

  function validateFile(file: File): string | null {
    const ext = file.name.toLowerCase().split(".").pop() ?? "";
    if (!SUPPORTED_EXTENSIONS.includes(ext)) {
      return `“${file.name}” isn’t a supported format — use .txt, .md, .csv, .json or .log.`;
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      return `“${file.name}” is ${formatBytes(file.size)} — the limit is 5 MB.`;
    }
    return null;
  }

  async function uploadFile(file: File) {
    if (!workspaceId) return;
    const problem = validateFile(file);
    if (problem) {
      toast.error(problem);
      return;
    }
    setUploading(true);
    try {
      const form = new FormData();
      form.append("workspaceId", workspaceId);
      form.append("file", file);
      const res = await fetch("/api/knowledge", {
        method: "POST",
        body: form,
        credentials: "same-origin",
      });
      if (!res.ok) {
        let message = `Upload failed (${res.status})`;
        try {
          const errBody = (await res.json()) as { error?: { message?: string } };
          if (errBody?.error?.message) message = errBody.error.message;
        } catch {
          /* ignore */
        }
        throw new Error(message);
      }
      const body = (await res.json()) as { ok: boolean; id: string; chunks: number };
      toast.success(`Indexed ${body.chunks} chunks on this device.`);
      void load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Upload failed.");
    } finally {
      setUploading(false);
    }
  }

  function onPickFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) void uploadFile(file);
    e.target.value = "";
  }

  function onDrop(e: DragEvent<HTMLButtonElement>) {
    e.preventDefault();
    setDragOver(false);
    if (!canEdit || uploading) return;
    const file = e.dataTransfer.files?.[0];
    if (file) void uploadFile(file);
  }

  async function confirmDelete() {
    const doc = deleteTarget;
    if (!doc) return;
    try {
      await apiDelete<{ ok: boolean }>(`/api/knowledge?id=${encodeURIComponent(doc.id)}`);
      toast.success(`“${doc.name}” deleted.`);
      void load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Delete failed.");
    }
  }

  async function runSearch() {
    const q = query.trim();
    if (!q || !workspaceId || searching) return;
    setSearching(true);
    try {
      const r = await apiPost<SearchResult>("/api/knowledge/search", { workspaceId, query: q, k: 5 });
      setResult(r);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Retrieval failed.");
    } finally {
      setSearching(false);
    }
  }

  if (!workspaceId) {
    return (
      <div className="h-full grid place-items-center p-6" role="status">
        <div className="text-center space-y-3 max-w-sm">
          <div className="size-12 mx-auto rounded-full border border-primary/15 bg-primary/5 grid place-items-center">
            <Database className="size-5 text-primary/50" aria-hidden />
          </div>
          <h1 className="text-sm font-medium">Create a workspace first</h1>
          <p className="text-xs text-muted-foreground leading-relaxed">
            Knowledge is scoped per workspace. Pick or create one from the workspace switcher in the
            top bar, then upload documents here.
          </p>
        </div>
      </div>
    );
  }

  const docCountLabel = `${documents.length} ${documents.length === 1 ? "document" : "documents"}`;

  return (
    <div className="h-full flex flex-col min-h-0">
      {/* Header */}
      <header className="shrink-0 border-b bg-card/60 px-4 py-3 flex items-center gap-3">
        <div className="min-w-0">
          <h1 className="text-sm font-semibold leading-tight">Knowledge</h1>
          <p className="text-xs text-muted-foreground mt-0.5 hidden sm:block">
            Documents indexed on this device — chunking and retrieval never leave the node.
          </p>
        </div>
        <div className="ml-auto flex items-center gap-2 shrink-0">
          <Badge variant="outline" className="text-[10px] hidden md:inline-flex tabular">{docCountLabel}</Badge>
          {canEdit && (
            <Button
              size="sm"
              className="h-9"
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading}
              aria-label="Upload a document"
            >
              {uploading ? (
                <Loader2 className="size-3.5 animate-spin" aria-hidden />
              ) : (
                <Upload className="size-3.5" aria-hidden />
              )}
              <span className="hidden sm:inline">{uploading ? "Indexing…" : "Upload"}</span>
            </Button>
          )}
        </div>
      </header>

      <div className="flex-1 min-h-0 flex flex-col lg:flex-row">
        {/* Documents column */}
        <section className="flex-1 min-w-0 min-h-0 flex flex-col" aria-label="Indexed documents">
          {canEdit && (
            <div className="shrink-0 p-3 sm:p-4 pb-0 sm:pb-0">
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragOver(true);
                }}
                onDragLeave={() => setDragOver(false)}
                onDrop={onDrop}
                disabled={uploading}
                aria-label="Upload zone — drag and drop a text file, or click to browse"
                className={`w-full min-h-20 rounded-lg border border-dashed p-4 text-center transition-colors ${
                  dragOver
                    ? "border-primary bg-primary/5"
                    : "border-border hover:border-primary/50 hover:bg-accent/40"
                } disabled:opacity-60`}
              >
                <span className="flex items-center justify-center gap-2 text-xs font-medium">
                  {uploading ? (
                    <Loader2 className="size-4 animate-spin text-primary" aria-hidden />
                  ) : (
                    <Upload className="size-4 text-muted-foreground" aria-hidden />
                  )}
                  {uploading ? "Indexing on this device…" : "Drop a file here, or click to browse"}
                </span>
                <span className="block text-[10px] text-muted-foreground mt-1.5">
                  .txt · .md · .csv · .json · .log — up to 5 MB, indexed locally
                </span>
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept=".txt,.md,.csv,.json,.log"
                className="sr-only"
                tabIndex={-1}
                aria-hidden="true"
                onChange={onPickFile}
              />
            </div>
          )}

          {/* Document list */}
          <div className="flex-1 min-h-0 overflow-y-auto scrollbar-thin">
            {loading ? (
              <div className="p-3 sm:p-4 space-y-2" aria-label="Loading documents">
                {[0, 1, 2, 3].map((i) => (
                  <Skeleton key={i} className="h-12 w-full" />
                ))}
              </div>
            ) : documents.length === 0 ? (
              <div className="h-full min-h-56 flex flex-col items-center justify-center text-center p-6 gap-3">
                <div className="size-12 rounded-full border border-primary/15 bg-primary/5 grid place-items-center">
                  <FileText className="size-6 text-primary/50" aria-hidden />
                </div>
                <h2 className="text-sm font-medium">No documents indexed yet</h2>
                <p className="text-xs text-muted-foreground max-w-xs leading-relaxed">
                  Upload text files — chunking and retrieval happen entirely on this device.
                </p>
                {canEdit && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-9 mt-1"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={uploading}
                    aria-label="Browse files to upload"
                  >
                    <Upload className="size-3.5" aria-hidden />
                    Browse files
                  </Button>
                )}
              </div>
            ) : (
              <div className="p-3 sm:p-4">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Document</TableHead>
                      <TableHead>Size</TableHead>
                      <TableHead className="text-right">Chunks</TableHead>
                      <TableHead>SHA-256</TableHead>
                      <TableHead>Uploaded</TableHead>
                      {canEdit && (
                        <TableHead className="w-14">
                          <span className="sr-only">Actions</span>
                        </TableHead>
                      )}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {documents.map((d) => (
                      <TableRow key={d.id}>
                        <TableCell className="max-w-44 sm:max-w-64">
                          <div className="flex items-center gap-2">
                            <FileText className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                            <span className="truncate font-medium" title={d.name}>
                              {d.name}
                            </span>
                          </div>
                        </TableCell>
                        <TableCell className="tabular text-muted-foreground">{formatBytes(d.sizeBytes)}</TableCell>
                        <TableCell className="text-right tabular text-muted-foreground">{d.chunkCount}</TableCell>
                        <TableCell>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <span className="font-mono text-[11px] text-muted-foreground cursor-help">
                                {d.sha256.slice(0, 12)}…
                              </span>
                            </TooltipTrigger>
                            <TooltipContent side="top" className="max-w-72 break-all font-mono text-[10px]">
                              {d.sha256}
                            </TooltipContent>
                          </Tooltip>
                        </TableCell>
                        <TableCell className="text-muted-foreground">{formatDay(d.createdAt)}</TableCell>
                        {canEdit && (
                          <TableCell>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="size-9 text-muted-foreground hover:text-destructive"
                              onClick={() => setDeleteTarget(d)}
                              aria-label={`Delete ${d.name}`}
                            >
                              <Trash2 className="size-3.5" aria-hidden />
                            </Button>
                          </TableCell>
                        )}
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </div>
        </section>

        {/* Retrieval tester */}
        <aside
          className="shrink-0 border-t lg:border-t-0 lg:border-l bg-card/40 flex flex-col min-h-0 lg:w-96"
          aria-label="Retrieval tester"
        >
          <div className="shrink-0 px-3 pt-3 pb-2 flex items-center gap-2">
            <SearchCheck className="size-3.5 text-primary" aria-hidden />
            <span className="text-xs font-medium">Retrieval tester</span>
            <span className="ml-auto text-[10px] text-muted-foreground">on-device BM25</span>
          </div>
          <div className="shrink-0 px-3 pb-3 flex gap-2">
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void runSearch();
              }}
              placeholder="Ask your documents…"
              className="h-9 text-xs"
              aria-label="Query your indexed documents"
            />
            <Button
              size="icon"
              className="size-9 shrink-0"
              onClick={() => void runSearch()}
              disabled={!query.trim() || searching}
              aria-label="Run retrieval"
            >
              {searching ? (
                <Loader2 className="size-4 animate-spin" aria-hidden />
              ) : (
                <Search className="size-4" aria-hidden />
              )}
            </Button>
          </div>
          <div className="max-h-64 lg:max-h-none lg:flex-1 min-h-0 overflow-y-auto scrollbar-thin border-t">
            <div className="p-3 space-y-2">
              {searching && <Skeleton className="h-16 w-full" aria-label="Retrieving" />}
              {!searching && result === null && (
                <p className="text-xs text-muted-foreground leading-relaxed p-2">
                  Run a query to see which passages the on-device retriever would cite in chat — with
                  its real measured latency.
                </p>
              )}
              {!searching && result !== null && result.hits.length === 0 && (
                <p className="text-xs text-muted-foreground p-2">
                  No matching passages in this workspace.
                </p>
              )}
              {!searching &&
                result !== null &&
                result.hits.map((h) => (
                  <div key={`${h.docId}:${h.chunkIdx}`} className="rounded-lg border bg-card p-3 space-y-1.5">
                    <div className="flex items-center gap-2 flex-wrap">
                      <Badge variant="outline" className="text-[10px] gap-1 max-w-44">
                        <FileText className="size-3" aria-hidden />
                        <span className="truncate">{h.docName}</span>
                      </Badge>
                      <span className="text-[10px] text-muted-foreground tabular">chunk {h.chunkIdx}</span>
                      <span className="ml-auto text-[10px] font-medium text-primary tabular">
                        score {h.score.toFixed(3)}
                      </span>
                    </div>
                    <p className="text-xs leading-relaxed text-muted-foreground">{h.snippet}</p>
                  </div>
                ))}
              {!searching && result !== null && (
                <p className="text-[10px] text-muted-foreground tabular text-center pt-1">
                  retrieved in {result.tookMs} ms on this device
                </p>
              )}
            </div>
          </div>
        </aside>
      </div>

      {/* Delete confirmation */}
      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(o) => {
          if (!o) setDeleteTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{deleteTarget?.name}”?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes the document and its {deleteTarget?.chunkCount ?? 0} indexed chunks from
              this device. The deletion is recorded in the Proof ledger.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90"
              onClick={() => {
                setDeleteTarget(null);
                void confirmDelete();
              }}
            >
              Delete document
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

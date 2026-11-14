"use client";

/**
 * Operations screens: live node Health and the Proof ledger.
 *
 * Merged module (v1.0.2 repository consolidation — zero behavior change).
 * Sections:
 *   1. Health screen
 *   2. Proof ledger screen
 */

import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { apiGet, type HealthData, type ProofEntry, type ProofListResponse } from "@/lib/client";
import { Badge, Button, Card, CardAction, CardContent, CardHeader, CardTitle, Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, Input, Progress, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Skeleton, Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow, Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui";
import { toast } from "sonner";
import { Activity, Archive, Boxes, ChevronLeft, ChevronRight, Cpu, Database, FileJson, FileText, Fingerprint, Loader2, RefreshCw, Search, Server, ShieldAlert, ShieldCheck, ShieldX, Timer, Zap } from "lucide-react";


// ═══ Health screen ═══════════════════════════════════════════════════════════════
// merged from src/components/console/HealthScreen.tsx

function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  const v = n / 1024 ** i;
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

function fmtNum(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return Math.round(n).toLocaleString();
}

function gbFromMb(mb: number): string {
  if (!Number.isFinite(mb) || mb <= 0) return "0 GB";
  return mb >= 10240 ? `${Math.round(mb / 1024).toLocaleString()} GB` : `${(mb / 1024).toFixed(1)} GB`;
}

function fmtDateShort(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return `${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })} · ${d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}`;
}

function truncateMiddle(s: string, head = 12, tail = 8): string {
  if (s.length <= head + tail + 1) return s;
  return `${s.slice(0, head)}…${s.slice(-tail)}`;
}

function clampPct(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(100, v));
}

function fmtUptime(hours: number): string {
  if (!Number.isFinite(hours) || hours < 0) return "—";
  if (hours < 1) {
    const mins = Math.round(hours * 60);
    return mins <= 0 ? "just started" : `${mins} min`;
  }
  if (hours < 48) return `${hours.toFixed(1)} h`;
  return `${Math.round(hours).toLocaleString()} h`;
}

const OK_BADGE = "border-emerald-600/30 bg-emerald-600/10 text-emerald-700 dark:text-emerald-400";
const BAD_BADGE = "border-destructive/40 bg-destructive/10 text-destructive";

// ─── Card scaffolding ────────────────────────────────────────────────────────

function VitalsCard({
  icon,
  title,
  action,
  children,
}: {
  icon: ReactNode;
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Card className="gap-3 rounded-lg py-4">
      <CardHeader className="px-4">
        <CardTitle className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          {icon}
          {title}
        </CardTitle>
        {action != null && <CardAction>{action}</CardAction>}
      </CardHeader>
      <CardContent className="px-4">{children}</CardContent>
    </Card>
  );
}

function Row({ label, value, mono }: { label: string; value: ReactNode; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <dt className="shrink-0 text-[11px] text-muted-foreground">{label}</dt>
      <dd className={`min-w-0 truncate text-right text-xs font-medium tabular ${mono ? "font-mono font-normal" : ""}`}>
        {value}
      </dd>
    </div>
  );
}

// ─── Screen ──────────────────────────────────────────────────────────────────

export function HealthScreen() {
  const [data, setData] = useState<HealthData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [busy, setBusy] = useState(false);
  const [refreshedAt, setRefreshedAt] = useState<Date | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await apiGet<HealthData>("/api/health");
      setData(r);
      setError(null);
      setRefreshedAt(new Date());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not reach /api/health.");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Auto-refresh every 10 s — paused while the tab is hidden.
  useEffect(() => {
    const timer = setInterval(() => {
      if (!document.hidden) void load();
    }, 10000);
    const onVisible = () => {
      if (!document.hidden) void load();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [load]);

  async function verifyChain() {
    if (verifying) return;
    setVerifying(true);
    try {
      const r = await apiGet<HealthData>("/api/health?verify=1");
      setData(r);
      setRefreshedAt(new Date());
      if (r.chain.valid) {
        toast.success(`Ledger verified — ${r.chain.checked.toLocaleString()} entries intact.`);
      } else {
        toast.error(
          r.chain.brokenReason
            ? `Ledger BROKEN at entry #${r.chain.firstBrokenSeq ?? "?"}: ${r.chain.brokenReason}`
            : "Ledger chain is BROKEN."
        );
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Verification failed.");
    } finally {
      setVerifying(false);
    }
  }

  async function manualRefresh() {
    if (busy) return;
    setBusy(true);
    await load();
    setBusy(false);
  }

  const ramPct = Math.round(clampPct(data?.hardware.ram.usedPct ?? 0));
  const diskPct = Math.round(clampPct(data?.hardware.disk.usedPct ?? 0));

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Header */}
      <div className="flex shrink-0 items-center gap-2 border-b bg-card/60 px-4 py-2.5">
        <Activity className="size-4 shrink-0 text-primary" aria-hidden />
        <h1 className="text-sm font-semibold">Node vitals</h1>
        {data && (
          <Badge variant="outline" className="text-[10px] text-muted-foreground">
            v{data.version}
          </Badge>
        )}
        <div className="ml-auto flex items-center gap-2 text-[11px] text-muted-foreground">
          {refreshedAt && <span className="hidden tabular sm:inline">updated {refreshedAt.toLocaleTimeString()}</span>}
          <span className="hidden md:inline">· auto-refresh 10 s</span>
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            onClick={() => void manualRefresh()}
            disabled={busy}
            aria-label="Refresh vitals now"
          >
            <RefreshCw className={`size-3.5 ${busy ? "animate-spin" : ""}`} aria-hidden />
          </Button>
        </div>
      </div>

      {/* Cards — internal scroll only, never a long page */}
      <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin" aria-label="Node vitals dashboard">
        <div className="mx-auto grid max-w-6xl grid-cols-1 gap-3 p-3 sm:grid-cols-2 sm:p-4 xl:grid-cols-3">
          {data === null && error !== null ? (
            <Card className="rounded-lg py-4 sm:col-span-2 xl:col-span-3">
              <CardContent className="flex flex-col items-center gap-3 px-4 py-10 text-center">
                <Activity className="size-8 text-destructive/60" aria-hidden />
                <div className="space-y-1">
                  <p className="text-sm font-medium">Vitals unavailable</p>
                  <p className="mx-auto max-w-sm text-xs leading-relaxed text-muted-foreground">{error}</p>
                </div>
                <Button variant="outline" size="sm" onClick={() => void load()}>
                  <RefreshCw className="size-3.5" aria-hidden />
                  Try again
                </Button>
              </CardContent>
            </Card>
          ) : data === null ? (
            Array.from({ length: 8 }, (_, i) => <Skeleton key={i} className="h-40 rounded-lg" />)
          ) : (
            <>
              {/* Engine */}
              <VitalsCard icon={<Server className="size-3.5" aria-hidden />} title="Engine">
                <div className="space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-sm font-medium" title={data.engine.label}>
                      {data.engine.label}
                    </span>
                    <Badge
                      variant="outline"
                      className={`text-[10px] ${data.engine.reachable ? OK_BADGE : BAD_BADGE}`}
                    >
                      {data.engine.reachable ? "reachable" : "unreachable"}
                    </Badge>
                  </div>
                  <p className="truncate font-mono text-[11px] text-muted-foreground" title={data.engine.url}>
                    {data.engine.url || "—"}
                  </p>
                  <p className="tabular text-xs text-muted-foreground">
                    {data.engine.models.length} model{data.engine.models.length === 1 ? "" : "s"} available
                  </p>
                  {data.engine.error && (
                    <p className="text-xs leading-snug text-destructive">{data.engine.error}</p>
                  )}
                </div>
              </VitalsCard>

              {/* Ledger */}
              <VitalsCard
                icon={
                  data.chain.valid ? (
                    <ShieldCheck className="size-3.5" aria-hidden />
                  ) : (
                    <ShieldX className="size-3.5 text-destructive" aria-hidden />
                  )
                }
                title="Ledger"
                action={
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 gap-1.5 px-2 text-[11px]"
                    onClick={() => void verifyChain()}
                    disabled={verifying}
                    aria-label="Re-verify the proof ledger chain"
                  >
                    {verifying ? (
                      <Loader2 className="size-3 animate-spin" aria-hidden />
                    ) : (
                      <ShieldCheck className="size-3" aria-hidden />
                    )}
                    Re-verify
                  </Button>
                }
              >
                <div className="space-y-2">
                  <Badge variant="outline" className={`text-[10px] ${data.chain.valid ? OK_BADGE : BAD_BADGE}`}>
                    {data.chain.valid ? "verified" : "BROKEN"}
                  </Badge>
                  <dl className="space-y-1.5">
                    <Row label="Entries checked" value={fmtNum(data.chain.checked)} />
                    <Row
                      label="Head hash"
                      mono
                      value={
                        <span title={data.chain.headHash ?? undefined}>
                          {data.chain.headHash ? truncateMiddle(data.chain.headHash) : "—"}
                        </span>
                      }
                    />
                  </dl>
                  {!data.chain.valid && (
                    <p className="text-xs leading-snug text-destructive">
                      Broken at #{data.chain.firstBrokenSeq ?? "?"}
                      {data.chain.brokenReason ? ` — ${data.chain.brokenReason}` : ""}
                    </p>
                  )}
                </div>
              </VitalsCard>

              {/* Throughput */}
              <VitalsCard icon={<Zap className="size-3.5" aria-hidden />} title="Throughput">
                <div className="space-y-2">
                  <div className="flex items-baseline gap-1.5">
                    <span className="text-3xl font-semibold tabular">{fmtNum(data.throughput.tokensPerSec)}</span>
                    <span className="text-xs text-muted-foreground">tok/s</span>
                  </div>
                  <p className="tabular text-xs text-muted-foreground">
                    avg {fmtNum(data.throughput.avgLatencyMs)} ms / turn
                  </p>
                  <p className="text-[11px] text-muted-foreground">
                    {data.throughput.sampledTurns > 0
                      ? `last ${data.throughput.sampledTurns.toLocaleString()} turns`
                      : "no sampled turns yet"}
                  </p>
                </div>
              </VitalsCard>

              {/* Hardware */}
              <VitalsCard icon={<Cpu className="size-3.5" aria-hidden />} title="Hardware">
                <div className="space-y-3">
                  <div className="space-y-0.5">
                    <p className="truncate text-xs font-medium" title={data.hardware.cpu.model}>
                      {data.hardware.cpu.model}
                    </p>
                    <p className="tabular text-[11px] text-muted-foreground">
                      {data.hardware.cpu.cores} cores · {data.hardware.os} {data.hardware.arch}
                    </p>
                  </div>
                  <div className="space-y-1">
                    <div className="flex items-center justify-between text-[11px]">
                      <span className="text-muted-foreground">RAM</span>
                      <span className="tabular">{ramPct}% used</span>
                    </div>
                    <Progress value={ramPct} className="h-1.5" aria-label={`RAM used: ${ramPct} percent`} />
                    <p className="tabular text-[11px] text-muted-foreground">
                      free {gbFromMb(data.hardware.ram.freeMb)} of {gbFromMb(data.hardware.ram.totalMb)}
                    </p>
                  </div>
                  <div className="space-y-1">
                    <div className="flex items-center justify-between text-[11px]">
                      <span className="text-muted-foreground">Disk</span>
                      <span className="tabular">{diskPct}% used</span>
                    </div>
                    <Progress value={diskPct} className="h-1.5" aria-label={`Disk used: ${diskPct} percent`} />
                    <p className="tabular text-[11px] text-muted-foreground">
                      free {data.hardware.disk.freeGb.toLocaleString()} GB of{" "}
                      {data.hardware.disk.totalGb.toLocaleString()} GB
                    </p>
                  </div>
                  <div className="space-y-1 border-t pt-2">
                    {data.hardware.gpus.length > 0 ? (
                      data.hardware.gpus.map((g, i) => (
                        <div key={`${g.name}-${i}`} className="flex items-center justify-between gap-2 text-xs">
                          <span className="truncate" title={g.name}>
                            {g.name}
                          </span>
                          {g.vramMb != null && (
                            <span className="shrink-0 tabular text-[10px] text-muted-foreground">
                              {gbFromMb(g.vramMb)} VRAM
                            </span>
                          )}
                        </div>
                      ))
                    ) : (
                      <p className="text-[11px] text-muted-foreground">No discrete GPU detected</p>
                    )}
                  </div>
                </div>
              </VitalsCard>

              {/* Storage */}
              <VitalsCard icon={<Database className="size-3.5" aria-hidden />} title="Storage">
                <div className="space-y-2.5">
                  <dl className="space-y-1.5">
                    <Row label="Database" value={fmtBytes(data.storage.dbBytes)} />
                    <Row label="WAL" value={fmtBytes(data.storage.walBytes)} />
                  </dl>
                  <p className="truncate font-mono text-[11px] text-muted-foreground" title={data.storage.dbPath}>
                    {truncateMiddle(data.storage.dbPath, 18, 12)}
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    <Badge variant="outline" className="text-[10px] text-muted-foreground">
                      {data.durability.journal.toUpperCase()}
                    </Badge>
                    <Badge variant="outline" className="text-[10px] text-muted-foreground">
                      sync {data.durability.synchronous}
                    </Badge>
                  </div>
                </div>
              </VitalsCard>

              {/* Counts */}
              <VitalsCard icon={<Boxes className="size-3.5" aria-hidden />} title="Counts">
                <dl className="grid grid-cols-2 gap-2">
                  {(
                    [
                      ["Conversations", data.counts.conversations],
                      ["Messages", data.counts.messages],
                      ["Documents", data.counts.documents],
                      ["Proofs", data.counts.proofs],
                      ["Users", data.counts.users],
                      ["Models", data.counts.models],
                    ] as [string, number][]
                  ).map(([label, value]) => (
                    <div key={label} className="rounded-md border bg-background/60 px-2.5 py-2">
                      <dt className="text-[10px] text-muted-foreground">{label}</dt>
                      <dd className="tabular text-sm font-semibold">{value.toLocaleString()}</dd>
                    </div>
                  ))}
                </dl>
              </VitalsCard>

              {/* Backups */}
              <VitalsCard icon={<Archive className="size-3.5" aria-hidden />} title="Backups">
                <div className="space-y-2.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[11px] text-muted-foreground">Scheduler</span>
                    <Badge
                      variant="outline"
                      className={`text-[10px] ${data.backupScheduler.schedulerRunning ? OK_BADGE : "text-muted-foreground"}`}
                    >
                      {data.backupScheduler.schedulerRunning ? "running" : "stopped"}
                    </Badge>
                  </div>
                  {data.backups.length === 0 ? (
                    <p className="text-xs text-muted-foreground">No backups yet — Settings → Backups.</p>
                  ) : (
                    <ul className="space-y-1.5">
                      {data.backups.slice(0, 5).map((b, i) => (
                        <li key={b.id} className="flex items-center gap-2 text-xs">
                          <Badge
                            variant="outline"
                            className={`shrink-0 text-[10px] ${b.kind === "manual" ? "text-primary" : "text-muted-foreground"}`}
                          >
                            {b.kind}
                          </Badge>
                          <span
                            className={`min-w-0 flex-1 truncate ${i === 0 ? "font-medium" : "text-muted-foreground"}`}
                            title={b.path}
                          >
                            {b.fileName}
                          </span>
                          <span className="shrink-0 tabular text-[11px] text-muted-foreground">
                            {fmtBytes(b.sizeBytes)}
                          </span>
                          <span className="hidden shrink-0 tabular text-[10px] text-muted-foreground sm:inline">
                            {fmtDateShort(b.createdAt)}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                  {data.backupScheduler.lastAuto && (
                    <p className="text-[10px] text-muted-foreground">
                      last auto run {fmtDateShort(data.backupScheduler.lastAuto)}
                    </p>
                  )}
                </div>
              </VitalsCard>

              {/* Process */}
              <VitalsCard icon={<Timer className="size-3.5" aria-hidden />} title="Process">
                <dl className="space-y-1.5">
                  <Row label="Uptime" value={fmtUptime(data.uptimeHours)} />
                  <Row label="Started" value={fmtDateShort(data.startedAt)} />
                  <Row label="RSS" value={`${fmtNum(data.process.rssMb)} MB`} />
                  <Row label="Node" value={data.process.node} mono />
                </dl>
              </VitalsCard>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ═══ Proof ledger screen ═════════════════════════════════════════════════════════
// merged from src/components/console/ProofScreen.tsx

const PAGE_SIZE = 50;

const ACTIONS: string[] = [
  "chat.request", "chat.response", "knowledge.upload", "knowledge.search", "knowledge.delete",
  "fit.run", "model.install", "model.uninstall", "model.approval", "model.sync",
  "policy.update", "settings.update", "settings.api_token", "user.create", "user.update", "user.delete",
  "workspace.create", "workspace.update", "workspace.delete", "backup.create", "backup.restore",
  "license.activate", "auth.login", "auth.fail", "setup.complete",
];

const STATUSES = ["ok", "blocked", "redacted", "error"] as const;
const EGRESS_VALUES = ["loopback", "private", "external", "none"] as const;

function truncateHash(hash: string | null): string {
  if (!hash) return "—";
  return hash.length > 10 ? `${hash.slice(0, 10)}…` : hash;
}

function shortTime(ts: string): string {
  return new Date(ts).toLocaleString(undefined, {
    month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
}

function fullTime(ts: string): string {
  return new Date(ts).toLocaleString();
}

function dash(value: string | null | undefined): string {
  const v = value?.trim();
  return v ? v : "—";
}

function StatusBadge({ status }: { status: ProofEntry["status"] }) {
  const styles: Record<ProofEntry["status"], string> = {
    ok: "border-success/30 bg-success/10 text-success",
    blocked: "border-destructive/30 bg-destructive/10 text-destructive",
    redacted: "border-amber-500/40 bg-amber-400/10 text-amber-700 dark:text-amber-400",
    error: "border-destructive/50 bg-destructive/15 text-destructive",
  };
  return (
    <Badge variant="outline" className={`text-[10px] ${styles[status]}`}>
      {status}
    </Badge>
  );
}

function EgressBadge({ egress }: { egress: ProofEntry["egress"] }) {
  if (egress == null) return <span className="text-[11px] text-muted-foreground">—</span>;
  switch (egress) {
    case "loopback":
      return (
        <Badge variant="outline" className="border-success/40 bg-success/10 text-[10px] text-success">
          loopback
        </Badge>
      );
    case "private":
      return (
        <Badge variant="outline" className="border-success/40 text-[10px] text-success">
          private network
        </Badge>
      );
    case "external":
      return (
        <Badge variant="outline" className="border-destructive/40 bg-destructive/10 text-[10px] text-destructive">
          external
        </Badge>
      );
    case "none":
      return (
        <Badge variant="secondary" className="text-[10px] text-muted-foreground">
          no egress
        </Badge>
      );
    default:
      return <span className="text-[11px] text-muted-foreground">{egress}</span>;
  }
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 text-sm break-words">{children}</dd>
    </div>
  );
}

export function ProofScreen() {
  const [data, setData] = useState<ProofListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [fetching, setFetching] = useState(false);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [action, setAction] = useState("all");
  const [status, setStatus] = useState("all");
  const [egress, setEgress] = useState("all");
  const [selected, setSelected] = useState<ProofEntry | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Debounce the search box (400ms) before it hits the API.
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 400);
    return () => clearTimeout(t);
  }, [search]);

  // A new search always restarts from the first page.
  useEffect(() => {
    setPage(1);
  }, [debouncedSearch]);

  const load = useCallback(async () => {
    setFetching(true);
    const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
    if (action !== "all") params.set("action", action);
    if (status !== "all") params.set("status", status);
    if (egress !== "all") params.set("egress", egress);
    const q = debouncedSearch.trim();
    if (q) params.set("q", q);
    try {
      const r = await apiGet<ProofListResponse>(`/api/proof?${params.toString()}`);
      setData(r);
    } catch {
      toast.error("Could not load the Proof ledger.");
    } finally {
      setFetching(false);
      setLoading(false);
    }
  }, [page, action, status, egress, debouncedSearch]);

  useEffect(() => {
    void load();
  }, [load]);

  // Jump back to the top whenever a new page/filter result lands.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 });
  }, [data]);

  const totalPages = data ? Math.max(1, Math.ceil(data.total / (data.pageSize || PAGE_SIZE))) : 1;
  const currentPage = data?.page ?? page;
  const canPrev = currentPage > 1 && !fetching;
  const canNext = currentPage < totalPages && !fetching;

  return (
    <div className="h-full flex flex-col min-h-0">
      {/* ── Chain integrity + exports ───────────────────────────────────── */}
      <div className="shrink-0 border-b bg-card/60">
        <div className="px-4 sm:px-5 py-3 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div className="min-w-0">
            {loading || !data ? (
              <div className="flex items-center gap-3">
                <Skeleton className="size-9 rounded-full" />
                <div className="space-y-1.5">
                  <Skeleton className="h-4 w-48" />
                  <Skeleton className="h-3 w-32" />
                </div>
              </div>
            ) : data.chain.valid ? (
              <div className="flex items-center gap-3 min-w-0">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-success/10">
                  <ShieldCheck className="size-4 text-success" aria-hidden />
                </span>
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                    <Badge variant="outline" className="border-success/40 bg-success/10 text-success">
                      Chain verified · {data.chain.checked} entries
                    </Badge>
                    <span className="font-mono text-xs text-muted-foreground truncate">
                      head {truncateHash(data.chain.headHash)}
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground hidden sm:block">
                    Every entry is hash-chained to its predecessor — tampering breaks the chain.
                  </p>
                </div>
              </div>
            ) : (
              <div
                role="alert"
                className="flex items-center gap-2.5 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2"
              >
                <ShieldAlert className="size-4 shrink-0 text-destructive" aria-hidden />
                <p className="text-sm font-medium text-destructive">
                  CHAIN BROKEN at seq {data.chain.firstBrokenSeq ?? "?"}: {data.chain.brokenReason ?? "unknown reason"}
                </p>
              </div>
            )}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {fetching && <Loader2 className="size-3.5 animate-spin text-muted-foreground" aria-hidden />}
            <Button asChild variant="outline" size="sm" className="h-9">
              <a href="/api/proof/export?format=json" download>
                <FileJson className="size-3.5" aria-hidden />
                Signed JSON
              </a>
            </Button>
            <Button asChild variant="outline" size="sm" className="h-9">
              <a href="/api/proof/export?format=pdf" download>
                <FileText className="size-3.5" aria-hidden />
                PDF report
              </a>
            </Button>
          </div>
        </div>
      </div>

      {/* ── Filters ─────────────────────────────────────────────────────── */}
      <div className="shrink-0 border-b px-4 sm:px-5 py-2.5 flex flex-wrap items-center gap-2">
        <div className="relative w-full sm:w-64 lg:flex-1 lg:max-w-80">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" aria-hidden />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search user, model, workspace…"
            className="pl-8 h-9 text-sm"
            aria-label="Search the ledger"
          />
        </div>
        <Select value={action} onValueChange={(v) => { setAction(v); setPage(1); }}>
          <SelectTrigger className="h-9 w-full sm:w-44 text-xs" aria-label="Filter by action">
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="max-h-72">
            <SelectItem value="all" className="text-xs">All actions</SelectItem>
            {ACTIONS.map((a) => (
              <SelectItem key={a} value={a} className="text-xs font-mono">{a}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={status} onValueChange={(v) => { setStatus(v); setPage(1); }}>
          <SelectTrigger className="h-9 w-full sm:w-32 text-xs" aria-label="Filter by status">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all" className="text-xs">All statuses</SelectItem>
            {STATUSES.map((s) => (
              <SelectItem key={s} value={s} className="text-xs">{s}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={egress} onValueChange={(v) => { setEgress(v); setPage(1); }}>
          <SelectTrigger className="h-9 w-full sm:w-32 text-xs" aria-label="Filter by egress">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all" className="text-xs">All egress</SelectItem>
            {EGRESS_VALUES.map((g) => (
              <SelectItem key={g} value={g} className="text-xs">{g}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* ── Ledger table ────────────────────────────────────────────────── */}
      <div ref={scrollRef} className="flex-1 min-h-0 overflow-auto scrollbar-thin" aria-label="Proof ledger table">
        {loading ? (
          <div className="p-4 sm:p-5 space-y-2">
            {Array.from({ length: 10 }).map((_, i) => (
              <Skeleton key={i} className="h-10 w-full rounded-md" />
            ))}
          </div>
        ) : data && data.total === 0 ? (
          <div className="h-full flex items-center justify-center p-6">
            <div className="text-center space-y-3 max-w-sm">
              <div className="mx-auto size-14 rounded-full bg-muted flex items-center justify-center">
                <Fingerprint className="size-7 text-muted-foreground" aria-hidden />
              </div>
              <p className="text-sm font-medium">The ledger is empty</p>
              <p className="text-xs leading-relaxed text-muted-foreground">
                Every request — chat, search, policy change, backup — is recorded here the moment it happens.
              </p>
            </div>
          </div>
        ) : (
          <Table className="text-xs min-w-[36rem] md:min-w-[48rem] xl:min-w-[66rem]">
            <TableCaption className="sr-only">Proof ledger entries, newest first</TableCaption>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="text-[11px] font-medium text-muted-foreground">Seq</TableHead>
                <TableHead className="hidden md:table-cell text-[11px] font-medium text-muted-foreground">Time</TableHead>
                <TableHead className="text-[11px] font-medium text-muted-foreground">Action</TableHead>
                <TableHead className="text-[11px] font-medium text-muted-foreground">Status</TableHead>
                <TableHead className="hidden sm:table-cell text-[11px] font-medium text-muted-foreground">User</TableHead>
                <TableHead className="hidden xl:table-cell text-[11px] font-medium text-muted-foreground">Workspace</TableHead>
                <TableHead className="text-[11px] font-medium text-muted-foreground">Model</TableHead>
                <TableHead className="hidden lg:table-cell text-[11px] font-medium text-muted-foreground">Provider</TableHead>
                <TableHead className="hidden xl:table-cell text-[11px] font-medium text-muted-foreground">Endpoint</TableHead>
                <TableHead className="text-[11px] font-medium text-muted-foreground">Egress</TableHead>
                <TableHead className="hidden sm:table-cell text-[11px] font-medium text-muted-foreground">Tok I/O</TableHead>
                <TableHead className="hidden lg:table-cell text-[11px] font-medium text-muted-foreground">ms</TableHead>
                <TableHead className="text-[11px] font-medium text-muted-foreground">Red.</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data?.entries.length === 0 ? (
                <TableRow className="hover:bg-transparent">
                  <TableCell colSpan={13} className="h-24 text-center text-muted-foreground">
                    No entries on this page.
                  </TableCell>
                </TableRow>
              ) : (
                data?.entries.map((e) => (
                  <TableRow
                    key={e.seq}
                    className="cursor-pointer h-11 focus-visible:bg-accent/60 focus-visible:outline-none"
                    onClick={() => setSelected(e)}
                    tabIndex={0}
                    onKeyDown={(ev) => {
                      if (ev.key === "Enter" || ev.key === " ") {
                        ev.preventDefault();
                        setSelected(e);
                      }
                    }}
                    aria-label={`Proof entry ${e.seq}, ${e.action}`}
                  >
                    <TableCell className="tabular font-mono text-[11px]">{e.seq}</TableCell>
                    <TableCell className="hidden md:table-cell text-[11px] text-muted-foreground tabular whitespace-nowrap">
                      {shortTime(e.ts)}
                    </TableCell>
                    <TableCell className="max-w-40 truncate font-medium">{e.action}</TableCell>
                    <TableCell><StatusBadge status={e.status} /></TableCell>
                    <TableCell className="hidden sm:table-cell max-w-28 truncate text-muted-foreground">
                      {dash(e.username)}
                    </TableCell>
                    <TableCell className="hidden xl:table-cell max-w-28 truncate text-muted-foreground">
                      {dash(e.workspaceName)}
                    </TableCell>
                    <TableCell className="max-w-28">
                      {e.modelKey ? (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span className="block truncate font-mono text-[11px] cursor-help">{e.modelKey}</span>
                          </TooltipTrigger>
                          <TooltipContent side="top">
                            <span className="font-mono">{e.modelKey}</span>
                          </TooltipContent>
                        </Tooltip>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell className="hidden lg:table-cell max-w-24 truncate text-muted-foreground">
                      {dash(e.providerLabel ?? e.provider)}
                    </TableCell>
                    <TableCell className="hidden xl:table-cell max-w-44 truncate text-muted-foreground">
                      {e.endpointHost
                        ? `${e.endpointHost}${e.endpointIp ? ` (${e.endpointIp})` : ""}`
                        : "—"}
                    </TableCell>
                    <TableCell><EgressBadge egress={e.egress} /></TableCell>
                    <TableCell className="hidden sm:table-cell tabular text-[11px] text-muted-foreground whitespace-nowrap">
                      {e.tokensIn ?? "—"}/{e.tokensOut ?? "—"}
                    </TableCell>
                    <TableCell className="hidden lg:table-cell tabular text-[11px] text-muted-foreground">
                      {e.latencyMs ?? "—"}
                    </TableCell>
                    <TableCell className="tabular text-[11px]">
                      {e.redactions != null && e.redactions > 0 ? (
                        <span className="font-medium text-amber-700 dark:text-amber-400">{e.redactions}</span>
                      ) : (
                        <span className="text-muted-foreground/60">—</span>
                      )}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        )}
      </div>

      {/* ── Pagination ──────────────────────────────────────────────────── */}
      <div className="shrink-0 border-t bg-card/60 px-4 sm:px-5 py-2.5 flex items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground tabular" aria-live="polite">
          {data ? `Showing ${currentPage} of ${totalPages} · ${data.total} entries` : "Loading…"}
        </p>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            className="h-9"
            disabled={!canPrev}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            aria-label="Previous page"
          >
            <ChevronLeft className="size-4" aria-hidden />
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-9"
            disabled={!canNext}
            onClick={() => setPage((p) => p + 1)}
            aria-label="Next page"
          >
            <ChevronRight className="size-4" aria-hidden />
          </Button>
        </div>
      </div>

      {/* ── Entry detail dialog ─────────────────────────────────────────── */}
      <Dialog open={selected !== null} onOpenChange={(open) => { if (!open) setSelected(null); }}>
        <DialogContent className="sm:max-w-2xl max-h-[85vh] overflow-y-auto scrollbar-thin">
          <DialogHeader>
            <DialogTitle className="flex flex-wrap items-baseline gap-x-2">
              <span>Entry #{selected?.seq}</span>
              <span className="font-mono text-sm font-normal text-muted-foreground">{selected?.action}</span>
            </DialogTitle>
            <DialogDescription className="text-xs">
              {selected ? fullTime(selected.ts) : ""} · recorded in the hash chain
            </DialogDescription>
          </DialogHeader>

          {selected && (
            <div className="space-y-5">
              <dl className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-4">
                <Field label="Status"><StatusBadge status={selected.status} /></Field>
                <Field label="User">{dash(selected.username)}</Field>
                <Field label="Workspace">{dash(selected.workspaceName)}</Field>
                <Field label="Model">
                  {selected.modelKey ? (
                    <span className="font-mono text-xs break-all">{selected.modelKey}</span>
                  ) : (
                    "—"
                  )}
                </Field>
                <Field label="Provider">{dash(selected.providerLabel ?? selected.provider)}</Field>
                <Field label="Egress"><EgressBadge egress={selected.egress} /></Field>
                <Field label="Endpoint host">{dash(selected.endpointHost)}</Field>
                <Field label="Endpoint IP">{dash(selected.endpointIp)}</Field>
                <Field label="Latency">
                  {selected.latencyMs != null ? <span className="tabular">{selected.latencyMs} ms</span> : "—"}
                </Field>
                <Field label="Tokens in">
                  {selected.tokensIn != null ? <span className="tabular">{selected.tokensIn}</span> : "—"}
                </Field>
                <Field label="Tokens out">
                  {selected.tokensOut != null ? <span className="tabular">{selected.tokensOut}</span> : "—"}
                </Field>
                <Field label="Redactions">
                  {selected.redactions != null && selected.redactions > 0 ? (
                    <span className="font-medium text-amber-700 dark:text-amber-400 tabular">
                      {selected.redactions}
                    </span>
                  ) : (
                    "—"
                  )}
                </Field>
              </dl>

              <div className="space-y-1.5">
                <p className="text-xs font-medium text-muted-foreground">Detail</p>
                <pre className="rounded-md border bg-muted/40 p-3 font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-all max-h-64 overflow-auto scrollbar-thin">
                  {JSON.stringify(selected.detail ?? {}, null, 2)}
                </pre>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="min-w-0 space-y-1">
                  <p className="text-xs font-medium text-muted-foreground">prev hash</p>
                  <p className="font-mono text-xs break-all text-muted-foreground [overflow-wrap:anywhere]">
                    {selected.prevHash ?? "—"}
                  </p>
                </div>
                <div className="min-w-0 space-y-1">
                  <p className="text-xs font-medium text-muted-foreground">self hash</p>
                  <p className="font-mono text-xs break-all [overflow-wrap:anywhere]">
                    {selected.selfHash ?? "—"}
                  </p>
                </div>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

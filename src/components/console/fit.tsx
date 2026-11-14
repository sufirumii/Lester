"use client";

/**
 * Lester Fit — evaluation of candidate models on your own prompts, with honest measured-vs-assumed cost math.
 *
 * Merged module (v1.0.2 repository consolidation — zero behavior change).
 * Sections:
 *   1. Fit screen
 */

import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { apiDelete, apiGet, apiPost, type FitRunInfo, type InstalledModel, type ModelsResponse, useLester } from "@/lib/client";
import { Alert, AlertDescription, AlertTitle, Badge, Button, Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle, Checkbox, Input, Label, Progress, Skeleton, Switch, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, Textarea } from "@/components/ui";
import { toast } from "sonner";
import { Ban, CircleSlash, Clock, Eye, FlaskConical, Gauge, History, Loader2, Play, RotateCcw, SlidersHorizontal, Square, TrendingDown } from "lucide-react";


// ═══ Fit screen ══════════════════════════════════════════════════════════════════
// merged from src/components/console/FitScreen.tsx

interface FitRunSummary {
  id: string;
  status: FitRunInfo["status"];
  progress: number;
  total: number;
  prompts: string[] | number; // the list endpoint returns a count
  candidates: string[];
  createdAt: string;
  error: string | null;
}

function promptCountOf(run: { prompts: string[] | number }): number {
  return typeof run.prompts === "number" ? run.prompts : run.prompts.length;
}

const MIN_PROMPTS = 20;
const MAX_PROMPTS = 200;

interface ConfigDraft {
  requestsPerMonth: string;
  pricePerMillionIn: string;
  pricePerMillionOut: string;
  hardwareMonthlyCost: string;
  judge: boolean;
}

const DEFAULT_CONFIG: ConfigDraft = {
  requestsPerMonth: "10000",
  pricePerMillionIn: "3",
  pricePerMillionOut: "15",
  hardwareMonthlyCost: "0",
  judge: true,
};

// ─── Small helpers ───────────────────────────────────────────────────────────

function usd(n: number): string {
  const abs = Math.abs(n);
  const opts: Intl.NumberFormatOptions = abs === 0
    ? { minimumFractionDigits: 0, maximumFractionDigits: 0 }
    : abs >= 100
      ? { minimumFractionDigits: 0, maximumFractionDigits: 0 }
      : abs >= 1
        ? { minimumFractionDigits: 0, maximumFractionDigits: 1 }
        : { minimumFractionDigits: 2, maximumFractionDigits: 2 };
  return n.toLocaleString("en-US", { style: "currency", currency: "USD", ...opts });
}

function num(v: number | null | undefined, digits = 0): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return v.toLocaleString(undefined, { maximumFractionDigits: digits });
}

function fmtDateShort(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return `${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })} · ${d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}`;
}

function StatusBadge({ status }: { status: FitRunInfo["status"] }) {
  const cls: Record<FitRunInfo["status"], string> = {
    queued: "text-muted-foreground",
    running: "border-amber-600/30 bg-amber-600/10 text-amber-700 dark:text-amber-400",
    done: "border-emerald-600/30 bg-emerald-600/10 text-emerald-700 dark:text-emerald-400",
    error: "border-destructive/40 bg-destructive/10 text-destructive",
    cancelled: "text-muted-foreground",
  };
  return (
    <Badge variant="outline" className={`text-[10px] capitalize ${cls[status]}`}>
      {status}
    </Badge>
  );
}

function ProviderBadge({ provider }: { provider: string }) {
  const map: Record<string, { label: string; cls: string }> = {
    LOCAL_ENGINE: { label: "local engine", cls: "text-muted-foreground" },
    CLOUD: { label: "cloud", cls: "border-amber-600/30 bg-amber-600/10 text-amber-700 dark:text-amber-400" },
  };
  const m = map[provider] ?? { label: provider.toLowerCase(), cls: "text-muted-foreground" };
  return (
    <Badge variant="outline" className={`shrink-0 text-[10px] ${m.cls}`}>
      {m.label}
    </Badge>
  );
}

function StepHeader({ n, title, right }: { n: number; title: string; right?: ReactNode }) {
  return (
    <div className="flex items-center gap-2">
      <span
        aria-hidden
        className="flex size-5 shrink-0 items-center justify-center rounded-full bg-primary/10 text-[11px] font-semibold text-primary"
      >
        {n}
      </span>
      <h3 className="text-sm font-medium">{title}</h3>
      {right != null && <div className="ml-auto min-w-0">{right}</div>}
    </div>
  );
}

function Stat({ label, value, muted }: { label: string; value: string; muted?: boolean }) {
  return (
    <div className="flex min-w-0 items-baseline justify-between gap-2">
      <dt className="shrink-0 text-[11px] text-muted-foreground">{label}</dt>
      <dd className={`truncate text-sm tabular ${muted ? "font-normal italic text-muted-foreground" : "font-medium"}`}>
        {value}
      </dd>
    </div>
  );
}

function AssumptionStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <dt className="text-[11px] text-muted-foreground">{label}</dt>
      <dd>
        <Badge variant="secondary" className="text-[10px] font-normal tabular">{value}</Badge>
      </dd>
    </div>
  );
}

// ─── Sub-views (right panel) ─────────────────────────────────────────────────

function RunningCard({
  run,
  labelFor,
  onCancel,
  cancelling,
}: {
  run: FitRunInfo;
  labelFor: (key: string) => string;
  onCancel: () => void;
  cancelling: boolean;
}) {
  const pct = run.total > 0 ? Math.min(100, (run.progress / run.total) * 100) : 0;
  const queued = run.status === "queued";
  return (
    <Card className="gap-3 rounded-lg py-4" aria-busy="true">
      <CardHeader className="px-4">
        <CardTitle className="flex items-center gap-2 text-sm">
          {queued ? (
            <Clock className="size-4 text-muted-foreground" aria-hidden />
          ) : (
            <Loader2 className="size-4 animate-spin text-primary" aria-hidden />
          )}
          {queued ? "Queued…" : "Running…"}
        </CardTitle>
        <CardDescription className="text-xs">
          Replaying {run.prompts.length} of your prompts against {run.candidates.length} candidate
          {run.candidates.length === 1 ? "" : "s"}.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 px-4">
        <Progress value={pct} aria-label={`Evaluation progress: ${run.progress} of ${run.total} requests`} />
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-sm tabular">
            {queued ? `0/${run.total} requests` : `Running… ${run.progress}/${run.total} requests`}
          </p>
          <Button variant="outline" size="sm" className="ml-auto h-8" onClick={onCancel} disabled={cancelling}>
            {cancelling ? (
              <Loader2 className="size-3.5 animate-spin" aria-hidden />
            ) : (
              <Square className="size-3.5" aria-hidden />
            )}
            Cancel
          </Button>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {run.candidates.map((k) => (
            <Badge key={k} variant="outline" className="max-w-48 text-[10px] font-normal text-muted-foreground">
              <span className="truncate">{labelFor(k)}</span>
            </Badge>
          ))}
        </div>
        <p className="text-[11px] text-muted-foreground">
          You can leave this screen — the run keeps going on the node.
        </p>
      </CardContent>
    </Card>
  );
}

function ErrorCard({ run }: { run: FitRunInfo }) {
  return (
    <Alert variant="destructive">
      <CircleSlash aria-hidden />
      <AlertTitle>Evaluation failed</AlertTitle>
      <AlertDescription>{run.error ?? "The run ended with an error and produced no results."}</AlertDescription>
    </Alert>
  );
}

function CancelledCard({ run }: { run: FitRunInfo }) {
  return (
    <Card className="gap-3 rounded-lg border-dashed py-4">
      <CardContent className="flex items-center gap-2 px-4 text-sm text-muted-foreground">
        <Ban className="size-4 shrink-0" aria-hidden />
        <span>
          Evaluation cancelled before finishing — no results were recorded.
          <span className="hidden tabular sm:inline"> · {fmtDateShort(run.createdAt)}</span>
        </span>
      </CardContent>
    </Card>
  );
}

function EmptyState() {
  return (
    <Card className="gap-0 rounded-lg py-4">
      <CardContent className="flex flex-col items-center gap-3 px-4 py-14 text-center">
        <Gauge className="size-10 text-primary/40" aria-hidden />
        <div className="space-y-1.5">
          <p className="text-base font-medium">No evaluations yet</p>
          <p className="mx-auto max-w-sm text-sm leading-relaxed text-muted-foreground">
            Upload 20–200 of your real prompts and Lester measures whether a local model can carry the workload —
            with a cost-saved estimate.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

function PlaceholderState() {
  return (
    <Card className="rounded-lg border-dashed py-4">
      <CardContent className="flex flex-col items-center gap-2 px-4 py-12 text-center">
        <History className="size-8 text-muted-foreground/50" aria-hidden />
        <p className="text-sm font-medium">Select an evaluation</p>
        <p className="max-w-xs text-xs leading-relaxed text-muted-foreground">
          Pick a past run to review its measurements, or start a new one with your real prompts.
        </p>
      </CardContent>
    </Card>
  );
}

function ResultsView({
  run,
  isAuditor,
  onReset,
}: {
  run: FitRunInfo;
  isAuditor: boolean;
  onReset: () => void;
}) {
  const s = run.summary;
  if (!s) {
    return (
      <Alert variant="destructive">
        <CircleSlash aria-hidden />
        <AlertTitle>Finished without a summary</AlertTitle>
        <AlertDescription>
          The run completed but produced no summary. Try running the evaluation again.
        </AlertDescription>
      </Alert>
    );
  }
  const m = s.measured;
  const a = s.assumptions;
  return (
    <>
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <StatusBadge status={run.status} />
        <span className="tabular">
          {fmtDateShort(run.createdAt)} · {promptCountOf(run)} prompts · {run.candidates.length} model
          {run.candidates.length === 1 ? "" : "s"}
        </span>
      </div>

      {/* Verdict */}
      <Card className="gap-3 rounded-lg py-4">
        <CardContent className="px-4 sm:px-5">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
            <div className="min-w-0 flex-1 space-y-2">
              <div className="flex items-center gap-1.5 text-primary">
                <TrendingDown className="size-4" aria-hidden />
                <span className="text-[11px] font-semibold uppercase tracking-wider">Verdict</span>
              </div>
              <p className="text-base font-medium leading-snug sm:text-lg">{s.verdict}</p>
              <p className="tabular text-xs text-muted-foreground">
                cloud {usd(s.monthlyCloudCost)}/mo → local {usd(s.monthlyLocalCost)}/mo
              </p>
            </div>
            <div className="shrink-0 rounded-lg border bg-primary/5 px-4 py-3">
              <p className="text-2xl font-semibold tabular text-primary sm:text-3xl">≈{usd(s.monthlySaved)}</p>
              <p className="text-[11px] text-muted-foreground">saved / month</p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Measured vs assumptions — two visually separated blocks */}
      <div className="grid gap-4 md:grid-cols-2">
        <Card className="gap-3 rounded-lg py-4">
          <CardHeader className="px-4">
            <CardTitle className="flex items-center gap-1.5 text-sm">
              <FlaskConical className="size-3.5 text-primary" aria-hidden />
              Measured on this node
            </CardTitle>
          </CardHeader>
          <CardContent className="px-4">
            <dl className="grid grid-cols-2 gap-x-4 gap-y-2.5">
              <Stat label="Prompts" value={num(m.prompts)} />
              <Stat label="Success rate" value={`${num(Math.round(m.successRate))}%`} />
              <Stat label="Avg tokens in" value={num(m.avgTokensIn)} />
              <Stat label="Avg tokens out" value={num(m.avgTokensOut)} />
              <Stat label="Avg latency" value={`${num(Math.round(m.avgLatencyMs))} ms`} />
              <Stat label="Throughput" value={`${num(m.tokensPerSec, 1)} tok/s`} />
              <Stat
                label="Avg quality"
                value={m.avgQuality == null ? "not measured" : num(m.avgQuality, 1)}
                muted={m.avgQuality == null}
              />
            </dl>
          </CardContent>
        </Card>

        <Card className="gap-3 rounded-lg border-dashed bg-muted/30 py-4">
          <CardHeader className="px-4">
            <CardTitle className="flex items-center gap-1.5 text-sm text-muted-foreground">
              <SlidersHorizontal className="size-3.5" aria-hidden />
              Your assumptions
            </CardTitle>
            <CardAction>
              <Badge variant="outline" className="text-[10px] text-muted-foreground">assumptions</Badge>
            </CardAction>
          </CardHeader>
          <CardContent className="px-4">
            <dl className="space-y-2">
              <AssumptionStat label="Requests / month" value={`${num(a.requestsPerMonth)} req`} />
              <AssumptionStat label="Cloud price / M in" value={usd(a.pricePerMillionIn)} />
              <AssumptionStat label="Cloud price / M out" value={usd(a.pricePerMillionOut)} />
              <AssumptionStat label="Hardware / month" value={usd(a.hardwareMonthlyCost)} />
              <AssumptionStat label="Quality judge" value={a.judge ? "on" : "off"} />
            </dl>
            <p className="mt-3 text-[10px] leading-relaxed text-muted-foreground">
              Your numbers, echoed from the run configuration — never presented as measurements.
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Candidates table */}
      <Card className="gap-3 rounded-lg py-4">
        <CardHeader className="px-4">
          <CardTitle className="text-sm">Candidates measured</CardTitle>
          <CardDescription className="text-xs">
            Each candidate replayed your {run.prompts.length} prompts on this machine.
          </CardDescription>
        </CardHeader>
        <CardContent className="px-0 pb-0">
          <Table className="text-xs">
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="pl-4 text-[11px] font-medium">Model</TableHead>
                <TableHead className="text-[11px] font-medium">Provider</TableHead>
                <TableHead className="text-[11px] font-medium">Egress</TableHead>
                <TableHead className="text-right text-[11px] font-medium">Success</TableHead>
                <TableHead className="text-right text-[11px] font-medium">Avg ms</TableHead>
                <TableHead className="text-right text-[11px] font-medium">p95 ms</TableHead>
                <TableHead className="text-right text-[11px] font-medium">tok/s</TableHead>
                <TableHead className="text-right text-[11px] font-medium">Avg tok in→out</TableHead>
                <TableHead className="pr-4 text-right text-[11px] font-medium">Quality</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {run.results.map((r) => (
                <TableRow key={r.modelKey}>
                  <TableCell className="pl-4 font-medium">{r.label}</TableCell>
                  <TableCell>
                    <ProviderBadge provider={r.provider} />
                  </TableCell>
                  <TableCell
                    className={r.egress === "external" ? "text-amber-700 dark:text-amber-400" : "text-muted-foreground"}
                  >
                    {r.egress}
                  </TableCell>
                  <TableCell className="text-right tabular">{Math.round(r.successRate)}%</TableCell>
                  <TableCell className="text-right tabular">{num(Math.round(r.avgLatencyMs))}</TableCell>
                  <TableCell className="text-right tabular">{num(Math.round(r.p95LatencyMs))}</TableCell>
                  <TableCell className="text-right tabular">{num(r.tokensPerSec, 1)}</TableCell>
                  <TableCell className="whitespace-nowrap text-right tabular">
                    {num(Math.round(r.avgTokensIn))} → {num(Math.round(r.avgTokensOut))}
                  </TableCell>
                  <TableCell className="pr-4 text-right tabular">
                    {r.avgQuality == null ? <span className="text-muted-foreground">—</span> : num(r.avgQuality, 1)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <p className="px-1 text-[11px] leading-relaxed text-muted-foreground">
        Latency, tokens and quality are measured live on this machine against your own prompts. Cost figures combine
        those measurements with the assumptions you provided.
      </p>

      {!isAuditor && (
        <div>
          <Button variant="outline" onClick={onReset}>
            <RotateCcw className="size-4" aria-hidden />
            Start a new evaluation
          </Button>
        </div>
      )}
    </>
  );
}

// ─── Screen ──────────────────────────────────────────────────────────────────

export function FitScreen() {
  const { user } = useLester();
  const role = user?.role ?? "MEMBER";
  const isAuditor = role === "AUDITOR";

  const [runs, setRuns] = useState<FitRunSummary[] | null>(null);
  const [models, setModels] = useState<InstalledModel[] | null>(null);
  const [promptsText, setPromptsText] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [config, setConfig] = useState<ConfigDraft>({ ...DEFAULT_CONFIG });
  const [activeId, setActiveId] = useState<string | null>(null);
  const [activeRun, setActiveRun] = useState<FitRunInfo | null>(null);
  const [starting, setStarting] = useState(false);
  const [cancelling, setCancelling] = useState(false);

  const activeIdRef = useRef<string | null>(null);
  const prevStatusRef = useRef<FitRunInfo["status"] | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const resultsRef = useRef<HTMLElement | null>(null);

  const prompts = useMemo(
    () =>
      promptsText
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 0),
    [promptsText]
  );
  const promptCount = prompts.length;
  const promptsValid = promptCount >= MIN_PROMPTS && promptCount <= MAX_PROMPTS;

  const availableModels = useMemo(
    () => (models ?? []).filter((m) => m.installed && m.approved && m.enabled),
    [models]
  );

  const labelFor = useCallback((key: string) => models?.find((m) => m.key === key)?.name ?? key, [models]);

  const selectRun = useCallback((id: string, status: FitRunInfo["status"]) => {
    activeIdRef.current = id;
    prevStatusRef.current = status;
    setActiveRun(null);
    setActiveId(id);
  }, []);

  const loadRuns = useCallback(async () => {
    try {
      const r = await apiGet<{ runs: FitRunSummary[] }>("/api/fit");
      setRuns(r.runs);
      // If a run is already in flight (e.g. after a page reload), attach to it.
      const live = r.runs.find((x) => x.status === "queued" || x.status === "running");
      if (live && activeIdRef.current === null) selectRun(live.id, live.status);
    } catch (e) {
      setRuns((prev) => prev ?? []);
      toast.error(e instanceof Error ? e.message : "Could not load evaluations.");
    }
  }, [selectRun]);

  const loadModels = useCallback(async () => {
    try {
      const r = await apiGet<ModelsResponse>("/api/models");
      setModels(r.installed);
    } catch {
      setModels([]);
      toast.error("Could not load the model registry.");
    }
  }, []);

  useEffect(() => {
    void loadRuns();
    void loadModels();
  }, [loadRuns, loadModels]);

  // Fetch the active run immediately, then poll every 2 s while queued/running.
  const pollKey = activeRun === null ? "loading" : activeRun.status;
  useEffect(() => {
    if (!activeId) return;
    if (pollKey !== "loading" && pollKey !== "queued" && pollKey !== "running") return;

    let stopped = false;
    const tick = async () => {
      if (stopped) return;
      try {
        const r = await apiGet<{ run: FitRunInfo }>(`/api/fit/${activeId}`);
        if (stopped) return;
        const prev = prevStatusRef.current;
        setActiveRun(r.run);
        prevStatusRef.current = r.run.status;
        const terminal = r.run.status !== "queued" && r.run.status !== "running";
        if (terminal && (prev === "queued" || prev === "running")) {
          if (r.run.status === "done") toast.success("Evaluation complete — results are ready.");
          else if (r.run.status === "error") toast.error(r.run.error ?? "Evaluation failed.");
          void loadRuns();
        }
      } catch {
        /* transient — the next tick retries */
      }
    };

    void tick();
    const timer = setInterval(() => void tick(), 2000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [activeId, pollKey, loadRuns]);

  const busy = activeRun?.status === "queued" || activeRun?.status === "running";
  const requestsPerMonth = Number(config.requestsPerMonth);
  const canStart =
    promptsValid &&
    selected.length > 0 &&
    Number.isFinite(requestsPerMonth) &&
    requestsPerMonth > 0 &&
    !starting &&
    !busy;

  function toggleCandidate(key: string, on: boolean) {
    setSelected((prev) =>
      on ? (prev.includes(key) ? prev : [...prev, key]) : prev.filter((k) => k !== key)
    );
  }

  async function startRun() {
    if (!canStart) return;
    setStarting(true);
    try {
      const r = await apiPost<{ ok: boolean; id: string }>("/api/fit", {
        prompts,
        candidates: selected,
        config: {
          requestsPerMonth: Math.max(0, Number(config.requestsPerMonth) || 0),
          pricePerMillionIn: Math.max(0, Number(config.pricePerMillionIn) || 0),
          pricePerMillionOut: Math.max(0, Number(config.pricePerMillionOut) || 0),
          hardwareMonthlyCost: Math.max(0, Number(config.hardwareMonthlyCost) || 0),
          judge: config.judge,
        },
      });
      toast.success("Evaluation queued — measuring on this node.");
      selectRun(r.id, "queued");
      void loadRuns();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not start the evaluation.");
    } finally {
      setStarting(false);
    }
  }

  async function cancelRun() {
    if (!activeId || cancelling) return;
    setCancelling(true);
    try {
      await apiDelete(`/api/fit/${activeId}`);
      toast.success("Evaluation cancelled.");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Cancel failed.");
    } finally {
      setCancelling(false);
    }
  }

  function resetWizard() {
    activeIdRef.current = null;
    prevStatusRef.current = null;
    setActiveId(null);
    setActiveRun(null);
    setPromptsText("");
    setSelected([]);
    setConfig({ ...DEFAULT_CONFIG });
    scrollRef.current?.scrollTo({ top: 0, behavior: "smooth" });
  }

  function openFromHistory(r: FitRunSummary) {
    selectRun(r.id, r.status);
    // On narrow layouts the results live below the wizard — bring them into view.
    if (typeof window !== "undefined" && window.matchMedia("(max-width: 1023px)").matches) {
      resultsRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Header */}
      <div className="flex shrink-0 items-center gap-2 border-b bg-card/60 px-4 py-2.5">
        <Gauge className="size-4 shrink-0 text-primary" aria-hidden />
        <h1 className="text-sm font-semibold">Fit</h1>
        <p className="hidden truncate text-xs text-muted-foreground sm:block">
          Should this workload run local? Measure it against your own prompts.
        </p>
      </div>

      {/* Body — wizard on the left, results on the right; stacked on mobile */}
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">
        <div className="mx-auto grid max-w-6xl items-start gap-4 p-3 sm:p-4 lg:grid-cols-[minmax(320px,400px)_minmax(0,1fr)]">
          {/* Left column */}
          <div className="min-w-0 space-y-4">
            {isAuditor ? (
              <Card className="gap-2 rounded-lg py-4">
                <CardContent className="flex items-start gap-2.5 px-4">
                  <Eye className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    Auditors can review evaluation results. Starting new runs is limited to members and admins.
                  </p>
                </CardContent>
              </Card>
            ) : (
              <Card className="gap-4 rounded-lg py-4">
                <CardHeader className="px-4">
                  <CardTitle className="text-sm">New evaluation</CardTitle>
                  <CardDescription className="text-xs">
                    Replay your real prompts on this node and compare the cost.
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-5 px-4">
                  {/* Step 1 — prompts */}
                  <section className="space-y-2" aria-label="Step 1: prompts">
                    <StepHeader
                      n={1}
                      title="Prompts"
                      right={
                        <Badge
                          variant="outline"
                          className={`tabular text-[10px] ${
                            promptsValid ? "text-muted-foreground" : "border-destructive/40 bg-destructive/5 text-destructive"
                          }`}
                        >
                          {promptCount} prompts · min {MIN_PROMPTS}, max {MAX_PROMPTS}
                        </Badge>
                      }
                    />
                    <Textarea
                      value={promptsText}
                      onChange={(e) => setPromptsText(e.target.value)}
                      placeholder={"One prompt per line — use your real workload.\nE.g. Summarize this quarter's support tickets…"}
                      rows={7}
                      aria-label="Prompts, one per line"
                      aria-invalid={promptCount > 0 && !promptsValid}
                      className="min-h-28 max-h-64 resize-none text-sm scrollbar-thin"
                    />
                    {promptCount === 0 ? (
                      <p className="text-[11px] text-muted-foreground">
                        Each non-empty line becomes one measured request.
                      </p>
                    ) : promptCount < MIN_PROMPTS ? (
                      <p className="text-[11px] text-destructive">
                        Add {MIN_PROMPTS - promptCount} more prompt{MIN_PROMPTS - promptCount === 1 ? "" : "s"} to start.
                      </p>
                    ) : promptCount > MAX_PROMPTS ? (
                      <p className="text-[11px] text-destructive">
                        Too many prompts — keep at most {MAX_PROMPTS} lines.
                      </p>
                    ) : (
                      <p className="text-[11px] text-muted-foreground">
                        These will be replayed against every candidate you pick.
                      </p>
                    )}
                  </section>

                  {/* Step 2 — candidates */}
                  <section className="space-y-2" aria-label="Step 2: candidate models">
                    <StepHeader
                      n={2}
                      title="Candidates"
                      right={
                        <Badge variant="outline" className="tabular text-[10px] text-muted-foreground">
                          {selected.length} selected
                        </Badge>
                      }
                    />
                    {models === null ? (
                      <div className="space-y-1.5">
                        {[0, 1, 2].map((i) => (
                          <Skeleton key={i} className="h-11 w-full" />
                        ))}
                      </div>
                    ) : availableModels.length === 0 ? (
                      <p className="text-xs text-muted-foreground">
                        No approved models installed — install one from the Models screen first.
                      </p>
                    ) : (
                      <div
                        className="max-h-64 space-y-1.5 overflow-y-auto scrollbar-thin pr-1"
                        role="group"
                        aria-label="Candidate models"
                      >
                        {availableModels.map((m) => (
                          <label
                            key={m.key}
                            className="flex cursor-pointer items-center gap-2.5 rounded-md border p-2.5 transition-colors hover:bg-accent/50 has-[[data-state=checked]]:border-primary/40 has-[[data-state=checked]]:bg-primary/5"
                          >
                            <Checkbox
                              checked={selected.includes(m.key)}
                              onCheckedChange={(c) => toggleCandidate(m.key, c === true)}
                              aria-label={`Include ${m.name} as a candidate`}
                            />
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-sm">{m.name}</span>
                              <span className="block text-[10px] text-muted-foreground">
                                {m.family} · {m.paramsB}B · {m.quant}
                              </span>
                            </span>
                            <ProviderBadge provider={m.provider} />
                          </label>
                        ))}
                      </div>
                    )}
                    {availableModels.length > 0 && selected.length === 0 && (
                      <p className="text-[11px] text-muted-foreground">Pick at least one model to evaluate.</p>
                    )}
                  </section>

                  {/* Step 3 — assumptions (your numbers, not measurements) */}
                  <section className="space-y-2.5" aria-label="Step 3: your assumptions">
                    <StepHeader n={3} title="Your assumptions" />
                    <div className="grid grid-cols-2 gap-3">
                      <div className="space-y-1.5">
                        <Label htmlFor="fit-requests" className="text-xs">
                          Requests / month
                        </Label>
                        <Input
                          id="fit-requests"
                          type="number"
                          min={1}
                          step={500}
                          inputMode="numeric"
                          className="h-9 tabular text-sm"
                          value={config.requestsPerMonth}
                          onChange={(e) => setConfig({ ...config, requestsPerMonth: e.target.value })}
                        />
                      </div>
                      <div className="space-y-1.5">
                        <Label htmlFor="fit-hardware" className="text-xs">
                          Hardware cost / month
                        </Label>
                        <Input
                          id="fit-hardware"
                          type="number"
                          min={0}
                          step={5}
                          className="h-9 tabular text-sm"
                          value={config.hardwareMonthlyCost}
                          onChange={(e) => setConfig({ ...config, hardwareMonthlyCost: e.target.value })}
                        />
                        <p className="text-[10px] leading-snug text-muted-foreground">
                          Amortized cost of running the hardware, if any.
                        </p>
                      </div>
                      <div className="space-y-1.5">
                        <Label htmlFor="fit-price-in" className="text-xs">
                          Cloud $ / M tokens in
                        </Label>
                        <Input
                          id="fit-price-in"
                          type="number"
                          min={0}
                          step={0.5}
                          className="h-9 tabular text-sm"
                          value={config.pricePerMillionIn}
                          onChange={(e) => setConfig({ ...config, pricePerMillionIn: e.target.value })}
                        />
                      </div>
                      <div className="space-y-1.5">
                        <Label htmlFor="fit-price-out" className="text-xs">
                          Cloud $ / M tokens out
                        </Label>
                        <Input
                          id="fit-price-out"
                          type="number"
                          min={0}
                          step={0.5}
                          className="h-9 tabular text-sm"
                          value={config.pricePerMillionOut}
                          onChange={(e) => setConfig({ ...config, pricePerMillionOut: e.target.value })}
                        />
                      </div>
                      <p className="col-span-2 text-[10px] leading-snug text-muted-foreground">
                        Your actual cloud API pricing per million tokens.
                      </p>
                    </div>
                    <div className="flex items-start justify-between gap-3 rounded-md border p-3">
                      <div className="space-y-0.5">
                        <Label htmlFor="fit-judge" className="text-xs">
                          Quality judge
                        </Label>
                        <p className="text-[10px] leading-snug text-muted-foreground">
                          Score response quality with an on-device LLM judge (measured, not invented).
                        </p>
                      </div>
                      <Switch
                        id="fit-judge"
                        checked={config.judge}
                        onCheckedChange={(v) => setConfig({ ...config, judge: v })}
                        aria-label="Score response quality with an on-device judge"
                      />
                    </div>
                  </section>

                  {/* Run */}
                  <div className="space-y-1.5 border-t pt-4">
                    <Button className="w-full" onClick={() => void startRun()} disabled={!canStart}>
                      {starting ? (
                        <Loader2 className="size-4 animate-spin" aria-hidden />
                      ) : (
                        <Play className="size-4" aria-hidden />
                      )}
                      {starting ? "Queueing evaluation…" : "Run evaluation"}
                    </Button>
                    {busy && (
                      <p className="text-center text-[11px] text-muted-foreground">
                        An evaluation is already running — watch it finish in the results panel.
                      </p>
                    )}
                    {!busy && Number.isFinite(requestsPerMonth) && requestsPerMonth <= 0 && (
                      <p className="text-center text-[11px] text-destructive">
                        Enter your expected monthly requests.
                      </p>
                    )}
                  </div>
                </CardContent>
              </Card>
            )}

            {/* History */}
            <Card className="gap-3 rounded-lg py-4">
              <CardHeader className="px-4">
                <CardTitle className="flex items-center gap-1.5 text-sm">
                  <History className="size-3.5 text-muted-foreground" aria-hidden />
                  Past evaluations
                </CardTitle>
              </CardHeader>
              <CardContent className="px-4">
                {runs === null ? (
                  <div className="space-y-1.5">
                    {[0, 1, 2].map((i) => (
                      <Skeleton key={i} className="h-12 w-full" />
                    ))}
                  </div>
                ) : runs.length === 0 ? (
                  <p className="py-2 text-xs text-muted-foreground">
                    {isAuditor
                      ? "No evaluations have been run on this node yet."
                      : "Nothing yet — finished runs land here."}
                  </p>
                ) : (
                  <div className="max-h-72 space-y-1.5 overflow-y-auto scrollbar-thin pr-1">
                    {runs.map((r) => (
                      <button
                        key={r.id}
                        type="button"
                        onClick={() => openFromHistory(r)}
                        aria-pressed={activeId === r.id}
                        className={`w-full rounded-md border px-2.5 py-2 text-left transition-colors ${
                          activeId === r.id ? "border-primary/40 bg-primary/5" : "hover:bg-accent/50"
                        }`}
                      >
                        <span className="flex items-center gap-2">
                          <StatusBadge status={r.status} />
                          <span className="ml-auto tabular text-[10px] text-muted-foreground">
                            {fmtDateShort(r.createdAt)}
                          </span>
                        </span>
                        <span className="mt-1 block tabular text-xs text-muted-foreground">
                          {promptCountOf(r)} prompts · {r.candidates.length} model{r.candidates.length === 1 ? "" : "s"}
                          {r.status === "running" || r.status === "queued" ? ` · ${r.progress}/${r.total}` : ""}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </div>

          {/* Right column — progress / results */}
          <section ref={resultsRef} className="min-w-0 space-y-4" aria-label="Evaluation results">
            {activeId === null ? (
              runs === null ? (
                <Skeleton className="h-72 w-full rounded-lg" />
              ) : runs.length === 0 ? (
                <EmptyState />
              ) : (
                <PlaceholderState />
              )
            ) : activeRun === null ? (
              <Skeleton className="h-72 w-full rounded-lg" />
            ) : activeRun.status === "queued" || activeRun.status === "running" ? (
              <RunningCard
                run={activeRun}
                labelFor={labelFor}
                onCancel={() => void cancelRun()}
                cancelling={cancelling}
              />
            ) : activeRun.status === "error" ? (
              <ErrorCard run={activeRun} />
            ) : activeRun.status === "cancelled" ? (
              <CancelledCard run={activeRun} />
            ) : (
              <ResultsView run={activeRun} isAuditor={isAuditor} onReset={resetWizard} />
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

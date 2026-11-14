"use client";

/**
 * Console entry flows: boot splash, PWA registration, login, first-run setup wizard and the application shell.
 *
 * Merged module (v1.0.2 repository consolidation — zero behavior change).
 * Sections:
 *   1. Brand marks + boot splash
 *   2. PWA service-worker registration
 *   3. Login screen
 *   4. First-run setup wizard
 *   5. Application shell (nav, tabs, theme)
 */

import { useEffect, useMemo, useState } from "react";
import { Badge, Button, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger, Input, Label, Progress, Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui";
import { apiGet, apiPost, SCREEN_META, type CatalogModel, type EngineCandidate, type EngineStatus, type Screen, type SessionUser, type SetupStatus, type WorkspaceInfo, useLester } from "@/lib/client";
import { toast } from "sonner";
import { Activity, Boxes, Check, CheckCircle2, Cpu, FileText, Fingerprint, Gauge, HardDrive, LayoutGrid, LogOut, MemoryStick, MessageSquare, MonitorSmartphone, Moon, MoreHorizontal, Plus, RefreshCw, Scale, Settings as SettingsIcon, ShieldCheck, Sun, Users as UsersIcon, Zap } from "lucide-react";
import { ChatScreen } from "@/components/console/chat";
import { KnowledgeScreen, PolicyScreen } from "@/components/console/governance";
import { ModelsScreen, UsersScreen } from "@/components/console/people";
import { HealthScreen, ProofScreen } from "@/components/console/ops";
import { FitScreen } from "@/components/console/fit";
import { SettingsScreen } from "@/components/console/settings";
import { useTheme } from "next-themes";


// ═══ Brand marks + boot splash ═══════════════════════════════════════════════════
// merged from src/components/console/BootSplash.tsx

export function BrandMark({ size = 28, className }: { size?: number; className?: string }) {
  return (
    <svg viewBox="0 0 64 64" width={size} height={size} className={className} role="img" aria-label="Lester mark">
      <rect x="6" y="6" width="52" height="52" rx="13" fill="currentColor" opacity={0.98} />
      <path d="M22 19 H33 V34 H48 V45 H22 Z" fill="var(--background)" />
      <rect x="36" y="21.5" width="9" height="9" rx="2.2" fill="currentColor" />
    </svg>
  );
}

export function Wordmark({ size = 20 }: { size?: number }) {
  return (
    <span className="font-semibold tracking-tight" style={{ fontSize: size }}>
      Lester
    </span>
  );
}

export function BootSplash() {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center gap-4 bg-background text-primary">
      <BrandMark size={48} />
      <div className="text-sm text-muted-foreground">Starting your private AI control plane…</div>
    </div>
  );
}

// ═══ PWA service-worker registration ═════════════════════════════════════════════
// merged from src/components/console/PwaRegister.tsx

export function PwaRegister() {
  useEffect(() => {
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js").catch(() => undefined);
    }
  }, []);
  return null;
}

// ═══ Login screen ════════════════════════════════════════════════════════════════
// merged from src/components/console/LoginScreen.tsx

export function LoginScreen({ onLogin }: { onLogin: (user: SessionUser) => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    try {
      const res = await apiPost<{ ok: true; user: SessionUser }>("/api/auth/login", { username, password });
      toast.success(`Welcome back, ${res.user.displayName}`);
      onLogin(res.user);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Sign-in failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-screen flex flex-col items-center justify-center gap-8 bg-background p-4">
      <div className="flex flex-col items-center gap-3">
        <div className="text-primary">
          <BrandMark size={56} />
        </div>
        <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
          <Wordmark size={26} /> <span className="text-muted-foreground font-normal">Console</span>
        </h1>
        <p className="text-sm text-muted-foreground text-center max-w-xs">
          Your AI. Your hardware. Your proof.
        </p>
      </div>
      <form onSubmit={submit} className="w-full max-w-sm space-y-4 bg-card border rounded-lg p-6 shadow-sm">
        <div className="space-y-2">
          <Label htmlFor="username">Username</Label>
          <Input
            id="username"
            autoComplete="username"
            autoFocus
            required
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="admin"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="password">Password</Label>
          <Input
            id="password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>
        <Button type="submit" className="w-full" disabled={busy}>
          {busy ? "Signing in…" : "Sign in"}
        </Button>
        <p className="text-xs text-muted-foreground text-center leading-relaxed">
          Local accounts only. Sessions stay on this machine.
        </p>
      </form>
    </div>
  );
}

// ═══ First-run setup wizard ══════════════════════════════════════════════════════
// merged from src/components/console/SetupWizard.tsx

const STEPS = ["Hardware & engine", "Admin account", "Model", "Done"] as const;

function fmtMb(mb: number): string {
  return `${(mb / 1024).toFixed(1)} GB`;
}

export function SetupWizard({ status: initialStatus, onDone }: { status: SetupStatus; onDone: (user: SessionUser) => void }) {
  const [status, setStatus] = useState(initialStatus);
  const [detecting, setDetecting] = useState(false);
  const [step, setStep] = useState(0);
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [workspaceName, setWorkspaceName] = useState("General");
  const reachable = status.detection.filter((d) => d.reachable);
  const connected = status.engine.type === "openai-compat" && status.engine.reachable;
  const [engineUrl, setEngineUrl] = useState<string>(reachable[0]?.url ?? "");
  const [modelKey, setModelKey] = useState<string>(reachable[0]?.models[0] ? `local:${reachable[0].models[0]}` : "");
  const [busy, setBusy] = useState(false);
  const hw = status.hardware;

  async function rescan() {
    setDetecting(true);
    try {
      const res = await fetch("/api/setup/status", { cache: "no-store" });
      const next = (await res.json()) as SetupStatus;
      setStatus(next);
      const first = next.detection.find((d) => d.reachable);
      setEngineUrl((prev) => prev || first?.url || "");
      setModelKey((prev) => prev || (first?.models[0] ? `local:${first.models[0]}` : ""));
      toast.success(first ? `Engine found: ${first.label} (${first.url})` : "Still no engine detected — install one, then rescan.");
    } catch {
      toast.error("Detection failed — is the server reachable?");
    } finally {
      setDetecting(false);
    }
  }

  const engineModels = useMemo(() => {
    const found: { key: string; name: string }[] = [];
    for (const d of reachable) {
      for (const m of d.models) found.push({ key: `local:${m}`, name: m });
    }
    return found;
  }, [reachable]);

  const selectedCatalog: CatalogModel | undefined = useMemo(
    () => status.recommendations.find((r) => r.catalogModel.key === modelKey)?.catalogModel,
    [modelKey, status.recommendations]
  );

  const canCreate =
    /^[a-z0-9_.-]{3,32}$/.test(username) &&
    password.length >= 10 &&
    /[a-zA-Z]/.test(password) &&
    /[0-9]/.test(password) &&
    workspaceName.trim().length > 0;

  async function create() {
    if (!canCreate || busy) return;
    setBusy(true);
    try {
      const chosenEngine = reachable.find((d) => d.url === engineUrl);
      const res = await apiPost<{ ok: true; user: SessionUser }>("/api/setup/complete", {
        adminUsername: username,
        adminDisplayName: displayName || username,
        adminPassword: password,
        workspaceName,
        ...(modelKey ? { modelKey } : {}),
        ...(chosenEngine ? { engineUrl: chosenEngine.url, engineAdapter: chosenEngine.adapter } : {}),
      });
      toast.success(
        chosenEngine
          ? "Lester is ready. Your control plane is live with a local engine."
          : "Lester is ready. Connect an engine in Settings → Engine whenever you like."
      );
      onDone(res.user);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Setup failed.");
      setBusy(false);
    }
  }

  return (
    <div className="min-h-screen flex flex-col bg-background">
      <header className="border-b bg-card">
        <div className="max-w-2xl mx-auto px-4 h-14 flex items-center gap-3">
          <div className="text-primary"><BrandMark size={26} /></div>
          <span className="font-semibold tracking-tight">Lester</span>
          <span className="text-muted-foreground text-sm hidden sm:inline">first-run setup</span>
          <div className="ml-auto flex items-center gap-1.5" aria-label={`Step ${step + 1} of 4`}>
            {STEPS.map((s, i) => (
              <div
                key={s}
                className={`h-1.5 rounded-full transition-all ${i <= step ? "w-6 bg-primary" : "w-3 bg-border"}`}
                title={s}
              />
            ))}
          </div>
        </div>
      </header>

      <main className="flex-1 flex items-start sm:items-center justify-center p-4 overflow-y-auto scrollbar-thin">
        <div className="w-full max-w-2xl bg-card border rounded-lg shadow-sm p-6 sm:p-8 space-y-6 my-4">
          {step === 0 && (
            <>
              <div>
                <h2 className="text-lg font-semibold">This machine, scanned</h2>
                <p className="text-sm text-muted-foreground mt-1">
                  Lester needs a local inference engine to run models. It looked for Ollama, LM Studio, llama.cpp and vLLM on the usual ports — results below, with instructions if nothing answered yet.
                </p>
              </div>
              <Progress value={100} className="h-1" aria-hidden />
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {[
                  { icon: Cpu, label: "Processor", value: `${hw.cpu.model}`, sub: `${hw.cpu.cores} cores · ${hw.arch}` },
                  { icon: MemoryStick, label: "Memory", value: `${fmtMb(hw.ram.totalMb)} total`, sub: `${fmtMb(hw.ram.freeMb)} free now` },
                  { icon: HardDrive, label: "Disk", value: `${hw.disk.totalGb} GB total`, sub: `${hw.disk.freeGb} GB free · ${hw.disk.path}` },
                  { icon: MonitorSmartphone, label: "System", value: hw.os, sub: hw.gpus.length > 0 ? hw.gpus.map((g) => g.name).join(", ") : "No discrete GPU detected" },
                ].map((row) => (
                  <div key={row.label} className="border rounded-lg p-4 flex gap-3">
                    <row.icon className="size-5 text-primary shrink-0 mt-0.5" aria-hidden />
                    <div className="min-w-0">
                      <div className="text-xs text-muted-foreground">{row.label}</div>
                      <div className="text-sm font-medium truncate">{row.value}</div>
                      <div className="text-xs text-muted-foreground truncate">{row.sub}</div>
                    </div>
                  </div>
                ))}
              </div>

              <div className={`border rounded-lg p-4 ${reachable.length > 0 ? "border-primary/30 bg-primary/5" : "border-amber-500/40 bg-amber-500/5"}`}>
                <div className="flex items-start gap-3">
                  <Zap className={`size-5 shrink-0 mt-0.5 ${reachable.length > 0 ? "text-primary" : "text-amber-600"}`} aria-hidden />
                  <div className="text-sm flex-1 min-w-0">
                    <div className="font-medium flex items-center gap-2 flex-wrap">
                      {reachable.length > 0 ? "Local engine detected" : "No local engine found (yet)"}
                      <Button variant="outline" size="sm" onClick={rescan} disabled={detecting} className="h-6 px-2 text-xs">
                        <RefreshCw className={`size-3 mr-1 ${detecting ? "animate-spin" : ""}`} aria-hidden />
                        Rescan
                      </Button>
                    </div>
                    {reachable.length > 0 ? (
                      <div className="mt-2 space-y-1.5">
                        {reachable.map((d) => (
                          <label key={d.url} className="flex items-center gap-2 text-xs cursor-pointer">
                            <input
                              type="radio"
                              name="engine"
                              checked={engineUrl === d.url}
                              onChange={() => setEngineUrl(d.url)}
                              aria-label={`Use ${d.label} at ${d.url}`}
                            />
                            <span className="font-medium">{d.label}</span>
                            <span className="text-muted-foreground truncate">{d.url} · {d.models.length} model{d.models.length === 1 ? "" : "s"} served</span>
                          </label>
                        ))}
                      </div>
                    ) : (
                      <div className="text-muted-foreground text-xs mt-1 space-y-1.5">
                        <p>Nothing to fix — you can finish setup now and connect an engine later in Settings → Engine. To get a working engine in about two minutes, pick one:</p>
                        <ul className="list-disc pl-4 space-y-1">
                          {status.adapterGuide.filter((g) => g.id !== "generic").map((g) => (
                            <li key={g.id}><span className="font-medium text-foreground">{g.label}:</span> {g.note}</li>
                          ))}
                        </ul>
                        <p className="text-muted-foreground">Then press <span className="font-medium text-foreground">Rescan</span> — Lester finds it automatically.</p>
                      </div>
                    )}
                  </div>
                </div>
              </div>
              <div className="flex justify-end">
                <Button onClick={() => setStep(1)}>Continue <span aria-hidden>→</span></Button>
              </div>
            </>
          )}

          {step === 1 && (
            <>
              <div>
                <h2 className="text-lg font-semibold">Create the admin account</h2>
                <p className="text-sm text-muted-foreground mt-1">
                  Local account, scrypt-hashed, stored only on this machine. This becomes the first admin of your Lester node.
                </p>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="su">Username</Label>
                  <Input id="su" autoFocus value={username} onChange={(e) => setUsername(e.target.value.toLowerCase())} placeholder="admin" autoComplete="username" />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="sd">Display name (optional)</Label>
                  <Input id="sd" value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="Ops Lead" />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="sp">Password</Label>
                  <Input id="sp" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
                  <p className="text-xs text-muted-foreground">10+ characters with letters and numbers; common passwords are rejected.</p>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="sw">First workspace name</Label>
                  <Input id="sw" value={workspaceName} onChange={(e) => setWorkspaceName(e.target.value)} />
                  <p className="text-xs text-muted-foreground">Workspaces isolate models, documents and policy.</p>
                </div>
              </div>
              <div className="flex justify-between">
                <Button variant="outline" onClick={() => setStep(0)}>Back</Button>
                <Button onClick={() => setStep(2)} disabled={!canCreate}>Continue</Button>
              </div>
            </>
          )}

          {step === 2 && (
            <>
              <div>
                <h2 className="text-lg font-semibold">Pick your first model</h2>
                <p className="text-sm text-muted-foreground mt-1">
                  {connected || reachable.length > 0
                    ? "Models served by your engine right now — no download needed."
                    : "Catalog picks with hardware-fit from the scan; they download through your engine once it is connected. You can also skip this and choose later."}
                </p>
              </div>
              <div className="space-y-2 max-h-96 overflow-y-auto scrollbar-thin pr-1">
                {engineModels.map((m) => (
                  <button
                    key={m.key}
                    type="button"
                    onClick={() => setModelKey(m.key)}
                    className={`w-full text-left border rounded-lg p-4 transition-colors ${modelKey === m.key ? "border-primary bg-primary/5" : "hover:bg-accent"}`}
                    aria-pressed={modelKey === m.key}
                  >
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium text-sm">{m.name}</span>
                      <Badge variant="secondary">on your engine</Badge>
                      {modelKey === m.key && <CheckCircle2 className="size-4 text-primary ml-auto" aria-hidden />}
                    </div>
                    <p className="text-xs text-muted-foreground mt-1">Already installed on the engine — zero download.</p>
                  </button>
                ))}
                {status.recommendations.map(({ catalogModel, fit }) => (
                  <button
                    key={catalogModel.key}
                    type="button"
                    onClick={() => setModelKey(catalogModel.key)}
                    className={`w-full text-left border rounded-lg p-4 transition-colors ${modelKey === catalogModel.key ? "border-primary bg-primary/5" : "hover:bg-accent"}`}
                    aria-pressed={modelKey === catalogModel.key}
                    disabled={fit.level === "no"}
                  >
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium text-sm">{catalogModel.name}</span>
                      <Badge variant="outline">{catalogModel.quant}</Badge>
                      <Badge
                        variant={fit.level === "fit" ? "default" : fit.level === "tight" ? "secondary" : "destructive"}
                        className={fit.level === "tight" ? "text-amber-700 dark:text-amber-400" : ""}
                      >
                        {fit.label}
                      </Badge>
                      {modelKey === catalogModel.key && <CheckCircle2 className="size-4 text-primary ml-auto" aria-hidden />}
                    </div>
                    <p className="text-xs text-muted-foreground mt-1">
                      {catalogModel.note} · ≈{(catalogModel.sizeMb / 1024).toFixed(1)} GB download · {fit.reason}
                    </p>
                  </button>
                ))}
              </div>
              <div className="flex justify-between">
                <Button variant="outline" onClick={() => setStep(1)}>Back</Button>
                <Button onClick={() => setStep(3)} disabled={!modelKey}>Review</Button>
              </div>
            </>
          )}

          {step === 3 && (
            <>
              <div>
                <h2 className="text-lg font-semibold">Ready to go</h2>
                <p className="text-sm text-muted-foreground mt-1">
                  One admin, one workspace, secure defaults: local-only routing, PII redaction on, cloud fallback off, no telemetry — ever.
                </p>
              </div>
              <div className="border rounded-lg divide-y text-sm">
                {([
                  ["Admin", username],
                  ["Workspace", workspaceName],
                  ["Engine", reachable.find((d) => d.url === engineUrl)?.label ?? "not connected yet (Settings → Engine later)"],
                  ["Model", engineModels.some((m) => m.key === modelKey) ? engineModels.find((m) => m.key === modelKey)!.name : selectedCatalog?.name ?? (modelKey || "none yet")],
                  ...(selectedCatalog && !engineModels.some((m) => m.key === modelKey)
                    ? ([["Download", `≈${(selectedCatalog.sizeMb / 1024).toFixed(1)} GB via your engine`]] as [string, string][])
                    : []),
                  ["Policy", "Local only · redaction on · cloud off"],
                ] as [string, string][]).map(([k, v]) => (
                  <div key={k} className="flex justify-between gap-4 px-4 py-2.5">
                    <span className="text-muted-foreground">{k}</span>
                    <span className="font-medium text-right">{v}</span>
                  </div>
                ))}
              </div>
              <div className="border rounded-lg p-4 flex gap-3 bg-primary/5">
                <ShieldCheck className="size-5 text-primary shrink-0 mt-0.5" aria-hidden />
                <p className="text-xs text-muted-foreground">
                  From this moment, every request is recorded in the tamper-evident Proof ledger: which model handled it, where it ran, whether any byte left the machine.
                </p>
              </div>
              <div className="flex justify-between">
                <Button variant="outline" onClick={() => setStep(2)}>Back</Button>
                <Button onClick={create} disabled={!canCreate || busy}>
                  {busy ? "Creating…" : "Start Lester"}
                </Button>
              </div>
            </>
          )}
        </div>
      </main>

      <footer className="border-t bg-card">
        <div className="max-w-2xl mx-auto px-4 h-10 flex items-center justify-between text-xs text-muted-foreground">
          <span>Lester {status.version} · private AI control plane</span>
          <span className="hidden sm:inline">License: {status.license.tier === "free" ? "Free single-user" : "Team"}</span>
        </div>
      </footer>
    </div>
  );
}

// ═══ Application shell (nav, tabs, theme) ════════════════════════════════════════
// merged from src/components/console/Shell.tsx

const NAV: { screen: Screen; icon: typeof MessageSquare; adminOnly?: boolean; auditorVisible?: boolean }[] = [
  { screen: "chat", icon: MessageSquare },
  { screen: "knowledge", icon: FileText },
  { screen: "models", icon: Boxes },
  { screen: "fit", icon: Gauge },
  { screen: "policy", icon: Scale },
  { screen: "proof", icon: Fingerprint, auditorVisible: true },
  { screen: "users", icon: UsersIcon, adminOnly: true },
  { screen: "health", icon: Activity, auditorVisible: true },
  { screen: "settings", icon: SettingsIcon },
];

const MOBILE_PRIMARY: Screen[] = ["chat", "knowledge", "fit", "proof"];

export function Shell({ onLogout }: { onLogout: () => void }) {
  const { user, screen, setScreen, workspaces, workspaceId, setWorkspaceId, setWorkspaces, engine, setEngine, setUser, version, setVersion } = useLester();
  const { theme, setTheme } = useTheme();
  const [creatingWs, setCreatingWs] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);

  const role = user?.role ?? "MEMBER";
  const visibleNav = NAV.filter((n) => {
    if (n.adminOnly && role !== "ADMIN") return false;
    if (role === "AUDITOR") return Boolean(n.auditorVisible);
    return true;
  });

  useEffect(() => {
    if (!user) return;
    apiGet<{ workspaces: WorkspaceInfo[] }>("/api/workspaces")
      .then((r) => setWorkspaces(r.workspaces))
      .catch(() => undefined);
    apiGet<{ engine: EngineStatus; version: string }>("/api/settings")
      .then((r) => {
        setEngine(r.engine);
        if (r.version) setVersion(r.version);
      })
      .catch(() => setEngine(null));
  }, [user, setWorkspaces, setEngine, setVersion]);

  useEffect(() => {
    if (role === "AUDITOR" && screen !== "proof" && screen !== "health") setScreen("proof");
  }, [role, screen, setScreen]);

  async function logout() {
    await apiPost("/api/auth/logout").catch(() => undefined);
    onLogout();
  }

  async function createWorkspace() {
    const name = window.prompt("Workspace name");
    if (!name?.trim()) return;
    setCreatingWs(true);
    try {
      await apiPost("/api/workspaces", { name: name.trim() });
      const r = await apiGet<{ workspaces: WorkspaceInfo[] }>("/api/workspaces");
      setWorkspaces(r.workspaces);
      toast.success(`Workspace “${name.trim()}” created with local-only policy.`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not create workspace.");
    } finally {
      setCreatingWs(false);
    }
  }

  const activeWorkspace = workspaces.find((w) => w.id === workspaceId) ?? null;
  const engineOk = engine?.reachable ?? false;

  const renderScreen = () => {
    switch (screen) {
      case "chat": return <ChatScreen />;
      case "knowledge": return <KnowledgeScreen />;
      case "models": return <ModelsScreen />;
      case "fit": return <FitScreen />;
      case "policy": return <PolicyScreen />;
      case "proof": return <ProofScreen />;
      case "users": return <UsersScreen />;
      case "health": return <HealthScreen />;
      case "settings": return <SettingsScreen onLogout={logout} />;
      default: return null;
    }
  };

  const navButton = (n: (typeof NAV)[number], mobile = false) => (
    <button
      key={n.screen}
      onClick={() => {
        setScreen(n.screen);
        setMoreOpen(false);
      }}
      className={`flex items-center gap-3 rounded-md text-sm transition-colors w-full ${
        mobile ? "flex-col gap-1 py-1 text-[11px]" : "px-3 py-2"
      } ${screen === n.screen ? "bg-primary/10 text-primary font-medium" : "text-muted-foreground hover:bg-accent hover:text-accent-foreground"}`}
      aria-current={screen === n.screen ? "page" : undefined}
    >
      <n.icon className={mobile ? "size-5" : "size-4"} aria-hidden />
      <span>{SCREEN_META[n.screen].label}</span>
    </button>
  );

  return (
    <div className="h-dvh flex flex-col bg-background overflow-hidden">
      {/* Top bar */}
      <header className="h-12 shrink-0 border-b bg-card flex items-center gap-2 px-3 sm:px-4">
        <div className="flex items-center gap-2 text-primary">
          <BrandMark size={22} />
        </div>
        <span className="font-semibold tracking-tight text-sm hidden xs:inline">Lester</span>

        {/* Workspace switcher */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm" className="ml-1 sm:ml-3 gap-2 max-w-40 sm:max-w-56">
              <LayoutGrid className="size-3.5 text-muted-foreground" aria-hidden />
              <span className="truncate font-normal">{activeWorkspace?.name ?? "—"}</span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-60">
            <DropdownMenuLabel className="text-xs">Workspaces</DropdownMenuLabel>
            {workspaces.map((w) => (
              <DropdownMenuItem key={w.id} onClick={() => setWorkspaceId(w.id)} className="gap-2">
                {w.id === workspaceId ? <Check className="size-3.5 text-primary" aria-hidden /> : <span className="size-3.5" />}
                <span className="flex-1 truncate">{w.name}</span>
                <span className="text-[10px] text-muted-foreground">{w.documents} docs</span>
              </DropdownMenuItem>
            ))}
            {role === "ADMIN" && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={createWorkspace} disabled={creatingWs}>
                  <Plus className="size-3.5" aria-hidden /> New workspace
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>

        <div className="ml-auto flex items-center gap-1.5">
          {/* Engine status */}
          <span
            className={`inline-flex items-center gap-1.5 text-xs text-muted-foreground px-2 py-1 rounded-md border ${engineOk ? "border-primary/25 bg-primary/5" : "border-destructive/30 bg-destructive/5"}`}
            title={engine ? `${engine.label} — ${engine.url}${engine.error ? ` (${engine.error})` : ""}` : "Engine status unknown"}
          >
            <span className={`size-1.5 rounded-full ${engineOk ? "bg-primary animate-pulse" : "bg-destructive"}`} aria-hidden />
            <span className="hidden sm:inline">{engineOk ? "engine up" : "engine down"}</span>
          </span>

          {/* Theme toggle */}
          <Button variant="ghost" size="icon" onClick={() => setTheme(theme === "dark" ? "light" : "dark")} aria-label="Toggle theme">
            {theme === "dark" ? <Sun className="size-4" aria-hidden /> : <Moon className="size-4" aria-hidden />}
          </Button>

          {/* User menu */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm" className="gap-2">
                <span className="size-6 rounded-full bg-primary/10 text-primary grid place-items-center text-xs font-semibold" aria-hidden>
                  {(user?.displayName ?? "?").slice(0, 1).toUpperCase()}
                </span>
                <span className="hidden sm:inline text-xs">{user?.displayName}</span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-52">
              <DropdownMenuLabel className="text-xs">
                <div>{user?.displayName}</div>
                <div className="text-muted-foreground font-normal">@{user?.username}</div>
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={logout}>
                <LogOut className="size-3.5" aria-hidden /> Sign out
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>

      {/* Body */}
      <div className="flex-1 min-h-0 flex">
        {/* Desktop sidebar */}
        <nav className="hidden md:flex w-52 shrink-0 border-r bg-card/60 flex-col p-2 gap-1" aria-label="Main navigation">
          {visibleNav.map((n) => navButton(n))}
          <div className="mt-auto p-2 text-[11px] text-muted-foreground leading-relaxed">
            {role === "AUDITOR" ? (
              <Badge variant="outline">Auditor · read-only</Badge>
            ) : (
              <span>Policy: {activeWorkspace?.policyMode === "LOCAL_ONLY" ? "local-only" : activeWorkspace?.policyMode === "CLOUD_FALLBACK" ? "cloud fallback" : activeWorkspace?.policyMode === "BLOCK_ALL" ? "blocked" : "local-only"}</span>
            )}
          </div>
        </nav>

        {/* Screen content — fixed shell, internal scroll */}
        <main className="flex-1 min-w-0 min-h-0 overflow-hidden" aria-live="polite">
          {renderScreen()}
        </main>
      </div>

      {/* Mobile bottom nav */}
      <nav className="md:hidden shrink-0 border-t bg-card grid grid-cols-5 h-16" aria-label="Mobile navigation">
        {MOBILE_PRIMARY.filter((s) => visibleNav.some((n) => n.screen === s)).map((s) => {
          const n = visibleNav.find((v) => v.screen === s)!;
          return navButton(n, true);
        })}
        <Sheet open={moreOpen} onOpenChange={setMoreOpen}>
          <SheetTrigger
            className="flex flex-col items-center gap-1 py-1 text-[11px] text-muted-foreground"
            aria-label="More sections"
          >
            <MoreHorizontal className="size-5" aria-hidden />
            <span>More</span>
          </SheetTrigger>
          <SheetContent side="bottom" className="pb-6">
            <SheetHeader>
              <SheetTitle className="text-left">All sections</SheetTitle>
            </SheetHeader>
            <div className="grid grid-cols-3 gap-2 mt-2">
              {visibleNav.filter((n) => !MOBILE_PRIMARY.includes(n.screen)).map((n) => (
                <button
                  key={n.screen}
                  onClick={() => {
                    setScreen(n.screen);
                    setMoreOpen(false);
                  }}
                  className={`flex flex-col items-center gap-2 rounded-lg border p-4 text-xs ${screen === n.screen ? "border-primary text-primary" : "text-muted-foreground"}`}
                >
                  <n.icon className="size-5" aria-hidden />
                  {SCREEN_META[n.screen].label}
                </button>
              ))}
            </div>
          </SheetContent>
        </Sheet>
      </nav>

      {/* Status bar (sticky footer of the shell) */}
      <footer className="shrink-0 h-7 border-t bg-card flex items-center gap-3 px-3 text-[11px] text-muted-foreground overflow-hidden">
        <span className="truncate">{engine ? `${engine.label}${engine.reachable ? "" : " · unreachable"}` : "engine unknown"}</span>
        <span className="ml-auto shrink-0">Proof ledger: chain-checked at boot</span>
        <span className="shrink-0 hidden sm:inline">{version ? `v${version}` : ""}</span>
      </footer>
    </div>
  );
}

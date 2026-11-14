"use client";

/**
 * Settings — engine, cloud providers, data & backups, network, sessions, license and API tokens.
 *
 * Merged module (v1.0.2 repository consolidation — zero behavior change).
 * Sections:
 *   1. Settings screen
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { apiDelete, apiGet, apiPost, apiPut, type ApiTokenInfo, type BackupInfo, type EngineCandidate, type EngineStatus, type LesterSettingsDto, type LicenseInfo, type SessionInfo, type SessionUser, useLester } from "@/lib/client";
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, Badge, Button, Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Input, Label, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Separator, Skeleton, Switch, Tabs, TabsContent, TabsList, TabsTrigger, Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui";
import { toast } from "sonner";
import { Copy, Download, Globe, Info, KeyRound, Loader2, Lock, LogOut, Package, Plus, Search, ShieldAlert, ShieldCheck, Trash2 } from "lucide-react";


// ═══ Settings screen ═════════════════════════════════════════════════════════════
// merged from src/components/console/SettingsScreen.tsx

type Role = SessionUser["role"];

interface SettingsPayload {
  settings: LesterSettingsDto;
  engine: EngineStatus;
  license: LicenseInfo;
  nodeId: string;
  paths: { db: string; dataDir: string; keys: string; backups: string };
  version: string;
}

const TABS: { id: string; label: string; roles: Role[] }[] = [
  { id: "engine", label: "Engine", roles: ["ADMIN", "MEMBER"] },
  { id: "cloud", label: "Cloud", roles: ["ADMIN"] },
  { id: "backups", label: "Backups", roles: ["ADMIN"] },
  { id: "security", label: "Security", roles: ["ADMIN"] },
  { id: "api", label: "API", roles: ["ADMIN", "MEMBER"] },
  { id: "about", label: "About", roles: ["ADMIN", "MEMBER", "AUDITOR"] },
];

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

async function copyText(text: string, what: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(`${what} copied to clipboard.`);
  } catch {
    toast.error("Could not copy — clipboard unavailable.");
  }
}

function errMsg(e: unknown, fallback: string): string {
  return e instanceof Error ? e.message : fallback;
}

function uid(): string {
  return `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

// ─── Engine tab ─────────────────────────────────────────────────────────────

function EngineFormCard({
  settings,
  editable,
  onSaved,
}: {
  settings: LesterSettingsDto;
  editable: boolean;
  onSaved: () => void;
}) {
  const [type, setType] = useState<LesterSettingsDto["engine"]["type"]>(settings.engine.type);
  const [url, setUrl] = useState(settings.engine.url);
  const [label, setLabel] = useState(settings.engine.label);
  const [adapter, setAdapter] = useState<LesterSettingsDto["engine"]["adapter"]>(settings.engine.adapter);
  const [saving, setSaving] = useState(false);
  const [detecting, setDetecting] = useState(false);
  const [detection, setDetection] = useState<EngineCandidate[] | null>(null);

  useEffect(() => {
    setType(settings.engine.type);
    setUrl(settings.engine.url);
    setLabel(settings.engine.label);
    setAdapter(settings.engine.adapter);
  }, [settings]);

  const dirty =
    type !== settings.engine.type ||
    url.trim() !== settings.engine.url ||
    label.trim() !== settings.engine.label ||
    adapter !== settings.engine.adapter;

  async function detect() {
    setDetecting(true);
    try {
      const r = await apiGet<{ detection: EngineCandidate[] }>("/api/engines/detect");
      setDetection(r.detection);
      const found = r.detection.find((d) => d.reachable);
      if (found) {
        setType("openai-compat");
        setUrl(found.url);
        setAdapter((found.adapter as LesterSettingsDto["engine"]["adapter"]) ?? "generic");
        setLabel(found.label);
        toast.success(`Found ${found.label} at ${found.url} — review and save.`);
      } else {
        toast.info("No engine answered. Install Ollama/LM Studio/llama.cpp, start it, then rescan.");
      }
    } catch (e) {
      toast.error(errMsg(e, "Detection failed."));
    } finally {
      setDetecting(false);
    }
  }

  async function save() {
    setSaving(true);
    try {
      await apiPut("/api/settings", { engine: { type, url: url.trim(), label: label.trim(), adapter } });
      toast.success("Engine settings saved.");
      onSaved();
    } catch (e) {
      toast.error(errMsg(e, "Save failed."));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card className="rounded-lg gap-4 py-4">
      <CardHeader className="px-4 pb-0">
        <CardTitle className="text-sm">Engine</CardTitle>
        <CardDescription>
          {editable
            ? "Where prompts get answered — a local OpenAI-compatible engine (Ollama, LM Studio, llama.cpp, vLLM…)."
            : "Read-only — engine configuration is managed by the admins of this node."}
        </CardDescription>
      </CardHeader>
      <CardContent className="px-4 space-y-4">
        {editable && (
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" onClick={() => void detect()} disabled={detecting}>
              {detecting ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <Search className="size-3.5" aria-hidden />}
              Detect engines
            </Button>
            {detection && (
              <span className="text-[11px] text-muted-foreground self-center">
                {detection.filter((d) => d.reachable).length} of {detection.length} probed endpoints reachable
              </span>
            )}
          </div>
        )}
        {detection && detection.filter((d) => d.reachable).length > 0 && (
          <div className="border rounded-md divide-y text-xs">
            {detection.filter((d) => d.reachable).map((d) => (
              <button
                key={d.url}
                type="button"
                className="w-full text-left px-3 py-2 hover:bg-accent flex items-center gap-2"
                onClick={() => {
                  setType("openai-compat");
                  setUrl(d.url);
                  setAdapter((d.adapter as LesterSettingsDto["engine"]["adapter"]) ?? "generic");
                  setLabel(d.label);
                }}
              >
                <span className="font-medium">{d.label}</span>
                <span className="text-muted-foreground font-mono">{d.url}</span>
                <Badge variant="secondary" className="ml-auto">{d.models.length} models</Badge>
              </button>
            ))}
          </div>
        )}
        <div className="space-y-1.5">
          <Label htmlFor="engine-type">Type</Label>
          <Select
            value={type}
            onValueChange={(v) => setType(v as LesterSettingsDto["engine"]["type"])}
            disabled={!editable}
          >
            <SelectTrigger id="engine-type" className="w-full text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="openai-compat" className="text-xs">
                Local engine — Ollama / LM Studio / llama.cpp / vLLM / OpenAI-compatible URL
              </SelectItem>
              <SelectItem value="none" className="text-xs">No engine (configure later)</SelectItem>
            </SelectContent>
          </Select>
        </div>
        {type === "openai-compat" && (
          <>
            <div className="space-y-1.5">
              <Label htmlFor="engine-adapter">Kind</Label>
              <Select value={adapter} onValueChange={(v) => setAdapter(v as LesterSettingsDto["engine"]["adapter"])} disabled={!editable}>
                <SelectTrigger id="engine-adapter" className="w-full text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ollama" className="text-xs">Ollama (model installs via /api/pull)</SelectItem>
                  <SelectItem value="lmstudio" className="text-xs">LM Studio</SelectItem>
                  <SelectItem value="llamacpp" className="text-xs">llama.cpp llama-server</SelectItem>
                  <SelectItem value="vllm" className="text-xs">vLLM</SelectItem>
                  <SelectItem value="generic" className="text-xs">Other OpenAI-compatible</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="engine-url">URL</Label>
              <Input
                id="engine-url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="http://127.0.0.1:11434"
                className="font-mono text-xs"
                spellCheck={false}
                autoCapitalize="none"
                disabled={!editable}
              />
              <p className="text-[11px] text-muted-foreground">
                e.g. http://127.0.0.1:11434/v1 — the /v1 suffix is added automatically when missing. Local engines must resolve to loopback or a private address; the destination is re-resolved at connect time.
              </p>
            </div>
          </>
        )}
        <div className="space-y-1.5">
          <Label htmlFor="engine-label">Label</Label>
          <Input
            id="engine-label"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="e.g. LM Studio on the workstation"
            disabled={!editable}
          />
        </div>
      </CardContent>
      {editable && (
        <CardFooter className="px-4 pt-0 gap-3">
          <Button size="sm" disabled={!dirty || saving} onClick={() => void save()}>
            {saving && <Loader2 className="size-3.5 animate-spin" aria-hidden />}
            Save engine
          </Button>
          {dirty && <span className="text-[11px] text-muted-foreground">Unsaved changes</span>}
        </CardFooter>
      )}
    </Card>
  );
}

function EngineStatusCard({ engine }: { engine: EngineStatus }) {
  return (
    <Card className="rounded-lg gap-4 py-4">
      <CardHeader className="px-4 pb-0">
        <CardTitle className="text-sm">Live status</CardTitle>
        <CardDescription>Probed on load and after every save.</CardDescription>
      </CardHeader>
      <CardContent className="px-4 space-y-2">
        <div className="flex items-center gap-2 flex-wrap">
          {engine.type === "none" ? (
            <Badge variant="outline">No engine</Badge>
          ) : engine.reachable ? (
            <Badge variant="secondary">Reachable</Badge>
          ) : (
            <Badge variant="destructive">Unreachable</Badge>
          )}
          <span className="text-xs text-muted-foreground truncate">{engine.label || "engine"}</span>
        </div>
        {engine.error && <p className="text-xs text-destructive">{engine.error}</p>}
        <p className="text-xs text-muted-foreground">
          {engine.models.length} model{engine.models.length === 1 ? "" : "s"} discovered
          {engine.url ? ` at ${engine.url}` : ""}
        </p>
        {engine.models.length > 0 && (
          <p className="text-[11px] text-muted-foreground truncate" title={engine.models.join(", ")}>
            {engine.models.slice(0, 6).join(" · ")}
            {engine.models.length > 6 ? " · …" : ""}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function PathsCard({ paths }: { paths: SettingsPayload["paths"] }) {
  const rows: { label: string; value: string }[] = [
    { label: "Database", value: paths.db },
    { label: "Data dir", value: paths.dataDir },
    { label: "Keys", value: paths.keys },
    { label: "Backups", value: paths.backups },
  ];
  return (
    <Card className="rounded-lg gap-4 py-4">
      <CardHeader className="px-4 pb-0">
        <CardTitle className="text-sm">Data paths</CardTitle>
        <CardDescription>Everything Lester writes stays on this disk.</CardDescription>
      </CardHeader>
      <CardContent className="px-4 space-y-2">
        {rows.map((r) => (
          <div key={r.label} className="flex items-baseline gap-3">
            <span className="text-[11px] text-muted-foreground w-16 shrink-0">{r.label}</span>
            <Tooltip>
              <TooltipTrigger asChild>
                <code className="font-mono text-[11px] truncate cursor-help">{r.value || "—"}</code>
              </TooltipTrigger>
              <TooltipContent side="top" className="max-w-96 break-all">
                <span className="font-mono">{r.value}</span>
              </TooltipContent>
            </Tooltip>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

// ─── Cloud tab ──────────────────────────────────────────────────────────────

interface ProviderDraft {
  id: string;
  label: string;
  baseUrl: string;
  enabled: boolean;
  defaultModel: string;
  hasKey: boolean;
  newKey: string;
}

function CloudTab({ settings, onSaved }: { settings: LesterSettingsDto; onSaved: () => void }) {
  const [draft, setDraft] = useState<ProviderDraft[]>([]);
  const [saving, setSaving] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<ProviderDraft | null>(null);
  const [npLabel, setNpLabel] = useState("");
  const [npUrl, setNpUrl] = useState("");
  const [npKey, setNpKey] = useState("");
  const [npModel, setNpModel] = useState("");

  useEffect(() => {
    setDraft(settings.cloudProviders.map((p) => ({ ...p, newKey: "" })));
  }, [settings]);

  const orig = settings.cloudProviders;
  const dirty =
    draft.some((p) => p.newKey.trim() !== "") ||
    draft.length !== orig.length ||
    draft.some((p) => {
      const o = orig.find((x) => x.id === p.id);
      return (
        !o ||
        o.label !== p.label ||
        o.baseUrl !== p.baseUrl ||
        o.enabled !== p.enabled ||
        o.defaultModel !== p.defaultModel
      );
    });

  function patch(id: string, part: Partial<ProviderDraft>) {
    setDraft((prev) => prev.map((p) => (p.id === id ? { ...p, ...part } : p)));
  }

  async function save(list: ProviderDraft[], message: string) {
    setSaving(true);
    try {
      await apiPut("/api/settings", {
        cloudProviders: list.map((p) => {
          const base = {
            id: p.id,
            label: p.label.trim() || "Cloud provider",
            baseUrl: p.baseUrl.trim(),
            enabled: p.enabled,
            defaultModel: p.defaultModel.trim(),
          };
          const key = p.newKey.trim();
          return key ? { ...base, apiKeyPlain: key } : base;
        }),
      });
      toast.success(message);
      onSaved();
    } catch (e) {
      toast.error(errMsg(e, "Save failed."));
    } finally {
      setSaving(false);
    }
  }

  function addProvider() {
    const label = npLabel.trim();
    const url = npUrl.trim();
    if (!label) {
      toast.error("Give the provider a label.");
      return;
    }
    if (!/^https?:\/\//i.test(url)) {
      toast.error("Base URL must start with http:// or https://");
      return;
    }
    setDraft((prev) => [
      ...prev,
      {
        id: uid(),
        label,
        baseUrl: url,
        enabled: false,
        defaultModel: npModel.trim(),
        hasKey: npKey.trim() !== "",
        newKey: npKey,
      },
    ]);
    setNpLabel("");
    setNpUrl("");
    setNpKey("");
    setNpModel("");
    setAddOpen(false);
    toast.info("Provider added to the list — press “Save providers” to store it.");
  }

  async function removeProvider() {
    if (!removeTarget) return;
    const next = draft.filter((p) => p.id !== removeTarget.id);
    setDraft(next);
    setRemoveTarget(null);
    await save(next, `Provider “${removeTarget.label}” removed.`);
  }

  return (
    <>
      <div className="rounded-lg border bg-muted/40 p-4 flex gap-3" role="note">
        <ShieldCheck className="size-4 shrink-0 mt-0.5 text-muted-foreground" aria-hidden />
        <p className="text-xs leading-relaxed text-muted-foreground">
          Cloud fallback is <span className="font-medium text-foreground">off by default</span> and stays
          off until a workspace policy explicitly allows it. Every cloud byte is recorded in Proof.
        </p>
      </div>

      <Card className="rounded-lg gap-4 py-4">
        <CardHeader className="px-4 pb-0">
          <CardTitle className="text-sm">Cloud providers</CardTitle>
          <CardDescription>
            OpenAI-compatible endpoints, used only when a workspace policy allows fallback routing.
          </CardDescription>
          <CardAction>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={() => setAddOpen(true)}>
                <Plus className="size-3.5" aria-hidden />
                Add provider
              </Button>
              <Button size="sm" disabled={!dirty || saving} onClick={() => void save(draft, "Cloud providers saved.")}>
                {saving && <Loader2 className="size-3.5 animate-spin" aria-hidden />}
                Save providers
              </Button>
            </div>
          </CardAction>
        </CardHeader>
        <CardContent className="px-4 space-y-3">
          {draft.length === 0 ? (
            <p className="py-6 text-center text-xs text-muted-foreground leading-relaxed">
              No cloud providers configured.
              <br />
              Add one only if a workspace policy needs fallback routing.
            </p>
          ) : (
            draft.map((p) => (
              <div key={p.id} className="rounded-lg border p-3 space-y-3">
                <div className="flex items-center gap-3 flex-wrap">
                  <div className="flex items-center gap-2">
                    <Switch
                      id={`enabled-${p.id}`}
                      checked={p.enabled}
                      onCheckedChange={(v) => patch(p.id, { enabled: v })}
                      aria-label={`Enable ${p.label}`}
                    />
                    <Label htmlFor={`enabled-${p.id}`} className="text-xs">Enabled</Label>
                  </div>
                  <span className="text-sm font-medium truncate flex-1 min-w-32">
                    {p.label || "Untitled provider"}
                  </span>
                  {p.hasKey || p.newKey.trim() !== "" ? (
                    <Badge variant="outline" className="text-[10px] gap-1">
                      <KeyRound className="size-3" aria-hidden /> key stored
                    </Badge>
                  ) : (
                    <Badge variant="outline" className="text-[10px]">no key</Badge>
                  )}
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-7 shrink-0"
                    aria-label={`Remove ${p.label}`}
                    onClick={() => setRemoveTarget(p)}
                  >
                    <Trash2 className="size-3.5 text-destructive" aria-hidden />
                  </Button>
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label htmlFor={`label-${p.id}`} className="text-xs">Label</Label>
                    <Input
                      id={`label-${p.id}`}
                      value={p.label}
                      onChange={(e) => patch(p.id, { label: e.target.value })}
                      placeholder="OpenAI"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor={`url-${p.id}`} className="text-xs">Base URL</Label>
                    <Input
                      id={`url-${p.id}`}
                      value={p.baseUrl}
                      onChange={(e) => patch(p.id, { baseUrl: e.target.value })}
                      placeholder="https://api.openai.com/v1"
                      className="font-mono text-xs"
                      spellCheck={false}
                      autoCapitalize="none"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor={`model-${p.id}`} className="text-xs">Default model</Label>
                    <Input
                      id={`model-${p.id}`}
                      value={p.defaultModel}
                      onChange={(e) => patch(p.id, { defaultModel: e.target.value })}
                      placeholder="gpt-4o-mini"
                      className="font-mono text-xs"
                      spellCheck={false}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor={`key-${p.id}`} className="text-xs">Replace API key</Label>
                    <Input
                      id={`key-${p.id}`}
                      type="password"
                      value={p.newKey}
                      onChange={(e) => patch(p.id, { newKey: e.target.value })}
                      placeholder={p.hasKey ? "Stored — type to replace" : "sk-…"}
                      autoComplete="off"
                    />
                  </div>
                </div>
              </div>
            ))
          )}
        </CardContent>
      </Card>

      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Add cloud provider</DialogTitle>
            <DialogDescription>
              Keys are encrypted at rest (AES-256-GCM) and only used when a policy allows fallback.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="np-label">Label</Label>
              <Input id="np-label" value={npLabel} onChange={(e) => setNpLabel(e.target.value)} placeholder="OpenAI" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="np-url">Base URL</Label>
              <Input
                id="np-url"
                value={npUrl}
                onChange={(e) => setNpUrl(e.target.value)}
                placeholder="https://api.openai.com/v1"
                className="font-mono text-xs"
                spellCheck={false}
                autoCapitalize="none"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="np-key">API key</Label>
              <Input
                id="np-key"
                type="password"
                value={npKey}
                onChange={(e) => setNpKey(e.target.value)}
                placeholder="sk-…"
                autoComplete="off"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="np-model">Default model</Label>
              <Input
                id="np-model"
                value={npModel}
                onChange={(e) => setNpModel(e.target.value)}
                placeholder="gpt-4o-mini"
                className="font-mono text-xs"
                spellCheck={false}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAddOpen(false)}>Cancel</Button>
            <Button onClick={addProvider}>Add provider</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!removeTarget} onOpenChange={(o) => !o && setRemoveTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove “{removeTarget?.label}”?</AlertDialogTitle>
            <AlertDialogDescription>
              The endpoint and its stored key are removed from this node. Workspaces routing to it lose
              their fallback.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <Button variant="destructive" disabled={saving} onClick={() => void removeProvider()}>
              {saving && <Loader2 className="size-3.5 animate-spin" aria-hidden />}
              Remove provider
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

// ─── Backups tab ────────────────────────────────────────────────────────────

function BackupsTab({ backup, onSaved }: { backup: LesterSettingsDto["backup"]; onSaved: () => void }) {
  const [enabled, setEnabled] = useState(backup.enabled);
  const [hour, setHour] = useState(String(backup.hour));
  const [keep, setKeep] = useState(String(backup.keep));
  const [saving, setSaving] = useState(false);
  const [backups, setBackups] = useState<BackupInfo[] | null>(null);
  const [scheduler, setScheduler] = useState<{ schedulerRunning: boolean; lastAuto: string | null } | null>(null);
  const [backingUp, setBackingUp] = useState(false);
  const [restoreTarget, setRestoreTarget] = useState<BackupInfo | null>(null);
  const [restoring, setRestoring] = useState(false);

  useEffect(() => {
    setEnabled(backup.enabled);
    setHour(String(backup.hour));
    setKeep(String(backup.keep));
  }, [backup]);

  const dirty =
    enabled !== backup.enabled ||
    Number.parseInt(hour, 10) !== backup.hour ||
    Number.parseInt(keep, 10) !== backup.keep;

  const loadBackups = useCallback(async () => {
    try {
      const r = await apiGet<{ backups: BackupInfo[]; scheduler: { schedulerRunning: boolean; lastAuto: string | null } }>(
        "/api/backups"
      );
      setBackups(r.backups);
      setScheduler(r.scheduler);
    } catch {
      setBackups([]);
    }
  }, []);

  useEffect(() => {
    void loadBackups();
  }, [loadBackups]);

  async function saveSchedule() {
    const h = Number.parseInt(hour, 10);
    const k = Number.parseInt(keep, 10);
    if (Number.isNaN(h) || h < 0 || h > 23) {
      toast.error("Hour must be between 0 and 23.");
      return;
    }
    if (Number.isNaN(k) || k < 1 || k > 365) {
      toast.error("Retained backups must be between 1 and 365.");
      return;
    }
    setSaving(true);
    try {
      await apiPut("/api/settings", { backup: { enabled, hour: h, keep: k } });
      toast.success("Backup schedule saved.");
      onSaved();
    } catch (e) {
      toast.error(errMsg(e, "Save failed."));
    } finally {
      setSaving(false);
    }
  }

  async function backupNow() {
    setBackingUp(true);
    try {
      const r = await apiPost<{ ok: boolean; backup: BackupInfo }>("/api/backups");
      toast.success(`Backup created — ${r.backup.fileName} (${fmtBytes(r.backup.sizeBytes)}).`);
      await loadBackups();
    } catch (e) {
      toast.error(errMsg(e, "Backup failed."));
    } finally {
      setBackingUp(false);
    }
  }

  async function doRestore() {
    if (!restoreTarget) return;
    setRestoring(true);
    try {
      await apiPut("/api/backups", { id: restoreTarget.id });
      toast.success(`Restored ${restoreTarget.fileName}.`);
      setRestoreTarget(null);
      await loadBackups();
      onSaved();
    } catch (e) {
      toast.error(errMsg(e, "Restore failed."));
    } finally {
      setRestoring(false);
    }
  }

  const hourDisplay = hour.trim() === "" ? "HH" : hour;

  return (
    <>
      <Card className="rounded-lg gap-4 py-4">
        <CardHeader className="px-4 pb-0">
          <CardTitle className="text-sm">Schedule</CardTitle>
          <CardDescription>Automatic WAL checkpoint followed by an atomic database copy.</CardDescription>
          <CardAction>
            <Button variant="outline" size="sm" onClick={() => void backupNow()} disabled={backingUp}>
              {backingUp ? (
                <Loader2 className="size-3.5 animate-spin" aria-hidden />
              ) : (
                <Plus className="size-3.5" aria-hidden />
              )}
              Back up now
            </Button>
          </CardAction>
        </CardHeader>
        <CardContent className="px-4 space-y-4">
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-0.5">
              <Label htmlFor="backup-enabled" className="text-sm">Daily automatic backups</Label>
              <p className="text-xs text-muted-foreground">Runs on the server clock; retention prunes old files.</p>
            </div>
            <Switch id="backup-enabled" checked={enabled} onCheckedChange={setEnabled} />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="backup-hour">Hour of day</Label>
              <Input
                id="backup-hour"
                type="number"
                min={0}
                max={23}
                value={hour}
                onChange={(e) => setHour(e.target.value)}
                className="w-24 text-xs"
              />
              <p className="text-[11px] text-muted-foreground">daily at {hourDisplay}:00 server time</p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="backup-keep">Retention</Label>
              <Input
                id="backup-keep"
                type="number"
                min={1}
                max={365}
                value={keep}
                onChange={(e) => setKeep(e.target.value)}
                className="w-24 text-xs"
              />
              <p className="text-[11px] text-muted-foreground">retain {keep.trim() || "N"} backups</p>
            </div>
          </div>
        </CardContent>
        <CardFooter className="px-4 pt-0">
          <Button size="sm" disabled={!dirty || saving} onClick={() => void saveSchedule()}>
            {saving && <Loader2 className="size-3.5 animate-spin" aria-hidden />}
            Save schedule
          </Button>
        </CardFooter>
      </Card>

      <Card className="rounded-lg gap-4 py-4">
        <CardHeader className="px-4 pb-0">
          <CardTitle className="text-sm">Snapshots</CardTitle>
          <CardDescription>
            {scheduler
              ? `Scheduler ${scheduler.schedulerRunning ? "running" : "stopped"} · last automatic backup ${
                  scheduler.lastAuto ? new Date(scheduler.lastAuto).toLocaleString() : "—"
                }`
              : "Integrity-hashed copies of the SQLite database."}
          </CardDescription>
        </CardHeader>
        <CardContent className="px-4">
          {backups === null ? (
            <div className="space-y-2">
              {Array.from({ length: 3 }).map((_, i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          ) : backups.length === 0 ? (
            <p className="py-6 text-center text-xs text-muted-foreground">No backups yet — press “Back up now”.</p>
          ) : (
            <div className="divide-y rounded-lg border">
              {backups.map((b) => (
                <div key={b.id} className="p-3 flex flex-wrap items-center gap-x-4 gap-y-2">
                  <div className="min-w-0 flex-1">
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <code className="font-mono text-xs block truncate max-w-full cursor-help">{b.fileName}</code>
                      </TooltipTrigger>
                      <TooltipContent side="top" className="max-w-96 break-all">
                        <span className="font-mono">{b.path}</span>
                      </TooltipContent>
                    </Tooltip>
                    <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground">
                      <span>{fmtBytes(b.sizeBytes)}</span>
                      <span aria-hidden>·</span>
                      <span>{b.entries} entries</span>
                      <span aria-hidden>·</span>
                      <span>{new Date(b.createdAt).toLocaleString()}</span>
                      <span aria-hidden>·</span>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <code className="font-mono cursor-help">sha256 {b.sha256.slice(0, 10)}…</code>
                        </TooltipTrigger>
                        <TooltipContent side="top" className="max-w-96 break-all">
                          <span className="font-mono">{b.sha256}</span>
                        </TooltipContent>
                      </Tooltip>
                    </div>
                  </div>
                  <Badge variant={b.kind === "manual" ? "secondary" : "outline"} className="text-[10px]">
                    {b.kind}
                  </Badge>
                  <div className="flex items-center gap-2">
                    <Button variant="outline" size="sm" className="h-7 text-xs" asChild>
                      <a href={`/api/backups?download=${b.id}`} download aria-label={`Download ${b.fileName}`}>
                        <Download className="size-3.5" aria-hidden />
                        Download
                      </a>
                    </Button>
                    <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => setRestoreTarget(b)}>
                      Restore
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <AlertDialog open={!!restoreTarget} onOpenChange={(o) => !o && setRestoreTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Restore “{restoreTarget?.fileName}”?</AlertDialogTitle>
            <AlertDialogDescription>
              The database will be replaced by this backup. Current data since the backup is lost.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <Button variant="destructive" disabled={restoring} onClick={() => void doRestore()}>
              {restoring && <Loader2 className="size-3.5 animate-spin" aria-hidden />}
              Restore backup
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

// ─── Security tab ───────────────────────────────────────────────────────────

function SecurityTab({ settings, onSaved }: { settings: LesterSettingsDto; onSaved: () => void }) {
  const [contentLogging, setContentLogging] = useState(settings.contentLogging);
  const [encryptAtRest, setEncryptAtRest] = useState(settings.encryptAtRest);
  const [ttl, setTtl] = useState(String(settings.sessionTtlHours));
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setContentLogging(settings.contentLogging);
    setEncryptAtRest(settings.encryptAtRest);
    setTtl(String(settings.sessionTtlHours));
  }, [settings]);

  const dirty =
    contentLogging !== settings.contentLogging ||
    encryptAtRest !== settings.encryptAtRest ||
    Number.parseInt(ttl, 10) !== settings.sessionTtlHours;

  async function save() {
    const t = Number.parseInt(ttl, 10);
    if (Number.isNaN(t) || t < 1 || t > 720) {
      toast.error("Session lifetime must be between 1 and 720 hours.");
      return;
    }
    setSaving(true);
    try {
      await apiPut("/api/settings", {
        contentLogging,
        encryptAtRest,
        sessionTtlHours: t,
      });
      toast.success("Security settings saved.");
      onSaved();
    } catch (e) {
      toast.error(errMsg(e, "Save failed."));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card className="rounded-lg gap-4 py-4">
      <CardHeader className="px-4 pb-0">
        <CardTitle className="text-sm">Privacy &amp; security</CardTitle>
        <CardDescription>Conservative defaults — change only what your auditors ask for.</CardDescription>
      </CardHeader>
      <CardContent className="px-4 space-y-4">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-0.5 max-w-sm">
            <Label htmlFor="content-logging" className="text-sm">Content logging</Label>
            <p className="text-xs leading-relaxed text-amber-700 dark:text-amber-400 flex gap-1.5">
              <ShieldAlert className="size-3.5 shrink-0 mt-0.5" aria-hidden />
              <span>
                Stores the first 500 chars of prompts in the Proof ledger. Off by default — enable only if
                an auditor asks.
              </span>
            </p>
          </div>
          <Switch id="content-logging" checked={contentLogging} onCheckedChange={setContentLogging} />
        </div>

        <Separator />

        <div className="flex items-start justify-between gap-4">
          <div className="space-y-0.5 max-w-sm">
            <Label htmlFor="encrypt-rest" className="text-sm flex gap-1.5">
              <Lock className="size-3.5 text-muted-foreground" aria-hidden />
              Encrypt at rest
            </Label>
            <p className="text-xs text-muted-foreground leading-relaxed">
              Encrypt message content and API keys at rest (AES-256-GCM). Applies to new messages.
            </p>
          </div>
          <Switch id="encrypt-rest" checked={encryptAtRest} onCheckedChange={setEncryptAtRest} />
        </div>

        <Separator />

        <div className="flex items-center justify-between gap-4">
          <div className="space-y-0.5">
            <Label htmlFor="session-ttl" className="text-sm">Session lifetime</Label>
            <p className="text-xs text-muted-foreground">Sign-in sessions expire after this many hours.</p>
          </div>
          <Input
            id="session-ttl"
            type="number"
            min={1}
            max={720}
            value={ttl}
            onChange={(e) => setTtl(e.target.value)}
            className="w-24 text-xs"
          />
        </div>

        <Separator />

        <div className="flex items-start justify-between gap-4">
          <div className="space-y-0.5 max-w-sm">
            <Label className="text-sm flex gap-1.5 items-center">
              <Globe className="size-3.5 text-muted-foreground" aria-hidden />
              Network binding
            </Label>
            <p className="text-xs text-muted-foreground leading-relaxed">
              This server currently binds to <code className="font-mono">{settings.network.bindAddress}</code> — read-only
              here, because it is an environment-level decision, not a Console toggle. {settings.network.note}
            </p>
          </div>
          <Badge variant={settings.network.bindAddress === "127.0.0.1" || settings.network.bindAddress === "localhost" || settings.network.bindAddress === "::1" ? "default" : "destructive"}>
            {settings.network.bindAddress === "127.0.0.1" || settings.network.bindAddress === "localhost" || settings.network.bindAddress === "::1" ? "loopback only" : "exposed"}
          </Badge>
        </div>
      </CardContent>
      <CardFooter className="px-4 pt-0">
        <Button size="sm" disabled={!dirty || saving} onClick={() => void save()}>
          {saving && <Loader2 className="size-3.5 animate-spin" aria-hidden />}
          Save changes
        </Button>
      </CardFooter>
    </Card>
  );
}

// ─── API tab ────────────────────────────────────────────────────────────────

function ApiTab({ role }: { role: Role; username: string }) {
  const [tokens, setTokens] = useState<ApiTokenInfo[] | null>(null);
  const [freshToken, setFreshToken] = useState<{ raw: string; name: string } | null>(null);
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [sessions, setSessions] = useState<SessionInfo[] | null>(null);

  const load = () => {
    apiGet<{ tokens: ApiTokenInfo[] }>("/api/tokens")
      .then((r) => setTokens(r.tokens))
      .catch(() => setTokens([]));
    apiGet<{ sessions: SessionInfo[] }>("/api/auth/sessions")
      .then((r) => setSessions(r.sessions))
      .catch(() => setSessions([]));
  };

  useEffect(load, []);

  async function create() {
    const name = newName.trim() || "api-token";
    setCreating(true);
    try {
      const r = await apiPost<{ ok: boolean; token: string; name: string }>("/api/tokens", { name });
      setFreshToken({ raw: r.token, name: r.name });
      setNewName("");
      toast.success("Token created — copy it now; it is shown only once and stored hashed.");
      load();
    } catch (e) {
      toast.error(errMsg(e, "Could not create token."));
    } finally {
      setCreating(false);
    }
  }

  async function revoke(id: string) {
    setRevoking(id);
    try {
      await apiDelete(`/api/tokens/${id}`);
      toast.success("Token revoked.");
      load();
    } catch (e) {
      toast.error(errMsg(e, "Revoke failed."));
    } finally {
      setRevoking(null);
    }
  }

  async function signOutEverywhere() {
    try {
      const r = await apiPost<{ revoked: number }>("/api/auth/sessions", { all: true });
      toast.success(`Signed out everywhere (${r.revoked} session${r.revoked === 1 ? "" : "s"} ended).`);
      window.location.href = "/";
    } catch (e) {
      toast.error(errMsg(e, "Sign-out failed."));
    }
  }

  if (role === "AUDITOR") {
    return (
      <Card className="rounded-lg py-8">
        <CardContent className="px-4 text-center">
          <p className="text-sm text-muted-foreground">
            API tokens are not available to auditor accounts.
          </p>
        </CardContent>
      </Card>
    );
  }

  const origin = typeof window === "undefined" ? "" : window.location.origin;
  const example = freshToken
    ? `from openai import OpenAI\nclient = OpenAI(base_url="${origin}/api/v1", api_key="${freshToken.raw}")\nr = client.chat.completions.create(model="<model-key>",\n    messages=[{"role": "user", "content": "Hi"}])`
    : `from openai import OpenAI\nclient = OpenAI(base_url="${origin}/api/v1", api_key="lst_…")\nr = client.chat.completions.create(model="<model-key>",  # GET /api/v1/models lists them\n    messages=[{"role": "user", "content": "Hi"}])`;

  return (
    <div className="space-y-6">
      <Card className="rounded-lg gap-4 py-4">
        <CardHeader className="px-4 pb-0">
          <CardTitle className="text-sm">API tokens (OpenAI-compatible endpoint)</CardTitle>
          <CardDescription>
            Use Lester as a private, OpenAI-compatible endpoint from other apps. Tokens are stored as SHA-256 hashes — the raw value is shown exactly once. Multiple named tokens are supported and each can be revoked independently.
          </CardDescription>
        </CardHeader>
        <CardContent className="px-4 space-y-4">
          <div className="flex flex-wrap gap-2 items-center">
            <Input
              aria-label="New token name"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="e.g. laptop-cli"
              className="w-48 text-xs"
              maxLength={60}
            />
            <Button size="sm" onClick={() => void create()} disabled={creating || (tokens?.length ?? 0) >= 20}>
              {creating ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <KeyRound className="size-3.5" aria-hidden />}
              Create token
            </Button>
          </div>

          {freshToken && (
            <div className="space-y-2 border rounded-lg p-3 bg-primary/5">
              <p className="text-xs font-medium">
                “{freshToken.name}” — copy it now, it will not be shown again:
              </p>
              <div className="flex items-center gap-2">
                <code className="flex-1 min-w-0 rounded-md border bg-muted/40 p-2 font-mono text-xs break-all">
                  {freshToken.raw}
                </code>
                <Button
                  variant="outline"
                  size="icon"
                  className="shrink-0"
                  aria-label="Copy token"
                  onClick={() => void copyText(freshToken.raw, "Token")}
                >
                  <Copy className="size-4" aria-hidden />
                </Button>
              </div>
            </div>
          )}

          <div className="border rounded-md divide-y">
            {tokens === null ? (
              <div className="px-3 py-3 text-xs text-muted-foreground">Loading…</div>
            ) : tokens.length === 0 ? (
              <div className="px-3 py-3 text-xs text-muted-foreground">No active tokens.</div>
            ) : (
              tokens.map((t) => (
                <div key={t.id} className="px-3 py-2.5 flex items-center gap-3 flex-wrap">
                  <span className="text-xs font-medium">{t.name}</span>
                  <code className="text-[11px] text-muted-foreground font-mono">{t.prefix}</code>
                  <span className="text-[11px] text-muted-foreground">
                    created {new Date(t.createdAt).toLocaleDateString()}
                    {t.lastUsedAt ? ` · last used ${new Date(t.lastUsedAt).toLocaleString()}` : " · never used"}
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    className="ml-auto h-7 text-xs"
                    disabled={revoking === t.id}
                    onClick={() => void revoke(t.id)}
                  >
                    {revoking === t.id ? <Loader2 className="size-3 animate-spin" aria-hidden /> : <Trash2 className="size-3" aria-hidden />}
                    Revoke
                  </Button>
                </div>
              ))
            )}
          </div>

          <div className="space-y-1.5">
            <p className="text-xs font-medium">Usage example (official OpenAI SDK)</p>
            <pre className="rounded-md border bg-muted/40 p-3 font-mono text-[11px] leading-relaxed overflow-x-auto scrollbar-thin whitespace-pre-wrap break-all">
              {example}
            </pre>
          </div>
          <p className="text-xs text-muted-foreground leading-relaxed">
            Every call passes through the same policy, redaction and Proof pipeline as the Console.
          </p>
        </CardContent>
      </Card>

      <Card className="rounded-lg gap-4 py-4">
        <CardHeader className="px-4 pb-0">
          <CardTitle className="text-sm">Your sessions</CardTitle>
          <CardDescription>Active sign-ins for your account. Password changes and account disables revoke all of them automatically.</CardDescription>
        </CardHeader>
        <CardContent className="px-4 space-y-3">
          <div className="border rounded-md divide-y">
            {sessions === null ? (
              <div className="px-3 py-3 text-xs text-muted-foreground">Loading…</div>
            ) : sessions.length === 0 ? (
              <div className="px-3 py-3 text-xs text-muted-foreground">No active sessions.</div>
            ) : (
              sessions.map((sn) => (
                <div key={sn.id} className="px-3 py-2.5 flex items-center gap-3 flex-wrap text-xs">
                  <code className="font-mono">{sn.id}…</code>
                  <span className="text-muted-foreground">last seen {new Date(sn.lastSeenAt).toLocaleString()}</span>
                  <span className="text-muted-foreground ml-auto">expires {new Date(sn.expiresAt).toLocaleString()}</span>
                </div>
              ))
            )}
          </div>
          <Button variant="outline" size="sm" onClick={() => void signOutEverywhere()}>
            <LogOut className="size-3.5" aria-hidden />
            Sign out everywhere
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}

// ─── About tab ──────────────────────────────────────────────────────────────

function AboutTab({
  version,
  nodeId,
  license,
  role,
  user,
  onLogout,
}: {
  version: string;
  nodeId: string;
  license: LicenseInfo;
  role: Role;
  user: SessionUser | null;
  onLogout: () => void;
}) {
  return (
    <>
      {role === "AUDITOR" && (
        <div className="rounded-lg border bg-muted/40 p-4 flex gap-3" role="note">
          <Info className="size-4 shrink-0 mt-0.5 text-muted-foreground" aria-hidden />
          <p className="text-xs text-muted-foreground leading-relaxed">
            Settings management is limited to admins. Auditors can review node identity and package details
            here — the read-only consoles live in Proof and Health.
          </p>
        </div>
      )}

      <Card className="rounded-lg gap-4 py-4">
        <CardHeader className="px-4 pb-0">
          <CardTitle className="text-sm">This node</CardTitle>
          <CardDescription>Identity and build of the Lester console you are using.</CardDescription>
        </CardHeader>
        <CardContent className="px-4 space-y-3">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <span className="text-sm">Lester v{version}</span>
            <Badge variant={license.tier === "team" ? "default" : "secondary"} className="text-[10px]">
              {license.tier === "team" ? `Team · ${license.customer}` : "Free tier"}
            </Badge>
          </div>
          <div className="flex items-center gap-2">
            <Tooltip>
              <TooltipTrigger asChild>
                <code className="flex-1 min-w-0 truncate font-mono text-xs cursor-help">{nodeId}</code>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="max-w-80 break-all">
                <span className="font-mono">{nodeId}</span>
              </TooltipContent>
            </Tooltip>
            <Button
              variant="outline"
              size="icon"
              className="size-7 shrink-0"
              aria-label="Copy node ID"
              onClick={() => void copyText(nodeId, "Node ID")}
            >
              <Copy className="size-3.5" aria-hidden />
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card className="rounded-lg gap-4 py-4">
        <CardHeader className="px-4 pb-0">
          <CardTitle className="text-sm">Download the complete Lester package</CardTitle>
          <CardDescription>
            Full source, brand assets, Docker setup, installers and docs — self-contained ZIP.
          </CardDescription>
        </CardHeader>
        <CardContent className="px-4 space-y-2">
          <Button asChild size="lg" className="w-full sm:w-auto">
            <a href="/lester-v1.0.zip" download>
              <Package className="size-4" aria-hidden />
              Download package
            </a>
          </Button>
          <p className="text-[11px] text-muted-foreground">
            Regenerate with: <code className="font-mono">bun scripts/package.ts</code>
          </p>
        </CardContent>
      </Card>

      <Card className="rounded-lg gap-4 py-4">
        <CardHeader className="px-4 pb-0">
          <CardTitle className="text-sm">Session</CardTitle>
          <CardDescription>
            Signed in as {user ? `${user.displayName} (@${user.username})` : "—"}.
          </CardDescription>
        </CardHeader>
        <CardContent className="px-4">
          <Button variant="outline" size="sm" onClick={onLogout}>
            <LogOut className="size-3.5" aria-hidden />
            Sign out
          </Button>
        </CardContent>
      </Card>
    </>
  );
}

// ─── Shared fallback ────────────────────────────────────────────────────────

function TabFallback({
  loadError,
  onRetry,
  height = "h-64",
}: {
  loadError: string | null;
  onRetry: () => void;
  height?: string;
}) {
  if (loadError) {
    return (
      <Card className="rounded-lg py-8">
        <CardContent className="px-4 text-center space-y-3">
          <p className="text-sm text-destructive">{loadError}</p>
          <Button variant="outline" size="sm" onClick={onRetry}>
            Retry
          </Button>
        </CardContent>
      </Card>
    );
  }
  return <Skeleton className={`${height} w-full rounded-lg`} />;
}

// ─── Screen ─────────────────────────────────────────────────────────────────

export function SettingsScreen({ onLogout }: { onLogout: () => void }) {
  const { user } = useLester();
  const role: Role = user?.role ?? "MEMBER";
  const [data, setData] = useState<SettingsPayload | null>(null);
  const [audit, setAudit] = useState<{ version: string; nodeId: string; license: LicenseInfo } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [tab, setTab] = useState("engine");

  const visibleTabs = useMemo(() => TABS.filter((t) => t.roles.includes(role)), [role]);
  // Derive the active tab so a role change never leaves an invisible tab selected.
  const activeTab = visibleTabs.some((t) => t.id === tab) ? tab : (visibleTabs[0]?.id ?? "about");

  const [refresh, setRefresh] = useState(0);
  const refreshNow = useCallback(() => setRefresh((n) => n + 1), []);

  useEffect(() => {
    let cancelled = false;
    if (role === "AUDITOR") {
      // Auditors cannot call /api/settings — assemble About data from health + license.
      apiGet<{ version: string }>("/api/health")
        .then((h) => apiGet<{ license: LicenseInfo }>("/api/license").then((l) => ({ h, l })))
        .then(({ h, l }) => {
          if (cancelled) return;
          setAudit({ version: h.version, nodeId: l.license.nodeId, license: l.license });
          setLoadError(null);
        })
        .catch((e: unknown) => {
          if (!cancelled) setLoadError(errMsg(e, "Could not load node info."));
        });
    } else {
      apiGet<SettingsPayload>("/api/settings")
        .then((r) => {
          if (cancelled) return;
          setData(r);
          setLoadError(null);
        })
        .catch((e: unknown) => {
          if (!cancelled) setLoadError(errMsg(e, "Could not load settings."));
        });
    }
    return () => {
      cancelled = true;
    };
  }, [role, refresh]);

  const about =
    role === "AUDITOR"
      ? audit
      : data
        ? { version: data.version, nodeId: data.nodeId, license: data.license }
        : null;

  return (
    <div className="h-full flex flex-col min-h-0">
      <Tabs value={activeTab} onValueChange={setTab} className="h-full flex flex-col min-h-0 gap-0">
        <header className="shrink-0 border-b bg-card/60">
          <div className="max-w-5xl w-full mx-auto px-4 sm:px-6 pt-3">
            <h1 className="text-sm font-semibold">Settings</h1>
            <p className="text-[11px] text-muted-foreground mt-0.5">
              Engine, cloud, backups and node identity — everything stays on this host.
            </p>
          </div>
          <div className="max-w-5xl w-full mx-auto px-4 sm:px-6 py-3">
            <TabsList className="w-full max-w-full justify-start overflow-x-auto scrollbar-thin">
              {visibleTabs.map((t) => (
                <TabsTrigger key={t.id} value={t.id} className="flex-none px-3 text-xs">
                  {t.label}
                </TabsTrigger>
              ))}
            </TabsList>
          </div>
        </header>

        <div className="flex-1 min-h-0 overflow-y-auto scrollbar-thin">
          <div className="max-w-5xl w-full mx-auto p-4 sm:p-6 space-y-4">
            <TabsContent value="engine" className="space-y-4">
              {data ? (
                <>
                  <EngineFormCard settings={data.settings} editable={role === "ADMIN"} onSaved={refreshNow} />
                  <EngineStatusCard engine={data.engine} />
                  <PathsCard paths={data.paths} />
                </>
              ) : (
                <TabFallback loadError={loadError} onRetry={refreshNow} height="h-96" />
              )}
            </TabsContent>

            <TabsContent value="cloud" className="space-y-4">
              {data ? (
                <CloudTab settings={data.settings} onSaved={refreshNow} />
              ) : (
                <TabFallback loadError={loadError} onRetry={refreshNow} />
              )}
            </TabsContent>

            <TabsContent value="backups" className="space-y-4">
              {data ? (
                <BackupsTab backup={data.settings.backup} onSaved={refreshNow} />
              ) : (
                <TabFallback loadError={loadError} onRetry={refreshNow} />
              )}
            </TabsContent>

            <TabsContent value="security" className="space-y-4">
              {data ? (
                <SecurityTab settings={data.settings} onSaved={refreshNow} />
              ) : (
                <TabFallback loadError={loadError} onRetry={refreshNow} />
              )}
            </TabsContent>

            <TabsContent value="api" className="space-y-4">
              <ApiTab role={role} username={user?.username ?? ""} />
            </TabsContent>

            <TabsContent value="about" className="space-y-4">
              {about ? (
                <AboutTab
                  version={about.version}
                  nodeId={about.nodeId}
                  license={about.license}
                  role={role}
                  user={user}
                  onLogout={onLogout}
                />
              ) : (
                <TabFallback loadError={loadError} onRetry={refreshNow} />
              )}
            </TabsContent>
          </div>
        </div>
      </Tabs>
    </div>
  );
}

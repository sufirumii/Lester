"use client";

/**
 * People & models screens: user/role management and the model registry with hardware fit.
 *
 * Merged module (v1.0.2 repository consolidation — zero behavior change).
 * Sections:
 *   1. Users screen
 *   2. Models screen
 */

import { useCallback, useEffect, useState } from "react";
import { apiDelete, apiGet, apiPatch, apiPost, type FitAssessment, type InstalledModel, type LicenseInfo, type ModelsResponse, type UserInfo, useLester } from "@/lib/client";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger, Input, Label, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Skeleton, Switch, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, Tabs, TabsContent, TabsList, TabsTrigger, Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui";
import { toast } from "sonner";
import { Ban, Boxes, Check, CircleCheck, CloudOff, Copy, Download, KeyRound, Loader2, MoreHorizontal, Plus, RefreshCw, Trash2, TriangleAlert, UserCog, X } from "lucide-react";


// ═══ Users screen ════════════════════════════════════════════════════════════════
// merged from src/components/console/UsersScreen.tsx

const ROLES: UserInfo["role"][] = ["ADMIN", "MEMBER", "AUDITOR"];

const ROLE_BADGE: Record<UserInfo["role"], "default" | "secondary" | "outline"> = {
  ADMIN: "default",
  MEMBER: "secondary",
  AUDITOR: "outline",
};

const ROLE_DESC: Record<UserInfo["role"], string> = {
  ADMIN: "full control",
  MEMBER: "chat, knowledge, evaluations",
  AUDITOR: "read-only access to Proof",
};

function validPassword(pw: string): boolean {
  return pw.length >= 8 && /[a-zA-Z]/.test(pw) && /[0-9]/.test(pw);
}

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
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

export function UsersScreen() {
  const { user } = useLester();
  const [users, setUsers] = useState<UserInfo[] | null>(null);
  const [license, setLicense] = useState<LicenseInfo | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Add-user dialog
  const [addOpen, setAddOpen] = useState(false);
  const [fUsername, setFUsername] = useState("");
  const [fDisplay, setFDisplay] = useState("");
  const [fPassword, setFPassword] = useState("");
  const [fRole, setFRole] = useState<UserInfo["role"]>("MEMBER");
  const [creating, setCreating] = useState(false);

  // Delete confirmation
  const [deleteTarget, setDeleteTarget] = useState<UserInfo | null>(null);
  const [deleting, setDeleting] = useState(false);

  // License activation
  const [licenseKey, setLicenseKey] = useState("");
  const [activating, setActivating] = useState(false);

  const load = useCallback(async () => {
    try {
      const [u, l] = await Promise.all([
        apiGet<{ users: UserInfo[] }>("/api/users"),
        apiGet<{ license: LicenseInfo }>("/api/license"),
      ]);
      setUsers(u.users);
      setLicense(l.license);
      setLoadError(null);
    } catch (e) {
      setLoadError(errMsg(e, "Could not load users."));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  function openAdd() {
    setFUsername("");
    setFDisplay("");
    setFPassword("");
    setFRole("MEMBER");
    setAddOpen(true);
  }

  async function createUser() {
    const username = fUsername.trim().toLowerCase();
    if (!/^[a-z0-9_.-]{3,32}$/.test(username)) {
      toast.error("Username: 3–32 chars, letters/numbers/._- only.");
      return;
    }
    if (!validPassword(fPassword)) {
      toast.error("Password needs 8+ characters with both letters and numbers.");
      return;
    }
    setCreating(true);
    try {
      await apiPost("/api/users", {
        username,
        displayName: fDisplay.trim() || undefined,
        password: fPassword,
        role: fRole,
      });
      toast.success(`User “${username}” created.`);
      setAddOpen(false);
      await load();
    } catch (e) {
      toast.error(errMsg(e, "Could not create user."));
    } finally {
      setCreating(false);
    }
  }

  async function toggleDisabled(u: UserInfo) {
    try {
      await apiPatch("/api/users", { id: u.id, disabled: !u.disabled });
      toast.success(u.disabled ? `${u.displayName} re-enabled.` : `${u.displayName} disabled — active sessions revoked.`);
      await load();
    } catch (e) {
      toast.error(errMsg(e, "Update failed."));
    }
  }

  async function changeRole(u: UserInfo, next: UserInfo["role"]) {
    if (next === u.role) return;
    try {
      await apiPatch("/api/users", { id: u.id, role: next });
      toast.success(`${u.displayName} is now ${next}.`);
      await load();
    } catch (e) {
      toast.error(errMsg(e, "Role change failed."));
    }
  }

  async function resetPassword(u: UserInfo) {
    const pw = window.prompt(`New password for ${u.username} — 8+ chars, letters + numbers`);
    if (pw === null) return;
    if (!validPassword(pw)) {
      toast.error("Password needs 8+ characters with both letters and numbers.");
      return;
    }
    try {
      await apiPatch("/api/users", { id: u.id, password: pw });
      toast.success(`Password updated for ${u.username}.`);
    } catch (e) {
      toast.error(errMsg(e, "Password reset failed."));
    }
  }

  async function deleteUser() {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await apiDelete(`/api/users?id=${deleteTarget.id}`);
      toast.success(`User “${deleteTarget.username}” deleted.`);
      setDeleteTarget(null);
      await load();
    } catch (e) {
      toast.error(errMsg(e, "Delete failed."));
    } finally {
      setDeleting(false);
    }
  }

  async function activate() {
    const key = licenseKey.trim();
    if (!key) return;
    setActivating(true);
    try {
      const r = await apiPost<{ ok: boolean; license: LicenseInfo }>("/api/license", { key });
      setLicense(r.license);
      setLicenseKey("");
      toast.success("Team license activated for this node.");
    } catch (e) {
      toast.error(errMsg(e, "Activation failed."));
    } finally {
      setActivating(false);
    }
  }

  if (user && user.role !== "ADMIN") {
    return (
      <div className="h-full grid place-items-center p-6">
        <p className="text-sm text-muted-foreground">Admins only.</p>
      </div>
    );
  }

  const team = license?.tier === "team";

  return (
    <div className="h-full flex flex-col min-h-0">
      {/* Header */}
      <header className="shrink-0 border-b bg-card/60">
        <div className="max-w-6xl w-full mx-auto px-4 sm:px-6 py-3 min-h-14 flex flex-wrap items-center gap-x-3 gap-y-2">
          <h1 className="text-sm font-semibold">Users &amp; roles</h1>
          {license && (
            <Badge variant="outline" className="font-normal text-[11px]">
              {users ? `${users.length} of ${license.users} users · ` : ""}
              {license.tier} tier
            </Badge>
          )}
          <div className="ml-auto">
            <Button size="sm" onClick={openAdd}>
              <Plus className="size-3.5" aria-hidden />
              Add user
            </Button>
          </div>
        </div>
      </header>

      {/* Scrollable content */}
      <div className="flex-1 min-h-0 overflow-y-auto scrollbar-thin">
        <div className="max-w-6xl w-full mx-auto p-4 sm:p-6 grid gap-4 xl:grid-cols-[340px_1fr] items-start">
          {/* License card */}
          <Card className="rounded-lg gap-4 py-4">
            <CardHeader className="px-4 pb-0">
              <CardTitle className="text-sm">License</CardTitle>
              <CardDescription>Offline, node-bound activation.</CardDescription>
            </CardHeader>
            <CardContent className="px-4 space-y-4">
              {license ? (
                <Badge
                  variant={team ? "default" : "secondary"}
                  className="whitespace-normal h-auto py-1 text-left leading-relaxed font-normal"
                >
                  {team
                    ? `Team · ${license.customer} · expires ${fmtDate(license.expiresAt)}`
                    : "Free tier · 1 user · 1 workspace"}
                </Badge>
              ) : (
                <Skeleton className="h-7 w-48" />
              )}

              <div className="space-y-1.5">
                <p className="text-[11px] text-muted-foreground">Node ID</p>
                <div className="flex items-center gap-2">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <code className="flex-1 min-w-0 truncate font-mono text-xs cursor-help">
                        {license?.nodeId ?? "…"}
                      </code>
                    </TooltipTrigger>
                    <TooltipContent side="bottom" className="max-w-80 break-all">
                      <span className="font-mono">{license?.nodeId}</span>
                    </TooltipContent>
                  </Tooltip>
                  <Button
                    variant="outline"
                    size="icon"
                    className="size-7 shrink-0"
                    aria-label="Copy node ID"
                    onClick={() => void copyText(license?.nodeId ?? "", "Node ID")}
                    disabled={!license}
                  >
                    <Copy className="size-3.5" aria-hidden />
                  </Button>
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="license-key" className="text-xs">Activate a team license</Label>
                <div className="flex gap-2">
                  <Input
                    id="license-key"
                    value={licenseKey}
                    onChange={(e) => setLicenseKey(e.target.value)}
                    placeholder="LST1.…"
                    className="font-mono text-xs h-8"
                    spellCheck={false}
                    autoCapitalize="none"
                  />
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-8 shrink-0"
                    disabled={!licenseKey.trim() || activating}
                    onClick={() => void activate()}
                  >
                    {activating && <Loader2 className="size-3.5 animate-spin" aria-hidden />}
                    Activate
                  </Button>
                </div>
                <p className="text-[11px] text-muted-foreground leading-relaxed">
                  Paste an LST1.… key issued for this node. Keys are signed and verified offline — no network, no phone-home.
                </p>
              </div>
            </CardContent>
          </Card>

          {/* Users table */}
          <Card className="rounded-lg gap-4 py-4 xl:col-span-1">
            <CardHeader className="px-4 pb-0">
              <CardTitle className="text-sm">Accounts on this node</CardTitle>
              <CardDescription>
                Passwords are hashed locally; tokens and sessions can be revoked per user.
              </CardDescription>
            </CardHeader>
            <CardContent className="px-4">
              {loadError && !users ? (
                <div className="py-8 text-center space-y-3">
                  <p className="text-sm text-destructive">{loadError}</p>
                  <Button variant="outline" size="sm" onClick={() => void load()}>Retry</Button>
                </div>
              ) : !users ? (
                <div className="space-y-2">
                  {Array.from({ length: 4 }).map((_, i) => (
                    <Skeleton key={i} className="h-10 w-full" />
                  ))}
                </div>
              ) : users.length === 0 ? (
                <p className="py-8 text-center text-xs text-muted-foreground">
                  No accounts yet — at least one admin normally exists on every node.
                </p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="text-xs">User</TableHead>
                      <TableHead className="text-xs">Role</TableHead>
                      <TableHead className="text-xs">Status</TableHead>
                      <TableHead className="text-xs">Created</TableHead>
                      <TableHead className="text-xs w-14">API</TableHead>
                      <TableHead className="w-10" aria-label="Row actions" />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {users.map((u) => {
                      const isSelf = user?.id === u.id;
                      return (
                        <TableRow key={u.id} className={u.disabled ? "opacity-60" : undefined}>
                          <TableCell className="min-w-40">
                            <div className="font-mono text-xs">
                              {u.username}
                              {isSelf && <span className="text-muted-foreground font-sans"> (you)</span>}
                            </div>
                            <div className="text-[11px] text-muted-foreground truncate max-w-44">{u.displayName}</div>
                          </TableCell>
                          <TableCell>
                            <Badge variant={ROLE_BADGE[u.role]} className="text-[10px]">{u.role}</Badge>
                          </TableCell>
                          <TableCell>
                            {u.disabled ? (
                              <Badge variant="destructive" className="text-[10px]">Disabled</Badge>
                            ) : (
                              <Badge variant="outline" className="text-[10px]">Active</Badge>
                            )}
                          </TableCell>
                          <TableCell>
                            <span className="text-xs text-muted-foreground">{fmtDate(u.createdAt)}</span>
                          </TableCell>
                          <TableCell>
                            {u.activeTokens ? (
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <span className="inline-flex" title="API token issued">
                                    <KeyRound className="size-3.5 text-muted-foreground" aria-hidden />
                                  </span>
                                </TooltipTrigger>
                                <TooltipContent>API token issued</TooltipContent>
                              </Tooltip>
                            ) : (
                              <span className="text-xs text-muted-foreground">—</span>
                            )}
                          </TableCell>
                          <TableCell>
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="size-8"
                                  aria-label={`Actions for ${u.username}`}
                                >
                                  <MoreHorizontal className="size-4" aria-hidden />
                                </Button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="end" className="w-56">
                                <DropdownMenuItem
                                  onClick={() => void toggleDisabled(u)}
                                  disabled={isSelf}
                                >
                                  {u.disabled ? (
                                    <CircleCheck className="size-3.5" aria-hidden />
                                  ) : (
                                    <Ban className="size-3.5" aria-hidden />
                                  )}
                                  {u.disabled ? "Enable" : "Disable"}
                                </DropdownMenuItem>
                                <DropdownMenuItem onClick={() => void resetPassword(u)}>
                                  <KeyRound className="size-3.5" aria-hidden />
                                  Reset password…
                                </DropdownMenuItem>
                                <DropdownMenuSub>
                                  <DropdownMenuSubTrigger className="gap-2">
                                    <UserCog className="size-3.5" aria-hidden />
                                    Change role
                                  </DropdownMenuSubTrigger>
                                  <DropdownMenuSubContent className="w-56">
                                    {ROLES.map((r) => (
                                      <DropdownMenuItem
                                        key={r}
                                        onClick={() => void changeRole(u, r)}
                                        disabled={r === u.role}
                                        className="gap-2"
                                      >
                                        <span className="w-3.5 flex items-center justify-center">
                                          {r === u.role && <Check className="size-3.5" aria-hidden />}
                                        </span>
                                        <span className="text-xs">{r}</span>
                                        <span className="ml-auto text-[10px] text-muted-foreground truncate">
                                          {ROLE_DESC[r]}
                                        </span>
                                      </DropdownMenuItem>
                                    ))}
                                  </DropdownMenuSubContent>
                                </DropdownMenuSub>
                                <DropdownMenuSeparator />
                                <DropdownMenuItem
                                  variant="destructive"
                                  onClick={() => setDeleteTarget(u)}
                                  disabled={isSelf}
                                >
                                  <Trash2 className="size-3.5" aria-hidden />
                                  Delete
                                </DropdownMenuItem>
                              </DropdownMenuContent>
                            </DropdownMenu>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </div>
      </div>

      {/* Add-user dialog */}
      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Add user</DialogTitle>
            <DialogDescription>
              Create an account on this node. No mail is ever sent — hand over the password in person.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="new-username">Username</Label>
              <Input
                id="new-username"
                value={fUsername}
                onChange={(e) => setFUsername(e.target.value)}
                placeholder="e.g. jsmith"
                className="font-mono text-xs"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="new-display">Display name (optional)</Label>
              <Input
                id="new-display"
                value={fDisplay}
                onChange={(e) => setFDisplay(e.target.value)}
                placeholder="e.g. Jane Smith"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="new-password">Password</Label>
              <Input
                id="new-password"
                type="password"
                value={fPassword}
                onChange={(e) => setFPassword(e.target.value)}
                autoComplete="new-password"
              />
              <p className="text-[11px] text-muted-foreground">8+ chars, letters + numbers</p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="new-role">Role</Label>
              <Select value={fRole} onValueChange={(v) => setFRole(v as UserInfo["role"])}>
                <SelectTrigger id="new-role" className="w-full text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ROLES.map((r) => (
                    <SelectItem key={r} value={r} className="text-xs">
                      {r} — {ROLE_DESC[r]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAddOpen(false)} disabled={creating}>
              Cancel
            </Button>
            <Button onClick={() => void createUser()} disabled={creating}>
              {creating && <Loader2 className="size-3.5 animate-spin" aria-hidden />}
              Create user
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirmation */}
      <AlertDialog open={!!deleteTarget} onOpenChange={(o) => !o && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{deleteTarget?.username}”?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently removes the account, its sessions and its API token from this node.
              Lester refuses to delete your own account or the last remaining admin.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <Button variant="destructive" disabled={deleting} onClick={() => void deleteUser()}>
              {deleting && <Loader2 className="size-3.5 animate-spin" aria-hidden />}
              Delete user
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// ═══ Models screen ═══════════════════════════════════════════════════════════════
// merged from src/components/console/ModelsScreen.tsx

type ModelAction =
  | "install"
  | "uninstall"
  | "approve"
  | "disapprove"
  | "enable"
  | "disable"
  | "syncCloud";

const NO_ENGINE_HINT =
  "Installing local model files needs a local engine (Ollama, LM Studio, llama.cpp, vLLM). Connect one in Settings → Engine — the Detect engines button finds it automatically.";

function formatGb(sizeMb: number): string {
  if (sizeMb <= 0) return "—";
  return `${(sizeMb / 1024).toFixed(1)} GB`;
}

function ProviderBadge({ provider }: { provider: InstalledModel["provider"] }) {
  if (provider === "LOCAL_ENGINE") {
    return <Badge variant="secondary" className="text-[10px]">local</Badge>;
  }
  return (
    <Badge variant="outline" className="text-[10px] border-amber-500/40 text-amber-700 dark:text-amber-400">
      cloud
    </Badge>
  );
}

function FitBadge({ fit }: { fit: FitAssessment | null }) {
  if (!fit) return <span className="text-xs text-muted-foreground">—</span>;
  const badge =
    fit.level === "no" ? (
      <Badge variant="destructive" className="text-[10px] cursor-help">{fit.label}</Badge>
    ) : fit.level === "tight" ? (
      <Badge
        variant="outline"
        className="text-[10px] cursor-help border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400"
      >
        {fit.label}
      </Badge>
    ) : (
      <Badge className="text-[10px] cursor-help">{fit.label}</Badge>
    );
  return (
    <Tooltip>
      <TooltipTrigger asChild>{badge}</TooltipTrigger>
      <TooltipContent side="top" className="max-w-64 text-xs">
        {fit.reason}
      </TooltipContent>
    </Tooltip>
  );
}

export function ModelsScreen() {
  const { user } = useLester();
  const role = user?.role ?? "MEMBER";
  const isAdmin = role === "ADMIN";

  const [data, setData] = useState<ModelsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<{ action: ModelAction; id: string } | null>(null);
  const [pendingUninstall, setPendingUninstall] = useState<InstalledModel | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await apiGet<ModelsResponse>("/api/models");
      setData(r);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not load the model registry.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function act(action: ModelAction, key?: string, providerId?: string) {
    setBusy({ action, id: key ?? providerId ?? "" });
    try {
      const r = await apiPost<{ ok: boolean; added?: number }>("/api/models", { action, key, providerId });
      if (action === "install") {
        toast.success("Model downloaded through the engine — approved and enabled.");
      } else if (action === "uninstall") {
        toast.success("Model files removed from the engine.");
      } else if (action === "syncCloud") {
        toast.success(
          typeof r.added === "number"
            ? `Discovered ${r.added} models — they start UNapproved; approve them in the Installed tab.`
            : "Cloud models discovered — they start UNapproved; approve them in the Installed tab."
        );
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Action failed.");
    } finally {
      setBusy(null);
      void load();
    }
  }

  const rowBusy = (id: string) => busy !== null && busy.id === id;
  const actionBusy = (action: ModelAction, id: string) =>
    busy !== null && busy.action === action && busy.id === id;

  if (loading) {
    return (
      <div className="h-full flex flex-col min-h-0 p-4 gap-4 max-w-6xl w-full mx-auto" aria-label="Loading models">
        <Skeleton className="h-8 w-56" />
        <Skeleton className="h-24 rounded-lg" />
        <Skeleton className="h-9 w-72" />
        <div className="space-y-2">
          {[0, 1, 2, 3, 4].map((i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="h-full grid place-items-center p-6" role="status">
        <div className="text-center space-y-3">
          <Boxes className="size-10 mx-auto text-muted-foreground/40" aria-hidden />
          <p className="text-sm text-muted-foreground">Model registry unavailable.</p>
          <Button
            size="sm"
            variant="outline"
            className="h-9"
            onClick={() => {
              setLoading(true);
              void load();
            }}
            aria-label="Retry loading the model registry"
          >
            <RefreshCw className="size-3.5" aria-hidden />
            Retry
          </Button>
        </div>
      </div>
    );
  }

  const { installed, catalog, engine, cloudProviders } = data;
  const installedRows = installed.filter((m) => m.installed);
  const noEngine = engine.type === "none";

  return (
    <div className="h-full flex flex-col min-h-0">
      {/* Header */}
      <header className="shrink-0 border-b bg-card/60 px-4 py-3 flex items-center gap-3">
        <div className="min-w-0">
          <h1 className="text-sm font-semibold leading-tight">Models</h1>
          <p className="text-xs text-muted-foreground mt-0.5 hidden sm:block">
            Registry, hardware fit and approvals{!isAdmin && " — read-only view for your role"}.
          </p>
        </div>
        <div className="ml-auto shrink-0">
          <Button
            size="sm"
            variant="outline"
            className="h-9"
            onClick={() => {
              setLoading(true);
              void load();
            }}
            aria-label="Refresh model registry"
          >
            <RefreshCw className="size-3.5" aria-hidden />
            <span className="hidden sm:inline">Refresh</span>
          </Button>
        </div>
      </header>

      <div className="flex-1 min-h-0 flex flex-col gap-3 p-3 sm:p-4 max-w-6xl w-full mx-auto">
        {/* Engine status */}
        <section
          className="shrink-0 rounded-lg border bg-card p-4 flex flex-wrap items-center gap-x-5 gap-y-3"
          aria-label="Engine status"
        >
          <div className="min-w-0">
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Engine</p>
            <p className="text-sm font-medium leading-tight">{engine.label}</p>
            <p
              className="text-[11px] text-muted-foreground font-mono truncate max-w-48 sm:max-w-72"
              title={engine.url}
            >
              {engine.url}
            </p>
          </div>
          <div className="flex items-center gap-2 min-w-0">
            {engine.reachable ? (
              <Badge className="gap-1.5">
                <span className="size-1.5 rounded-full bg-primary-foreground/70" aria-hidden />
                reachable
              </Badge>
            ) : (
              <Badge variant="destructive" className="gap-1.5">
                <span className="size-1.5 rounded-full bg-white/70" aria-hidden />
                unreachable
              </Badge>
            )}
            {engine.error && !engine.reachable && (
              <span className="text-xs text-destructive truncate max-w-44 sm:max-w-xs" title={engine.error}>
                {engine.error}
              </span>
            )}
          </div>
          <div className="ml-auto text-right shrink-0">
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Models on engine</p>
            <p className="text-sm font-medium tabular leading-tight">{engine.models.length}</p>
          </div>
        </section>

        {!engine.reachable && (
          <div
            className="shrink-0 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400 flex items-start gap-2"
            role="alert"
          >
            <TriangleAlert className="size-3.5 mt-0.5 shrink-0" aria-hidden />
            <span>
              Start your local engine (e.g. <code className="font-mono">ollama serve</code>) or switch
              engine in Settings → Engine.
            </span>
          </div>
        )}

        <Tabs defaultValue="installed" className="flex-1 min-h-0 flex flex-col gap-3">
          <TabsList className="shrink-0 w-full sm:w-fit">
            <TabsTrigger value="installed" className="gap-1.5">
              Installed
              <span className="tabular text-[10px] text-muted-foreground">{installedRows.length}</span>
            </TabsTrigger>
            <TabsTrigger value="catalog">Catalog</TabsTrigger>
            <TabsTrigger value="cloud">Cloud</TabsTrigger>
          </TabsList>

          {/* Installed */}
          <TabsContent
            value="installed"
            className="flex-1 min-h-0 overflow-y-auto scrollbar-thin"
            aria-label="Installed models"
          >
            {installedRows.length === 0 ? (
              <div className="h-full min-h-48 flex flex-col items-center justify-center text-center p-6 gap-3">
                <div className="size-12 rounded-full border border-primary/15 bg-primary/5 grid place-items-center">
                  <Boxes className="size-6 text-primary/50" aria-hidden />
                </div>
                <h3 className="text-sm font-medium">No models installed</h3>
                <p className="text-xs text-muted-foreground max-w-xs leading-relaxed">
                  Install a catalog model through your local engine, or sync a cloud provider — then
                  approve it here for chat.
                </p>
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Model</TableHead>
                    <TableHead>Provider</TableHead>
                    <TableHead>Params</TableHead>
                    <TableHead>Quant</TableHead>
                    <TableHead>Size</TableHead>
                    <TableHead>Hardware fit</TableHead>
                    <TableHead>Approved</TableHead>
                    <TableHead>Enabled</TableHead>
                    <TableHead className="w-28">
                      <span className="sr-only">Actions</span>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {installedRows.map((m) => (
                    <TableRow key={m.key}>
                      <TableCell className="max-w-40 sm:max-w-56">
                        <div className="flex items-center gap-2">
                          {rowBusy(m.key) && (
                            <Loader2 className="size-3.5 animate-spin text-primary shrink-0" aria-hidden />
                          )}
                          <span className="truncate font-medium" title={m.name}>
                            {m.name}
                          </span>
                        </div>
                        <p className="text-[10px] text-muted-foreground">{m.family}</p>
                      </TableCell>
                      <TableCell>
                        <ProviderBadge provider={m.provider} />
                      </TableCell>
                      <TableCell className="tabular text-muted-foreground">
                        {m.paramsB > 0 ? `${m.paramsB}B` : "—"}
                      </TableCell>
                      <TableCell className="text-muted-foreground">{m.quant || "—"}</TableCell>
                      <TableCell className="tabular text-muted-foreground">{formatGb(m.sizeMb)}</TableCell>
                      <TableCell>
                        {m.provider === "LOCAL_ENGINE" ? (
                          <FitBadge fit={(m.fit ?? null)} />
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell>
                        {isAdmin ? (
                          <Switch
                            checked={m.approved}
                            onCheckedChange={(v) => void act(v ? "approve" : "disapprove", m.key)}
                            disabled={rowBusy(m.key)}
                            aria-label={`Approve ${m.name}`}
                          />
                        ) : (
                          <span role="img" aria-label={m.approved ? "Approved" : "Not approved"}>
                            {m.approved ? (
                              <Check className="size-4 text-primary" aria-hidden />
                            ) : (
                              <X className="size-4 text-muted-foreground/60" aria-hidden />
                            )}
                          </span>
                        )}
                      </TableCell>
                      <TableCell>
                        {isAdmin ? (
                          <Switch
                            checked={m.enabled}
                            onCheckedChange={(v) => void act(v ? "enable" : "disable", m.key)}
                            disabled={rowBusy(m.key)}
                            aria-label={`Enable ${m.name}`}
                          />
                        ) : (
                          <span role="img" aria-label={m.enabled ? "Enabled" : "Disabled"}>
                            {m.enabled ? (
                              <Check className="size-4 text-primary" aria-hidden />
                            ) : (
                              <X className="size-4 text-muted-foreground/60" aria-hidden />
                            )}
                          </span>
                        )}
                      </TableCell>
                      <TableCell>
                        {isAdmin ? (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-9 px-2.5 text-muted-foreground hover:text-destructive"
                            onClick={() => setPendingUninstall(m)}
                            disabled={rowBusy(m.key)}
                            aria-label={`Uninstall ${m.name}`}
                          >
                            {actionBusy("uninstall", m.key) ? (
                              <Loader2 className="size-3.5 animate-spin" aria-hidden />
                            ) : (
                              <Trash2 className="size-3.5" aria-hidden />
                            )}
                            <span className="hidden xl:inline">Uninstall</span>
                          </Button>
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </TabsContent>

          {/* Catalog */}
          <TabsContent
            value="catalog"
            className="flex-1 min-h-0 overflow-y-auto scrollbar-thin"
            aria-label="Model catalog"
          >
            <p className="text-xs text-muted-foreground mb-3">
              Catalog models download through your local engine (Ollama tags, Q4_K_M).
            </p>
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {catalog.map((c) => (
                <div key={c.key} className="rounded-lg border bg-card p-4 flex flex-col gap-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-sm font-medium truncate" title={c.name}>
                        {c.name}
                      </p>
                      <p className="text-[11px] text-muted-foreground mt-0.5">
                        {c.family} · {c.quant}
                      </p>
                    </div>
                    <FitBadge fit={c.fit ?? null} />
                  </div>
                  <div className="flex items-center gap-2 text-xs text-muted-foreground flex-wrap">
                    <span className="tabular">{c.paramsB}B params</span>
                    <span aria-hidden>·</span>
                    <span className="tabular">≈{(c.sizeMb / 1024).toFixed(1)} GB download</span>
                  </div>
                  <p className="text-xs text-muted-foreground leading-relaxed">{c.note}</p>
                  <div className="mt-auto pt-1">
                    {c.installed ? (
                      <Button variant="outline" size="sm" className="h-9 w-full gap-1.5" disabled>
                        <Check className="size-3.5 text-primary" aria-hidden />
                        Installed ✓
                      </Button>
                    ) : !isAdmin ? (
                      <p className="text-[10px] text-muted-foreground text-center">
                        Installs are admin-only
                      </p>
                    ) : noEngine ? (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span
                            tabIndex={0}
                            className="block rounded-md"
                            aria-label={`Install ${c.name} — requires a local engine`}
                          >
                            <Button variant="outline" size="sm" className="h-9 w-full pointer-events-none" disabled>
                              <Download className="size-3.5" aria-hidden />
                              Install
                            </Button>
                          </span>
                        </TooltipTrigger>
                        <TooltipContent side="top" className="max-w-64 text-xs">
                          {NO_ENGINE_HINT}
                        </TooltipContent>
                      </Tooltip>
                    ) : actionBusy("install", c.key) ? (
                      <Button size="sm" className="h-9 w-full" disabled aria-live="polite">
                        <Loader2 className="size-3.5 animate-spin" aria-hidden />
                        downloading via engine…
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        className="h-9 w-full"
                        onClick={() => void act("install", c.key)}
                        aria-label={`Install ${c.name}`}
                      >
                        <Download className="size-3.5" aria-hidden />
                        Install
                      </Button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </TabsContent>

          {/* Cloud */}
          <TabsContent
            value="cloud"
            className="flex-1 min-h-0 overflow-y-auto scrollbar-thin"
            aria-label="Cloud providers"
          >
            {cloudProviders.length === 0 ? (
              <div className="h-full min-h-48 flex flex-col items-center justify-center text-center p-6 gap-3">
                <div className="size-12 rounded-full border border-primary/15 bg-primary/5 grid place-items-center">
                  <CloudOff className="size-6 text-primary/50" aria-hidden />
                </div>
                <h3 className="text-sm font-medium">No cloud providers configured</h3>
                <p className="text-xs text-muted-foreground max-w-sm leading-relaxed">
                  Cloud providers are configured in Settings — cloud is OFF by default, and Lester
                  records every cloud byte in the Proof ledger.
                </p>
              </div>
            ) : (
              <div className="space-y-3">
                {cloudProviders.map((p) => (
                  <div
                    key={p.id}
                    className="rounded-lg border bg-card p-4 flex flex-wrap items-center gap-x-4 gap-y-3"
                  >
                    <div className="min-w-0">
                      <p className="text-sm font-medium leading-tight">{p.label}</p>
                      <p
                        className="text-[11px] font-mono text-muted-foreground truncate max-w-48 sm:max-w-72"
                        title={p.baseUrl}
                      >
                        {p.baseUrl}
                      </p>
                      <p className="text-[11px] text-muted-foreground mt-0.5">
                        default model: <span className="font-mono">{p.defaultModel || "—"}</span>
                      </p>
                    </div>
                    <div className="ml-auto flex flex-wrap items-center gap-2">
                      {p.enabled ? (
                        <Badge className="gap-1.5">
                          <span className="size-1.5 rounded-full bg-primary-foreground/70" aria-hidden />
                          enabled
                        </Badge>
                      ) : (
                        <Badge variant="outline">disabled</Badge>
                      )}
                      {!p.hasKey && (
                        <Badge variant="outline" className="text-muted-foreground">no API key</Badge>
                      )}
                      {isAdmin && (
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-9"
                          onClick={() => void act("syncCloud", undefined, p.id)}
                          disabled={actionBusy("syncCloud", p.id)}
                          aria-label={`Sync models from ${p.label}`}
                        >
                          {actionBusy("syncCloud", p.id) ? (
                            <Loader2 className="size-3.5 animate-spin" aria-hidden />
                          ) : (
                            <RefreshCw className="size-3.5" aria-hidden />
                          )}
                          {actionBusy("syncCloud", p.id) ? "Syncing…" : "Sync models"}
                        </Button>
                      )}
                    </div>
                  </div>
                ))}
                {!isAdmin && (
                  <p className="text-[10px] text-muted-foreground px-1">
                    Syncing cloud models is an admin action.
                  </p>
                )}
              </div>
            )}
          </TabsContent>
        </Tabs>
      </div>

      {/* Uninstall confirmation */}
      <AlertDialog
        open={pendingUninstall !== null}
        onOpenChange={(o) => {
          if (!o) setPendingUninstall(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Uninstall {pendingUninstall?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              Model files are removed from your engine. You can reinstall it from the Catalog any
              time. The action is recorded in the Proof ledger.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90"
              onClick={() => {
                const target = pendingUninstall;
                setPendingUninstall(null);
                if (target) void act("uninstall", target.key);
              }}
            >
              Uninstall
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

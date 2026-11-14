"use client";

import { useCallback, useEffect, useState, useTransition } from "react";
import { useLester } from "@/lib/client";
import { apiGet, type SetupStatus, type SessionUser, type WorkspaceInfo } from "@/lib/client";
import { BootSplash, SetupWizard, LoginScreen, Shell } from "@/components/console/entry";

type Phase = "loading" | "setup" | "login" | "app";

export default function Page() {
  const [phase, setPhase] = useState<Phase>("loading");
  const [setupStatus, setSetupStatus] = useState<SetupStatus | null>(null);
  const { setUser, setWorkspaces } = useLester();
  const [, startTransition] = useTransition();

  const enterApp = useCallback(
    async (user: SessionUser) => {
      setUser(user);
      try {
        const ws = await apiGet<{ workspaces: WorkspaceInfo[] }>("/api/workspaces");
        setWorkspaces(ws.workspaces);
      } catch {
        setWorkspaces([]);
      }
      startTransition(() => setPhase("app"));
    },
    [setUser, setWorkspaces, startTransition]
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const status = await apiGet<SetupStatus>("/api/setup/status");
        if (cancelled) return;
        setSetupStatus(status);
        if (!status.setupComplete) {
          setPhase("setup");
          return;
        }
        const session = await apiGet<{ user: SessionUser }>("/api/auth/session").catch(() => null);
        if (cancelled) return;
        if (!session?.user) {
          setPhase("login");
          return;
        }
        await enterApp(session.user);
      } catch {
        if (!cancelled) setPhase("login");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [enterApp]);

  if (phase === "loading") return <BootSplash />;
  if (phase === "setup" && setupStatus) {
    return <SetupWizard status={setupStatus} onDone={(user) => void enterApp(user)} />;
  }
  if (phase === "login") {
    return <LoginScreen onLogin={(user) => void enterApp(user)} />;
  }
  return (
    <Shell
      onLogout={() => {
        setUser(null);
        setPhase("login");
      }}
    />
  );
}

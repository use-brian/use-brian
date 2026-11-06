"use client";

import { createContext, useContext, useEffect, useMemo, useSyncExternalStore, type ReactNode } from "react";
import { usePathname, useRouter } from "next/navigation";
import { AppSessionController, type SessionAdapter, type SessionSnapshot } from "@/lib/app-session";
import { authFetch, getAccessToken, getValidAccessToken, AuthRefreshUnavailableError } from "@/lib/auth-fetch";
import { desktopBridge, isDesktopAuth } from "@/lib/desktop-auth-source";
import { idbGet, idbSet, idbDelete } from "@/lib/offline/idb";
import { publicRuntimeConfig } from "@/lib/runtime-public-config";
import { isGuardedPath } from "@/lib/site-hosts";
import { sessionIdentity, subscribeSessionEvents } from "@/lib/session-events";
import { Button } from "./ui/button";
import { WorkspacePicker } from "./workspace-picker";
import { useT } from "@/lib/i18n/client";
import { AccountEntry } from "./account-entry";

const SessionContext = createContext<{ controller: AppSessionController; serverUserId?: string } | null>(null);
const empty: SessionSnapshot = { session: "checking", connection: "online", identity: null, workspaces: [], admissions: {} };
const serverSnapshot = () => empty;
const cacheKey = (identity: string) => `app:admission:v1:${identity}`;

function browserAdapter(): SessionAdapter {
  const identity = () => sessionIdentity(getAccessToken(), desktopBridge()?.getUserId?.());
  const request = async (path: string) => {
    if (navigator.onLine === false) throw new TypeError("Offline");
    const before = identity();
    let res: Response;
    try { res = await authFetch(`${publicRuntimeConfig().apiUrl}/api${path}`, { signal: AbortSignal.timeout(15_000) }); }
    catch (error) { if (error instanceof AuthRefreshUnavailableError) return { status: 503 }; throw error; }
    if (before && identity() !== before) return { status: 409 };
    if (!res.ok) return { status: res.status };
    try { return { status: res.status, data: await res.json() }; } catch { return { status: 502 }; }
  };
  return {
    identity,
    subject: () => { try { const key = identity(); return key ? JSON.parse(key)[2] : null; } catch { return null; } },
    hasCredential: () => Boolean(getAccessToken() || desktopBridge()?.getRefreshToken?.()),
    session: async () => {
      if (isDesktopAuth() && !getAccessToken() && !desktopBridge()?.getRefreshToken?.()) return { status: 401 };
      await getValidAccessToken();
      if (isDesktopAuth() && !getAccessToken() && !desktopBridge()?.getRefreshToken?.()) return { status: 401 };
      return request("/workspaces");
    },
    workspace: (id) => request(`/workspaces/${encodeURIComponent(id)}`),
    read: (identity) => idbGet(cacheKey(identity)),
    write: (identity, value) => value ? idbSet(cacheKey(identity), value) : idbDelete(cacheKey(identity)),
  };
}

/** Mounted once per renderer, including public account entry. [COMP:app-web/app-session] */
export function AppSessionProvider({ children, adapter, serverUserId }: { children: ReactNode; adapter?: SessionAdapter; serverUserId?: string }) {
  const path = usePathname();
  const controller = useMemo(() => new AppSessionController(adapter ?? browserAdapter()), [adapter]);
  const value = useMemo(() => ({ controller, serverUserId }), [controller, serverUserId]);
  useEffect(() => {
    const stop = subscribeSessionEvents((event) => controller.invalidate(event.type === "logout", event.identity));
    const stopNative = desktopBridge()?.onSessionCleared?.(reason => controller.invalidate(reason === "logout"));
    const stopRestored = desktopBridge()?.onSessionRestored?.(() => { void controller.check(); });
    return () => { stop(); stopNative?.(); stopRestored?.(); };
  }, [controller]);
  useEffect(() => {
    const recheck = () => {
      const snapshot = controller.snapshot();
      if (document.visibilityState === "hidden" ||
          (snapshot.session !== "authenticated" && !(snapshot.session === "checking" && snapshot.connection !== "online"))) return;
      void controller.check().then(() => {
        const id = /^\/w\/([^/]+)/.exec(path)?.[1] ?? /^\/desktop\/chat\/([^/]+)/.exec(path)?.[1];
        if (id) void controller.admit(id, true);
      });
    };
    window.addEventListener("online", recheck);
    window.addEventListener("focus", recheck);
    document.addEventListener("visibilitychange", recheck);
    const interval = setInterval(recheck, 60_000);
    return () => {
      clearInterval(interval); window.removeEventListener("online", recheck); window.removeEventListener("focus", recheck);
      document.removeEventListener("visibilitychange", recheck);
    };
  }, [controller, path]);
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}
const noSubscribe = () => () => {};
export function useOptionalAppSession() {
  const context = useContext(SessionContext);
  const state = useSyncExternalStore(context?.controller.subscribe ?? noSubscribe, context?.controller.snapshot ?? serverSnapshot, serverSnapshot);
  return context ? { state, ...context } : null;
}
export function useAppSession() {
  const value = useOptionalAppSession();
  if (!value) throw new Error("AppSessionProvider is required");
  return value;
}

function SessionGate({ children, workspaceId }: { children: ReactNode; workspaceId?: string }) {
  const { state, controller, serverUserId } = useAppSession();
  let renderedSubject: string | undefined;
  try { renderedSubject = state.identity ? JSON.parse(state.identity)[2] : undefined; } catch {}
  const changedServerIdentity = !desktopBridge() && Boolean(serverUserId && renderedSubject && serverUserId !== renderedSubject);
  useEffect(() => { if (changedServerIdentity) window.location.reload(); }, [changedServerIdentity]);
  useEffect(() => { if (controller.snapshot().session === "checking") void controller.check(); }, [controller]);
  useEffect(() => {
    if (state.session === "authenticated" && workspaceId) void controller.admit(workspaceId);
  }, [controller, state.session, state.identity, workspaceId]);
  const admission = workspaceId ? state.admissions[workspaceId] : undefined;
  if (changedServerIdentity) return <AccountEntry mode="checking" />;
  if (state.session !== "authenticated" || (workspaceId && admission?.kind !== "allowed")) {
    return <AccountEntry mode={state.session === "authenticated" ? admission?.kind ?? "checking" : state.session}
      retry={() => void controller.check().then(() => { if (workspaceId) return controller.admit(workspaceId, true); })} />;
  }
  return <>{children}</>;
}

/** Public callbacks/handoffs never inherit workspace authority. */
export function SessionRouteBoundary({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const workspaceId = /^\/w\/([^/]+)/.exec(pathname)?.[1] ?? /^\/desktop\/chat\/([^/]+)/.exec(pathname)?.[1];
  const explicitEntry = typeof window !== "undefined" && desktopBridge() && new URLSearchParams(window.location.search).get("accountEntry");
  if (explicitEntry && pathname === "/") return <AccountEntry recovery={explicitEntry} />;
  const protectedRoute = pathname === "/" || isGuardedPath(pathname);
  return protectedRoute ? <SessionGate workspaceId={workspaceId}>{children}</SessionGate> : <>{children}</>;
}


export function SessionWorkspacePicker({ next = "" }: { next?: string }) {
  const { state } = useAppSession(); const router = useRouter(); const t = useT();
  useEffect(() => {
    if (state.workspaces.length === 1) router.replace(`/w/${state.workspaces[0].id}${next}`);
  }, [router, state.workspaces, next]);
  return <main className="flex min-h-dvh items-center justify-center bg-background px-4 py-12 text-foreground">
    <div className="w-full max-w-lg space-y-6"><h1 className="text-2xl font-semibold">{t.teams.title}</h1>
      <WorkspacePicker initialWorkspaces={state.workspaces} next={next} />
      <Button className="max-md:min-h-11" variant="outline" onClick={() => router.push("/accounts")}>{t.desktopSession.switchAccount}</Button>
    </div>
  </main>;
}

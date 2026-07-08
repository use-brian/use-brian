"use client";

/**
 * `useWorkspaces()` adapter for app-web — the consolidation foundation.
 *
 * Web surfaces being folded into app-web (Brain / Studio / Workflow /
 * Approvals / Settings) all read the active workspace through
 * `apps/web`'s `@/contexts/workspace-context` → `useWorkspaces()`, which
 * returns `{ workspaces, activeId, active, setActive }` backed by a
 * module-level `useSyncExternalStore` singleton + `localStorage`
 * (multi-workspace switcher model).
 *
 * app-web is **single-workspace per route** (`/w/[workspaceId]/...`):
 * the active workspace *is* the route param, exposed by the existing
 * per-route `@/lib/workspace-context` (`useWorkspaceContext()`). This module
 * is the seam that lets ported surfaces keep importing
 * `@/contexts/workspace-context` unchanged while sourcing `activeId` from the
 * route rather than a localStorage singleton. The only mutable shared state
 * here is the **workspace list** (for the switcher + settings); the active id
 * is route-derived, and `setActive` navigates.
 *
 * Why mirror `apps/web`'s path + exported names: ported surfaces import
 * `@/contexts/workspace-context` and call `useWorkspaces`, `setWorkspaces`,
 * `useWorkspaceFetch`, etc. Keeping the same surface means a surface port is a
 * file move, not an import rewrite.
 *
 * Spec: docs/architecture/features/doc.md §5a → "The hard prerequisite".
 * [COMP:app-web/workspaces-adapter]
 */

import { useCallback, useEffect, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import { authFetch } from "@/lib/auth-fetch";
import { docPagePath } from "@/lib/doc-page-url";
import { useWorkspaceContext } from "@/lib/workspace-context";

/** Mirror of `apps/web`'s `Workspace` so ported surfaces typecheck unchanged. */
export type Workspace = {
  id: string;
  name: string;
  plan?: string | null;
  /** Live `workspace_members` count; drives solo-vs-shared connector behavior. */
  memberCount?: number;
  iconSeed?: number | null;
  /** `true` for the auto-created default workspace (`is_personal`) — a label
   *  only; it gates no connector/sharing behavior (that keys on `memberCount`). */
  isPersonal?: boolean;
};

// ── Workspace list cache (the only mutable shared state) ──────────────────
// The active id is NOT cached here — it is route-derived (see `useWorkspaces`).
// `lastRouteActiveId` is a write-through mirror of the current route's
// workspace so the imperative `getActiveWorkspaceId()` keeps working for
// non-React callers ported from web; React readers use the hook.

let cachedWorkspaces: Workspace[] = [];
let lastRouteActiveId: string | null = null;

// `useSyncExternalStore` requires a stable snapshot reference between
// mutations — mint a new object only in `emit()`.
let cachedSnapshot: { workspaces: Workspace[] } = { workspaces: cachedWorkspaces };
const SERVER_SNAPSHOT: { workspaces: Workspace[] } = { workspaces: [] };

type Listener = () => void;
const listeners = new Set<Listener>();

function emit(): void {
  cachedSnapshot = { workspaces: cachedWorkspaces };
  listeners.forEach((fn) => fn());
}

function subscribe(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

function snapshot(): { workspaces: Workspace[] } {
  return cachedSnapshot;
}

function getServerSnapshot(): { workspaces: Workspace[] } {
  return SERVER_SNAPSHOT;
}

/** Replace the cached workspace list. Active id stays route-derived. */
export function setWorkspaces(workspaces: Workspace[]): void {
  if (!Array.isArray(workspaces)) return;
  cachedWorkspaces = workspaces;
  emit();
}

/**
 * Patch a single cached workspace in place (e.g. after its icon regenerates).
 * No-op if the id isn't in the list. Emits so subscribers re-render.
 */
export function updateWorkspace(id: string, patch: Partial<Workspace>): void {
  if (!cachedWorkspaces.some((w) => w.id === id)) return; // no-op preserves the reference
  cachedWorkspaces = cachedWorkspaces.map((w) =>
    w.id === id ? { ...w, ...patch } : w,
  );
  emit();
}

/**
 * Imperative read of the active workspace id for non-React callers ported
 * from web. In app-web the source of truth is the route; this returns the
 * last id a `useWorkspaces()` render observed. React components should read
 * the hook (which is always route-current) instead.
 */
export function getActiveWorkspaceId(): string | null {
  return lastRouteActiveId;
}

/** Imperative read of the cached workspace list (non-React callers + tests). */
export function getCachedWorkspaces(): Workspace[] {
  return cachedWorkspaces;
}

/**
 * Compatibility no-op for ported callers: in app-web the active workspace
 * is the route, so there is no imperative "set active" without navigation.
 * `useWorkspaces().setActive` performs the route navigation instead.
 */
export function setActiveWorkspaceId(_id: string | null): void {
  // Intentionally a no-op — route is the source of truth. Kept so ported
  // imports resolve; navigation goes through `useWorkspaces().setActive`.
}

/** Compatibility no-op — the route hydrates the active workspace in app-web. */
export function useWorkspaceHydrate(): void {}

/**
 * Hook returning the workspace list + the route-derived active id, matching
 * `apps/web`'s `useWorkspaces()` shape. `setActive` navigates to the target
 * workspace (app-web is route-scoped, so switching = navigation).
 *
 * Must be called inside a `WorkspaceContextProvider` (every `/w/[workspaceId]`
 * route mounts one), since `activeId` reads from the route context.
 */
export function useWorkspaces(): {
  workspaces: Workspace[];
  activeId: string | null;
  active: Workspace | null;
  setActive: (id: string) => void;
} {
  const { workspaces } = useSyncExternalStore(subscribe, snapshot, getServerSnapshot);
  const ctx = useWorkspaceContext();
  const router = useRouter();
  const activeId = ctx.workspaceId;
  // Write-through so the imperative `getActiveWorkspaceId()` reflects the route.
  lastRouteActiveId = activeId;
  const active = workspaces.find((w) => w.id === activeId) ?? null;
  const setActive = useCallback(
    (id: string) => {
      if (id !== activeId) router.push(docPagePath(id));
    },
    [activeId, router],
  );
  return { workspaces, activeId, active, setActive };
}

/**
 * Fetch the workspace list once per app load into the shared cache. Mount on
 * a layout so every ported surface can rely on the list being populated;
 * subsequent route transitions don't re-fetch. Mirrors `apps/web`.
 */
export function useWorkspaceFetch(apiUrl: string): void {
  useEffect(() => {
    if (cachedWorkspaces.length > 0) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await authFetch(`${apiUrl}/api/workspaces`);
        if (!res.ok || cancelled) return;
        const data = (await res.json()) as {
          workspaces?: Workspace[];
          teams?: Workspace[];
        };
        const list = Array.isArray(data.workspaces)
          ? data.workspaces
          : Array.isArray(data.teams)
            ? data.teams
            : [];
        if (!cancelled) setWorkspaces(list);
      } catch (err) {
        // Non-fatal — the switcher falls back to an empty list.
        console.warn("[workspace-context] fetch failed:", err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [apiUrl]);
}

/**
 * Test-only reset of the module cache. Not exported through the barrel; used by
 * the unit test to isolate cases.
 */
export function __resetWorkspaceCacheForTest(): void {
  cachedWorkspaces = [];
  lastRouteActiveId = null;
  cachedSnapshot = { workspaces: cachedWorkspaces };
  listeners.clear();
}

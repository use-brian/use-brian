"use client";

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

export type WorkspaceContextValue = {
  workspaceId: string;
  name: string;
  role: "owner" | "admin" | "member";
  /**
   * The requesting member's own data clearance (migration 153). The doc
   * page-header clearance pill bounds its picker to this — a member can't set
   * a page above their own clearance (the PATCH route enforces the same).
   */
  clearance: "public" | "internal" | "confidential";
  /**
   * Identity of the requesting user — used by collaborative surfaces
   * to dedupe own-events from bus broadcasts and skip presence flicker
   * for self.
   */
  me: { id: string };
};

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

/**
 * Rename broadcast — the provider's `value` is a static snapshot (fetched by
 * the Next server layout, or once by the desktop SPA's `WorkspaceShell`), so a
 * client-side rename in the settings modal would otherwise stay stale in every
 * `ctx.name` consumer (the top-left switcher trigger, breadcrumbs, …) until a
 * full reload — `router.refresh()` is not an option because the desktop shim
 * makes it a no-op. The settings rename dispatches this event after a
 * successful PATCH; the provider applies it as an override when the workspace
 * id matches. Same window-event pattern as the settings modal's
 * `OPEN_SETTINGS_EVENT`.
 */
export const WORKSPACE_RENAMED_EVENT = "brian:workspace-renamed";

export type WorkspaceRenamedDetail = { workspaceId: string; name: string };

export function emitWorkspaceRenamed(detail: WorkspaceRenamedDetail): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<WorkspaceRenamedDetail>(WORKSPACE_RENAMED_EVENT, { detail }),
  );
}

/**
 * Pure core of the provider's rename override (unit-tested — app-web vitest
 * has no DOM to dispatch real events into). Applies the last observed rename
 * to the static snapshot only when it targets the same workspace; a rename of
 * another workspace (or none) leaves the snapshot untouched, reference
 * included, so memoized consumers don't re-render.
 */
export function applyWorkspaceRename(
  base: WorkspaceContextValue,
  renamed: WorkspaceRenamedDetail | null,
): WorkspaceContextValue {
  if (!renamed || renamed.workspaceId !== base.workspaceId) return base;
  if (renamed.name === base.name) return base;
  return { ...base, name: renamed.name };
}

export function WorkspaceContextProvider(props: {
  value: WorkspaceContextValue;
  children: ReactNode;
}) {
  // Latest rename observed on this mount. Kept as {id, name} so an override
  // for one workspace never leaks onto another after a route change (the
  // provider instance survives `/w/[id]` param swaps — parent layouts don't
  // remount on child navigation).
  const [renamed, setRenamed] = useState<WorkspaceRenamedDetail | null>(null);

  useEffect(() => {
    function onRenamed(e: Event) {
      const detail = (e as CustomEvent<WorkspaceRenamedDetail>).detail;
      if (!detail?.workspaceId || !detail.name) return;
      setRenamed(detail);
    }
    window.addEventListener(WORKSPACE_RENAMED_EVENT, onRenamed);
    return () => window.removeEventListener(WORKSPACE_RENAMED_EVENT, onRenamed);
  }, []);

  const value = useMemo<WorkspaceContextValue>(
    () => applyWorkspaceRename(props.value, renamed),
    [props.value, renamed],
  );

  return (
    <WorkspaceContext.Provider value={value}>
      {props.children}
    </WorkspaceContext.Provider>
  );
}

export function useWorkspaceContext(): WorkspaceContextValue {
  const value = useContext(WorkspaceContext);
  if (!value) {
    throw new Error(
      "useWorkspaceContext must be used inside a WorkspaceContextProvider",
    );
  }
  return value;
}

"use client";


import { publicRuntimeConfig } from "@/lib/runtime-public-config";
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { authFetch } from "@/lib/auth-fetch";
import {
  WORKSPACE_IDENTITY_REFRESH_EVENT,
  type WorkspaceIdentityRefreshDetail,
} from "@/lib/workspace-identity-events";
import { updateWorkspacePickerPreferences } from "@/lib/api/workspaces";

const API_URL = publicRuntimeConfig().apiUrl ?? "http://localhost:4000";

export type WorkspaceContextValue = {
  workspaceId: string;
  name: string;
  /** Generated landmark fallback. */
  iconSeed?: number | null;
  /** Versioned public proxy URL for an uploaded workspace picture. */
  iconUrl?: string | null;
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
export const WORKSPACE_ICON_CHANGED_EVENT = "brian:workspace-icon-changed";

export type WorkspaceRenamedDetail = { workspaceId: string; name: string };
export type WorkspaceIconChangedDetail = {
  workspaceId: string;
  iconSeed: number | null;
  iconUrl: string | null;
};

export function emitWorkspaceRenamed(detail: WorkspaceRenamedDetail): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<WorkspaceRenamedDetail>(WORKSPACE_RENAMED_EVENT, { detail }),
  );
}

export function emitWorkspaceIconChanged(
  detail: WorkspaceIconChangedDetail,
): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<WorkspaceIconChangedDetail>(WORKSPACE_ICON_CHANGED_EVENT, {
      detail,
    }),
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

/** Pure custom-icon override used by the provider and unit tests. */
export function applyWorkspaceIcon(
  base: WorkspaceContextValue,
  changed: WorkspaceIconChangedDetail | null,
): WorkspaceContextValue {
  if (!changed || changed.workspaceId !== base.workspaceId) return base;
  if (
    changed.iconSeed === (base.iconSeed ?? null) &&
    changed.iconUrl === (base.iconUrl ?? null)
  ) {
    return base;
  }
  return {
    ...base,
    iconSeed: changed.iconSeed,
    iconUrl: changed.iconUrl,
  };
}

export function WorkspaceContextProvider(props: {
  value: WorkspaceContextValue;
  children: ReactNode;
  /** Desktop may point at a user-selected API origin. */
  apiUrl?: string;
}) {
  // Latest rename observed on this mount. Kept as {id, name} so an override
  // for one workspace never leaks onto another after a route change (the
  // provider instance survives `/w/[id]` param swaps — parent layouts don't
  // remount on child navigation).
  const [renamed, setRenamed] = useState<WorkspaceRenamedDetail | null>(null);
  const [iconChanged, setIconChanged] =
    useState<WorkspaceIconChangedDetail | null>(null);

  // Any real workspace open counts as recent, including a direct/deep link
  // that never passed through picker chrome. This is a non-critical navigation
  // preference write and never blocks the workspace shell.
  useEffect(() => {
    void updateWorkspacePickerPreferences(
      props.value.workspaceId,
      { opened: true },
      props.apiUrl,
    ).catch(() => {});
  }, [props.apiUrl, props.value.workspaceId]);

  useEffect(() => {
    function onRenamed(e: Event) {
      const detail = (e as CustomEvent<WorkspaceRenamedDetail>).detail;
      if (!detail?.workspaceId || !detail.name) return;
      setRenamed(detail);
    }
    window.addEventListener(WORKSPACE_RENAMED_EVENT, onRenamed);
    return () => window.removeEventListener(WORKSPACE_RENAMED_EVENT, onRenamed);
  }, []);

  useEffect(() => {
    function onIconChanged(e: Event) {
      const detail = (e as CustomEvent<WorkspaceIconChangedDetail>).detail;
      if (!detail?.workspaceId) return;
      setIconChanged(detail);
    }
    window.addEventListener(WORKSPACE_ICON_CHANGED_EVENT, onIconChanged);
    return () =>
      window.removeEventListener(WORKSPACE_ICON_CHANGED_EVENT, onIconChanged);
  }, []);

  // Cross-tab/device/team repair. `workspace_config` is a signal, not pushed
  // data, so re-read the active identity projection through the authenticated
  // detail route. The initiating tab also applies the direct events above and
  // does not wait for this round-trip.
  useEffect(() => {
    let disposed = false;
    async function onIdentityRefresh(e: Event) {
      const detail = (e as CustomEvent<WorkspaceIdentityRefreshDetail>).detail;
      if (detail?.workspaceId !== props.value.workspaceId) return;
      try {
        const res = await authFetch(
          `${API_URL}/api/workspaces/${encodeURIComponent(props.value.workspaceId)}`,
        );
        if (!res.ok || disposed) return;
        const next = (await res.json()) as {
          name?: string;
          iconSeed?: number | null;
          iconUrl?: string | null;
        };
        if (disposed) return;
        if (typeof next.name === "string" && next.name) {
          emitWorkspaceRenamed({
            workspaceId: props.value.workspaceId,
            name: next.name,
          });
        }
        emitWorkspaceIconChanged({
          workspaceId: props.value.workspaceId,
          iconSeed: next.iconSeed ?? null,
          iconUrl: next.iconUrl ?? null,
        });
      } catch {
        // Non-fatal chrome repair. The next stream reconnect/tab wake retries.
      }
    }
    window.addEventListener(
      WORKSPACE_IDENTITY_REFRESH_EVENT,
      onIdentityRefresh,
    );
    return () => {
      disposed = true;
      window.removeEventListener(
        WORKSPACE_IDENTITY_REFRESH_EVENT,
        onIdentityRefresh,
      );
    };
  }, [props.value.workspaceId]);

  const value = useMemo<WorkspaceContextValue>(
    () =>
      applyWorkspaceIcon(
        applyWorkspaceRename(props.value, renamed),
        iconChanged,
      ),
    [props.value, renamed, iconChanged],
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

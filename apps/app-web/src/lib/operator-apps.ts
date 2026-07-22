/**
 * Operator app registry — the single source of truth for the Home hub's
 * second bar (`OperatorAppBar`) and its sticky per-workspace selection.
 *
 * Two navigation tiers (docs/plans/tasks-operator-surface.md §2):
 *
 *   - The TOP icon row (doc-sidebar) is frozen at Home / Brain / Studio /
 *     Workflow — how you shape the brain. It never grows.
 *   - OPERATOR APPS — things you run over the brain (Page, Tasks, Feed;
 *     CRM reserved) — live under Home in the app-bar. Selecting Home
 *     resolves to the workspace's LAST-USED operator app (default Page),
 *     cached per workspace in localStorage, so leaving to Studio and
 *     returning resumes where you were.
 *
 * Pure + IO-light (localStorage only, guarded) so vitest can exercise the
 * resolution logic without React or the router.
 *
 * [COMP:app-web/operator-app-bar]
 */

import type { WorkspaceSurface } from "@/lib/doc-page-url";

/** The operator apps, in app-bar order. Page is the default. */
export const OPERATOR_APP_KEYS = ["page", "tasks", "feed", "crm"] as const;
export type OperatorAppKey = (typeof OPERATOR_APP_KEYS)[number];

export const DEFAULT_OPERATOR_APP: OperatorAppKey = "page";

/** App key → the `WorkspaceSurface` route segment it lives on. */
const APP_SEGMENT: Record<OperatorAppKey, string> = {
  page: "p",
  tasks: "tasks",
  feed: "feed",
  crm: "crm",
};

/** Surfaces that belong to an operator app (the bar shows on these). */
const SURFACE_TO_APP: Partial<Record<WorkspaceSurface, OperatorAppKey>> = {
  p: "page",
  tasks: "tasks",
  feed: "feed",
  crm: "crm",
};

/** The operator app a surface belongs to, or null for Brain/Studio/… */
export function operatorAppFromSurface(
  surface: WorkspaceSurface | null,
): OperatorAppKey | null {
  if (!surface) return null;
  return SURFACE_TO_APP[surface] ?? null;
}

/** Route for an operator app (`/w/<id>/p`, `/w/<id>/tasks`, `/w/<id>/feed`). */
export function operatorAppPath(
  workspaceId: string,
  app: OperatorAppKey,
): string {
  return `/w/${workspaceId}/${APP_SEGMENT[app]}`;
}

/** Per-workspace sticky-selection localStorage key. */
export function operatorAppStorageKey(workspaceId: string): string {
  return `doc:operator-app:${workspaceId}`;
}

function isOperatorAppKey(value: unknown): value is OperatorAppKey {
  return (
    typeof value === "string" &&
    (OPERATOR_APP_KEYS as readonly string[]).includes(value)
  );
}

/**
 * Resolve the workspace's active operator app from the cache, constrained
 * to the apps currently available (`enabled`). An unknown / disabled cached
 * value (e.g. `feed` after distribution profiles disconnect) falls back to
 * the default. Safe on the server (no `window`) — returns the default.
 */
export function readOperatorApp(
  workspaceId: string,
  enabled: readonly OperatorAppKey[] = OPERATOR_APP_KEYS,
): OperatorAppKey {
  if (typeof window === "undefined") return DEFAULT_OPERATOR_APP;
  try {
    const raw = window.localStorage.getItem(operatorAppStorageKey(workspaceId));
    if (isOperatorAppKey(raw) && enabled.includes(raw)) return raw;
  } catch {
    // Non-fatal — sticky selection is a convenience, not load-bearing.
  }
  return DEFAULT_OPERATOR_APP;
}

/** Persist the active operator app for the workspace (visits + bar clicks). */
export function writeOperatorApp(
  workspaceId: string,
  app: OperatorAppKey,
): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(operatorAppStorageKey(workspaceId), app);
  } catch {
    // Non-fatal.
  }
}

/**
 * The Home destination: the workspace's persisted operator app's route.
 * This is what the top-row Home icon + the ⌘/Ctrl+1 shortcut navigate to —
 * Home resolves to *your last app*, never a hard-coded `/p`.
 */
export function homePath(
  workspaceId: string,
  enabled: readonly OperatorAppKey[] = OPERATOR_APP_KEYS,
): string {
  return operatorAppPath(workspaceId, readOperatorApp(workspaceId, enabled));
}

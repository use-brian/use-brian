/**
 * Operator app registry — the single source of truth for the Home hub's
 * second bar (`OperatorAppBar`) and its sticky per-workspace selection.
 *
 * Two navigation tiers (docs/plans/tasks-operator-surface.md §2):
 *
 *   - The TOP icon row (doc-sidebar) is frozen at Home / Brain / Studio /
 *     Workflow — how you shape the brain. It never grows.
 *   - OPERATOR APPS — things you run over the brain (Page, Tasks, CRM,
 *     Feed, Browsers, Chat) — live under Home in the app-bar. Selecting Home
 *     resolves to the workspace's LAST-USED operator app, cached per
 *     workspace in localStorage, so leaving to Studio and returning resumes
 *     where you were.
 *
 * WHICH apps are on the strip is workspace config, not a constant: the
 * `enabled` list threaded through every resolver here comes from
 * `workspaces.home_apps` (chat-miniapp-home-config.md §6). The KEY VOCABULARY
 * is shared with the API through `@use-brian/shared/home-apps` so the route
 * schema, the store setter, and this module can never disagree about what a
 * valid app is; this file adds only the client-side mappings (route segment,
 * surface, sticky cache) the server has no use for.
 *
 * Custom (workspace-built) apps ride the same list as `custom:<uuid>` entries
 * and route to `/w/<id>/apps/<appId>` (custom-home-apps.md T12). They are
 * `HomeAppEntry`s, not `OperatorAppKey`s — the built-in key type stays closed
 * so `APP_ICON` / `operatorBar` dictionary exhaustiveness keeps working.
 *
 * Pure + IO-light (localStorage only, guarded) so vitest can exercise the
 * resolution logic without React or the router.
 *
 * [COMP:app-web/operator-app-bar]
 */

import {
  BUILTIN_HOME_APP_KEYS,
  DEFAULT_HOME_APPS,
  customHomeAppId,
  isBuiltinHomeAppKey,
  type HomeAppEntry,
  type HomeAppKey,
} from "@use-brian/shared/home-apps";
import type { WorkspaceSurface } from "@/lib/doc-page-url";

export type { HomeAppEntry } from "@use-brian/shared/home-apps";

/** The built-in operator apps, in app-bar order. Page is the historical
 *  default; Feed holds the 4th slot, Browsers the 5th, Chat the 6th. */
export const OPERATOR_APP_KEYS = BUILTIN_HOME_APP_KEYS;
export type OperatorAppKey = HomeAppKey;

/** Fallback when config resolution has nothing to say (SSR, empty list). */
export const DEFAULT_OPERATOR_APP: OperatorAppKey = "page";

/** App key → the `WorkspaceSurface` route segment it lives on. Browsers reuses
 *  the existing `/computer` route family (the Take-Over live view + its new
 *  session-rail index). */
const APP_SEGMENT: Record<OperatorAppKey, string> = {
  page: "p",
  tasks: "tasks",
  feed: "feed",
  crm: "crm",
  browsers: "computer",
  chat: "chat",
};

/** Surfaces that belong to an operator app (the bar shows on these). */
const SURFACE_TO_APP: Partial<Record<WorkspaceSurface, OperatorAppKey>> = {
  p: "page",
  tasks: "tasks",
  feed: "feed",
  crm: "crm",
  computer: "browsers",
  chat: "chat",
};

/** The BUILT-IN operator app a surface belongs to, or null for Brain/Studio/…
 *  A custom app lives on the shared `apps` surface, so its identity is the id
 *  in the path, not the segment — see `customAppIdFromPathname`. */
export function operatorAppFromSurface(
  surface: WorkspaceSurface | null,
): OperatorAppKey | null {
  if (!surface) return null;
  return SURFACE_TO_APP[surface] ?? null;
}

/** Route for a built-in operator app (`/w/<id>/p`, `/w/<id>/tasks`, …). */
export function operatorAppPath(
  workspaceId: string,
  app: OperatorAppKey,
): string {
  return `/w/${workspaceId}/${APP_SEGMENT[app]}`;
}

/** Route for a custom app (`/w/<id>/apps/<appId>`). */
export function customAppPath(workspaceId: string, appId: string): string {
  return `/w/${workspaceId}/apps/${appId}`;
}

/** Route for ANY strip entry — built-in key or `custom:<uuid>`. */
export function homeAppPath(workspaceId: string, entry: HomeAppEntry): string {
  const customId = customHomeAppId(entry);
  if (customId) return customAppPath(workspaceId, customId);
  return operatorAppPath(workspaceId, entry as OperatorAppKey);
}

/** Matches the custom-app route, capturing the `workspace_home_apps` row id. */
const CUSTOM_APP_PATH_RE = /^\/w\/[^/]+\/apps\/([^/?#]+)/;

/**
 * The custom app id the pathname is on, or `null` anywhere else. The strip's
 * active-entry highlight needs this because every custom app shares one
 * surface (`apps`) — the segment alone cannot say *which* app is open.
 */
export function customAppIdFromPathname(
  pathname: string | null | undefined,
): string | null {
  if (!pathname) return null;
  const match = CUSTOM_APP_PATH_RE.exec(pathname);
  return match ? match[1] : null;
}

/** The strip entry a pathname resolves to (built-in key or `custom:<id>`). */
export function homeAppFromPathname(
  surface: WorkspaceSurface | null,
  pathname: string | null | undefined,
): HomeAppEntry | null {
  const customId = customAppIdFromPathname(pathname);
  if (customId) return `custom:${customId}`;
  return operatorAppFromSurface(surface);
}

/** Per-workspace sticky-selection localStorage key. */
export function operatorAppStorageKey(workspaceId: string): string {
  return `doc:operator-app:${workspaceId}`;
}

/** The fallback when nothing is cached or the cached app is not enabled.
 *  T12: Home resolves to the FIRST enabled entry — Page may be deselected, so
 *  a hard-coded `page` would send those workspaces to a hidden app. */
function firstEnabled(enabled: readonly HomeAppEntry[]): HomeAppEntry {
  return enabled[0] ?? DEFAULT_OPERATOR_APP;
}

/**
 * Resolve the workspace's active operator app from the cache, constrained
 * to the apps currently on the strip (`enabled` — the workspace's
 * `home_apps` config). A cached value that has since been disabled (or a
 * custom app that was removed / dropped to `needs_consent`) falls back to the
 * first enabled entry. Safe on the server (no `window`).
 */
export function readOperatorApp(
  workspaceId: string,
  enabled: readonly HomeAppEntry[] = DEFAULT_HOME_APPS,
): HomeAppEntry {
  if (typeof window === "undefined") return firstEnabled(enabled);
  try {
    const raw = window.localStorage.getItem(operatorAppStorageKey(workspaceId));
    if (
      raw &&
      (isBuiltinHomeAppKey(raw) || raw.startsWith("custom:")) &&
      (enabled as readonly string[]).includes(raw)
    ) {
      return raw as HomeAppEntry;
    }
  } catch {
    // Non-fatal — sticky selection is a convenience, not load-bearing.
  }
  return firstEnabled(enabled);
}

/** Persist the active operator app for the workspace (visits + bar clicks). */
export function writeOperatorApp(
  workspaceId: string,
  app: HomeAppEntry,
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
 * This is what the top-row Home icon, the ⌘/Ctrl+1 shortcut, and the
 * workspace-root redirect navigate to — Home resolves to *your last app*
 * within the workspace's configured strip, never a hard-coded `/p`.
 */
export function homePath(
  workspaceId: string,
  enabled: readonly HomeAppEntry[] = DEFAULT_HOME_APPS,
): string {
  return homeAppPath(workspaceId, readOperatorApp(workspaceId, enabled));
}

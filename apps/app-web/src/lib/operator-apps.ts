/**
 * Operator app registry — the single source of truth for the Home hub's
 * second bar (`OperatorAppBar`) and its sticky per-workspace selection.
 *
 * Two navigation tiers (docs/plans/tasks-operator-surface.md §2):
 *
 *   - The TOP icon row (doc-sidebar) is frozen at Home / Brain / Studio /
 *     Workflow / Live — how you shape and observe the brain. Live owns the
 *     former Inbox slot and is intentionally not a Home app key.
 *   - OPERATOR APPS — things you run over the brain (Page, Tasks, CRM,
 *     Feed, Browsers, Chat) — live under Home in the app-bar. Selecting Home
 *     resolves to the workspace's LAST-USED operator app and its last safe
 *     pathname, cached per workspace in localStorage, so leaving to Studio and
 *     returning resumes where you were.
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
} from "@use-brian/shared/home-apps";
import type { WorkspaceSurface } from "@/lib/doc-page-url";

export type { HomeAppEntry } from "@use-brian/shared/home-apps";
// Re-exported so app-web consumers reach the strip vocabulary through the
// registry they already import, rather than half of them going direct to the
// shared package. Only what is actually consumed here — an unused re-export is
// dead surface the ratchet catches.
export {
  HOME_APPS_MAX,
  customHomeAppId,
  isBuiltinHomeAppKey,
} from "@use-brian/shared/home-apps";

/**
 * The built-in operator apps, in DEFAULT strip order — DERIVED, not restated.
 *
 * This was a hand-copied literal until 2026-08-10, which made the header's
 * claim above ("can never disagree") untrue: adding a key to the shared list
 * left this one behind, and the app simply had no route, icon or label for it
 * while the API happily accepted it. Deriving also makes `APP_SEGMENT` and
 * `APP_ICON` exhaustive against the real vocabulary, so the next key added
 * cannot compile until it has both.
 *
 * The order the strip actually renders is whatever `home_apps` stores, which
 * an admin can drag (`reorderHomeApps`); this order only seeds the default and
 * groups the Studio "Hidden" list.
 */
export const OPERATOR_APP_KEYS = BUILTIN_HOME_APP_KEYS;
export type OperatorAppKey = (typeof OPERATOR_APP_KEYS)[number];
const OPERATOR_APP_SET: ReadonlySet<string> = new Set(OPERATOR_APP_KEYS);

export function isOperatorAppKey(value: unknown): value is OperatorAppKey {
  return typeof value === "string" && OPERATOR_APP_SET.has(value);
}

/** Fallback when config resolution has nothing to say (SSR, empty list). */
export const DEFAULT_OPERATOR_APP: OperatorAppKey = "page";

/** App key → the `WorkspaceSurface` route segment it lives on. Browsers reuses
 *  the existing `/computer` route family (the Take-Over live view + its new
 *  session-rail index). */
const APP_SEGMENT: Record<OperatorAppKey, WorkspaceSurface> = {
  page: "p",
  office: "office",
  tasks: "tasks",
  feed: "feed",
  crm: "crm",
  browsers: "computer",
  chat: "chat",
  shopify: "shopify",
};

/** Surfaces that belong to an operator app (the bar shows on these). */
const SURFACE_TO_APP: Partial<Record<WorkspaceSurface, OperatorAppKey>> = {
  p: "page",
  office: "office",
  tasks: "tasks",
  feed: "feed",
  crm: "crm",
  computer: "browsers",
  chat: "chat",
  shopify: "shopify",
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

/**
 * Sidebar body to keep underneath the explicit Suggested briefing.
 *
 * Suggested is hosted on `/p`, but it does not turn the selected Home app into
 * Page. Resolving from the sticky app keeps that app's already-loaded sidebar
 * navigation visible while the briefing temporarily owns the content pane.
 */
export function sidebarSurfaceForHome(
  routedSurface: WorkspaceSurface | null,
  activeApp: HomeAppEntry | null,
  suggestedOpen: boolean,
): WorkspaceSurface | null {
  if (!suggestedOpen || !activeApp) return routedSurface;
  if (customHomeAppId(activeApp)) return "apps";
  return isOperatorAppKey(activeApp) ? APP_SEGMENT[activeApp] : routedSurface;
}

/**
 * Identity chrome to retain while Suggested temporarily owns the Page pane.
 *
 * Page is deliberately excluded: its top bar is an interactive tab strip, and
 * Suggested suspends the URL sync that makes those tabs truthful. Every other
 * operator app uses the single-chip `OperatorTopbar`, whose identity-only form
 * can safely remain above the briefing without duplicating surface controls.
 */
export function operatorTopbarAppForSuggested(
  activeApp: HomeAppEntry | null,
  suggestedOpen: boolean,
): HomeAppEntry | null {
  return suggestedOpen && activeApp !== "page" ? activeApp : null;
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

/** Base route for ANY strip entry — built-in key or `custom:<uuid>`. */
export function homeAppBasePath(
  workspaceId: string,
  entry: HomeAppEntry,
): string {
  const customId = customHomeAppId(entry);
  if (customId) return customAppPath(workspaceId, customId);
  if (isOperatorAppKey(entry)) return operatorAppPath(workspaceId, entry);
  // A reserved-but-not-enabled built-in must never produce a dead route.
  return operatorAppPath(workspaceId, DEFAULT_OPERATOR_APP);
}

/** Per-workspace, per-app pathname cache. Query strings are deliberately not
 * stored: app handoffs, OAuth/checkout returns, and filters may be transient or
 * sensitive, while a pathname is enough to resume durable objects/surfaces. */
export function homeAppLocationStorageKey(
  workspaceId: string,
  entry: HomeAppEntry,
): string {
  return `doc:operator-app-location:${workspaceId}:${entry}`;
}

/** Whether a pathname is safely inside this exact app's route family. */
export function isHomeAppPath(
  workspaceId: string,
  entry: HomeAppEntry,
  pathname: string,
): boolean {
  if (
    !pathname.startsWith("/") ||
    pathname.includes("?") ||
    pathname.includes("#")
  ) {
    return false;
  }
  const base = homeAppBasePath(workspaceId, entry);
  return pathname === base || pathname.startsWith(`${base}/`);
}

/** Read a previously visited safe pathname for one app. */
export function readHomeAppLocation(
  workspaceId: string,
  entry: HomeAppEntry,
): string | null {
  if (typeof window === "undefined") return null;
  try {
    const pathname = window.localStorage.getItem(
      homeAppLocationStorageKey(workspaceId, entry),
    );
    return pathname && isHomeAppPath(workspaceId, entry, pathname)
      ? pathname
      : null;
  } catch {
    return null;
  }
}

/** Remember a routed app position. Page's bare `/p` is a shell landing/panel,
 * not a more useful position than an already-cached `/p/<pageId>`, so it never
 * overwrites the document location. */
export function writeHomeAppLocation(
  workspaceId: string,
  entry: HomeAppEntry,
  pathname: string,
): void {
  if (
    typeof window === "undefined" ||
    !isHomeAppPath(workspaceId, entry, pathname)
  ) {
    return;
  }
  const base = homeAppBasePath(workspaceId, entry);
  if (entry === "page" && pathname === base) return;
  try {
    window.localStorage.setItem(
      homeAppLocationStorageKey(workspaceId, entry),
      pathname,
    );
  } catch {
    // Non-fatal: resume falls back to the app's base route.
  }
}

/** Resume route for an app: its last validated pathname, then its base. */
export function homeAppPath(workspaceId: string, entry: HomeAppEntry): string {
  return (
    readHomeAppLocation(workspaceId, entry) ??
    homeAppBasePath(workspaceId, entry)
  );
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

/**
 * Move `from` into `to`'s slot, keeping every other entry's relative order.
 *
 * The strip renders `home_apps` in stored array order end to end — nothing
 * downstream sorts or re-derives it — so a reorder IS just a permutation of
 * that array. This lives here rather than in the Studio page because two
 * surfaces read it: the sortable list commits with it on drop, and the Home
 * preview strip calls it on every drag-over to show where the app would land.
 *
 * Either entry missing (a stale drag id) returns a copy unchanged, so a
 * mismatched drop can never drop or duplicate an app.
 */
export function reorderHomeApps<T extends HomeAppEntry>(
  entries: readonly T[],
  from: T,
  to: T,
): T[] {
  const next = [...entries];
  const fromIndex = next.indexOf(from);
  const toIndex = next.indexOf(to);
  if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) return next;
  const [moved] = next.splice(fromIndex, 1);
  next.splice(toIndex, 0, moved);
  return next;
}

/** Per-workspace sticky-selection localStorage key. */
export function operatorAppStorageKey(workspaceId: string): string {
  return `doc:operator-app:${workspaceId}`;
}

/** The fallback when nothing is cached or the cached app is not enabled.
 *  T12: Home resolves to the FIRST enabled entry — Page may be deselected, so
 *  a hard-coded `page` would send those workspaces to a hidden app. */
function firstEnabled(enabled: readonly HomeAppEntry[]): HomeAppEntry {
  return enabled.find((entry) => isOperatorAppKey(entry) || Boolean(customHomeAppId(entry))) ?? DEFAULT_OPERATOR_APP;
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
      (isOperatorAppKey(raw) || raw.startsWith("custom:")) &&
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

/**
 * Legacy bare-path resolver — pure mapping for pre-consolidation app paths.
 *
 * Before the single-app cutover (docs/architecture/features/web-ui.md) the
 * authenticated surfaces lived at root paths on the marketing origin
 * (`sidan.ai/brain`, `/studio`, …). The marketing proxy now 308s those to
 * this app **path-preserved** (`app.sidan.ai/brain`), but every route here
 * is workspace-scoped (`/w/<id>/brain`) — so without this mapping each
 * forwarded legacy link (old bookmarks, the pre-fix invite bounce, external
 * deep-links) dead-ends in a 404.
 *
 * `resolveLegacyPath` classifies a bare path into a redirect target; the
 * catch-all route (`app/[...legacy]/page.tsx`) resolves the workspace the
 * same way the root landing does and issues the redirect. Unknown paths
 * return `null` so genuinely wrong URLs still 404.
 *
 * Two surfaces have no index route here, so their bare heads map to their
 * default sub-surface: `/knowledge-base` → `/w/<id>/knowledge-base/gaps`
 * and `/memories` → `/w/<id>/memories/review`. Deeper sub-paths pass
 * through unchanged. `/workspaces/<id>` (old bookmarks, also produced by
 * the apps/web `/teams/:path*` redirects) carries the workspace id, so it
 * maps straight to `/w/<id>` instead of dropping to the picker.
 *
 * Keep the surface list in sync with `MOVED_TO_APP_PREFIXES` in
 * `apps/web/src/lib/protected-routes.ts` — that list decides what the
 * marketing proxy forwards here.
 *
 * [COMP:app-web/legacy-redirect]
 */

export type LegacyTarget =
  /** Redirect to `/w/<workspaceId><suffix>` once a workspace is resolved. */
  | { kind: "workspace"; suffix: string }
  /** Redirect straight to `/w/<id>` — the legacy path carried the id. */
  | { kind: "workspace-id"; id: string }
  /** Redirect straight to the workspace picker. */
  | { kind: "teams" };

/** Legacy surfaces that exist workspace-scoped under `/w/<id>/...`. */
const WORKSPACE_SURFACES = new Set([
  "brain",
  "studio",
  "workflow",
  "feed",
  "approvals",
  "knowledge-base",
  "memories",
]);

/**
 * Legacy surfaces with no standalone route in this app — chat is the
 * floating dock and settings is a modal, both live inside the doc shell —
 * so they land on the workspace root (`/w/<id>` → the `/p` index).
 */
const WORKSPACE_ROOT_ALIASES = new Set(["home", "chat", "settings"]);

export function resolveLegacyPath(
  segments: readonly string[],
): LegacyTarget | null {
  const [head, ...rest] = segments;
  if (!head) return null;
  if (head === "workspaces") {
    // `/workspaces/<id>` carries the workspace id — go straight to `/w/<id>`
    // instead of bouncing the user through the picker. Bare `/workspaces`
    // still lands on the picker.
    const [id] = rest;
    if (id) return { kind: "workspace-id", id };
    return { kind: "teams" };
  }
  if (WORKSPACE_ROOT_ALIASES.has(head)) {
    // Sub-paths (`/settings/billing`) are dropped — the destinations are
    // modals/docks with no path-addressable sub-surface here.
    return { kind: "workspace", suffix: "" };
  }
  if (WORKSPACE_SURFACES.has(head)) {
    // Bare heads with no index route land on their default sub-surface —
    // `/w/<id>/knowledge-base` and `/w/<id>/memories` have no page.tsx.
    if (rest.length === 0 && head === "knowledge-base") {
      return { kind: "workspace", suffix: "/knowledge-base/gaps" };
    }
    if (rest.length === 0 && head === "memories") {
      return { kind: "workspace", suffix: "/memories/review" };
    }
    return { kind: "workspace", suffix: `/${[head, ...rest].join("/")}` };
  }
  return null;
}

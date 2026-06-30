/**
 * Client-side canonical doc page URLs.
 *
 * The canonical per-page URL is path-based: `/w/<workspaceId>/p/<pageId>`
 * (Doc v1 URL refactor §9.3). The legacy
 * `/w/<workspaceId>/doc?viewId=<id>` surface still exists but the proxy
 * 301-redirects it here (`doc-redirect.ts`).
 *
 * In-app navigation must therefore target the canonical path **directly**.
 * Routing a client transition through the legacy URL makes the proxy's
 * redirect intercept that transition, and a middleware redirect during a
 * client navigation forces Next.js to fall back to a full-document load —
 * the "whole page hard-refreshes when I switch pages" bug. These two pure
 * helpers keep every navigation on the canonical path and read the active
 * page id back off it (replacing the old `?viewId=` query bridge).
 *
 * Kept as a separate, IO-free module (same shape as `doc-redirect.ts`)
 * so vitest can exercise it without React or the router.
 *
 * Spec: `docs/plans/doc-v1-execution.md` §9.3 (URL redirects);
 * `docs/architecture/features/doc.md` → "Routes".
 *
 * [COMP:app-web/page-url]
 */

/** Matches a canonical doc page path, capturing the page id segment. */
const PAGE_PATH_RE = /^\/w\/[^/]+\/p\/([^/?#]+)/;

/**
 * Build the canonical doc page URL. Omit `pageId` (or pass null) for
 * the latest-or-empty `/p` index route.
 */
export function docPagePath(
  workspaceId: string,
  pageId?: string | null,
): string {
  return pageId ? `/w/${workspaceId}/p/${pageId}` : `/w/${workspaceId}/p`;
}

/**
 * Extract the active page id from a doc pathname. Returns `null` at the
 * `/p` index (no page segment) or for any non-doc path. The pathname
 * must be query-free — pass the value from `usePathname()`, not a full URL.
 */
export function pageIdFromPathname(
  pathname: string | null | undefined,
): string | null {
  if (!pathname) return null;
  const match = PAGE_PATH_RE.exec(pathname);
  return match ? match[1] : null;
}

/** A workspace-less page path `/p/<pageId>` — the canonical in-chat link form. */
const SHORT_PAGE_PATH_RE = /^\/p\/([^/?#]+)/;

/** A bare RFC-4122 page id (a UUID), the only id shape `saved_views` mints. */
const BARE_PAGE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Resolve a markdown link href to an in-app doc page id, or `null` if the
 * href is not an in-app page link.
 *
 * The assistant references existing pages in chat prose. The canonical form is
 * `[Title](/p/<pageId>)` (matching the `child_page` links `to-markdown.ts`
 * emits and the doc skill prompt), but it has also emitted the bare page id and
 * the fully-qualified `/w/<wid>/p/<pageId>` path. All three resolve here so the
 * chat renderer can intercept the click and soft-navigate to the page instead
 * of following a broken relative href (the "hallucinated link" symptom — the
 * page is real, the bare-id href just isn't navigable). Query strings and
 * `#b-<blockId>` hashes are ignored; external/unknown hrefs return `null`.
 */
export function pageIdFromInAppHref(
  href: string | null | undefined,
): string | null {
  if (!href) return null;
  const trimmed = href.trim();
  // `/w/<wid>/p/<pageId>` — the fully-qualified canonical URL.
  const full = PAGE_PATH_RE.exec(trimmed);
  if (full) return full[1];
  // `/p/<pageId>` — the workspace-less canonical in-chat form.
  const short = SHORT_PAGE_PATH_RE.exec(trimmed);
  if (short) return short[1];
  // A bare page id (drop any query/hash the model appended).
  const bare = trimmed.split(/[?#]/, 1)[0];
  return BARE_PAGE_ID_RE.test(bare) ? bare : null;
}

/**
 * The active top-level surface under `/w/<workspaceId>/`. Drives the
 * persistent sidebar's nav-row highlight (`WorkspaceChrome` / `DocSidebar`)
 * across every workspace surface, not just the doc page tree.
 *
 *   - `'p'`             the doc page surface (`/p`, `/p/<pageId>`, and the
 *                       legacy `/doc` alias which 301s onto `/p`)
 *   - `'brain'`         `/brain` (+ `/brain/<entityId>`)
 *   - `'studio'`        `/studio/...`
 *   - `'workflow'`      `/workflow` (+ `/workflow/<id>`)
 *   - `'approvals'`     `/approvals`
 *   - `'knowledge-base'``/knowledge-base/...`
 *   - `'inbox'`         the legacy `/inbox` route (now a flyout; the route
 *                       redirects to `/p`, but the segment is still classified)
 *   - `null`            the workspace root, a non-workspace path, or nullish
 */
export type WorkspaceSurface =
  | "p"
  | "brain"
  | "studio"
  | "workflow"
  | "goals"
  | "approvals"
  | "knowledge-base"
  | "inbox";

/** Matches the first path segment after `/w/<workspaceId>/`. */
const SURFACE_PATH_RE = /^\/w\/[^/]+\/([^/?#]+)/;

const KNOWN_SURFACES: ReadonlySet<string> = new Set([
  "p",
  "brain",
  "studio",
  "workflow",
  "goals",
  "approvals",
  "knowledge-base",
  "inbox",
]);

/**
 * Classify a workspace pathname into its active top-level surface. Returns
 * `null` at the workspace root (`/w/<id>` with no segment), for the legacy
 * `doc` alias mapped onto `'p'`, or for any non-workspace path. The
 * pathname must be query-free — pass the value from `usePathname()`.
 */
export function surfaceFromPathname(
  pathname: string | null | undefined,
): WorkspaceSurface | null {
  if (!pathname) return null;
  const match = SURFACE_PATH_RE.exec(pathname);
  if (!match) return null;
  const segment = match[1];
  // The legacy `/doc?viewId=` alias is the doc page surface.
  if (segment === "doc") return "p";
  return KNOWN_SURFACES.has(segment) ? (segment as WorkspaceSurface) : null;
}

/** Query param the desktop quick-capture hotkey sets to request a fresh draft. */
export const CAPTURE_PARAM = "capture";

/**
 * True if a location carries the desktop quick-capture request (`?capture=1`).
 *
 * The desktop shell (`apps/app-desktop`) loads `${docUrl}/?capture=1` on
 * the global hotkey; the root + workspace redirects preserve it into
 * `/w/<id>/p?capture=1`, and `doc-shell` consumes it once on mount to open a
 * fresh blank draft. Accepts a raw search string (`window.location.search`, with
 * or without the leading `?`) or a `URLSearchParams`.
 *
 * See `docs/architecture/features/app-desktop.md` → "quick-capture.ts".
 */
export function isCaptureRequest(
  search: string | URLSearchParams | null | undefined,
): boolean {
  if (!search) return false;
  const params = typeof search === "string" ? new URLSearchParams(search) : search;
  return params.get(CAPTURE_PARAM) === "1";
}

/** Hash prefix marking a deep link to a single block: `#b-<blockId>`. */
export const BLOCK_HASH_PREFIX = "b-";

/**
 * Build a canonical deep link to a single block:
 *   `/w/<workspaceId>/p/<pageId>#b-<blockId>`
 * The block id is `node.attrs.blockId` from the shared doc schema (rendered
 * as `data-block-id`). The "Copy link to block" action stamps an id on the
 * target block first, then builds this — see `block-action-menu.tsx`.
 */
export function docBlockHash(
  workspaceId: string,
  pageId: string,
  blockId: string,
): string {
  return `${docPagePath(workspaceId, pageId)}#${BLOCK_HASH_PREFIX}${blockId}`;
}

/**
 * Read a block id back out of a location hash (`#b-<id>` or `b-<id>`). Returns
 * `null` for an empty hash, a bare `#`, an empty id, or any non-block hash
 * (e.g. a future `#comment-<id>`), so callers can no-op safely.
 */
export function blockIdFromHash(
  hash: string | null | undefined,
): string | null {
  if (!hash) return null;
  const bare = hash.startsWith("#") ? hash.slice(1) : hash;
  if (!bare.startsWith(BLOCK_HASH_PREFIX)) return null;
  const id = bare.slice(BLOCK_HASH_PREFIX.length);
  return id.length > 0 ? id : null;
}

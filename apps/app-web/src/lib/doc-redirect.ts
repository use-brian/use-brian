import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

/**
 * Doc v1 URL refactor — path-based pages.
 *
 * Phase 0 migrates the doc surface from
 *   `/w/<workspaceId>/doc?viewId=<id>`
 * to
 *   `/w/<workspaceId>/p/<pageId>`
 *
 * This helper is the pure decider for the redirect: given a request that
 * arrived at the proxy, return a NextResponse (legacy URL → canonical
 * URL) or `null` if the request should pass through untouched.
 *
 * Two cases (Doc v1 execution plan §9.3):
 *
 *   1. `/w/<wid>/doc?viewId=<uuid>` → **301** → `/w/<wid>/p/<uuid>`.
 *      Permanent so browsers + search engines + Slack unfurl caches all
 *      learn the canonical per-page URL. We preserve any non-`viewId`
 *      query params and the URL hash — both can carry real intent
 *      (deep-link to a block, theme override, A/B bucket).
 *   2. `/w/<wid>/doc` with **no** `viewId` → **302** → `/w/<wid>/p`.
 *      Temporary: there's no single canonical page to land on, so we
 *      bounce to the `/p` index route which resolves latest-or-empty
 *      (shows the sidebar + an empty selection state). 302 (not 301)
 *      because the eventual destination depends on the workspace's
 *      current page set, which changes over time — we must not let it
 *      get cached.
 *
 * Kept as a separate module from `proxy.ts` so vitest can exercise it
 * without invoking the auth + cookie machinery in the proxy proper. The
 * proxy wires this in by calling `computeDocRedirect()` first and
 * short-circuiting if it returns a response.
 *
 * Spec: `docs/plans/doc-v1-execution.md` §9.3 (URL redirects).
 * Component-map row lives in `docs/workflow/component-map.md` under
 * `[COMP:app-web/url-refactor]`.
 */

const DOC_PATH_RE = /^\/w\/([^/]+)\/doc\/?$/;

/**
 * Compute a redirect for legacy doc URLs.
 *
 * Returns a NextResponse when the incoming request matches the legacy
 * `/w/<workspaceId>/doc` surface (with or without trailing slash):
 *   - with `?viewId=<id>` → 301 to `/w/<workspaceId>/p/<id>`
 *   - without `viewId`    → 302 to `/w/<workspaceId>/p`
 * Returns `null` for everything else — the proxy then continues with its
 * normal flow (auth check, refresh, passthrough).
 */
export function computeDocRedirect(req: NextRequest): NextResponse | null {
  // Use a fresh URL parse so we can mutate `pathname` + `searchParams`
  // without disturbing the request object itself.
  const url = new URL(req.url);
  const pathMatch = DOC_PATH_RE.exec(url.pathname);
  if (!pathMatch) return null;

  const workspaceId = pathMatch[1];
  const viewId = url.searchParams.get("viewId");

  const next = new URL(req.url);
  if (viewId) {
    next.pathname = `/w/${workspaceId}/p/${viewId}`;
    next.searchParams.delete("viewId");
    // `URL.hash` round-trips through the constructor unchanged, so
    // `#section` is preserved on the redirected URL automatically.
    return NextResponse.redirect(next, 301);
  }

  // No viewId — bounce to the `/p` index, which resolves latest-or-empty.
  next.pathname = `/w/${workspaceId}/p`;
  return NextResponse.redirect(next, 302);
}

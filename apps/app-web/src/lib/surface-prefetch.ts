/**
 * Intent prefetch - start the work for a surface when the pointer lands on its
 * link, not when the click does.
 *
 * A surface switch costs two serial waits: the route's RSC payload plus its JS
 * chunk, and then the surface's own data fetch on mount. Hovering a sidebar
 * icon precedes the click by a few hundred milliseconds, which is enough to
 * cover most of both. This module spends that window:
 *
 *  - `router.prefetch(href)` warms the route.
 *  - `warmSurfaceData` warms the SAME cache key the destination surface reads
 *    on mount (`lib/surface-cache.ts`), so the fetch is already in flight - or
 *    already resolved - by the time the surface renders.
 *
 * The second half is the one that matters. The routes here are client
 * components with no server data, so their payloads are small; the list fetch
 * is the wait the user actually feels.
 *
 * **Cache keys live here, not in the surfaces**, so a warm and the mount that
 * consumes it cannot drift apart. A surface reads its data with
 * `useCachedResource(surfaceDataKey('tasks', workspaceId), ...)` and this module
 * warms the identical string.
 *
 * Everything degrades silently: a failed warm just means the surface fetches
 * normally, and `router.prefetch` is a no-op in the desktop SPA (the
 * `next/navigation` shim stubs it).
 *
 * Spec: docs/architecture/features/perceived-performance.md
 * [COMP:app-web/surface-prefetch]
 */

import { useCallback } from "react";
import { useRouter } from "next/navigation";
import type { WorkspaceSurface } from "@/lib/doc-page-url";
import { surfaceFromPathname } from "@/lib/doc-page-url";
import { invalidateSurfaceCache, warmSurfaceCache } from "@/lib/surface-cache";
import { fetchWorkspaceCrm } from "@/lib/api/crm";
import { fetchWorkspaceTasks } from "@/lib/api/tasks";
import { getView } from "@/lib/api/views";
import { listWorkflows } from "@/lib/api/workflow";

/** Surfaces whose landing data is a single workspace-scoped list. */
type WarmableSurface = "tasks" | "crm" | "workflow";

/**
 * The cache key for a surface's landing data. Both the prefetch and the
 * surface's own `useCachedResource` call go through here.
 *
 * `null` for surfaces with no single landing list (Brain's graph, Studio's
 * per-section fetches, the doc surface's per-page metadata). Those are not
 * un-warmable in principle, just not one key - they are left alone rather than
 * given a half-right key that would mask a miss.
 */
export function surfaceDataKey(
  surface: WorkspaceSurface | null,
  workspaceId: string | null | undefined,
): string | null {
  if (!workspaceId) return null;
  switch (surface) {
    case "tasks":
      return `tasks:${workspaceId}`;
    case "crm":
      return `crm:${workspaceId}`;
    case "workflow":
      return `workflow:${workspaceId}`;
    default:
      return null;
  }
}

/**
 * Cache key for a single doc page's metadata (`getView`).
 *
 * Doc pages are keyed per page rather than per surface: the doc shell persists
 * across `/p/<pageId>` swaps and re-fetches only the centre pane's metadata, so
 * the unit worth caching is one page, not the surface. Hovering a sidebar row
 * warms it; opening the page paints the cached copy and revalidates.
 */
export function docPageCacheKey(pageId: string): string {
  return `page:${pageId}`;
}

/**
 * Warm one doc page's metadata - called from sidebar row hover. Skips when the
 * copy in cache is still fresh, so running the pointer down a long page list
 * does not fire a request per row it passes over.
 */
export function warmDocPage(pageId: string | null | undefined): void {
  if (!pageId) return;
  warmSurfaceCache(docPageCacheKey(pageId), () => getView(pageId));
}

/** Drop a doc page's cached metadata after a rename / move / delete. */
export function invalidateDocPage(pageId: string | null | undefined): void {
  if (!pageId) return;
  invalidateSurfaceCache(docPageCacheKey(pageId));
}

/**
 * Cache key for the Brain workspace graph overview.
 *
 * Brain gets no `surfaceDataKey` entry because its landing is several fetches
 * driven by filter state, not one list. The GRAPH is the exception worth
 * caching on its own: it is the default view, its key depends only on the
 * workspace + viewpoint (so it is identical on every visit), and it is the
 * slowest thing the surface asks for. Drill-down scopes use the component-local
 * semantic-zoom cache instead of this persistent overview key.
 */
export function brainGraphCacheKey(
  workspaceId: string,
  viewpointAssistantId: string | null | undefined,
): string {
  return `brain-graph:${workspaceId}:${viewpointAssistantId ?? ""}`;
}

const WARMERS: Record<WarmableSurface, (workspaceId: string) => Promise<unknown>> =
  {
    tasks: (workspaceId) => fetchWorkspaceTasks(workspaceId),
    crm: (workspaceId) => fetchWorkspaceCrm(workspaceId),
    workflow: (workspaceId) => listWorkflows(workspaceId, { includeArchived: true }),
  };

/**
 * Kick off the destination surface's landing fetch. No-op when the surface has
 * no single landing list, or when the cache is already fresh - hovering the
 * same icon repeatedly costs nothing.
 */
function warmSurfaceData(
  surface: WorkspaceSurface | null,
  workspaceId: string | null | undefined,
): void {
  const key = surfaceDataKey(surface, workspaceId);
  if (!key || !workspaceId) return;
  const warmer = WARMERS[surface as WarmableSurface];
  if (!warmer) return;
  warmSurfaceCache(key, () => warmer(workspaceId));
}

/** The workspace id in a `/w/<id>/...` path, or null. */
export function workspaceIdFromPath(href: string): string | null {
  const match = /^\/w\/([^/?#]+)/.exec(href);
  return match ? match[1] : null;
}

/**
 * Props to spread onto any in-app navigation trigger (a `<Link>`, or a button
 * that `router.push`es):
 *
 *   <Link href={href} {...intentPrefetch(href)}>
 *
 * `onPointerEnter` covers mouse and pen. `onFocus` covers keyboard tabbing, so
 * a keyboard user gets the same head start. Touch is deliberately not wired:
 * there is no hover before a tap, and `onTouchStart` would fire a request for
 * every scroll that starts on a link.
 */
export function useIntentPrefetch(): (href: string) => {
  onPointerEnter: () => void;
  onFocus: () => void;
} {
  const router = useRouter();
  return useCallback(
    (href: string) => {
      const warm = () => {
        try {
          router.prefetch(href);
        } catch {
          // Prefetch is best-effort; a router that refuses must not break the
          // link it is attached to.
        }
        warmSurfaceData(surfaceFromPathname(href), workspaceIdFromPath(href));
      };
      return { onPointerEnter: warm, onFocus: warm };
    },
    [router],
  );
}

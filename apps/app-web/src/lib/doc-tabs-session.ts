/**
 * Session-scoped home for the Doc tab strip, plus the seed rule that
 * reconciles a restored strip with the URL the surface was re-entered on.
 *
 * **Why this exists.** The strip used to live in a `useState` inside
 * `<DocShell>`, which `/w/[id]/p/layout.tsx` mounts. That layout survives
 * `/p/<pageId>` soft swaps but NOT a move to a sibling surface — Brain,
 * Studio, Workflow, Feed and Approvals are mounted by the *workspace* layout,
 * one level up, so entering any of them tears the doc surface down. Every tab
 * the user had open was lost, and returning Home re-seeded a single fresh tab.
 *
 * The strip is held here instead: a module-level map keyed by workspace, so it
 * outlives the mount, is never shared between workspaces, and dies with the
 * JS context. That is the same **session scope** the feature was specified
 * with (`docs/architecture/features/doc.md` → "Top bar") — survives soft
 * navigation, resets on a hard reload — which is why this is a plain in-memory
 * map and not `sessionStorage`: cross-reload persistence would need stale-id
 * pruning against pages deleted while away, and that is still out of scope.
 *
 * Kept IO-free and React-free so vitest can exercise the seed rule directly,
 * the same seam as `doc-tabs.ts` itself.
 *
 * [COMP:app-web/doc-tabs-session]
 */

import {
  activePageId,
  dropPage,
  initTabs,
  openPage,
  type TabsState,
} from "./doc-tabs";

/** The live strip per workspace. Module scope = one JS context = one session. */
const sessions = new Map<string, TabsState>();

/** The workspace's stored strip, or null when the surface hasn't been opened. */
export function readDocTabsSession(workspaceId: string): TabsState | null {
  return sessions.get(workspaceId) ?? null;
}

/** Remember the workspace's strip for the next mount of the doc surface. */
export function writeDocTabsSession(
  workspaceId: string,
  state: TabsState,
): void {
  sessions.set(workspaceId, state);
}

/** Drop every trace of a deleted page from a stored (unmounted) strip. */
export function dropPageFromDocTabsSession(
  workspaceId: string,
  pageId: string,
): void {
  const stored = sessions.get(workspaceId);
  if (stored) sessions.set(workspaceId, dropPage(stored, pageId));
}

/** Test-only: forget every workspace's strip. */
export function resetDocTabsSession(): void {
  sessions.clear();
}

export type TabsSeed = {
  /** The state the surface should mount with. */
  state: TabsState;
  /**
   * Whether the URL already agrees with `state`'s active entry. `false` means
   * the restored strip won and the URL is the stale side — the caller must let
   * its tabs → URL sync rewrite the URL and must NOT adopt the stale URL back
   * into the strip.
   */
  urlAgrees: boolean;
};

/**
 * Decide what the doc surface mounts with, given the workspace's stored strip
 * (if any) and the entry the URL points at.
 *
 * Three cases, in order:
 *  1. **No stored strip** (first entry this session) — seed from the URL.
 *  2. **Stored strip + a URL entry** (a deep link, a sidebar page click from
 *     Brain) — the URL wins for the *active tab*; the rest of the strip is
 *     kept. Same as any in-surface navigation.
 *  3. **Stored strip + no URL entry** (the nav rail's Home targets a bare
 *     `/w/<id>/p`) — the STRIP wins and the URL follows. The nav rail is a
 *     surface switcher, not a browser home button: coming back to Home must
 *     show the doc surface as it was left. Blanking the active tab stays the
 *     behaviour of clicking Home while the surface is already mounted, which
 *     is a live URL change and never routes through here.
 */
export function seedDocTabs(
  stored: TabsState | null,
  urlEntry: string | null,
): TabsSeed {
  if (!stored) return { state: initTabs(urlEntry), urlAgrees: true };
  const active = activePageId(stored);
  if (urlEntry !== null && active !== urlEntry) {
    return { state: openPage(stored, urlEntry), urlAgrees: true };
  }
  return { state: stored, urlAgrees: active === urlEntry };
}

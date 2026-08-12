/**
 * Tiny event bus telling the brain page to re-fetch its row list
 * (app-web).
 *
 * Ported verbatim from `apps/web/src/lib/brain-events.ts` as part of the
 * brain surface migration (docs/architecture/features/doc.md
 * §5a). The brain detail-drawer / unverified-nudge fire this after a
 * successful brain-write (verify / adjust / delete / alias); the brain
 * page subscribes, re-fetches, and fades in any rows it hadn't seen
 * before. The shell-level workspace stream (`workspace-events.ts`) also
 * dispatches it for cross-process writes routed by brain primitives.
 *
 * Mirrors the chat-seed.ts pattern — a one-shot CustomEvent keeps the
 * surfaces decoupled.
 */

export const BRAIN_REFRESH_EVENT = "sidan:brain-refresh";
export const BRAIN_ENTRY_VIEW_EVENT = "sidan:brain-entry-view";

export type BrainRefreshDetail = {
  /**
   * Scopes the refresh to a specific workspace. The brain page ignores
   * events whose workspaceId doesn't match its current view.
   */
  workspaceId: string | null;
};

export type BrainEntryViewDetail = {
  workspaceId: string;
  entry: { primitive: string; rowId: string } | null;
};

/** Publish the detail drawer's exact live target to persistent workspace chrome. */
export function publishBrainEntryView(detail: BrainEntryViewDetail): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<BrainEntryViewDetail>(BRAIN_ENTRY_VIEW_EVENT, { detail }),
  );
}

export function requestBrainRefresh(workspaceId: string | null): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<BrainRefreshDetail>(BRAIN_REFRESH_EVENT, {
      detail: { workspaceId },
    }),
  );
}

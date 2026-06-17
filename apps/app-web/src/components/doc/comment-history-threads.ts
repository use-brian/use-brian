/**
 * Pure ordering + status helpers for the read-only page **History** panel
 * (`comment-history.tsx`). Kept in their own module — no React, no heavy
 * transitive imports — so the ordering contract is unit-tested in isolation,
 * the same split as `comment-quote.ts` ↔ `comment-quote-reply.tsx`.
 *
 * [COMP:app-web/comment-history]
 */

import type { CommentThread } from "@/lib/api/comments";

/** A thread's coarse lifecycle for the History list chip. */
export type HistoryStatus = "resolved" | "open";

export function historyThreadStatus(
  thread: Pick<CommentThread, "resolvedAt">,
): HistoryStatus {
  return thread.resolvedAt ? "resolved" : "open";
}

/** The timestamp History sorts a thread by: when the iteration settled
 *  (`resolvedAt`) if resolved, else when the conversation started
 *  (`createdAt`). Returns 0 for a missing/unparseable stamp so a malformed row
 *  sinks to the bottom of the list rather than throwing. */
export function historyActivityTime(
  thread: Pick<CommentThread, "resolvedAt" | "createdAt">,
): number {
  const iso = thread.resolvedAt ?? thread.createdAt;
  const ms = iso ? Date.parse(iso) : NaN;
  return Number.isNaN(ms) ? 0 : ms;
}

/** Order a page's threads for the History list: most-recent activity first
 *  (resolved → by `resolvedAt`; open → by `createdAt`). Non-mutating — sorts a
 *  copy so the caller's array (and React state) is untouched. */
export function orderHistoryThreads<
  T extends Pick<CommentThread, "resolvedAt" | "createdAt">,
>(threads: readonly T[]): T[] {
  return [...threads].sort(
    (a, b) => historyActivityTime(b) - historyActivityTime(a),
  );
}

/**
 * The merged post queue: one lifecycle, one rail (feed-revamp.md §3.2).
 *
 * Before the revamp the same post appeared in three sibling routes as it
 * moved along — `/feed/drafts` while being written, `/feed/inbox` awaiting
 * approval, `/feed/ready` awaiting a manual post. They read as three features
 * but they are four states of one thing, and the thing is the **draft
 * session**: it already carries the saved draft and its status, so the queue
 * needs one data source rather than three endpoints stitched together.
 *
 * Everything here is pure and unit-tested; `feed-posts.tsx` holds only
 * rendering and selection state.
 *
 * [COMP:app-web/feed-posts-queue]
 */

import type {
  FeedDraftSeedKind,
  FeedDraftSessionSummary,
  FeedReplyTargetSummary,
} from "@/lib/api/feed";
import type { FeedPlatform } from "@/lib/feed-nav";

/** The four states of one post, in lifecycle order. */
export const POST_QUEUE_STATUSES = [
  "drafting",
  "review",
  "ready",
  "posted",
] as const;

export type PostQueueStatus = (typeof POST_QUEUE_STATUSES)[number];
export type PostQueueFilter = PostQueueStatus | "all";

function isPostQueueStatus(value: unknown): value is PostQueueStatus {
  return (POST_QUEUE_STATUSES as readonly unknown[]).includes(value);
}

/** Narrow a `?status=` param, defaulting to the unfiltered rail. */
export function parseQueueFilter(value: string | null): PostQueueFilter {
  if (value === "all") return "all";
  return isPostQueueStatus(value) ? value : "all";
}

/**
 * Strip the storage-level platform prefix from a session title.
 *
 * The content-planning store encodes the platform in a `[threads] …` title
 * prefix (that is how its platform-scoped queries filter). It is a storage
 * detail, and showing it is doubly redundant now that the sidebar is already
 * scoped to one platform.
 */
export function displayPostTitle(title: string): string {
  return title.replace(/^\[(instagram|threads|twitter|xhs)\]\s*/i, "");
}

export type PostQueueItem = {
  sessionId: string;
  assistantId: string;
  platform: FeedPlatform;
  title: string;
  /** The body to preview: the committed draft when there is one, else the
   *  latest proposed alternative, else the chat preview. */
  body: string | null;
  status: PostQueueStatus;
  lastActiveAt: string;
  startedBy: { id: string; name: string | null };
  replyTarget: FeedReplyTargetSummary | null;
  seedKind: FeedDraftSeedKind | null;
  /** True once the live post was taken down (posted, then deleted). */
  takenDown: boolean;
};

/**
 * Where one session sits in the lifecycle. A session with no committed draft
 * is still being written; otherwise the committed draft's own status decides.
 *
 * A `rejected` draft returns the session to `drafting` rather than hiding it:
 * the operator rejected the copy, not the intent, and the session is exactly
 * where they go to write the next version.
 */
export function postQueueStatus(
  session: Pick<FeedDraftSessionSummary, "selectedDraft" | "draftCounts">,
): PostQueueStatus {
  const selected = session.selectedDraft;
  if (!selected) return "drafting";
  switch (selected.status) {
    case "pending":
      return "review";
    case "ready":
      return "ready";
    case "posted":
      return "posted";
    case "rejected":
      return "drafting";
    // An unknown status from a newer server means "not finished yet", which
    // is the safe place to leave a post: visible and still editable.
    default:
      return "drafting";
  }
}

export function toQueueItem(
  assistantId: string,
  session: FeedDraftSessionSummary,
): PostQueueItem {
  return {
    sessionId: session.id,
    assistantId,
    platform: session.platform,
    title: displayPostTitle(session.title),
    body: session.selectedDraft?.text ?? session.draftText ?? session.preview,
    status: postQueueStatus(session),
    lastActiveAt: session.lastActiveAt,
    startedBy: session.startedBy,
    replyTarget: session.replyTarget,
    seedKind: session.seedKind ?? null,
    takenDown: session.draftCounts.deleted > 0,
  };
}

/**
 * Flatten every distribution assistant's sessions into one rail, newest
 * activity first. A workspace can hold more than one brand voice, and the
 * operator thinks in posts, not in which assistant owns them.
 */
export function buildPostQueue(
  perAssistant: readonly {
    assistantId: string;
    sessions: readonly FeedDraftSessionSummary[];
  }[],
): PostQueueItem[] {
  const items = perAssistant.flatMap(({ assistantId, sessions }) =>
    sessions.map((session) => toQueueItem(assistantId, session)),
  );
  items.sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt));
  return items;
}

export function filterQueue(
  items: readonly PostQueueItem[],
  filter: PostQueueFilter,
  platform?: FeedPlatform | "all",
): PostQueueItem[] {
  return items.filter(
    (item) =>
      (filter === "all" || item.status === filter) &&
      (!platform || platform === "all" || item.platform === platform),
  );
}

export function queueCounts(
  items: readonly PostQueueItem[],
): Record<PostQueueStatus, number> {
  const counts: Record<PostQueueStatus, number> = {
    drafting: 0,
    review: 0,
    ready: 0,
    posted: 0,
  };
  for (const item of items) counts[item.status] += 1;
  return counts;
}

/**
 * The item to select after acting on `sessionId`: the next one still in the
 * same filtered rail, else the previous one, else nothing. Acting on a queue
 * should advance it rather than dumping the operator back to an empty pane
 * (the locked master-detail rule).
 */
export function nextAfterAction(
  visible: readonly PostQueueItem[],
  sessionId: string,
): PostQueueItem | null {
  const index = visible.findIndex((item) => item.sessionId === sessionId);
  if (index === -1) return visible[0] ?? null;
  const remaining = visible.filter((item) => item.sessionId !== sessionId);
  if (remaining.length === 0) return null;
  return remaining[Math.min(index, remaining.length - 1)] ?? null;
}

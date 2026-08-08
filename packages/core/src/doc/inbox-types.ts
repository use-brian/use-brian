/**
 * Doc Inbox — the wire types for the sidebar Inbox view.
 *
 * The Inbox surfaces two things to a workspace member:
 *
 *   1. **Pending replies** — open comment threads the user STARTED whose
 *      latest comment is the assistant's. Derived at read time from
 *      `comment_threads` + `session_messages` (no stored row); it leaves the
 *      Inbox the moment the user replies, resolves the thread, or DISMISSES
 *      the row by opening it (a `doc_inbox_dismissals` row, migration 426 —
 *      the one piece of state the derived model does need).
 *   2. **Mentions** — a recorded `doc_notifications` row (migration 227)
 *      written when another member @-tagged the user in a page body or a
 *      comment. These carry a read/unread state; only UNREAD ones are listed.
 *
 * Both lanes are additionally bounded by the workspace's retention window
 * (`workspaces.inbox_retention_days`, migration 426) — see
 * `resolveInboxCutoff` below.
 *
 * Types live here in `core` (no `pg`); the DB adapters
 * (`createDbDocNotificationsStore` + `listPendingRepliesForUser` on the
 * comment-thread store) live in `packages/api/src/db`. Mirrors the
 * `comment-types.ts` core↔api split.
 *
 * Spec: `docs/architecture/features/doc-inbox.md`.
 *
 * [COMP:core/inbox-types]
 */

// ── Retention window (migration 426) ───────────────────────────

/**
 * Default Inbox retention: items stop being listed once their last activity is
 * older than this. A workspace can override it (or set `null` for "never
 * prune") via `workspaces.inbox_retention_days`.
 */
export const DEFAULT_INBOX_RETENTION_DAYS = 30

/** Accepted bounds for a configured window. One day to ten years. */
export const MIN_INBOX_RETENTION_DAYS = 1
export const MAX_INBOX_RETENTION_DAYS = 3650

/**
 * Turn a retention window into the cutoff timestamp both Inbox lanes filter on.
 * `null` days (never prune) → `null` cutoff, meaning "no filter".
 *
 * The window is a **read-time filter, never a delete**: nothing is destroyed
 * when an item ages out, so raising the setting brings older items straight
 * back. That reversibility is the reason retention is expressed here rather
 * than as a cleanup job — a job would make the setting one-way.
 *
 * `now` is injected so this stays a pure function (the callers pass
 * `new Date()`; tests pass a fixed instant).
 */
export function resolveInboxCutoff(
  retentionDays: number | null | undefined,
  now: Date,
): Date | null {
  if (retentionDays === null || retentionDays === undefined) return null
  if (!Number.isFinite(retentionDays) || retentionDays <= 0) return null
  return new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000)
}

/** A derived "your assistant replied" item — an open thread you started whose
 *  latest comment is the AI's. No persisted row backs it, but a dismissal
 *  (`doc_inbox_dismissals`) can suppress it until the next assistant reply. */
export type InboxPendingReply = {
  threadId: string
  pageId: string
  /** `saved_views.name` — the page title for the row label. */
  pageTitle: string
  /** The thread's anchored-text snapshot, for context in the row. */
  quote: string | null
  /** ISO timestamp of the AI's latest comment (the row's sort key). */
  lastActivityAt: string
}

/** A recorded mention — one `doc_notifications` row of kind `'mention'`. */
export type InboxMention = {
  id: string
  pageId: string
  pageTitle: string
  /** The thread the mention was made in; null for a page-body mention. */
  threadId: string | null
  /** Who tagged the user. */
  actorUserId: string
  /** The actor's display name (joined from `users`), or null if unavailable. */
  actorName: string | null
  /** Short snippet of the surrounding text. */
  preview: string | null
  createdAt: string
  /** ISO timestamp; null = unread. */
  readAt: string | null
}

/** The full Inbox payload returned by `GET /workspaces/:id/inbox`. */
export type InboxPayload = {
  pending: InboxPendingReply[]
  mentions: InboxMention[]
  /** Live count of derived pending replies. */
  pendingCount: number
  /** Count of mentions with `readAt === null`. */
  unreadMentionCount: number
}

/**
 * Store contract for persisted doc notifications (mentions). Fulfilled by
 * `createDbDocNotificationsStore` in `packages/api/src/db`.
 */
export type DocNotificationsStore = {
  /**
   * Record a mention for each recipient. Validates every `recipientUserId` is
   * a member of `workspaceId` and drops the actor (no self-mentions). Writes
   * are system-side (the actor authors rows owned by other recipients).
   * Returns the number of rows inserted.
   */
  recordMentions(params: {
    workspaceId: string
    pageId: string
    threadId?: string | null
    actorUserId: string
    recipientUserIds: string[]
    preview?: string | null
  }): Promise<number>

  /**
   * A recipient's **unread** mentions, newest first, joined to page title +
   * actor name. Reading a mention (clicking its Inbox row) is what removes it
   * from this list, so read rows are filtered out server-side rather than
   * rendered in a muted state.
   *
   * `since` is the retention cutoff from `resolveInboxCutoff`; `null` means no
   * age filter.
   */
  listForUser(
    userId: string,
    workspaceId: string,
    opts?: { since?: Date | null },
  ): Promise<InboxMention[]>

  /** Mark a recipient's mentions read. Omit `ids` to mark all of theirs read. */
  markRead(userId: string, opts?: { ids?: string[] }): Promise<void>

  /** Count of the recipient's unread mentions in a workspace (badge). */
  unreadCount(
    userId: string,
    workspaceId: string,
    opts?: { since?: Date | null },
  ): Promise<number>
}

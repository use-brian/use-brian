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
 *   2. **Mentions** — a recorded `doc_notifications` row written when
 *      another member @-tags the user. Two shapes share the table (migration
 *      452 widened it in place, D-H5 in docs/plans/room-human-mentions.md):
 *      a page/comment mention (migration 227, `kind='mention'`, anchored to
 *      a `page_id`) and a room mention (migration 452, `kind='room_mention'`,
 *      anchored to a `session_id`/`session_message_id` — a human `@Jane Doe`
 *      tag in workspace chat). These carry a read/unread state; only UNREAD
 *      ones are listed.
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

import type { Sensitivity } from '../security/sensitivity.js'

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

/**
 * A recorded mention — one `doc_notifications` row. A page/comment mention
 * (`kind='mention'`) and a room mention (`kind='room_mention'`, migration
 * 452) are a discriminated union on `kind` rather than one shape with every
 * page/session field optional, so a renderer switching on `kind` cannot
 * forget a case. This mirrors the DB's XOR check
 * (`num_nonnulls(page_id, session_id) = 1`) — exactly one of the two target
 * shapes is ever populated for a given row.
 */
export type InboxMention = InboxPageMention | InboxRoomMention

/** A page/comment mention (migration 227) — the original shape, kept
 *  source-compatible for existing call sites (same fields as before, plus
 *  the `kind` discriminant). */
export type InboxPageMention = {
  kind: 'mention'
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

/** A room mention (migration 452, docs/plans/room-human-mentions.md T-H3) —
 *  a human `@Jane Doe` tag in workspace chat. No page is involved; the
 *  target is the room itself, anchored to the message that carried the tag
 *  (`sessionMessageId`), which is what makes edit diff-reconcile (D-H6) and
 *  the multi-assistant fan-out's write idempotency (T-H2) possible. */
export type InboxRoomMention = {
  kind: 'room_mention'
  id: string
  sessionId: string
  sessionMessageId: string
  /** `sessions.title` (joined), or `''` if the room has none — mirrors
   *  `InboxPageMention.pageTitle`'s empty-string-not-null convention so the
   *  Inbox row can fall back to its own copy the same way. PH2 (T-H7): this
   *  is what lets a room-mention row name the room instead of a page. */
  roomTitle: string
  /** Who tagged the user. */
  actorUserId: string
  /** The actor's display name (joined from `users`), or null if unavailable. */
  actorName: string | null
  /** Short snippet of the surrounding message text. */
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

  /**
   * Record a ROOM mention for each recipient (migration 452, T-H3/T-H6 in
   * docs/plans/room-human-mentions.md). Same recipient hygiene as
   * `recordMentions` — self-mentions dropped, dedupe, and every candidate
   * validated as a member of `workspaceId` system-side — PLUS a check
   * `recordMentions` has no equivalent of: each recipient must also pass the
   * room's `effective_clearance` under the same `canRead(memberClearance,
   * sessionClearance)` predicate `gateSessionRead` uses
   * (`packages/api/src/routes/sessions.ts`). This is a hard boundary
   * independent of any roster-endpoint filtering upstream (T-H4's
   * `/mentionable` endpoint is a convenience; this is the enforcement) — no
   * `preview` text may ever reach a recipient who is below the room's
   * clearance.
   *
   * Idempotent under the multi-assistant fan-out: `@Ops @Sales @Jane Doe`
   * sends one POST per assistant target, but only the first creates the
   * user-message row, so every writer racing to record the SAME
   * `(sessionMessageId, recipientUserId)` pair lands on one row via
   * `ON CONFLICT … DO UPDATE SET read_at = NULL, preview = …` — which is
   * also D-H6's "re-add a name whose row was already read re-surfaces that
   * row" behavior, rather than inserting a duplicate.
   *
   * Returns the number of rows inserted or updated (i.e. recipients
   * notified).
   */
  recordRoomMentions(params: {
    workspaceId: string
    sessionId: string
    sessionMessageId: string
    /**
     * The room's `sessions.effective_clearance`. `null`/`undefined` means no
     * restriction — mirrors `gateSessionRead`'s own
     * `if (session.effectiveClearance && !canRead(...))` check, so a session
     * with no clearance set gates nobody.
     */
    sessionClearance: Sensitivity | null | undefined
    actorUserId: string
    recipientUserIds: string[]
    preview?: string | null
  }): Promise<number>

  /**
   * Retract room-mention rows for a set of recipients on one message
   * (D-H6's edit-diff "name removed" case). Deletes ONLY rows that are
   * still unread — a row already read means the ping already happened, so
   * it survives the edit. Returns the number of rows deleted.
   */
  retractRoomMentions(params: {
    sessionMessageId: string
    recipientUserIds: string[]
  }): Promise<number>
}

/**
 * `DocNotificationsStore` adapter — the persisted half of the doc Inbox.
 *
 * Fulfils the interface declared in `packages/core/src/doc/inbox-types.ts`
 * against the `doc_notifications` table (migration 227; widened by migration
 * 469 to also hold ROOM mentions — see `recordRoomMentions` /
 * `retractRoomMentions` below, docs/plans/room-human-mentions.md). Only
 * **mentions** are stored here; the "pending assistant reply" half of the
 * Inbox is derived (see `listPendingRepliesForUser` on
 * `comment-thread-store.ts`).
 *
 * Writes are SYSTEM-SIDE (bare `query()`): the actor records a row owned by a
 * DIFFERENT recipient, which the recipient-scoped RLS read policy can't
 * author. The `doc_notifications_system_bypass` policy lets these through.
 * Reads + mark-read run through `queryWithRLS(userId, …)` so the
 * `doc_notifications_recipient` policy gates them to the calling user's own
 * rows. Recipient validation (workspace membership) is enforced here in
 * `recordMentions` / `recordRoomMentions` rather than trusting the caller.
 *
 * `listForUser` / `unreadCount` cover BOTH `kind`s (PH2, T-H7): a superset
 * row shape is selected (page columns via `saved_views`, room columns via
 * `sessions`) and `mapInboxMention` dispatches on `n.kind` to the matching
 * `InboxMention` member so a room row never runs through the page mapper
 * (which assumes a non-null `pageId`) or vice versa.
 *
 * [COMP:api/doc-notifications-store]
 */

import type { DocNotificationsStore, InboxMention } from '@use-brian/core'
import { canRead } from '@use-brian/core'
import { query, queryWithRLS } from './client.js'

const MENTION_COLS = `
  n.id, n.kind, n.page_id as "pageId", n.thread_id as "threadId",
  n.session_id as "sessionId", n.session_message_id as "sessionMessageId",
  n.actor_user_id as "actorUserId", u.name as "actorName",
  sv.name as "pageTitle", s.title as "roomTitle", n.preview,
  n.created_at as "createdAt", n.read_at as "readAt"`

type MentionRow = {
  id: string
  kind: 'mention' | 'room_mention'
  pageId: string | null
  threadId: string | null
  sessionId: string | null
  sessionMessageId: string | null
  actorUserId: string
  actorName: string | null
  pageTitle: string | null
  roomTitle: string | null
  preview: string | null
  createdAt: Date
  readAt: Date | null
}

function mapMention(row: MentionRow): InboxMention {
  return {
    kind: 'mention',
    id: row.id,
    // NOT NULL for a kind='mention' row (the XOR check, migration 469) —
    // asserted here rather than re-typed as optional so InboxPageMention
    // keeps its original, narrower shape for every existing call site.
    pageId: row.pageId as string,
    pageTitle: row.pageTitle ?? '',
    threadId: row.threadId,
    actorUserId: row.actorUserId,
    actorName: row.actorName,
    preview: row.preview,
    createdAt: row.createdAt.toISOString(),
    readAt: row.readAt ? row.readAt.toISOString() : null,
  }
}

function mapRoomMention(row: MentionRow): InboxMention {
  return {
    kind: 'room_mention',
    id: row.id,
    // NOT NULL for a kind='room_mention' row (the XOR check + T-H3's
    // required session_message_id) — same assertion pattern as mapMention.
    sessionId: row.sessionId as string,
    sessionMessageId: row.sessionMessageId as string,
    roomTitle: row.roomTitle ?? '',
    actorUserId: row.actorUserId,
    actorName: row.actorName,
    preview: row.preview,
    createdAt: row.createdAt.toISOString(),
    readAt: row.readAt ? row.readAt.toISOString() : null,
  }
}

/** Dispatch on `kind` (PH2, T-H7) — the discriminated union means a caller
 *  switching on `.kind` can never forget a case, and neither mapper ever
 *  sees a row shaped for the other. */
function mapInboxMention(row: MentionRow): InboxMention {
  return row.kind === 'room_mention' ? mapRoomMention(row) : mapMention(row)
}

/** Trim a preview to a sane single-line snippet for the Inbox row. */
function clampPreview(preview: string | null | undefined): string | null {
  if (!preview) return null
  const clean = preview.replace(/\s+/g, ' ').trim()
  return clean ? clean.slice(0, 160) : null
}

export function createDbDocNotificationsStore(): DocNotificationsStore {
  return {
    async recordMentions(params): Promise<number> {
      // Drop self-mentions and dedupe up front — no point notifying yourself,
      // and the same member mentioned twice in one body is one notification.
      const recipients = Array.from(
        new Set(params.recipientUserIds.filter((id) => id && id !== params.actorUserId)),
      )
      if (recipients.length === 0) return 0

      // Validate each recipient is a member of THIS workspace (system-side —
      // workspace_members RLS only shows the caller's own row). Never trust the
      // client's id list: a mention must not mint a notification for a
      // non-member or a member of another workspace.
      const memberRes = await query<{ userId: string }>(
        `SELECT user_id as "userId" FROM workspace_members
          WHERE workspace_id = $1 AND user_id = ANY($2::uuid[])`,
        [params.workspaceId, recipients],
      )
      const validRecipients = memberRes.rows.map((r) => r.userId)
      if (validRecipients.length === 0) return 0

      const preview = clampPreview(params.preview)
      // One multi-row INSERT (system-side: rows are owned by other users, so
      // the recipient RLS policy can't author them; the system_bypass policy
      // applies). unnest expands the recipient array into one row each.
      const res = await query<{ id: string }>(
        `INSERT INTO doc_notifications
           (workspace_id, recipient_user_id, kind, page_id, thread_id, actor_user_id, preview)
         SELECT $1, recipient, 'mention', $2, $3, $4, $5
           FROM unnest($6::uuid[]) AS recipient
         RETURNING id`,
        [
          params.workspaceId,
          params.pageId,
          params.threadId ?? null,
          params.actorUserId,
          preview,
          validRecipients,
        ],
      )
      return res.rowCount ?? 0
    },

    async recordRoomMentions(params): Promise<number> {
      // Same self-mention/dedupe hygiene as recordMentions.
      const recipients = Array.from(
        new Set(params.recipientUserIds.filter((id) => id && id !== params.actorUserId)),
      )
      if (recipients.length === 0) return 0

      // Validate membership AND fetch clearance in one query (system-side —
      // never trust the caller's id list). Extends recordMentions' shape with
      // `clearance` so the room's effective_clearance can be checked below —
      // a hard boundary independent of any roster-endpoint filtering upstream
      // (T-H4's /mentionable is a convenience; this is the enforcement).
      const memberRes = await query<{
        userId: string
        clearance: 'public' | 'internal' | 'confidential'
      }>(
        `SELECT user_id as "userId", clearance FROM workspace_members
          WHERE workspace_id = $1 AND user_id = ANY($2::uuid[])`,
        [params.workspaceId, recipients],
      )
      // Mirrors gateSessionRead's own `if (session.effectiveClearance && …)`
      // guard: a room with no clearance set gates nobody.
      const sessionClearance = params.sessionClearance
      const validRecipients = memberRes.rows
        .filter((r) => !sessionClearance || canRead(r.clearance, sessionClearance))
        .map((r) => r.userId)
      if (validRecipients.length === 0) return 0

      const preview = clampPreview(params.preview)
      // ON CONFLICT targets the partial unique index on
      // (session_message_id, recipient_user_id) WHERE session_message_id IS
      // NOT NULL (migration 469) — the WHERE clause here must repeat that
      // predicate for Postgres to infer the partial index. This is what makes
      // the write idempotent under the multi-assistant fan-out (T-H2) AND is
      // D-H6's "re-add a name whose row was already read re-surfaces that
      // row" mechanism: re-notify by clearing read_at rather than inserting a
      // second row.
      const res = await query<{ id: string }>(
        `INSERT INTO doc_notifications
           (workspace_id, recipient_user_id, kind, session_id, session_message_id, actor_user_id, preview)
         SELECT $1, recipient, 'room_mention', $2, $3, $4, $5
           FROM unnest($6::uuid[]) AS recipient
         ON CONFLICT (session_message_id, recipient_user_id) WHERE session_message_id IS NOT NULL
         DO UPDATE SET read_at = NULL, preview = EXCLUDED.preview
         RETURNING id`,
        [
          params.workspaceId,
          params.sessionId,
          params.sessionMessageId,
          params.actorUserId,
          preview,
          validRecipients,
        ],
      )
      return res.rowCount ?? 0
    },

    async retractRoomMentions(params): Promise<number> {
      // D-H6: an edit that removes a name retracts that recipient's row only
      // while it is still UNREAD — once read, the ping already happened and
      // the row stays (and, per recordRoomMentions above, re-adding the name
      // later re-surfaces this same row instead of inserting a duplicate).
      if (params.recipientUserIds.length === 0) return 0
      const res = await query<{ id: string }>(
        `DELETE FROM doc_notifications
          WHERE session_message_id = $1
            AND recipient_user_id = ANY($2::uuid[])
            AND read_at IS NULL
          RETURNING id`,
        [params.sessionMessageId, params.recipientUserIds],
      )
      return res.rowCount ?? 0
    },

    async listForUser(
      userId: string,
      workspaceId: string,
      opts?: { since?: Date | null },
    ): Promise<InboxMention[]> {
      // RLS-scoped to the recipient's own rows. Join page title + actor name
      // for a page mention, room title for a room mention (PH2, T-H7); LEFT
      // JOIN throughout so a deleted user/page/session doesn't drop the
      // notification — each row only ever has one of the two targets
      // populated (the XOR check), so the unmatched join is just NULL.
      //
      // UNREAD ONLY (migration 426): reading a mention is what removes it from
      // the Inbox, so `read_at IS NOT NULL` is the dismissal record here — the
      // mentions lane needs no dismissals table because it already has rows.
      //
      // `since` is the retention window. It is a filter, not a delete: the rows
      // stay, so widening the window restores them. The LIMIT stays as a
      // backstop for a workspace with a huge window and a very loud teammate.
      //
      // Both `kind`s (migration 469, PH2): `mapInboxMention` dispatches each
      // row to the matching `InboxMention` member, so a room row never runs
      // through the page mapper (which assumes a non-null `pageId`) or vice
      // versa.
      const since = opts?.since ?? null
      const res = await queryWithRLS<MentionRow>(
        userId,
        `SELECT ${MENTION_COLS}
           FROM doc_notifications n
           LEFT JOIN saved_views sv ON sv.id = n.page_id
           LEFT JOIN sessions s ON s.id = n.session_id
           LEFT JOIN users u ON u.id = n.actor_user_id
          WHERE n.workspace_id = $1
            AND n.kind IN ('mention', 'room_mention')
            AND n.read_at IS NULL
            AND ($2::timestamptz IS NULL OR n.created_at >= $2::timestamptz)
          ORDER BY n.created_at DESC
          LIMIT 100`,
        [workspaceId, since],
      )
      return res.rows.map(mapInboxMention)
    },

    async markRead(userId: string, opts?: { ids?: string[] }): Promise<void> {
      // RLS-scoped: the recipient policy makes only the user's own rows
      // visible, so this can never mark another user's notifications read.
      if (opts?.ids && opts.ids.length > 0) {
        await queryWithRLS(
          userId,
          `UPDATE doc_notifications
              SET read_at = now()
            WHERE id = ANY($1::uuid[]) AND read_at IS NULL`,
          [opts.ids],
        )
        return
      }
      await queryWithRLS(
        userId,
        `UPDATE doc_notifications SET read_at = now() WHERE read_at IS NULL`,
      )
    },

    async unreadCount(
      userId: string,
      workspaceId: string,
      opts?: { since?: Date | null },
    ): Promise<number> {
      // Same retention window AND the same both-kinds scope as listForUser,
      // so the badge can never count a mention the panel will not show.
      const since = opts?.since ?? null
      const res = await queryWithRLS<{ count: string }>(
        userId,
        `SELECT COUNT(*)::int as count FROM doc_notifications
          WHERE workspace_id = $1 AND kind IN ('mention', 'room_mention') AND read_at IS NULL
            AND ($2::timestamptz IS NULL OR created_at >= $2::timestamptz)`,
        [workspaceId, since],
      )
      return Number(res.rows[0]?.count ?? 0)
    },
  }
}

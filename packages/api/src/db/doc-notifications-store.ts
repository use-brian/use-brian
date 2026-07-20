/**
 * `DocNotificationsStore` adapter — the persisted half of the doc Inbox.
 *
 * Fulfils the interface declared in `packages/core/src/doc/inbox-types.ts`
 * against the `doc_notifications` table (migration 227). Only **mentions**
 * are stored here; the "pending assistant reply" half of the Inbox is derived
 * (see `listPendingRepliesForUser` on `comment-thread-store.ts`).
 *
 * Writes are SYSTEM-SIDE (bare `query()`): the actor records a row owned by a
 * DIFFERENT recipient, which the recipient-scoped RLS read policy can't
 * author. The `doc_notifications_system_bypass` policy lets these through.
 * Reads + mark-read run through `queryWithRLS(userId, …)` so the
 * `doc_notifications_recipient` policy gates them to the calling user's own
 * rows. Recipient validation (workspace membership) is enforced here in
 * `recordMentions` rather than trusting the caller.
 *
 * [COMP:api/doc-notifications-store]
 */

import type { DocNotificationsStore, InboxMention } from '@use-brian/core'
import { query, queryWithRLS } from './client.js'

const MENTION_COLS = `
  n.id, n.page_id as "pageId", n.thread_id as "threadId",
  n.actor_user_id as "actorUserId", u.name as "actorName",
  sv.name as "pageTitle", n.preview,
  n.created_at as "createdAt", n.read_at as "readAt"`

type MentionRow = {
  id: string
  pageId: string
  threadId: string | null
  actorUserId: string
  actorName: string | null
  pageTitle: string | null
  preview: string | null
  createdAt: Date
  readAt: Date | null
}

function mapMention(row: MentionRow): InboxMention {
  return {
    id: row.id,
    pageId: row.pageId,
    pageTitle: row.pageTitle ?? '',
    threadId: row.threadId,
    actorUserId: row.actorUserId,
    actorName: row.actorName,
    preview: row.preview,
    createdAt: row.createdAt.toISOString(),
    readAt: row.readAt ? row.readAt.toISOString() : null,
  }
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

    async listForUser(userId: string, workspaceId: string): Promise<InboxMention[]> {
      // RLS-scoped to the recipient's own rows. Join page title + actor name
      // for the row label; LEFT JOIN so a deleted user/page doesn't drop the
      // notification.
      const res = await queryWithRLS<MentionRow>(
        userId,
        `SELECT ${MENTION_COLS}
           FROM doc_notifications n
           LEFT JOIN saved_views sv ON sv.id = n.page_id
           LEFT JOIN users u ON u.id = n.actor_user_id
          WHERE n.workspace_id = $1
          ORDER BY n.created_at DESC
          LIMIT 100`,
        [workspaceId],
      )
      return res.rows.map(mapMention)
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

    async unreadCount(userId: string, workspaceId: string): Promise<number> {
      const res = await queryWithRLS<{ count: string }>(
        userId,
        `SELECT COUNT(*)::int as count FROM doc_notifications
          WHERE workspace_id = $1 AND read_at IS NULL`,
        [workspaceId],
      )
      return Number(res.rows[0]?.count ?? 0)
    },
  }
}

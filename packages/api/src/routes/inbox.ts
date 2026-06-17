/**
 * Doc Inbox — REST routes backing the sidebar Inbox view.
 *
 * The Inbox merges two sources for the calling workspace member:
 *
 *   GET  /workspaces/:workspaceId/inbox          — the merged payload:
 *        `pending` (derived: open threads you started whose latest comment is
 *        the assistant's) + `mentions` (recorded `doc_notifications` rows)
 *        + counts for the sidebar badge.
 *   POST /workspaces/:workspaceId/inbox/read     — mark mentions read (all, or
 *        a given subset of ids). Body: `{ ids?: string[] }`.
 *   POST /workspaces/:workspaceId/doc-mentions — the mention emit the
 *        client calls when an `@person` node is inserted in a page body
 *        (`threadId` omitted) or committed in a comment (`threadId` set). Body:
 *        `{ pageId, threadId?, mentionedUserIds: string[], preview?: string }`.
 *        One uniform path for both page + comment mentions; the comment routes
 *        and the chat reply turn stay mention-agnostic.
 *
 * All routes require auth (mounted under `requireAuth` in
 * `apps/api/src/index.ts`). Notification reads/updates are RLS-scoped to the
 * caller's own rows; the derived-pending query is RLS-gated on
 * `comment_threads`. Recipient validation (workspace membership) happens in
 * the store. Mount point: `/api`.
 *
 * [COMP:api/inbox-routes]
 */

import { Router } from 'express'
import { z } from 'zod'
import type { DocNotificationsStore, CommentThreadStore, InboxPayload } from '@sidanclaw/core'

export type InboxRouteOptions = {
  commentThreadStore: CommentThreadStore
  docNotificationsStore: DocNotificationsStore
}

function unauthorized(res: import('express').Response): void {
  res.status(401).json({ error: 'unauthorized' })
}
function badRequest(res: import('express').Response, message: string): void {
  res.status(400).json({ error: message })
}

const markReadSchema = z.object({
  /** Omit to mark all of the caller's mentions read. */
  ids: z.array(z.string().min(1)).optional(),
})

const recordMentionSchema = z.object({
  pageId: z.string().min(1),
  /** Set for a comment mention; omitted for a page-body mention. */
  threadId: z.string().min(1).optional(),
  mentionedUserIds: z.array(z.string().min(1)).min(1),
  preview: z.string().max(280).optional(),
})

export function inboxRoutes(opts: InboxRouteOptions): Router {
  const router = Router()
  const { commentThreadStore, docNotificationsStore } = opts

  router.get('/workspaces/:workspaceId/inbox', async (req, res) => {
    const userId = (req as { userId?: string }).userId
    if (!userId) return unauthorized(res)
    const { workspaceId } = req.params
    const [pending, mentions] = await Promise.all([
      commentThreadStore.listPendingRepliesForUser(userId, workspaceId),
      docNotificationsStore.listForUser(userId, workspaceId),
    ])
    const payload: InboxPayload = {
      pending,
      mentions,
      pendingCount: pending.length,
      unreadMentionCount: mentions.filter((m) => m.readAt === null).length,
    }
    res.json(payload)
  })

  router.post('/workspaces/:workspaceId/inbox/read', async (req, res) => {
    const userId = (req as { userId?: string }).userId
    if (!userId) return unauthorized(res)
    const parsed = markReadSchema.safeParse(req.body ?? {})
    if (!parsed.success) return badRequest(res, 'ids must be an array of strings')
    await docNotificationsStore.markRead(userId, { ids: parsed.data.ids })
    res.status(204).end()
  })

  router.post('/workspaces/:workspaceId/doc-mentions', async (req, res) => {
    const userId = (req as { userId?: string }).userId
    if (!userId) return unauthorized(res)
    const parsed = recordMentionSchema.safeParse(req.body)
    if (!parsed.success) {
      return badRequest(
        res,
        parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
      )
    }
    // recordMentions validates each recipient is a workspace member and drops
    // self-mentions, so a forged id list can't mint a notification for a
    // non-member. threadId present → comment mention; absent → page-body.
    const created = await docNotificationsStore.recordMentions({
      workspaceId: req.params.workspaceId,
      pageId: parsed.data.pageId,
      threadId: parsed.data.threadId ?? null,
      actorUserId: userId,
      recipientUserIds: parsed.data.mentionedUserIds,
      preview: parsed.data.preview ?? null,
    })
    res.status(201).json({ created })
  })

  return router
}

/**
 * Doc comments — REST routes for the HUMAN-initiated thread flow.
 *
 * The AI-initiated flow goes through the `postComment` / `resolveComment`
 * tools inside `/api/chat` (see `doc/inject.ts` + `routes/chat.ts`);
 * these routes back the editor's own actions:
 *
 *   POST  /pages/:pageId/comment-threads  — create a human thread and seed its
 *                                           first comment. Defaults to a
 *                                           `human_range` thread (the floating-
 *                                           toolbar "Comment" action); pass
 *                                           `anchorKind:'human_block'` to anchor
 *                                           on an atom block (chart / image / …)
 *                                           that can't carry an inline mark
 *   GET   /pages/:pageId/comment-threads  — list a page's threads (the gutter
 *                                           badges + the thread-list panel)
 *   PATCH /comment-threads/:id            — resolve / reopen a thread
 *
 * A thread's comment messages are read via the existing
 * `GET /api/sessions/:id/messages` (the thread's `sessionId`); a human REPLY
 * that should wake the AI goes through `/api/chat` with that `sessionId`.
 *
 * All routes require auth (mounted under `requireAuth` in
 * `apps/api/src/index.ts`). Workspace/page access is enforced by RLS on the
 * `comment_threads` insert/select (the policy doubles as the INSERT
 * `WITH CHECK`), so a user can't open or read a thread on a page they can't
 * see. Mount point: `/api`.
 *
 * [COMP:api/comment-routes]
 */

import { Router } from 'express'
import { z } from 'zod'
import type { CommentThreadStore } from '@sidanclaw/core'

export type CommentRouteOptions = {
  commentThreadStore: CommentThreadStore
}

function unauthorized(res: import('express').Response): void {
  res.status(401).json({ error: 'unauthorized' })
}
function badRequest(res: import('express').Response, message: string): void {
  res.status(400).json({ error: message })
}
function notFound(res: import('express').Response, what = 'Not found'): void {
  res.status(404).json({ error: what })
}

const createThreadSchema = z.object({
  /** The doc assistant the thread's session belongs to (so a later AI
   *  reply uses it). The app-web client already holds this. */
  assistantId: z.string().min(1),
  workspaceId: z.string().min(1),
  /** How the thread anchors. Humans create 'human_range' (a text-range
   *  `comment` mark) by default, or 'human_block' when commenting on an atom
   *  block (chart / image / data / …) that can't carry an inline mark — the
   *  highlight is then a whole-block client decoration from `anchorBlockId`.
   *  'ai_block' is intentionally NOT accepted here: only the AI's `postComment`
   *  tool mints those. */
  anchorKind: z.enum(['human_range', 'human_block']).optional(),
  anchorBlockId: z.string().optional(),
  quote: z.string().max(280).optional(),
  /** Optional first comment, seeded as the thread's message #1. */
  body: z.string().min(1).optional(),
})

const resolveSchema = z.object({ resolved: z.boolean() })

const addMessageSchema = z.object({ body: z.string().min(1).max(10000) })

export function commentRoutes(opts: CommentRouteOptions): Router {
  const router = Router()
  const store = opts.commentThreadStore

  router.post('/pages/:pageId/comment-threads', async (req, res) => {
    const userId = (req as { userId?: string }).userId
    if (!userId) return unauthorized(res)
    const parsed = createThreadSchema.safeParse(req.body)
    if (!parsed.success) {
      return badRequest(
        res,
        parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
      )
    }
    try {
      const thread = await store.createThread({
        userId,
        workspaceId: parsed.data.workspaceId,
        pageId: req.params.pageId,
        assistantId: parsed.data.assistantId,
        anchorKind: parsed.data.anchorKind ?? 'human_range',
        anchorBlockId: parsed.data.anchorBlockId ?? null,
        quote: parsed.data.quote ?? null,
        firstComment: parsed.data.body
          ? { role: 'user', body: parsed.data.body, senderUserId: userId }
          : undefined,
      })
      res.status(201).json(thread)
    } catch (err) {
      // RLS WITH CHECK rejects a thread on a page the user can't access.
      console.warn('[comments] createThread failed:', err)
      return res.status(403).json({ error: 'cannot comment on this page' })
    }
  })

  router.get('/pages/:pageId/comment-threads', async (req, res) => {
    const userId = (req as { userId?: string }).userId
    if (!userId) return unauthorized(res)
    const includeResolved =
      req.query.includeResolved === 'true' || req.query.includeResolved === '1'
    const threads = await store.listThreadsForPage(userId, req.params.pageId, {
      includeResolved,
    })
    res.json(threads)
  })

  // Ids of the page's EMPTY threads (the first comment never landed). The
  // editor sweeps their orphaned `comment` marks out of the Yjs doc on load so
  // a stranded amber highlight clears. Page-access gated; emptiness is computed
  // system-side (see store) so it's clearance-safe and contentless.
  router.get('/pages/:pageId/comment-threads/empty', async (req, res) => {
    const userId = (req as { userId?: string }).userId
    if (!userId) return unauthorized(res)
    const emptyThreadIds = await store.listEmptyThreadIdsForPage(userId, req.params.pageId)
    res.json({ emptyThreadIds })
  })

  // Append a PLAIN human comment to a thread — a teammate comment with no AI
  // turn. The AI-reply path goes through /api/chat (which runs the assistant);
  // this is the "AI reply off" path: store the message and return it, nothing
  // else. RLS on `comment_threads` (inside `addComment`) gates access.
  router.post('/comment-threads/:id/messages', async (req, res) => {
    const userId = (req as { userId?: string }).userId
    if (!userId) return unauthorized(res)
    const parsed = addMessageSchema.safeParse(req.body)
    if (!parsed.success) return badRequest(res, 'body (non-empty string) is required')
    try {
      const message = await store.addComment({
        userId,
        threadId: req.params.id,
        role: 'user',
        body: parsed.data.body,
        senderUserId: userId,
      })
      res.status(201).json(message)
    } catch (err) {
      // RLS / missing thread → the user can't post here.
      console.warn('[comments] addComment failed:', err)
      return res.status(403).json({ error: 'cannot comment on this thread' })
    }
  })

  router.patch('/comment-threads/:id', async (req, res) => {
    const userId = (req as { userId?: string }).userId
    if (!userId) return unauthorized(res)
    const parsed = resolveSchema.safeParse(req.body)
    if (!parsed.success) return badRequest(res, 'resolved (boolean) is required')
    const updated = await store.setResolved({
      userId,
      threadId: req.params.id,
      resolved: parsed.data.resolved,
    })
    if (!updated) return notFound(res, 'Comment thread not found')
    res.json(updated)
  })

  return router
}

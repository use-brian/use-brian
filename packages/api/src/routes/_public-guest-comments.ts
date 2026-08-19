/**
 * Guest comment routes — the anonymous comment surface of doc page sharing
 * (Phase 2), mounted once per public address family so the three families
 * cannot drift on the auth gate:
 *
 *   POST <base>/comment-threads          — open a thread (mints the guest's
 *                                           `guest_session_token` on first post);
 *                                           `anchorBlockId` + `quote` make it a
 *                                           RANGE comment on selected text
 *   POST <base>/comment-threads/:id/messages — reply in one of the guest's OWN threads
 *   GET  <base>/comments?guestSessionToken=  — list the guest's OWN threads
 *
 * `<base>` is `/public/pages/:token` (link), `/public/published/:pageId`
 * (universal URL) or `/public/sites/:host` (custom domain). The caller hands
 * in the family's resolver; every handler re-resolves the target on each
 * request and 404s unless the resolved role allows commenting — so unpublish
 * / revoke / raise clearance / flip the workspace switch / drop the role back
 * to `view` all cut guests off immediately. **The route is the auth gate**:
 * the store writes system-side under the sentinel guest user, and a guest sees
 * only threads carrying their own token (`listGuestComments`).
 *
 * [COMP:doc/public-share-route]
 */

import type { Request, Response, Router } from 'express'
import { randomUUID } from 'node:crypto'
import { addGuestComment, createGuestThread, listGuestComments } from '../db/guest-comment-store.js'

/** The slice of a resolved public target the guest routes need. */
export type GuestCommentTarget = { pageId: string; workspaceId: string; role: string }

/** The request as the family resolvers see it: string params (`:token`,
 *  `:pageId`, `:host`) + the raw query (`?page=` scope). */
export type GuestCommentRequest = Request<Record<string, string>>

export const roleAllowsComment = (role: string): boolean =>
  role === 'comment' || role === 'edit' || role === 'full'

export function mountGuestCommentRoutes(
  router: Router,
  base: string,
  resolve: (req: GuestCommentRequest) => Promise<GuestCommentTarget | null>,
): void {
  async function gate(req: Request, res: Response): Promise<GuestCommentTarget | null> {
    const target = await resolve(req as unknown as GuestCommentRequest)
    if (!target || !roleAllowsComment(target.role)) {
      res.status(404).json({ error: 'Not found' })
      return null
    }
    return target
  }

  // Open a thread. Mints the guest's session token on their first comment;
  // the client persists it and sends it back on later posts/lists.
  router.post(`${base}/comment-threads`, async (req, res) => {
    const target = await gate(req, res)
    if (!target) return
    const b = (req.body ?? {}) as Record<string, unknown>
    const text = typeof b.body === 'string' ? b.body.trim() : ''
    if (!text) {
      res.status(400).json({ error: 'body is required' })
      return
    }
    const guestName =
      typeof b.guestName === 'string' && b.guestName.trim() ? b.guestName.trim().slice(0, 80) : 'Guest'
    const guestSessionToken =
      typeof b.guestSessionToken === 'string' && b.guestSessionToken ? b.guestSessionToken : randomUUID()
    // A RANGE comment (the guest selected text on the public page) carries the
    // block it starts in + the selected text. The guest cannot write the doc,
    // so the quote IS the anchor: both renderers find it inside the block and
    // highlight exactly that run (a vanished quote falls back to the block).
    // Bounded like every other guest field; a quote with no block is dropped
    // (nothing could place it), a block with no quote tints the whole block.
    const anchorBlockId =
      typeof b.anchorBlockId === 'string' && b.anchorBlockId.trim() ? b.anchorBlockId.trim().slice(0, 128) : null
    const quote =
      anchorBlockId && typeof b.quote === 'string' && b.quote.trim() ? b.quote.trim().slice(0, 280) : null
    try {
      const { threadId } = await createGuestThread({
        pageId: target.pageId,
        workspaceId: target.workspaceId,
        guestName,
        guestEmail: typeof b.guestEmail === 'string' ? b.guestEmail.slice(0, 320) : null,
        guestSessionToken,
        anchorBlockId,
        quote,
        body: text.slice(0, 10000),
      })
      res.status(201).json({ threadId, guestSessionToken })
    } catch (err) {
      console.error('[public-share] guest thread failed:', err)
      res.status(500).json({ error: 'Failed to post comment' })
    }
  })

  // Append a reply to one of the guest's OWN threads (token-scoped).
  router.post(`${base}/comment-threads/:id/messages`, async (req, res) => {
    const target = await gate(req, res)
    if (!target) return
    const b = (req.body ?? {}) as Record<string, unknown>
    const text = typeof b.body === 'string' ? b.body.trim() : ''
    const guestSessionToken = typeof b.guestSessionToken === 'string' ? b.guestSessionToken : ''
    if (!text || !guestSessionToken) {
      res.status(400).json({ error: 'guestSessionToken and body are required' })
      return
    }
    const ok = await addGuestComment({
      threadId: req.params.id,
      pageId: target.pageId,
      guestSessionToken,
      body: text.slice(0, 10000),
    })
    if (!ok) {
      res.status(403).json({ error: 'Cannot comment on this thread' })
      return
    }
    res.status(201).json({ ok: true })
  })

  // List the guest's OWN threads (scoped by guest_session_token).
  router.get(`${base}/comments`, async (req, res) => {
    const target = await gate(req, res)
    if (!target) return
    const guestSessionToken =
      typeof req.query.guestSessionToken === 'string' ? req.query.guestSessionToken : ''
    if (!guestSessionToken) {
      res.json({ threads: [] })
      return
    }
    const threads = await listGuestComments(target.pageId, guestSessionToken)
    res.json({ threads })
  })
}

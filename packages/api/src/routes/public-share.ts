/**
 * Public share routes — anonymous, unauthenticated read access to an
 * externally shared doc page. Mounted at `/api` **before** `requireAuth`
 * (precedent: authRoutes / telegramRoutes).
 *
 *   GET /public/pages/:token              — live page (blocks + public-tier
 *                                            data), identity/media neutralized
 *   GET /public/pages/:token/media/:blockId — token-gated signed media URL
 *
 * Access is by an unguessable link token only (no login, no cookies). The
 * link-token resolver gates on a live grant + the GRANTED page being currently
 * `clearance='public'` + the workspace's `external_sharing_enabled` switch,
 * so revoking the link, raising the root's clearance, or flipping the switch
 * all 404 immediately. Sharing cascades to the subtree: every token route
 * accepts `?page=<id>` to scope to a descendant of the granted root
 * (`resolveLinkPage`), with no clearance condition on the descendant itself
 * (doc.md "Subtree share"). Data is rendered through `renderPublicPage`, which
 * pins `clearance:'public'` — the same path the owner `public-preview` uses.
 *
 * [COMP:doc/public-share-route]
 */

import { Router } from 'express'
import type { Request, Response, NextFunction } from 'express'
import { getPageSystem } from '../db/saved-views-store.js'
import type { PageGrantStore } from '../db/page-grant-store.js'
import { buildStorageKey } from '../files/gcs-client.js'
import type { GcsFilesClient } from '../files/gcs-client.js'
import { randomUUID } from 'node:crypto'
import { renderPublicPage, type PublicRenderDeps } from './_public-render.js'
import {
  publicRecordingSummaryFor,
  sendPublicRecordingMediaUrl,
  sendPublicRecordingTranscript,
  type ResolveRecordingReadClient,
} from './_public-recording.js'
import { addGuestComment, createGuestThread, listGuestComments } from '../db/guest-comment-store.js'
import { listPublicThreadsForPage } from '../db/comment-thread-store.js'
import { subscribeToPageShareChanges } from '../page-share-fanout.js'
import { getLinkBreadcrumb, getPublicBreadcrumb, type ResolvedLink } from '../db/page-grant-store.js'

export type PublicShareRouteOptions = PublicRenderDeps & {
  pageGrantStore: PageGrantStore
  /** Null when no blob client is configured — media endpoint then 404s. */
  gcs: GcsFilesClient | null
  /** BYO-storage signer for recording playback URLs; absent → `gcs` signs. */
  resolveRecordingReadClient?: ResolveRecordingReadClient
}

// ── Minimal fixed-window per-IP rate limiter ──────────────────────────
// Anonymous traffic on the autoscaling user API. Per-instance, fixed
// window — a cheap abuse backstop; production also fronts this with
// infra-level limits. Bounded by periodic window reset.
function rateLimiter(limit: number, windowMs: number) {
  let windowStart = 0
  let hits = new Map<string, number>()
  return (req: Request, res: Response, next: NextFunction): void => {
    const now = Date.now()
    if (now - windowStart > windowMs) {
      windowStart = now
      hits = new Map()
    }
    const ip = req.ip ?? 'unknown'
    const n = (hits.get(ip) ?? 0) + 1
    hits.set(ip, n)
    if (n > limit) {
      res.status(429).json({ error: 'Too many requests' })
      return
    }
    next()
  }
}

export function publicShareRoutes(opts: PublicShareRouteOptions): Router {
  const router = Router()
  const { pageGrantStore, gcs } = opts

  // Resolve the token routes' target: the token's own page, or — with the
  // `?page=<id>` scope — a descendant of it (subtree cascade). One helper so
  // the page/media/stream/comment routes can't drift on the descendant gate.
  // (Takes the token + raw query value, not the Request: a standalone handler
  // doesn't get the route-literal param typing the inline handlers infer.)
  async function resolveTokenTarget(token: string, pageParam: unknown): Promise<ResolvedLink | null> {
    const sub = typeof pageParam === 'string' && pageParam ? pageParam : null
    return sub ? pageGrantStore.resolveLinkPage(token, sub) : pageGrantStore.resolveLinkToken(token)
  }

  // Render a resolved page (link or published) + its read-only comments and
  // respond. Shared by both the `/pages/:token` and `/published/:pageId` routes.
  // A token sub-page (`link.rootPageId` set) gets the token-scoped breadcrumb
  // (root → current); everything else gets the published-ancestor chain.
  async function respondWithPage(res: Response, link: ResolvedLink): Promise<void> {
    const page = await getPageSystem(link.pageId)
    try {
      const shareRootId = link.rootPageId ?? link.pageId
      const rendered = await renderPublicPage(opts, link.workspaceId, page ?? { blocks: [] }, shareRootId)
      const [comments, breadcrumb, recording] = await Promise.all([
        listPublicThreadsForPage(link.pageId),
        link.rootPageId
          ? getLinkBreadcrumb(link.pageId, link.rootPageId)
          : getPublicBreadcrumb(link.pageId),
        // The page's recording chrome (player + transcript + seekable
        // [H:MM:SS] citations) — resolved from the page's OWN pointer, so the
        // shared view carries the same surface the brief page does in-app.
        publicRecordingSummaryFor(link.pageId, link.workspaceId),
      ])
      // Light cache so polling clients don't hammer the render path.
      res.setHeader('Cache-Control', 'public, max-age=15')
      res.json({
        title: link.title,
        icon: link.icon,
        fullWidth: link.fullWidth,
        indexable: link.indexable,
        role: link.role,
        blocks: rendered.blocks,
        payload: rendered.payload,
        comments,
        breadcrumb,
        recording,
      })
    } catch (err) {
      console.error('[public-share] render failed:', err)
      res.status(500).json({ error: 'Failed to render page' })
    }
  }

  router.use('/public/pages', rateLimiter(120, 60_000))

  // GET /public/pages/:token — the live, neutralized page. `?page=<id>`
  // scopes to a descendant of the token's root (subtree cascade).
  router.get('/public/pages/:token', async (req, res) => {
    const link = await resolveTokenTarget(req.params.token, req.query.page)
    if (!link) {
      res.status(404).json({ error: 'This shared page is unavailable' })
      return
    }
    await respondWithPage(res, link)
  })

  // GET /public/pages/:token/media/:blockId — 302 to a fresh signed GCS URL.
  // The real storage key is re-derived server-side from the live page; the
  // block's MediaRef bucket/path never leaves the server. `?page=` scopes the
  // block lookup to a sub-page.
  router.get('/public/pages/:token/media/:blockId', async (req, res) => {
    const link = await resolveTokenTarget(req.params.token, req.query.page)
    if (!link) {
      res.status(404).json({ error: 'Not found' })
      return
    }
    const page = await getPageSystem(link.pageId)
    if (!gcs) {
      res.status(404).json({ error: 'Not found' })
      return
    }
    const block = page?.blocks.find((b) => b.id === req.params.blockId)
    if (!block || (block.kind !== 'image' && block.kind !== 'file') || !block.ref) {
      res.status(404).json({ error: 'Not found' })
      return
    }
    // path === workspace_files row id by contract (see doc-files upload).
    const fileId = block.ref.path
    try {
      const key = buildStorageKey(link.workspaceId, fileId)
      const url = await gcs.signedReadUrl(key)
      if (/^https?:\/\//i.test(url)) {
        res.redirect(302, url)
        return
      }
      const blob = await gcs.readBlob(key)
      if (!blob) {
        res.status(404).json({ error: 'Not found' })
        return
      }
      res.setHeader('Content-Type', blob.mime || block.ref.mimeType)
      res.setHeader('Cache-Control', 'public, max-age=3600')
      res.setHeader('Content-Length', String(blob.bytes.length))
      res.send(blob.bytes)
    } catch (err) {
      console.error('[public-share] media failed:', err)
      res.status(500).json({ error: 'Failed to load media' })
    }
  })

  // ── The shared page's recording (player + transcript) ────────────────
  // Both resolve the recording from the PAGE's own pointer server-side —
  // no recording id in the URL, so there is nothing to enumerate. `?page=`
  // scopes to a sub-page exactly like the media route.

  // GET /public/pages/:token/recording/media-url — JSON {url, expiresAt, ...}
  // (authed-route contract, so the one player provider consumes both).
  router.get('/public/pages/:token/recording/media-url', async (req, res) => {
    const link = await resolveTokenTarget(req.params.token, req.query.page)
    if (!link) {
      res.status(404).json({ error: 'Not found' })
      return
    }
    await sendPublicRecordingMediaUrl(res, {
      pageId: link.pageId,
      workspaceId: link.workspaceId,
      gcs,
      ...(opts.resolveRecordingReadClient
        ? { resolveReadClient: opts.resolveRecordingReadClient }
        : {}),
    })
  })

  // GET /public/pages/:token/recording/transcript?fromIndex= — one bounded
  // page of transcript segments (authed-route response shape).
  router.get('/public/pages/:token/recording/transcript', async (req, res) => {
    const link = await resolveTokenTarget(req.params.token, req.query.page)
    if (!link) {
      res.status(404).json({ error: 'Not found' })
      return
    }
    await sendPublicRecordingTranscript(req, res, {
      pageId: link.pageId,
      workspaceId: link.workspaceId,
    })
  })

  // ── Guest comments (Phase 2) — `comment` (or higher) link roles ──────
  // The route is the auth gate: resolveLinkToken validates the live grant +
  // role + page-still-public; writes go system-side under the sentinel user.
  const roleAllowsComment = (role: string) => role === 'comment' || role === 'edit' || role === 'full'

  // POST a new guest thread (mints a guest_session_token on first comment).
  // `?page=` anchors the thread to the sub-page being viewed.
  router.post('/public/pages/:token/comment-threads', async (req, res) => {
    const link = await resolveTokenTarget(req.params.token, req.query.page)
    if (!link || !roleAllowsComment(link.role)) {
      res.status(404).json({ error: 'Not found' })
      return
    }
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
    try {
      const { threadId } = await createGuestThread({
        pageId: link.pageId,
        workspaceId: link.workspaceId,
        guestName,
        guestEmail: typeof b.guestEmail === 'string' ? b.guestEmail.slice(0, 320) : null,
        guestSessionToken,
        anchorBlockId: typeof b.anchorBlockId === 'string' ? b.anchorBlockId : null,
        quote: typeof b.quote === 'string' ? b.quote.slice(0, 280) : null,
        body: text.slice(0, 10000),
      })
      res.status(201).json({ threadId, guestSessionToken })
    } catch (err) {
      console.error('[public-share] guest thread failed:', err)
      res.status(500).json({ error: 'Failed to post comment' })
    }
  })

  // Append a reply to one of the guest's OWN threads (token-scoped).
  router.post('/public/pages/:token/comment-threads/:id/messages', async (req, res) => {
    const link = await resolveTokenTarget(req.params.token, req.query.page)
    if (!link || !roleAllowsComment(link.role)) {
      res.status(404).json({ error: 'Not found' })
      return
    }
    const b = (req.body ?? {}) as Record<string, unknown>
    const text = typeof b.body === 'string' ? b.body.trim() : ''
    const guestSessionToken = typeof b.guestSessionToken === 'string' ? b.guestSessionToken : ''
    if (!text || !guestSessionToken) {
      res.status(400).json({ error: 'guestSessionToken and body are required' })
      return
    }
    const ok = await addGuestComment({
      threadId: req.params.id,
      pageId: link.pageId,
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
  router.get('/public/pages/:token/comments', async (req, res) => {
    const link = await resolveTokenTarget(req.params.token, req.query.page)
    if (!link || !roleAllowsComment(link.role)) {
      res.status(404).json({ error: 'Not found' })
      return
    }
    const guestSessionToken =
      typeof req.query.guestSessionToken === 'string' ? req.query.guestSessionToken : ''
    if (!guestSessionToken) {
      res.json({ threads: [] })
      return
    }
    const threads = await listGuestComments(link.pageId, guestSessionToken)
    res.json({ threads })
  })

  // GET /public/pages/:token/stream — SSE (Phase 3). Pushes a `change` signal
  // on grant changes (e.g. a revoke → the page reacts live) plus a periodic
  // `tick` the client treats as "re-fetch" (page content lives in the separate
  // doc-sync process, invisible to this in-memory fanout). Replaces the
  // Phase-1 client poll. Token-gated like the other public routes.
  router.get('/public/pages/:token/stream', async (req, res) => {
    const link = await resolveTokenTarget(req.params.token, req.query.page)
    if (!link) {
      res.status(404).end()
      return
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    })
    res.write(': connected\n\n')
    const send = (event: string) => {
      try {
        res.write(`event: ${event}\ndata: {}\n\n`)
      } catch {
        // client gone; cleanup runs on 'close'
      }
    }
    // A sub-page view also subscribes to the token's ROOT — grant changes
    // (revoke / role change) fan out keyed on the granted page id, and they
    // cut the whole subtree, so the sub-page viewer must hear them too.
    const unsubscribe = subscribeToPageShareChanges(link.pageId, () => send('change'))
    const unsubscribeRoot = link.rootPageId
      ? subscribeToPageShareChanges(link.rootPageId, () => send('change'))
      : null
    const tick = setInterval(() => send('tick'), 20_000)
    req.on('close', () => {
      clearInterval(tick)
      unsubscribe()
      unsubscribeRoot?.()
      res.end()
    })
  })

  // ── Published pages — one universal URL per page (`/share/p/:pageId`) ──
  // Notion-style "publish to web": the page id IS the address (no token). The
  // gate is a live `published` grant on the page or an ancestor that is still
  // clearance-public, + the workspace switch (subtree cascade) — unpublish /
  // raise the published root's clearance / flip switch all 404 the subtree.
  router.use('/public/published', rateLimiter(120, 60_000))

  // GET /public/published/:pageId — the live, neutralized published page.
  router.get('/public/published/:pageId', async (req, res) => {
    const link = await pageGrantStore.resolvePublishedPage(req.params.pageId)
    if (!link) {
      res.status(404).json({ error: 'This shared page is unavailable' })
      return
    }
    await respondWithPage(res, link)
  })

  // GET /public/published/:pageId/media/:blockId — 302 to a fresh signed URL.
  router.get('/public/published/:pageId/media/:blockId', async (req, res) => {
    const link = await pageGrantStore.resolvePublishedPage(req.params.pageId)
    if (!link || !gcs) {
      res.status(404).json({ error: 'Not found' })
      return
    }
    const page = await getPageSystem(link.pageId)
    const block = page?.blocks.find((b) => b.id === req.params.blockId)
    if (!block || (block.kind !== 'image' && block.kind !== 'file') || !block.ref) {
      res.status(404).json({ error: 'Not found' })
      return
    }
    const fileId = block.ref.path
    try {
      const key = buildStorageKey(link.workspaceId, fileId)
      const url = await gcs.signedReadUrl(key)
      if (/^https?:\/\//i.test(url)) {
        res.redirect(302, url)
        return
      }
      const blob = await gcs.readBlob(key)
      if (!blob) {
        res.status(404).json({ error: 'Not found' })
        return
      }
      res.setHeader('Content-Type', blob.mime || block.ref.mimeType)
      res.setHeader('Cache-Control', 'public, max-age=3600')
      res.setHeader('Content-Length', String(blob.bytes.length))
      res.send(blob.bytes)
    } catch (err) {
      console.error('[public-share] published media failed:', err)
      res.status(500).json({ error: 'Failed to load media' })
    }
  })

  // GET /public/published/:pageId/recording/media-url — published twin of the
  // token route above; the publish grant is the authorization.
  router.get('/public/published/:pageId/recording/media-url', async (req, res) => {
    const link = await pageGrantStore.resolvePublishedPage(req.params.pageId)
    if (!link) {
      res.status(404).json({ error: 'Not found' })
      return
    }
    await sendPublicRecordingMediaUrl(res, {
      pageId: link.pageId,
      workspaceId: link.workspaceId,
      gcs,
      ...(opts.resolveRecordingReadClient
        ? { resolveReadClient: opts.resolveRecordingReadClient }
        : {}),
    })
  })

  // GET /public/published/:pageId/recording/transcript?fromIndex=
  router.get('/public/published/:pageId/recording/transcript', async (req, res) => {
    const link = await pageGrantStore.resolvePublishedPage(req.params.pageId)
    if (!link) {
      res.status(404).json({ error: 'Not found' })
      return
    }
    await sendPublicRecordingTranscript(req, res, {
      pageId: link.pageId,
      workspaceId: link.workspaceId,
    })
  })

  // GET /public/published/:pageId/stream — SSE live updates (change + tick).
  // A sub-page resolved via an ANCESTOR's grant only subscribes to its own id;
  // a revoke on the ancestor fans out on the ancestor's id, so the sub-page
  // viewer picks it up on the next 20s tick re-fetch (acceptable lag).
  router.get('/public/published/:pageId/stream', async (req, res) => {
    const link = await pageGrantStore.resolvePublishedPage(req.params.pageId)
    if (!link) {
      res.status(404).end()
      return
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    })
    res.write(': connected\n\n')
    const send = (event: string) => {
      try {
        res.write(`event: ${event}\ndata: {}\n\n`)
      } catch {
        // client gone; cleanup runs on 'close'
      }
    }
    const unsubscribe = subscribeToPageShareChanges(link.pageId, () => send('change'))
    const tick = setInterval(() => send('tick'), 20_000)
    req.on('close', () => {
      clearInterval(tick)
      unsubscribe()
      res.end()
    })
  })

  return router
}

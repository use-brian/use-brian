/**
 * Public site routes — anonymous, unauthenticated read access to a published
 * page subtree served on a customer's custom domain. Mounted at `/api`
 * **before** `requireAuth` (immediately after `publicShareRoutes`).
 *
 *   GET /public/sites/:host/page?path=      — resolve + render, or a redirect
 *                                             directive (slug history / canon)
 *   GET /public/sites/:host/media/:blockId  — signed media (`?page=` scopes)
 *   GET /public/sites/:host/stream          — SSE change/tick (`?page=`)
 *
 * The hostname is the address, never the gate: every request re-derives the
 * publish state of the DOMAIN ROOT (live `published` grant + root still
 * `clearance='public'` + workspace switch) via `resolveSitePath` /
 * `resolveSitePage`, and renders through the same pinned-public
 * `renderPublicPage` as the token/published routes. Spec:
 * docs/architecture/features/custom-domains.md.
 *
 * [COMP:doc/public-site-route]
 */

import { Router } from 'express'
import type { Request, Response, NextFunction } from 'express'
import { getPageSystem } from '../db/saved-views-store.js'
import type { PageDomain, PageDomainStore } from '../db/page-domain-store.js'
import { buildStorageKey } from '../files/gcs-client.js'
import type { GcsFilesClient } from '../files/gcs-client.js'
import { renderPublicPage, type PublicRenderDeps } from './_public-render.js'
import {
  publicRecordingSummaryFor,
  sendPublicRecordingMediaUrl,
  sendPublicRecordingTranscript,
  type ResolveRecordingReadClient,
} from './_public-recording.js'
import { listPublicThreadsForPage } from '../db/comment-thread-store.js'
import { subscribeToPageShareChanges } from '../page-share-fanout.js'
import { getLinkBreadcrumb } from '../db/page-grant-store.js'

export type PublicSiteRouteOptions = PublicRenderDeps & {
  pageDomainStore: PageDomainStore
  /** Null when no blob client is configured — media endpoint then 404s. */
  gcs: GcsFilesClient | null
  /** BYO-storage signer for recording playback URLs; absent → `gcs` signs. */
  resolveRecordingReadClient?: ResolveRecordingReadClient
}

// Same minimal fixed-window per-IP limiter as public-share.ts.
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

/** Host params arrive from our own middleware rewrite; strip port + case. */
function normalizeHostParam(raw: string): string {
  return raw.toLowerCase().replace(/:\d+$/, '')
}

export function publicSiteRoutes(opts: PublicSiteRouteOptions): Router {
  const router = Router()
  const { pageDomainStore, gcs } = opts

  router.use('/public/sites', rateLimiter(240, 60_000))

  // GET /public/sites/:host/page?path= — resolve the path (slug / /p/<id> /
  // root), then render. Historical slugs and slug-canonicalization come back
  // as `{ redirect }` for the site route to 301.
  router.get('/public/sites/:host/page', async (req, res) => {
    const host = normalizeHostParam(req.params.host)
    const path = typeof req.query.path === 'string' ? req.query.path : null
    const resolution = await pageDomainStore.resolveSitePath(host, path)
    if (!resolution) {
      res.status(404).json({ error: 'This page is unavailable' })
      return
    }
    if (resolution.kind === 'redirect') {
      res.setHeader('Cache-Control', 'public, max-age=60')
      res.json({ redirect: resolution.location })
      return
    }
    const { domain, target, canonicalPath } = resolution
    const page = await getPageSystem(target.pageId)
    try {
      const rootPageId = target.rootPageId ?? target.pageId
      const rendered = await renderPublicPage(
        opts,
        target.workspaceId,
        page ?? { blocks: [] },
        rootPageId,
      )
      const [comments, breadcrumb, recording] = await Promise.all([
        listPublicThreadsForPage(target.pageId),
        getLinkBreadcrumb(target.pageId, rootPageId),
        // The page's recording chrome — same surface the brief carries in-app.
        publicRecordingSummaryFor(target.pageId, target.workspaceId),
      ])
      const paths = await buildSitePaths(pageDomainStore, domain, rendered.blocks, breadcrumb)
      res.setHeader('Cache-Control', 'public, max-age=15')
      res.json({
        title: target.title,
        icon: target.icon,
        fullWidth: target.fullWidth,
        indexable: target.indexable,
        role: target.role,
        blocks: rendered.blocks,
        payload: rendered.payload,
        comments,
        breadcrumb,
        recording,
        pageId: target.pageId,
        canonicalPath,
        paths,
      })
    } catch (err) {
      console.error('[public-sites] render failed:', err)
      res.status(500).json({ error: 'Failed to render page' })
    }
  })

  // GET /public/sites/:host/media/:blockId — 302 to a fresh signed URL.
  // `?page=` scopes the block lookup to a sub-page of the domain root.
  router.get('/public/sites/:host/media/:blockId', async (req, res) => {
    const host = normalizeHostParam(req.params.host)
    const pageParam = typeof req.query.page === 'string' && req.query.page ? req.query.page : null
    const resolved = await pageDomainStore.resolveSitePage(host, pageParam)
    if (!resolved || !gcs) {
      res.status(404).json({ error: 'Not found' })
      return
    }
    const { target } = resolved
    const page = await getPageSystem(target.pageId)
    const block = page?.blocks.find((b) => b.id === req.params.blockId)
    if (!block || (block.kind !== 'image' && block.kind !== 'file') || !block.ref) {
      res.status(404).json({ error: 'Not found' })
      return
    }
    const fileId = block.ref.path
    try {
      const key = buildStorageKey(target.workspaceId, fileId)
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
      console.error('[public-sites] media failed:', err)
      res.status(500).json({ error: 'Failed to load media' })
    }
  })

  // ── The shared page's recording (player + transcript) ────────────────
  // `?page=` scopes to a sub-page of the domain root, like the media route.
  // The recording resolves from the PAGE's own pointer server-side — no
  // recording id in the URL, nothing to enumerate.

  // GET /public/sites/:host/recording/media-url — JSON {url, expiresAt, ...}
  router.get('/public/sites/:host/recording/media-url', async (req, res) => {
    const host = normalizeHostParam(req.params.host)
    const pageParam = typeof req.query.page === 'string' && req.query.page ? req.query.page : null
    const resolved = await pageDomainStore.resolveSitePage(host, pageParam)
    if (!resolved) {
      res.status(404).json({ error: 'Not found' })
      return
    }
    await sendPublicRecordingMediaUrl(res, {
      pageId: resolved.target.pageId,
      workspaceId: resolved.target.workspaceId,
      gcs,
      ...(opts.resolveRecordingReadClient
        ? { resolveReadClient: opts.resolveRecordingReadClient }
        : {}),
    })
  })

  // GET /public/sites/:host/recording/transcript?fromIndex=
  router.get('/public/sites/:host/recording/transcript', async (req, res) => {
    const host = normalizeHostParam(req.params.host)
    const pageParam = typeof req.query.page === 'string' && req.query.page ? req.query.page : null
    const resolved = await pageDomainStore.resolveSitePage(host, pageParam)
    if (!resolved) {
      res.status(404).json({ error: 'Not found' })
      return
    }
    await sendPublicRecordingTranscript(req, res, {
      pageId: resolved.target.pageId,
      workspaceId: resolved.target.workspaceId,
    })
  })

  // GET /public/sites/:host/stream — SSE change/tick. Subscribes to the
  // viewed page AND the domain root: publish-state changes fan out keyed on
  // the granted (root) page id and cut the whole domain.
  router.get('/public/sites/:host/stream', async (req, res) => {
    const host = normalizeHostParam(req.params.host)
    const pageParam = typeof req.query.page === 'string' && req.query.page ? req.query.page : null
    const resolved = await pageDomainStore.resolveSitePage(host, pageParam)
    if (!resolved) {
      res.status(404).end()
      return
    }
    const { target } = resolved
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
    const unsubscribe = subscribeToPageShareChanges(target.pageId, () => send('change'))
    const unsubscribeRoot = target.rootPageId
      ? subscribeToPageShareChanges(target.rootPageId, () => send('change'))
      : null
    const tick = setInterval(() => send('tick'), 20_000)
    req.on('close', () => {
      clearInterval(tick)
      unsubscribe()
      unsubscribeRoot?.()
      res.end()
    })
  })

  return router
}

/** Canonical site paths for every page the response references (breadcrumb +
 *  child_page blocks): `/` for the root, `/<slug>` when a current slug
 *  exists, `/p/<id>` otherwise. One query, no per-link lookups. Exported for
 *  tests. */
export async function buildSitePaths(
  store: PageDomainStore,
  domain: PageDomain,
  blocks: Array<{ kind?: string; childPageId?: string | null }>,
  breadcrumb: Array<{ pageId: string }>,
): Promise<Record<string, string>> {
  const ids = new Set<string>()
  for (const crumb of breadcrumb) ids.add(crumb.pageId)
  for (const block of blocks) {
    if (block.kind === 'child_page' && block.childPageId) ids.add(block.childPageId)
  }
  // The default page owns `/` (an unbound domain has none — every referenced
  // page then addresses by slug or /p/<id>).
  const paths: Record<string, string> = {}
  if (domain.pageId) {
    ids.delete(domain.pageId)
    paths[domain.pageId] = '/'
  }
  const slugs = await store.listCurrentSlugs(domain.id, [...ids])
  for (const id of ids) {
    const slug = slugs.get(id)
    paths[id] = slug ? `/${slug}` : `/p/${id}`
  }
  return paths
}

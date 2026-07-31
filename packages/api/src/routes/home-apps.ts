/**
 * Custom Home app routes — bundle serving, the frame's session, and bridge KV.
 *
 * The shape here follows one rule: **the iframe is a stranger.** It runs at an
 * opaque origin with no cookies and no Authorization header, so every request
 * it makes carries a signed capability token instead of a session, and every
 * handler re-derives the workspace from the app row rather than trusting a
 * claim in the request.
 *
 * Routes:
 *   GET  /api/home-apps/:appId/session   (authed) — what the HOST page needs
 *        to render the frame: status, entry URL with a bundle token, and the
 *        bridge token to hand over the postMessage channel.
 *   GET  /api/home-apps/:appId/bundle/*  (token)  — the bytes, content-type
 *        pinned from an allowlist, with the CSP attached.
 *   GET  /api/home-apps/:appId/state     (bridge) — KV read
 *   PUT  /api/home-apps/:appId/state     (bridge) — KV write, size-capped
 *
 * There are deliberately NO bridge data endpoints. An app reaches the brain
 * through the existing brain-MCP server, which now accepts the bridge token as
 * a third credential kind — so apps get `searchBrain`, tasks, CRM, pages and
 * files with zero new tool code, scope- and clearance-gated exactly like a
 * brain key. Adding a parallel data API here would be a second, weaker
 * authorization surface over the same data.
 *
 * Spec: docs/architecture/features/home-apps.md.
 * [COMP:api/home-app-bundle-route]
 */

import { Router, type RequestHandler } from 'express'
import multer from 'multer'
import type { AppManifest, AppScopes } from '@use-brian/brian-app'
import { BUNDLE_MAX_TOTAL_BYTES, contentTypeFor } from '@use-brian/brian-app'
import type { FilesApi } from '@use-brian/core'
import {
  consumeHomeAppBudget,
  createHomeApp,
  deleteHomeApp,
  getHomeApp,
  recordHomeAppSyncError,
  grantHomeApp,
  setHomeAppStatus,
  getHomeAppState,
  isRenderableHomeApp,
  listHomeApps,
  putHomeAppState,
  type HomeAppRow,
} from '../db/home-apps-store.js'
import {
  getWorkspaceMembershipWithClearanceSystem,
  getWorkspaceRoleSystem,
} from '../db/workspace-store.js'
import { buildBundleCsp } from '../home-apps/csp.js'
import { writeHomeAppBundle } from '../home-apps/tools.js'
import { buildBundleZip, filesFromZipBuffer } from '../home-apps/zip.js'
import { notifyWorkspaceChange } from '../brain-stream/notify.js'
import {
  BRIDGE_TOKEN_TTL_MS,
  mintBridgeToken,
  mintBundleToken,
  verifyBridgeToken,
  verifyBundleToken,
} from '../home-apps/tokens.js'

/** Reserved storage prefix for bundle files (brain-exclusion key). */
export const APPS_PATH_PREFIX = '/apps/'

/** Where a bundle file lives in workspace file storage. */
export function bundleStoragePath(appId: string, path: string): string {
  return `${APPS_PATH_PREFIX}${appId}/${path}`
}

/** Sync one app now (injected — the route module does not own GitHub). */
export type SyncNow = (app: HomeAppRow) => Promise<
  { status: 'unchanged' | 'synced'; droppedToNeedsConsent?: boolean } | { status: 'failed'; error: string }
>

export type HomeAppRouteOptions = {
  /**
   * The auth middleware, applied PER ROUTE rather than to the whole mount.
   *
   * `/session` is a normal authenticated call from the host page; `/bundle/*`
   * and `/state` are reached by the opaque-origin iframe, which has no cookie
   * and no session, so a blanket guard would 401 them before their own
   * capability check ever ran. Injected (the `oauthRoutes` dependency pattern)
   * so the composition root owns the secret and this module stays testable.
   */
  requireAuth: RequestHandler
  filesApi: FilesApi
  /** The single server-side signing secret (`JWT_SECRET`). */
  signingSecret: string
  /** The API's own origin, folded into the bundle CSP's `connect-src`. */
  apiOrigin: string
  /**
   * Sync-now. Optional — when unset the GitHub import + manual sync routes are
   * not mounted at all, so a build with no GitHub reads (or no credentials
   * resolver) advertises no half-working import.
   */
  syncNow?: SyncNow
}

/** Owner/admin gate for the routes that do not go through a store setter. */
async function isWorkspaceAdmin(userId: string, workspaceId: string): Promise<boolean> {
  const role = await getWorkspaceRoleSystem(userId, workspaceId)
  return role === 'owner' || role === 'admin'
}

/** Store-result reason → HTTP status. */
function statusFor(reason: 'not_admin' | 'not_found' | 'invalid'): number {
  return reason === 'not_found' ? 404 : reason === 'invalid' ? 400 : 403
}

/** Remove every stored file under an app's reserved bundle prefix. */
export async function deleteBundle(
  filesApi: FilesApi,
  workspaceId: string,
  appId: string,
): Promise<void> {
  const ctx = { workspaceId, userId: '', system: true } as never
  const prefix = `${APPS_PATH_PREFIX}${appId}/`
  const existing = await filesApi.search(ctx, { parentPath: prefix, limit: 100 })
  for (const file of existing) {
    await filesApi.delete(ctx, file.path)
  }
}

/** The manifest we will act on — the stored, validated one, never the bundle. */
function storedManifest(app: HomeAppRow): AppManifest | null {
  const m = app.manifest as AppManifest
  return m && typeof m === 'object' && m.scopes ? m : null
}

export function homeAppRoutes(opts: HomeAppRouteOptions): Router {
  const router = Router()

  const uploadZip = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: BUNDLE_MAX_TOTAL_BYTES + 1024 * 1024, files: 1 },
  })

  /**
   * GET /api/home-apps?workspaceId= — the workspace's custom apps.
   *
   * Feeds two surfaces from one read: the Studio Custom section (which wants
   * every app, including the ones waiting on consent) and the Home app-bar
   * (which wants only the renderable ones). Rather than two endpoints, each row
   * carries `renderable` and the strip filters on it — which is how the T3
   * drift rule reaches the UI: an app whose re-synced manifest widened its
   * scopes drops to `needs_consent`, stops being renderable, and disappears
   * from the strip until an admin re-grants.
   */
  router.get('/', opts.requireAuth, async (req, res) => {
    const userId = (req as { userId?: string }).userId
    if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return }
    const workspaceId = req.query.workspaceId
    if (typeof workspaceId !== 'string' || !workspaceId) {
      res.status(400).json({ error: 'Missing workspaceId' })
      return
    }
    const membership = await getWorkspaceMembershipWithClearanceSystem(userId, workspaceId)
    if (!membership) { res.status(403).json({ error: 'Not a member of this workspace' }); return }

    const apps = await listHomeApps(workspaceId)
    res.json(
      apps.map((app) => ({
        id: app.id,
        name: app.name,
        description: app.description,
        icon: app.icon,
        kind: app.kind,
        status: app.status,
        renderable: isRenderableHomeApp(app),
        repo: app.repo,
        branch: app.branch,
        lastSyncedAt: app.lastSyncedAt,
        syncError: app.syncError,
        requestedScopes: storedManifest(app)?.scopes ?? null,
        grantedScopes: app.grantedScopes,
        maxClearance: app.maxClearance,
        dailyCallLimit: app.dailyCallLimit,
        dailyUsed: app.dailyUsed,
      })),
    )
  })

  if (opts.syncNow) {
    const syncNow = opts.syncNow

    /**
     * POST /api/home-apps/github — import an app from a repository.
     *
     * Owner/admin only, and the FIRST SYNC RUNS INLINE: an import that
     * silently created a row and left the bundle to arrive within 15 minutes
     * would show the admin a consent screen for a manifest nobody had read
     * yet. If the first sync fails, the row is removed rather than left as a
     * broken shell the admin has to clean up.
     */
    router.post('/github', opts.requireAuth, async (req, res) => {
      const userId = (req as { userId?: string }).userId
      if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return }
      const body = (req.body ?? {}) as {
        workspaceId?: unknown
        repo?: unknown
        branch?: unknown
        rootPath?: unknown
        connectorInstanceId?: unknown
      }
      const workspaceId = typeof body.workspaceId === 'string' ? body.workspaceId : ''
      const repo = typeof body.repo === 'string' ? body.repo.trim() : ''
      if (!workspaceId || !/^[\w.-]+\/[\w.-]+$/.test(repo)) {
        res.status(400).json({ error: 'workspaceId and repo (owner/name) are required' })
        return
      }
      if (!(await isWorkspaceAdmin(userId, workspaceId))) {
        res.status(403).json({ error: 'Only a workspace owner or admin can add an app.' })
        return
      }

      // A placeholder manifest until the first sync writes the real one. The
      // row is never renderable in this state — `status` defaults to
      // `needs_consent` and `granted_scopes` is NULL.
      const app = await createHomeApp({
        workspaceId,
        kind: 'github',
        manifest: {
          manifestVersion: 1,
          name: repo.split('/')[1] ?? repo,
          entry: 'index.html',
          scopes: { data: 'read' },
          metadata: {},
        },
        repo,
        branch: typeof body.branch === 'string' && body.branch ? body.branch : 'main',
        rootPath: typeof body.rootPath === 'string' ? body.rootPath : '',
        connectorInstanceId:
          typeof body.connectorInstanceId === 'string' ? body.connectorInstanceId : null,
        createdBy: userId,
      })

      const outcome = await syncNow(app)
      if (outcome.status === 'failed') {
        // Roll back rather than leave a broken shell an admin must clean up.
        await deleteHomeApp({ actingUserId: userId, appId: app.id })
        res.status(400).json({ error: outcome.error })
        return
      }
      notifyWorkspaceChange(workspaceId, 'workspace_config', 'update')
      res.status(201).json({ id: app.id, repo, status: 'needs_consent' })
    })

    /** POST /api/home-apps/:appId/sync — "Sync now". */
    router.post('/:appId/sync', opts.requireAuth, async (req, res) => {
      const userId = (req as { userId?: string }).userId
      if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return }
      const app = await getHomeApp(String(req.params.appId))
      if (!app) { res.status(404).json({ error: 'App not found' }); return }
      if (!(await isWorkspaceAdmin(userId, app.workspaceId))) {
        res.status(403).json({ error: 'Only a workspace owner or admin can sync an app.' })
        return
      }
      const outcome = await syncNow(app)
      if (outcome.status === 'failed') {
        await recordHomeAppSyncError(app.id, outcome.error)
        res.status(400).json({ error: outcome.error })
        return
      }
      notifyWorkspaceChange(app.workspaceId, 'workspace_config', 'update')
      res.json({
        ok: true,
        status: outcome.status,
        // Surfaced so the client can say "it synced, but it now asks for more
        // access and has left Home" rather than a bare success.
        droppedToNeedsConsent: outcome.droppedToNeedsConsent ?? false,
      })
    })
  }

  /**
   * POST /api/home-apps/import — import an app from a zip (multipart `file`).
   *
   * The GitHub path without the repo, mounted UNCONDITIONALLY (a zip needs no
   * credentials, so a build with no GitHub sync still imports). Extraction
   * feeds the same `writeHomeAppBundle` seam the assistant path uses — one
   * validator, one write path, and the imported app lands at `needs_consent`
   * exactly like every other arrival. Same manifest name re-imported = an
   * update to the same `upload`-kind app.
   */
  const receiveZip: RequestHandler = (req, res, next) => {
    // Multer's memory storage, capped just above the bundle total so the
    // recognisable "too large" answer comes from us, not a socket error.
    uploadZip.single('file')(req, res, (err?: unknown) => {
      if (err) {
        res.status(400).json({ error: 'That zip is too large to import.' })
        return
      }
      next()
    })
  }
  router.post('/import', opts.requireAuth, receiveZip, async (req, res) => {
    const userId = (req as { userId?: string }).userId
    if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return }
    const workspaceId = (req.body as { workspaceId?: unknown })?.workspaceId
    if (typeof workspaceId !== 'string' || !workspaceId) {
      res.status(400).json({ error: 'Missing workspaceId' })
      return
    }
    if (!(await isWorkspaceAdmin(userId, workspaceId))) {
      res.status(403).json({ error: 'Only a workspace owner or admin can add an app.' })
      return
    }
    const file = (req as { file?: { buffer: Buffer } }).file
    if (!file) { res.status(400).json({ error: 'Attach the bundle zip as `file`.' }); return }

    const extracted = await filesFromZipBuffer(file.buffer)
    if (!extracted.ok) { res.status(400).json({ error: extracted.message }); return }

    const result = await writeHomeAppBundle(
      {
        filesApi: opts.filesApi,
        workspaceId,
        actingUserId: userId,
        bundlePath: bundleStoragePath,
        clearBundle: (ws, appId) => deleteBundle(opts.filesApi, ws, appId),
      },
      { files: extracted.files, kind: 'upload' },
    )
    if (!result.ok) { res.status(400).json({ error: result.message }); return }

    notifyWorkspaceChange(workspaceId, 'workspace_config', 'update')
    res.status(201).json({
      id: result.app.id,
      name: result.app.name,
      created: result.created,
      status: result.app.status,
      warnings: result.warnings,
    })
  })

  /**
   * POST /api/home-apps/:appId/grant — the consent action.
   *
   * Owner/admin only, enforced in the STORE (the brain-keys pattern), and the
   * granted scopes come from the app's stored manifest rather than the body —
   * otherwise the screen an admin read and the grant that lands could differ.
   * The body carries only the two things the admin actually chooses: an
   * optional clearance ceiling and an optional daily budget.
   */
  router.post('/:appId/grant', opts.requireAuth, async (req, res) => {
    const userId = (req as { userId?: string }).userId
    if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return }
    const body = (req.body ?? {}) as { maxClearance?: unknown; dailyCallLimit?: unknown }
    const maxClearance =
      body.maxClearance === 'public' ||
      body.maxClearance === 'internal' ||
      body.maxClearance === 'confidential'
        ? body.maxClearance
        : null
    const dailyCallLimit =
      typeof body.dailyCallLimit === 'number' && Number.isInteger(body.dailyCallLimit) &&
      body.dailyCallLimit >= 0
        ? body.dailyCallLimit
        : undefined
    const result = await grantHomeApp({
      actingUserId: userId,
      appId: String(req.params.appId),
      maxClearance,
      ...(dailyCallLimit !== undefined ? { dailyCallLimit } : {}),
    })
    if (!result.ok) {
      res.status(statusFor(result.reason)).json({ error: result.message })
      return
    }
    notifyWorkspaceChange(result.app.workspaceId, 'workspace_config', 'update')
    res.json({ ok: true, status: result.app.status })
  })

  /**
   * PATCH /api/home-apps/:appId — enable, disable, or revoke consent.
   * Revoking sets `needs_consent`, which CLEARS the grant in the store.
   */
  router.patch('/:appId', opts.requireAuth, async (req, res) => {
    const userId = (req as { userId?: string }).userId
    if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return }
    const status = (req.body as { status?: unknown })?.status
    if (status !== 'active' && status !== 'disabled' && status !== 'needs_consent') {
      res.status(400).json({ error: "status must be 'active', 'disabled', or 'needs_consent'" })
      return
    }
    const result = await setHomeAppStatus({
      actingUserId: userId,
      appId: String(req.params.appId),
      status,
    })
    if (!result.ok) {
      res.status(statusFor(result.reason)).json({ error: result.message })
      return
    }
    notifyWorkspaceChange(result.app.workspaceId, 'workspace_config', 'update')
    res.json({ ok: true, status: result.app.status })
  })

  /** DELETE /api/home-apps/:appId — remove the app and its bundle. */
  router.delete('/:appId', opts.requireAuth, async (req, res) => {
    const userId = (req as { userId?: string }).userId
    if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return }
    const appId = String(req.params.appId)
    const result = await deleteHomeApp({ actingUserId: userId, appId })
    if (!result.ok) {
      res.status(statusFor(result.reason)).json({ error: result.message })
      return
    }
    // Best-effort bundle cleanup. The row is gone either way — a stale blob is
    // storage debt, but a row that survives a "remove" is a live grant the
    // admin believes they revoked.
    void deleteBundle(opts.filesApi, result.app.workspaceId, appId).catch((err) => {
      console.warn('[home-apps] bundle cleanup failed:', err)
    })
    notifyWorkspaceChange(result.app.workspaceId, 'workspace_config', 'update')
    res.json({ ok: true })
  })

  /**
   * GET /api/home-apps/:appId/export — the stored bundle as a zip.
   *
   * Member-gated, not admin-gated: any member's browser already receives every
   * one of these bytes through the bundle route, so export reveals nothing new
   * — it just makes the app portable (C2: the exported bundle + manifest is
   * the unit of sharing). What ships is what is STORED, i.e. exactly what the
   * serving route serves, never a re-fetch from the app's origin.
   */
  router.get('/:appId/export', opts.requireAuth, async (req, res) => {
    const userId = (req as { userId?: string }).userId
    if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return }
    const app = await getHomeApp(String(req.params.appId))
    if (!app) { res.status(404).json({ error: 'App not found' }); return }
    const membership = await getWorkspaceMembershipWithClearanceSystem(userId, app.workspaceId)
    if (!membership) { res.status(403).json({ error: 'Not a member of this workspace' }); return }

    const ctx = { workspaceId: app.workspaceId, userId: '', system: true } as never
    const prefix = `${APPS_PATH_PREFIX}${app.id}/`
    const rows = await opts.filesApi.search(ctx, { parentPath: prefix, limit: 100 })
    if (rows.length === 0) {
      res.status(404).json({ error: 'This app has no stored bundle yet.' })
      return
    }
    const files: Array<{ path: string; bytes: Uint8Array }> = []
    for (const row of rows) {
      const read = await opts.filesApi.readBytes(ctx, row.path)
      if (read.ok) files.push({ path: row.path.slice(prefix.length), bytes: read.value.bytes })
    }

    // ASCII-safe filename — the slug is also the header-injection guard.
    const slug = app.name.replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '') || 'app'
    res.setHeader('Content-Type', 'application/zip')
    res.setHeader('Content-Disposition', `attachment; filename="${slug}.zip"`)
    res.send(await buildBundleZip(files))
  })

  /**
   * GET /api/home-apps/:appId/session — the host page's mount payload.
   *
   * Authenticated + membership-checked. This is the ONLY place a bridge token
   * is minted, and it is minted for the calling viewer: the token carries
   * their `userId`, so per-user KV and any identity claim are bound to whoever
   * actually has the page open, not to whoever installed the app.
   */
  router.get('/:appId/session', opts.requireAuth, async (req, res) => {
    const userId = (req as { userId?: string }).userId
    if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return }

    const app = await getHomeApp(String(req.params.appId))
    if (!app) { res.status(404).json({ error: 'App not found' }); return }

    const membership = await getWorkspaceMembershipWithClearanceSystem(userId, app.workspaceId)
    if (!membership) { res.status(403).json({ error: 'Not a member of this workspace' }); return }

    const manifest = storedManifest(app)
    const renderable = isRenderableHomeApp(app) && manifest !== null

    // A non-renderable app still answers 200 with its state: the frame renders
    // a "needs consent" / "disabled" / "sync error" panel, which is far more
    // useful than a bare error, and an admin reading it is exactly who can fix
    // it. What it does NOT get is a bridge token.
    res.json({
      id: app.id,
      name: app.name,
      description: app.description,
      icon: app.icon,
      status: app.status,
      syncError: app.syncError,
      lastSyncedAt: app.lastSyncedAt,
      renderable,
      requestedScopes: manifest?.scopes ?? null,
      grantedScopes: app.grantedScopes,
      ...(renderable && manifest
        ? {
            entryUrl:
              `/api/home-apps/${encodeURIComponent(app.id)}/bundle/${manifest.entry}` +
              `?t=${encodeURIComponent(mintBundleToken({ appId: app.id, secret: opts.signingSecret }))}`,
            bridgeToken: mintBridgeToken({
              appId: app.id,
              workspaceId: app.workspaceId,
              userId,
              scope: (app.grantedScopes as AppScopes).data,
              maxClearance: app.maxClearance,
              secret: opts.signingSecret,
            }),
            bridgeTokenTtlMs: BRIDGE_TOKEN_TTL_MS,
          }
        : {}),
    })
  })

  /**
   * GET /api/home-apps/:appId/bundle/<path> — the bytes.
   *
   * UNAUTHENTICATED by necessity (the opaque-origin frame sends no
   * credentials) and therefore capability-gated: a valid, unexpired,
   * app-bound `home-app-bundle` signature or nothing. The entry URL carries
   * the token; sub-resources ride relative paths under the same route, so the
   * browser re-sends the query string only for the entry — hence sub-resource
   * requests accept the token from either the query or the Referer's query,
   * and fall back to 401.
   */
  router.get('/:appId/bundle/*', async (req, res) => {
    const appId = String(req.params.appId)
    const token = readBundleToken(req)
    if (!token) { res.status(401).json({ error: 'Missing bundle token' }); return }

    const verified = verifyBundleToken({ token, appId, secret: opts.signingSecret })
    if (!verified.ok) { res.status(401).json({ error: 'Invalid bundle token' }); return }

    // Express puts the `*` wildcard capture at index 0 of `params`.
    const wildcard = (req.params as unknown as Record<string, unknown>)['0']
    const rawPath = typeof wildcard === 'string' ? wildcard : ''
    const contentType = contentTypeFor(rawPath)
    // Pinned from an allowlist, never sniffed: the bytes are third-party, and
    // letting the response type follow the content would let an app choose how
    // the browser interprets its own file.
    if (!contentType) { res.status(404).json({ error: 'Not found' }); return }

    const app = await getHomeApp(appId)
    if (!app || !isRenderableHomeApp(app)) {
      res.status(404).json({ error: 'Not found' })
      return
    }
    const manifest = storedManifest(app)

    const file = await opts.filesApi.readBytes(
      { workspaceId: app.workspaceId, userId: app.createdBy ?? '', system: true } as never,
      bundleStoragePath(appId, rawPath),
    )
    if (!file.ok) { res.status(404).json({ error: 'Not found' }); return }

    res.setHeader('Content-Type', contentType)
    res.setHeader(
      'Content-Security-Policy',
      buildBundleCsp({ apiOrigin: opts.apiOrigin, netOrigins: manifest?.scopes.net }),
    )
    // Belt-and-braces against the one thing the CSP cannot express: a browser
    // that ignores the pinned type and sniffs anyway.
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('X-Frame-Options', 'SAMEORIGIN')
    // Private: the bytes are workspace content behind a short-lived signature.
    res.setHeader('Cache-Control', 'private, max-age=60')
    res.send(file.value.bytes)
  })

  // ── Bridge KV ─────────────────────────────────────────────────────────
  // Authenticated by the BRIDGE token (`aud: 'home-app'`), which carries the
  // viewer. Every call also spends one unit of the app's daily budget, so a
  // runaway app is bounded rather than unbounded.

  async function bridgeAuth(
    req: { params: Record<string, string>; headers: Record<string, unknown> },
  ): Promise<
    | { ok: true; app: HomeAppRow; userId: string }
    | { ok: false; status: number; error: string }
  > {
    const header = req.headers.authorization
    const token =
      typeof header === 'string' && header.startsWith('Bearer ')
        ? header.slice('Bearer '.length)
        : null
    if (!token) return { ok: false, status: 401, error: 'Missing bridge token' }

    const appId = String(req.params.appId)
    const verified = verifyBridgeToken({ token, appId, secret: opts.signingSecret })
    if (!verified.ok) return { ok: false, status: 401, error: 'Invalid bridge token' }

    const app = await getHomeApp(appId)
    // Re-derive from the ROW, never from the token's claim: a grant revoked
    // after the token was minted must stop working immediately, which a
    // self-describing token cannot express.
    if (!app || !isRenderableHomeApp(app)) {
      return { ok: false, status: 403, error: 'App is not active' }
    }
    const budget = await consumeHomeAppBudget(appId)
    if (!budget.allowed) {
      return { ok: false, status: 429, error: 'This app has used its daily budget.' }
    }
    return { ok: true, app, userId: verified.payload.userId }
  }

  router.get('/:appId/state', async (req, res) => {
    const auth = await bridgeAuth(req as never)
    if (!auth.ok) { res.status(auth.status).json({ error: auth.error }); return }
    const scope = req.query.scope === 'workspace' ? 'workspace' : 'user'
    res.json({
      scope,
      data: await getHomeAppState({ appId: auth.app.id, scope, userId: auth.userId }),
    })
  })

  router.put('/:appId/state', async (req, res) => {
    const auth = await bridgeAuth(req as never)
    if (!auth.ok) { res.status(auth.status).json({ error: auth.error }); return }
    const scope = req.query.scope === 'workspace' ? 'workspace' : 'user'
    const result = await putHomeAppState({
      appId: auth.app.id,
      workspaceId: auth.app.workspaceId,
      scope,
      userId: auth.userId,
      data: (req.body as { data?: unknown })?.data ?? {},
    })
    if (!result.ok) { res.status(413).json({ error: result.message }); return }
    res.json({ ok: true, scope })
  })

  return router
}

/**
 * A bundle token from the query string, or from the Referer's query for
 * sub-resources (the browser does not re-append the entry's query to a
 * relative `<script src>`).
 */
function readBundleToken(req: {
  query: Record<string, unknown>
  headers: Record<string, unknown>
}): string | null {
  if (typeof req.query.t === 'string' && req.query.t) return req.query.t
  const referer = req.headers.referer
  if (typeof referer !== 'string') return null
  try {
    return new URL(referer).searchParams.get('t')
  } catch {
    return null
  }
}

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
import type { AppManifest, AppScopes } from '@use-brian/brian-app'
import { contentTypeFor } from '@use-brian/brian-app'
import type { FilesApi } from '@use-brian/core'
import {
  consumeHomeAppBudget,
  deleteHomeApp,
  getHomeApp,
  grantHomeApp,
  setHomeAppStatus,
  getHomeAppState,
  isRenderableHomeApp,
  listHomeApps,
  putHomeAppState,
  type HomeAppRow,
} from '../db/home-apps-store.js'
import { getWorkspaceMembershipWithClearanceSystem } from '../db/workspace-store.js'
import { buildBundleCsp } from '../home-apps/csp.js'
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

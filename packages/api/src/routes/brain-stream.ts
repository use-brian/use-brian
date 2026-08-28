/**
 * Server-Sent Events stream of brain change notifications for a workspace.
 *
 *   GET /api/brain/stream?workspaceId=<uuid>&access_token=<jwt>
 *
 * Auth: this route is mounted WITHOUT `requireAuth` (browser EventSource
 * cannot send custom headers). It accepts `Authorization: Bearer <jwt>`
 * for curl / integration tests and `?access_token=<jwt>` for the
 * browser path — the same pattern as `feed-events-sse.ts`. Workspace
 * membership is verified before the stream opens.
 *
 * Wire format:
 *
 *   event: brain-change
 *   data: { workspaceId, primitive, rowId?, action }
 *
 * Heartbeat: a `: ping` comment every 25s keeps Cloudflare / Vercel /
 * Cloud Run proxies from cutting the idle stream around 30s.
 *
 * Lifetime: every stream is ended CLEANLY by the server after
 * `SSE_MAX_LIFETIME_MS` ±20% jitter (a `: cycle` comment, then `end`). The
 * stream is a signal channel with no replay, so the cycle is lossless —
 * EventSource auto-reconnects (browser default backoff, a few seconds) and
 * the client re-runs catch-up on `open`. The bound exists because the
 * request slot is the scarce resource: a silently-dead socket (closed lid,
 * NAT drop) never fires `close`, and without a lifetime it holds one of
 * the instance's concurrency slots until the platform request timeout
 * reaps it (2026-08-27: enough of those crossed the 30-slot cap and Cloud
 * Run shed every request for 16 minutes). The jitter is load-bearing:
 * tabs restored in the same second would otherwise phase-lock and fire
 * their reconnect + catch-up refetch bursts together, every cycle,
 * forever.
 *
 * The route does NOT replay — payloads are signals, not data, and the
 * web client re-fetches via the existing list / rollup endpoints.
 *
 * Spec: docs/architecture/platform/realtime-sync.md.
 *
 * [COMP:api/brain-stream-sse]
 */
import { Router, type Request, type Response } from 'express'
import type { WorkspaceStore } from '../db/workspace-store.js'
import {
  subscribeToBrainChanges,
  type BrainChangePayload,
} from '../brain-stream/sse-fanout.js'
import { verifyAccessToken } from '../auth/jwt.js'

type BrainStreamRouteOptions = {
  workspaceStore: WorkspaceStore
  /** JWT secret for the SSE route's own auth pass. */
  jwtSecret: string
  /** Test seam. Production always runs the derived defaults below. */
  maxLifetimeMs?: number
  heartbeatMs?: number
}

/**
 * One stream cycle's maximum lifetime (pre-jitter). Derived, not tuned: an
 * order of magnitude under the platform request ceiling it must undercut
 * (Cloud Run `--timeout=1800` — see `invariants/cloud-run-request-timeout`),
 * and far above the few-second browser-default reconnect it costs.
 */
export const SSE_MAX_LIFETIME_MS = 5 * 60_000

const HEARTBEAT_MS = 25_000

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function extractUserId(req: Request, jwtSecret: string): string | null {
  const header = req.headers.authorization
  if (header?.startsWith('Bearer ')) {
    const id = verifyAccessToken(header.slice(7), jwtSecret)
    if (id && UUID_RE.test(id)) return id
  }
  const qToken = req.query.access_token
  if (typeof qToken === 'string' && qToken.length > 0) {
    const id = verifyAccessToken(qToken, jwtSecret)
    if (id && UUID_RE.test(id)) return id
  }
  return null
}

export function brainStreamRoutes(options: BrainStreamRouteOptions): Router {
  const router = Router()
  const maxLifetimeMs = options.maxLifetimeMs ?? SSE_MAX_LIFETIME_MS
  const heartbeatMs = options.heartbeatMs ?? HEARTBEAT_MS

  router.get('/', async (req, res) => {
    const userId = extractUserId(req, options.jwtSecret)
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' })
      return
    }
    const workspaceId = typeof req.query.workspaceId === 'string' ? req.query.workspaceId : null
    if (!workspaceId || !UUID_RE.test(workspaceId)) {
      res.status(400).json({ error: 'workspaceId query param is required' })
      return
    }

    const role = await options.workspaceStore.getRole(userId, workspaceId)
    if (!role) {
      // Same 404 the entity routes return — never confirm a workspace
      // exists to a non-member.
      res.status(404).json({ error: 'Not found' })
      return
    }

    res.status(200)
    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache, no-transform')
    res.setHeader('Connection', 'keep-alive')
    res.setHeader('X-Accel-Buffering', 'no')
    res.flushHeaders?.()
    sendComment(res, 'connected')

    let isOpen = true
    const unsubscribe = subscribeToBrainChanges(workspaceId, (payload) => {
      if (!isOpen) return
      sendEvent(res, payload)
    })

    const heartbeat = setInterval(() => {
      if (!isOpen) return
      try {
        sendComment(res, 'ping')
      } catch {
        cleanup() // socket already torn down
      }
    }, heartbeatMs)

    // ±20% per-connection jitter so streams opened together (session
    // restore) don't cycle — and refetch — in lockstep forever.
    const lifetimeMs = Math.round(maxLifetimeMs * (0.8 + Math.random() * 0.4))
    const maxLifetime = setTimeout(() => {
      // Clean end of one cycle: a live client auto-reconnects and re-runs
      // catch-up on `open`, so nothing is missed; a dead socket stops
      // holding a request slot. See the header comment.
      try {
        sendComment(res, 'cycle')
      } catch {
        // dead socket — cleanup below still releases everything
      }
      cleanup()
    }, lifetimeMs)

    const cleanup = () => {
      if (!isOpen) return
      isOpen = false
      clearInterval(heartbeat)
      clearTimeout(maxLifetime)
      unsubscribe()
      try {
        res.end()
      } catch {
        // socket already closed
      }
    }
    req.on('close', cleanup)
    req.on('aborted', cleanup)
    res.on('error', cleanup)
  })

  return router
}

function sendEvent(res: Response, payload: BrainChangePayload): void {
  res.write(`event: brain-change\n`)
  res.write(`data: ${JSON.stringify(payload)}\n\n`)
}

function sendComment(res: Response, msg: string): void {
  res.write(`: ${msg}\n\n`)
}

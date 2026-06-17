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
 * The route does NOT replay — payloads are signals, not data, and the
 * web client re-fetches via the existing list / rollup endpoints.
 *
 * Spec: docs/architecture/brain/realtime-stream.md.
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
}

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
        // socket already torn down; cleanup will fire from req close
      }
    }, 25_000)

    const cleanup = () => {
      if (!isOpen) return
      isOpen = false
      clearInterval(heartbeat)
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

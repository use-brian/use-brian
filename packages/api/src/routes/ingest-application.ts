import { Router, type Response } from 'express'
import { z } from 'zod'
import type { AccessContext } from '@use-brian/core'
import {
  IngestApplicationServiceError,
  type IngestApplicationService,
} from '../ingest/application-service.js'
import { resolveIngestApplicationAccess } from '../ingest/default-application-service.js'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const retryBody = z.object({
  runId: z.string().uuid(),
  expectedPlanHash: z.string().regex(/^[0-9a-f]{64}$/),
})

export type IngestApplicationRecoveryRouteOptions = {
  application: IngestApplicationService
  resolveAccess?: (
    userId: string,
    workspaceId: string | undefined,
    episodeId?: string,
  ) => Promise<AccessContext>
}

function sendApplicationError(res: Response, error: unknown): void {
  if (error instanceof IngestApplicationServiceError) {
    const status = error.code === 'not_found' ? 404 : error.code === 'forbidden' ? 403 : 409
    res.status(status).json({ error: error.code, message: error.message })
    return
  }
  const code = (error as { code?: unknown })?.code
  if (code === 'not_found' || code === 'context_not_available') {
    res.status(404).json({ error: 'not_found' })
    return
  }
  console.error('[ingest] application recovery failed:', error)
  res.status(500).json({ error: 'application_recovery_failed' })
}

/** Authenticated adapter shared by the OSS and hosted ingest control planes. */
export function createIngestApplicationRecoveryRoutes(
  opts: IngestApplicationRecoveryRouteOptions,
): Router {
  const router = Router()
  const resolveAccess = opts.resolveAccess ?? resolveIngestApplicationAccess

  router.get('/applications', async (req, res) => {
    const userId = req.userId
    if (!userId) return void res.status(401).json({ error: 'Unauthorized' })
    const workspaceId = typeof req.query.workspaceId === 'string' ? req.query.workspaceId : ''
    if (!UUID_RE.test(workspaceId)) return void res.status(400).json({ error: 'workspaceId is required' })
    if (req.query.cursor !== undefined
      && (typeof req.query.cursor !== 'string' || !UUID_RE.test(req.query.cursor))) {
      return void res.status(400).json({ error: 'cursor is invalid' })
    }
    try {
      const access = await resolveAccess(userId, workspaceId)
      res.json(await opts.application.list(access, {
        cursor: typeof req.query.cursor === 'string' ? req.query.cursor : undefined,
      }))
    } catch (error) {
      sendApplicationError(res, error)
    }
  })

  router.get('/episodes/:episodeId/application', async (req, res) => {
    const userId = req.userId
    if (!userId) return void res.status(401).json({ error: 'Unauthorized' })
    const { episodeId } = req.params
    if (!UUID_RE.test(episodeId)) return void res.status(400).json({ error: 'episodeId is required' })
    try {
      const access = await resolveAccess(userId, undefined, episodeId)
      res.json(await opts.application.get(access, episodeId))
    } catch (error) {
      sendApplicationError(res, error)
    }
  })

  router.post('/episodes/:episodeId/retry-application', async (req, res) => {
    const userId = req.userId
    if (!userId) return void res.status(401).json({ error: 'Unauthorized' })
    const { episodeId } = req.params
    const parsed = retryBody.safeParse(req.body)
    if (!UUID_RE.test(episodeId) || !parsed.success) {
      return void res.status(400).json({ error: 'Invalid application retry request' })
    }
    try {
      const access = await resolveAccess(userId, undefined, episodeId)
      res.json(await opts.application.retry({
        ctx: access,
        episodeId,
        runId: parsed.data.runId,
        expectedPlanHash: parsed.data.expectedPlanHash,
      }))
    } catch (error) {
      sendApplicationError(res, error)
    }
  })

  return router
}

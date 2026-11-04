/** Closed native personal transcript presentation. [COMP:api/session-display-history] */
import { Router } from 'express'
import { z } from 'zod'
import { readPrivateSessionDisplay } from '../db/session-display-history.js'
import { WorkspaceAccessError } from '../workspace-access/policy.js'

const query = z.object({ workspaceId: z.string().uuid(),
  afterSequence: z.coerce.number().int().min(0).max(2147483647).default(0),
  limit: z.coerce.number().int().min(1).max(100).default(100) }).strict()

export function sessionDisplayHistoryRoutes(): Router {
  const router = Router({ mergeParams: true })
  router.get<{ id: string }>('/', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    if (!req.userId || !req.authSessionId || req.authVersion === undefined) {
      res.status(401).json({ error: 'authenticated_session_required' }); return
    }
    if (!z.string().uuid().safeParse(req.params.id).success) {
      res.status(404).json({ error: 'display_history_unavailable' }); return
    }
    const parsed = query.safeParse(req.query)
    if (!parsed.success) { res.status(400).json({ error: 'invalid_display_history' }); return }
    try {
      res.json(await readPrivateSessionDisplay({ ...parsed.data, sessionId: String(req.params.id),
        claims: { userId: req.userId, sessionId: req.authSessionId, authVersion: req.authVersion } }))
    } catch (error) {
      if (error instanceof WorkspaceAccessError) { res.status(error.status).json({ error: error.code }); return }
      console.error('Personal transcript display read error:', error)
      res.status(500).json({ error: 'display_history_failed' })
    }
  })
  return router
}

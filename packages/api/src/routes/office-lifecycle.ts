/** Archive/Trash/Retained/purge lifecycle routes. [COMP:api/office-routes] */
import { Router } from 'express'
import { z } from 'zod'
import { changeOfficeLifecycle, type OfficeLifecycleDeps } from '../office/lifecycle.js'

export type OfficeLifecycleRouteDeps = OfficeLifecycleDeps

export function officeLifecycleRoutes(deps: OfficeLifecycleRouteDeps): Router {
  const router = Router()
  router.post('/artifacts/:artifactId/lifecycle', async (req, res) => {
    const userId = (req as { userId?: string }).userId
    if (!userId) return void res.status(401).json({ error: 'Unauthorized' })
    const body = z.object({ action: z.enum(['archive', 'unarchive', 'trash', 'restore', 'purge']), reason: z.string().min(1).max(2_000) }).strict().safeParse(req.body)
    if (!body.success) return void res.status(400).json({ error: 'Invalid Office lifecycle request', issues: body.error.issues })
    const artifactId = String(req.params.artifactId)
    const result = await changeOfficeLifecycle(deps, { userId, artifactId, ...body.data })
    if (result.status !== 200) return void res.status(result.status).json({ error: result.error })
    res.json({ artifact: result.artifact })
  })
  return router
}

/** Archive/Trash/Retained/purge lifecycle routes. [COMP:api/office-routes] */
import { Router } from 'express'
import { z } from 'zod'
import type { ResolvedOfficeAccess } from '../office/access.js'

export type OfficeLifecycleRouteDeps = {
  resolveAccess(userId: string, artifactId: string): Promise<ResolvedOfficeAccess | null>
  transition(params: { userId: string; artifactId: string; action: 'archive' | 'unarchive' | 'trash' | 'restore' | 'purge'; reason: string }): Promise<unknown | null>
  revokeOffline(userId: string, artifactId: string): Promise<void>
}

export function officeLifecycleRoutes(deps: OfficeLifecycleRouteDeps): Router {
  const router = Router()
  router.post('/artifacts/:artifactId/lifecycle', async (req, res) => {
    const userId = (req as { userId?: string }).userId
    if (!userId) return void res.status(401).json({ error: 'Unauthorized' })
    const body = z.object({ action: z.enum(['archive', 'unarchive', 'trash', 'restore', 'purge']), reason: z.string().min(1).max(2_000) }).strict().safeParse(req.body)
    if (!body.success) return void res.status(400).json({ error: 'Invalid Office lifecycle request', issues: body.error.issues })
    const artifactId = String(req.params.artifactId)
    const access = await deps.resolveAccess(userId, artifactId)
    if (!access) return void res.status(404).json({ error: 'Office artifact not found' })
    const permitted = body.data.action === 'purge' ? access.canDeletePermanently : body.data.action === 'restore' || body.data.action === 'unarchive' ? access.canRestore : access.role === 'edit'
    if (!permitted) return void res.status(404).json({ error: 'Office artifact not found' })
    const artifact = await deps.transition({ userId, artifactId, ...body.data })
    if (!artifact) return void res.status(409).json({ error: 'lifecycle_transition_blocked' })
    if (body.data.action === 'archive' || body.data.action === 'trash' || body.data.action === 'purge') await deps.revokeOffline(userId, artifactId)
    res.json({ artifact })
  })
  return router
}

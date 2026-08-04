/** Office template registry endpoints. [COMP:api/office-routes] */
import { Router } from 'express'
import { z } from 'zod'

export type OfficeTemplatesRouteDeps = {
  list(userId: string, workspaceId: string, family?: 'document' | 'presentation'): Promise<unknown[]>
  createDraft(params: { userId: string; workspaceId: string; family: 'document' | 'presentation'; name: string; description: string; sensitivity: 'public' | 'internal' | 'confidential' }): Promise<{ id: string }>
}

export function officeTemplateRoutes(deps: OfficeTemplatesRouteDeps): Router {
  const router = Router()
  router.get('/templates', async (req, res) => {
    const userId = (req as { userId?: string }).userId
    if (!userId) return void res.status(401).json({ error: 'Unauthorized' })
    const workspaceId = z.string().uuid().safeParse(req.query.workspaceId)
    const family = z.enum(['document', 'presentation']).optional().safeParse(req.query.family)
    if (!workspaceId.success || !family.success) return void res.status(400).json({ error: 'Invalid template query' })
    res.json({ templates: await deps.list(userId, workspaceId.data, family.data) })
  })
  router.post('/templates', async (req, res) => {
    const userId = (req as { userId?: string }).userId
    if (!userId) return void res.status(401).json({ error: 'Unauthorized' })
    const body = z.object({ workspaceId: z.string().uuid(), family: z.enum(['document', 'presentation']), name: z.string().min(1).max(255), description: z.string().min(1).max(4_000), sensitivity: z.enum(['public', 'internal', 'confidential']).default('internal') }).strict().safeParse(req.body)
    if (!body.success) return void res.status(400).json({ error: 'Invalid template draft', issues: body.error.issues })
    res.status(201).json(await deps.createDraft({ userId, ...body.data }))
  })
  return router
}

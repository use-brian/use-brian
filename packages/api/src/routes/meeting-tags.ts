/** [COMP:recordings/meeting-tags] Authenticated meeting-tag command routes. */
import { Router } from 'express'
import type { createMeetingTagsService } from '../recordings/meeting-tags-service.js'
import { z } from 'zod'

export function meetingTagRoutes(service: ReturnType<typeof createMeetingTagsService>, getRole: (userId: string, workspaceId: string) => Promise<string | null>): Router {
  const router = Router()
  for (const method of ['get', 'post'] as const) router[method]('/meeting-tags/:pageId', async (req, res) => {
    const userId = (req as typeof req & { userId?: string }).userId
    if (!userId) return void res.status(401).json({ error: 'Unauthorized' })
    const workspaceId = method === 'get' ? req.query.workspaceId : req.body?.workspaceId
    if (typeof workspaceId !== 'string' || !workspaceId) return void res.status(400).json({ error: 'workspaceId is required' })
    if (!(await getRole(userId, workspaceId))) return void res.status(403).json({ error: 'Not a member of this workspace' })
    try {
      const state = method === 'get' ? await service.read(userId, workspaceId, req.params.pageId)
        : await service.command(userId, workspaceId, req.params.pageId, req.body.command)
      res.json({ state })
    } catch (error) {
      res.status(error instanceof z.ZodError ? 400 : 409).json({ error: error instanceof Error ? error.message : 'Meeting tags unavailable' })
    }
  })
  return router
}

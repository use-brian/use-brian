/**
 * Workspace goal-default-budget API.
 *
 * Mounted at `/api/goals/default-budget` before the generic goals router.
 * [COMP:api/goal-default-budget]
 */
import { Router } from 'express'
import { z } from 'zod'
import type { GoalDefaultBudgetStorePort } from '@use-brian/core'
import type { WorkspaceStore } from '../db/workspace-store.js'

const updateBody = z
  .object({
    workspaceId: z.string().min(1),
    maxIterations: z.number().int().positive().max(1000).optional(),
    maxSpend: z.number().positive().optional(),
    reset: z.boolean().optional(),
  })
  .strict()
  .refine(
    (body) => body.reset === true || body.maxIterations !== undefined || body.maxSpend !== undefined,
    { message: 'maxIterations, maxSpend, or reset=true is required' },
  )
  .refine(
    (body) => !(body.reset && (body.maxIterations !== undefined || body.maxSpend !== undefined)),
    { message: 'reset cannot be combined with maxIterations or maxSpend' },
  )

export function goalDefaultBudgetRoutes(opts: {
  workspaceStore: Pick<WorkspaceStore, 'getRole'>
  store: GoalDefaultBudgetStorePort
}): Router {
  const router = Router()

  router.get('/', async (req, res) => {
    const userId = (req as { userId?: string }).userId
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' })
      return
    }
    const workspaceId = typeof req.query.workspaceId === 'string' ? req.query.workspaceId : ''
    if (!workspaceId) {
      res.status(400).json({ error: 'workspaceId query param is required' })
      return
    }
    if (!(await opts.workspaceStore.getRole(userId, workspaceId))) {
      res.status(404).json({ error: 'Not found' })
      return
    }
    res.json(await opts.store.get(workspaceId))
  })

  router.put('/', async (req, res) => {
    const userId = (req as { userId?: string }).userId
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' })
      return
    }
    const parsed = updateBody.safeParse(req.body ?? {})
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_request', issues: parsed.error.issues })
      return
    }
    const { workspaceId, maxIterations, maxSpend, reset } = parsed.data
    if (!(await opts.workspaceStore.getRole(userId, workspaceId))) {
      res.status(404).json({ error: 'Not found' })
      return
    }
    const result = await opts.store.set(userId, workspaceId, {
      maxIterations,
      maxSpend,
      reset,
    })
    if (!result.ok) {
      const status =
        result.reason === 'not_found' ? 404 : result.reason === 'invalid' ? 400 : 403
      res.status(status).json({ error: result.message, reason: result.reason })
      return
    }
    res.json({ ok: true, budget: result.budget, source: result.source })
  })

  return router
}

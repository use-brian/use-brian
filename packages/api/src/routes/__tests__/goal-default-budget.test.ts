import express from 'express'
import { describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import type { GoalDefaultBudgetStorePort } from '@use-brian/core'
import { goalDefaultBudgetRoutes } from '../goal-default-budget.js'

function makeApp(options: {
  userId?: string
  role?: string | null
  store?: Partial<GoalDefaultBudgetStorePort>
}) {
  const workspaceStore = {
    getRole: vi.fn(async () => options.role ?? null),
  }
  const store: GoalDefaultBudgetStorePort = {
    get: vi.fn(async () => ({
      budget: { maxIterations: 30, maxSpend: 5 },
      source: 'built_in' as const,
    })),
    set: vi.fn(async (_userId, _workspaceId, patch) => ({
      ok: true as const,
      budget: {
        maxIterations: patch.maxIterations ?? 30,
        maxSpend: patch.maxSpend ?? 5,
      },
      source: patch.reset ? ('built_in' as const) : ('workspace' as const),
    })),
    ...options.store,
  }
  const app = express()
  app.use(express.json())
  if (options.userId) {
    app.use((req, _res, next) => {
      ;(req as typeof req & { userId: string }).userId = options.userId!
      next()
    })
  }
  app.use('/api/goals/default-budget', goalDefaultBudgetRoutes({
    workspaceStore: workspaceStore as never,
    store,
  }))
  return { app, workspaceStore, store }
}

describe('[COMP:api/goal-default-budget] goal default budget routes', () => {
  it('lets a member read the effective default', async () => {
    const { app, store } = makeApp({ userId: 'user-1', role: 'member' })

    const response = await request(app).get(
      '/api/goals/default-budget?workspaceId=workspace-1',
    )

    expect(response.status).toBe(200)
    expect(response.body).toEqual({
      budget: { maxIterations: 30, maxSpend: 5 },
      source: 'built_in',
    })
    expect(store.get).toHaveBeenCalledWith('workspace-1')
  })

  it('hides the setting from a non-member', async () => {
    const { app, store } = makeApp({ userId: 'user-1', role: null })
    const response = await request(app).get(
      '/api/goals/default-budget?workspaceId=workspace-1',
    )
    expect(response.status).toBe(404)
    expect(store.get).not.toHaveBeenCalled()
  })

  it('updates one field through the authority-checking store', async () => {
    const { app, store } = makeApp({ userId: 'user-1', role: 'admin' })

    const response = await request(app)
      .put('/api/goals/default-budget')
      .send({ workspaceId: 'workspace-1', maxIterations: 16 })

    expect(response.status).toBe(200)
    expect(store.set).toHaveBeenCalledWith('user-1', 'workspace-1', {
      maxIterations: 16,
      maxSpend: undefined,
      reset: undefined,
    })
    expect(response.body).toMatchObject({
      ok: true,
      budget: { maxIterations: 16, maxSpend: 5 },
    })
  })

  it('maps a store role rejection to 403', async () => {
    const { app } = makeApp({
      userId: 'user-1',
      role: 'member',
      store: {
        set: vi.fn(async () => ({
          ok: false as const,
          reason: 'not_admin' as const,
          message: 'Only a workspace owner or admin can change the default goal budget.',
        })),
      },
    })
    const response = await request(app)
      .put('/api/goals/default-budget')
      .send({ workspaceId: 'workspace-1', maxSpend: 8 })
    expect(response.status).toBe(403)
    expect(response.body.reason).toBe('not_admin')
  })

  it('rejects an empty update and reset mixed with values', async () => {
    const { app, store } = makeApp({ userId: 'user-1', role: 'owner' })
    const empty = await request(app)
      .put('/api/goals/default-budget')
      .send({ workspaceId: 'workspace-1' })
    const mixed = await request(app)
      .put('/api/goals/default-budget')
      .send({ workspaceId: 'workspace-1', reset: true, maxSpend: 8 })
    expect(empty.status).toBe(400)
    expect(mixed.status).toBe(400)
    expect(store.set).not.toHaveBeenCalled()
  })
})

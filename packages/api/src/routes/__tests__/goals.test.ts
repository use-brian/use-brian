import { describe, it, expect, vi, beforeEach } from 'vitest'
import request from 'supertest'
import { goalsRoutes, type GoalsRouteOptions } from '../goals.js'
import { createTestApp } from './helpers.js'

// The confirm/work routes use the db helpers directly (not the goalStore port).
vi.mock('../../db/goals.js', () => ({
  getGoalById: vi.fn(),
  getGoalByIdSystem: vi.fn(),
  updateGoalSystem: vi.fn(),
}))
import { getGoalById, updateGoalSystem } from '../../db/goals.js'
const mockGetGoalById = vi.mocked(getGoalById)
const mockUpdateGoalSystem = vi.mocked(updateGoalSystem)

beforeEach(() => vi.clearAllMocks())

function makeApp(opts: {
  userId?: string
  role?: string | null
  goals?: unknown[]
  assessClarity?: GoalsRouteOptions['assessClarity']
}) {
  const goalStore = {
    list: vi.fn().mockResolvedValue(opts.goals ?? []),
    create: vi.fn(),
    getById: vi.fn(),
    getByIdSystem: vi.fn(),
    listByHostSystem: vi.fn(),
    setStatusSystem: vi.fn(),
    countOpenSubGoalsSystem: vi.fn(),
  }
  const workspaceStore = { getRole: vi.fn().mockResolvedValue(opts.role ?? null) }
  const app = createTestApp(
    '/api/goals',
    goalsRoutes({
      goalStore: goalStore as never,
      workspaceStore: workspaceStore as never,
      assessClarity: opts.assessClarity,
    }),
    opts.userId ? { userId: opts.userId } : undefined,
  )
  return { app, goalStore, workspaceStore }
}

const NOW = new Date('2026-06-30T00:00:00.000Z')
const DRAFT_GOAL = {
  id: 'g1',
  workspaceId: 'w1',
  parentGoalId: null,
  recipeId: null,
  host: { type: 'task', id: 't1' },
  outcome: 'grow the business',
  doneWhen: { kind: 'subtasks' },
  means: {},
  budget: {},
  policy: {},
  status: 'active',
  blockerReason: null,
  createdByUserId: 'u1',
  confirmedAt: null,
  createdAt: NOW,
  updatedAt: NOW,
}

describe('[COMP:api/goals-route] GET /api/goals', () => {
  it('401 when unauthenticated', async () => {
    const { app, goalStore } = makeApp({ role: 'member' })
    const res = await request(app).get('/api/goals?workspaceId=w1')
    expect(res.status).toBe(401)
    expect(goalStore.list).not.toHaveBeenCalled()
  })

  it('400 when workspaceId is missing', async () => {
    const { app, goalStore } = makeApp({ userId: 'u1', role: 'member' })
    const res = await request(app).get('/api/goals')
    expect(res.status).toBe(400)
    expect(goalStore.list).not.toHaveBeenCalled()
  })

  it('404 when the user is not a workspace member', async () => {
    const { app, goalStore } = makeApp({ userId: 'stranger', role: null })
    const res = await request(app).get('/api/goals?workspaceId=w1')
    expect(res.status).toBe(404)
    expect(goalStore.list).not.toHaveBeenCalled()
  })

  it('200 returns the workspace goals (projected), RLS-scoped to the user', async () => {
    const now = new Date('2026-06-30T00:00:00.000Z')
    const goalRow = {
      id: 'g1',
      workspaceId: 'w1',
      parentGoalId: null,
      recipeId: null,
      host: { type: 'task', id: 't1' },
      outcome: 'ship it',
      doneWhen: { kind: 'subtasks' },
      means: {},
      budget: {},
      policy: {},
      status: 'active',
      blockerReason: null,
      createdByUserId: 'u1',
      createdAt: now,
      updatedAt: now,
    }
    const { app, goalStore } = makeApp({ userId: 'u1', role: 'member', goals: [goalRow] })
    const res = await request(app).get('/api/goals?workspaceId=w1&status=active')

    expect(res.status).toBe(200)
    expect(goalStore.list).toHaveBeenCalledWith('u1', 'w1', {
      status: 'active',
      hostType: undefined,
      hostId: undefined,
      includeTerminal: false,
    })
    // Projection drops internal fields (budget / policy / createdByUserId) and
    // surfaces `confirmedAt` + `hasWorkflow` for the panel's action choice.
    expect(res.body.goals).toEqual([
      {
        id: 'g1',
        outcome: 'ship it',
        status: 'active',
        host: { type: 'task', id: 't1' },
        parentGoalId: null,
        recipeId: null,
        blockerReason: null,
        confirmedAt: null,
        hasWorkflow: false,
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      },
    ])
  })

  it('ignores an unknown status / hostType filter (resolves to undefined, not a 400)', async () => {
    const { app, goalStore } = makeApp({ userId: 'u1', role: 'member', goals: [] })
    const res = await request(app).get('/api/goals?workspaceId=w1&status=bogus&hostType=nope&includeTerminal=true')

    expect(res.status).toBe(200)
    expect(goalStore.list).toHaveBeenCalledWith('u1', 'w1', {
      status: undefined,
      hostType: undefined,
      hostId: undefined,
      includeTerminal: true,
    })
  })
})

describe('[COMP:api/goals-route] POST /api/goals/:id/confirm — clarity gate (§12)', () => {
  it('blocks an unclear goal and does NOT arm it (returns the clarifying question)', async () => {
    mockGetGoalById.mockResolvedValue(DRAFT_GOAL as never)
    const assessClarity = vi
      .fn()
      .mockResolvedValue({ clear: false, clarifyingQuestion: 'What does done look like?' })
    const { app } = makeApp({ userId: 'u1', role: 'member', assessClarity })

    const res = await request(app).post('/api/goals/g1/confirm').send({})

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: false, needsClarification: true, question: 'What does done look like?' })
    // Assesses the goal's current outcome; never arms.
    expect(assessClarity).toHaveBeenCalledWith({ outcome: 'grow the business', userId: 'u1' })
    expect(mockUpdateGoalSystem).not.toHaveBeenCalled()
  })

  it('arms a clear goal, assessing the refined outcome when one is supplied', async () => {
    mockGetGoalById.mockResolvedValue(DRAFT_GOAL as never)
    mockUpdateGoalSystem.mockResolvedValue({ ...DRAFT_GOAL, confirmedAt: NOW } as never)
    const assessClarity = vi.fn().mockResolvedValue({ clear: true })
    const { app } = makeApp({ userId: 'u1', role: 'member', assessClarity })

    const res = await request(app).post('/api/goals/g1/confirm').send({ outcome: 'Close the Acme deal' })

    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(assessClarity).toHaveBeenCalledWith({ outcome: 'Close the Acme deal', userId: 'u1' })
    expect(mockUpdateGoalSystem).toHaveBeenCalledWith('g1', { confirm: true, outcome: 'Close the Acme deal' })
  })

  it('arms without a clarity check when no assessor is wired (OSS / no provider)', async () => {
    mockGetGoalById.mockResolvedValue(DRAFT_GOAL as never)
    mockUpdateGoalSystem.mockResolvedValue({ ...DRAFT_GOAL, confirmedAt: NOW } as never)
    const { app } = makeApp({ userId: 'u1', role: 'member' }) // no assessClarity

    const res = await request(app).post('/api/goals/g1/confirm').send({})

    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(mockUpdateGoalSystem).toHaveBeenCalledWith('g1', { confirm: true, outcome: undefined })
  })

  it('404 when the goal is absent / the caller is not a member (before any assessment)', async () => {
    mockGetGoalById.mockResolvedValue(null as never)
    const assessClarity = vi.fn()
    const { app } = makeApp({ userId: 'u1', role: 'member', assessClarity })

    const res = await request(app).post('/api/goals/g1/confirm').send({})

    expect(res.status).toBe(404)
    expect(assessClarity).not.toHaveBeenCalled()
    expect(mockUpdateGoalSystem).not.toHaveBeenCalled()
  })
})

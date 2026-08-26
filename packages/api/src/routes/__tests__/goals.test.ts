import { describe, it, expect, vi, beforeEach } from 'vitest'
import request from 'supertest'
import { goalsRoutes, type GoalsRouteOptions } from '../goals.js'
import { createTestApp } from './helpers.js'

// The confirm/work/abandon routes use the db helpers directly (not the goalStore port).
vi.mock('../../db/goals.js', () => ({
  getGoalById: vi.fn(),
  getGoalByIdSystem: vi.fn(),
  narrowGoalContextSystem: vi.fn(),
  updateGoalSystem: vi.fn(),
  setGoalStatusSystem: vi.fn(),
}))
import { getGoalById, narrowGoalContextSystem, updateGoalSystem, setGoalStatusSystem } from '../../db/goals.js'
const mockGetGoalById = vi.mocked(getGoalById)
const mockNarrowGoalContextSystem = vi.mocked(narrowGoalContextSystem)
const mockUpdateGoalSystem = vi.mocked(updateGoalSystem)
const mockSetGoalStatusSystem = vi.mocked(setGoalStatusSystem)

beforeEach(() => vi.clearAllMocks())

function makeApp(opts: {
  userId?: string
  role?: string | null
  goals?: unknown[]
  assessClarity?: GoalsRouteOptions['assessClarity']
  ready?: boolean
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
  const contextStore = {
    getTeamSystem: vi.fn(),
    getProjectSystem: vi.fn(),
    resolveMemberTeamPrincipalSystem: vi.fn().mockResolvedValue({ role: 'member', mode: 'assigned', grant: null }),
  }
  const app = createTestApp(
    '/api/goals',
    goalsRoutes({
      goalStore: goalStore as never,
      workspaceStore: workspaceStore as never,
      assessClarity: opts.assessClarity,
      resolveAssistantId: async () => 'a1',
      contextStore: contextStore as never,
      getReadiness: async () => ({
        enforcementVersion: 1,
        readyForActivation: opts.ready ?? true,
        checks: opts.ready === false
          ? [{ id: 'schema', ready: false, blocking: true, detail: 'missing' }]
          : [],
        legacyGeneral: {},
      } as never),
    }),
    opts.userId ? { userId: opts.userId } : undefined,
  )
  return { app, goalStore, workspaceStore, contextStore }
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
  contextGroupId: null,
  contextProjectId: null,
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
        hostTitle: null,
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

  it('threads the §8 confirmed filter (drafts for triage, confirmed for the board)', async () => {
    const { app, goalStore } = makeApp({ userId: 'u1', role: 'member', goals: [] })
    await request(app).get('/api/goals?workspaceId=w1&confirmed=false')
    expect(goalStore.list).toHaveBeenLastCalledWith(
      'u1',
      'w1',
      expect.objectContaining({ confirmed: false }),
    )
    await request(app).get('/api/goals?workspaceId=w1&confirmed=true')
    expect(goalStore.list).toHaveBeenLastCalledWith(
      'u1',
      'w1',
      expect.objectContaining({ confirmed: true }),
    )
    await request(app).get('/api/goals?workspaceId=w1')
    expect(goalStore.list).toHaveBeenLastCalledWith(
      'u1',
      'w1',
      expect.objectContaining({ confirmed: undefined }),
    )
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
    expect(assessClarity).toHaveBeenCalledWith({ outcome: 'grow the business', userId: 'u1', workspaceId: 'w1', assistantId: 'a1' })
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
    expect(assessClarity).toHaveBeenCalledWith({ outcome: 'Close the Acme deal', userId: 'u1', workspaceId: 'w1', assistantId: 'a1' })
    expect(mockUpdateGoalSystem).toHaveBeenCalledWith('g1', { confirm: true, outcome: 'Close the Acme deal' })
  })

  it('assesses and persists §8 brief edits (verification / approach) alongside the outcome', async () => {
    mockGetGoalById.mockResolvedValue({
      ...DRAFT_GOAL,
      brief: { verification: 'old check', approach: 'old plan', judgeReason: 'fits' },
    } as never)
    mockUpdateGoalSystem.mockResolvedValue({ ...DRAFT_GOAL, confirmedAt: NOW } as never)
    const assessClarity = vi.fn().mockResolvedValue({ clear: true })
    const { app } = makeApp({ userId: 'u1', role: 'member', assessClarity })

    const res = await request(app)
      .post('/api/goals/g1/confirm')
      .send({ verification: 'At least three vendors compared.' })

    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    // The gate reviews the edited configuration (edit merged onto the brief).
    expect(assessClarity).toHaveBeenCalledWith({
      outcome: 'grow the business',
      verification: 'At least three vendors compared.',
      approach: 'old plan',
      userId: 'u1',
      workspaceId: 'w1',
      assistantId: 'a1',
    })
    expect(mockUpdateGoalSystem).toHaveBeenCalledWith('g1', {
      confirm: true,
      outcome: undefined,
      brief: { verification: 'At least three vendors compared.', approach: 'old plan', judgeReason: 'fits' },
    })
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

describe('[COMP:api/goals-route] POST /api/goals/:id/outcome — inline edit', () => {
  it('401 when unauthenticated (never reads or writes the goal)', async () => {
    const { app } = makeApp({ role: 'member' })
    const res = await request(app).post('/api/goals/g1/outcome').send({ outcome: 'x' })
    expect(res.status).toBe(401)
    expect(mockGetGoalById).not.toHaveBeenCalled()
    expect(mockUpdateGoalSystem).not.toHaveBeenCalled()
  })

  it('404 when the goal is absent / the caller is not a member (RLS-scoped)', async () => {
    mockGetGoalById.mockResolvedValue(null as never)
    const { app } = makeApp({ userId: 'stranger', role: null })
    const res = await request(app).post('/api/goals/g1/outcome').send({ outcome: 'x' })
    expect(res.status).toBe(404)
    expect(mockUpdateGoalSystem).not.toHaveBeenCalled()
  })

  it('400 when outcome is missing or blank (never writes)', async () => {
    mockGetGoalById.mockResolvedValue(DRAFT_GOAL as never)
    const { app } = makeApp({ userId: 'u1', role: 'member' })
    const res = await request(app).post('/api/goals/g1/outcome').send({ outcome: '   ' })
    expect(res.status).toBe(400)
    expect(mockUpdateGoalSystem).not.toHaveBeenCalled()
  })

  it('409 refuses to edit a completed goal (a verified success is immutable)', async () => {
    mockGetGoalById.mockResolvedValue({ ...DRAFT_GOAL, status: 'done', confirmedAt: NOW } as never)
    const { app } = makeApp({ userId: 'u1', role: 'member' })
    const res = await request(app).post('/api/goals/g1/outcome').send({ outcome: 'rewrite history' })
    expect(res.status).toBe(409)
    expect(mockUpdateGoalSystem).not.toHaveBeenCalled()
  })

  it('updates the outcome (trimmed) without confirming a draft', async () => {
    mockGetGoalById.mockResolvedValue(DRAFT_GOAL as never)
    mockUpdateGoalSystem.mockResolvedValue({ ...DRAFT_GOAL, outcome: 'Close the Acme deal' } as never)
    const { app } = makeApp({ userId: 'u1', role: 'member' })

    const res = await request(app).post('/api/goals/g1/outcome').send({ outcome: '  Close the Acme deal  ' })

    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(res.body.goal.outcome).toBe('Close the Acme deal')
    // The draft stays a draft — no `confirm` rides the write.
    expect(mockUpdateGoalSystem).toHaveBeenCalledWith('g1', { outcome: 'Close the Acme deal' })
  })
})

describe('[COMP:workflow/context-scope] PUT /api/goals/:id/context — narrowing only', () => {
  const TEAM_ID = '11111111-1111-4111-8111-111111111111'
  const PROJECT_ID = '22222222-2222-4222-8222-222222222222'

  it('binds previously unset Team and Project axes after validating current authority', async () => {
    mockGetGoalById.mockResolvedValue(DRAFT_GOAL as never)
    mockNarrowGoalContextSystem.mockResolvedValue({
      ...DRAFT_GOAL,
      contextGroupId: TEAM_ID,
      contextProjectId: PROJECT_ID,
    } as never)
    const { app, contextStore } = makeApp({ userId: 'u1', role: 'member' })
    contextStore.getTeamSystem.mockResolvedValue({
      id: TEAM_ID,
      status: 'active',
      compartmentKey: `team:${TEAM_ID}`,
    })
    contextStore.getProjectSystem.mockResolvedValue({ id: PROJECT_ID, status: 'active' })

    const res = await request(app).put('/api/goals/g1/context').send({
      contextGroupId: TEAM_ID,
      contextProjectId: PROJECT_ID,
    })

    expect(res.status).toBe(200)
    expect(mockNarrowGoalContextSystem).toHaveBeenCalledWith('g1', TEAM_ID, PROJECT_ID)
    expect(res.body.goal).toMatchObject({
      contextGroupId: TEAM_ID,
      contextProjectId: PROJECT_ID,
    })
  })

  it('rejects clearing or switching an existing binding before store writes', async () => {
    mockGetGoalById.mockResolvedValue({ ...DRAFT_GOAL, contextGroupId: TEAM_ID } as never)
    const { app } = makeApp({ userId: 'u1', role: 'member' })

    const res = await request(app).put('/api/goals/g1/context').send({
      contextGroupId: null,
      contextProjectId: null,
    })

    expect(res.status).toBe(409)
    expect(res.body.error).toBe('goal_context_cannot_widen')
    expect(mockNarrowGoalContextSystem).not.toHaveBeenCalled()
  })

  it('rejects a Team outside the caller effective flat grant', async () => {
    mockGetGoalById.mockResolvedValue(DRAFT_GOAL as never)
    const { app, contextStore } = makeApp({ userId: 'u1', role: 'member' })
    contextStore.getTeamSystem.mockResolvedValue({
      id: TEAM_ID,
      status: 'active',
      compartmentKey: `team:${TEAM_ID}`,
    })
    contextStore.resolveMemberTeamPrincipalSystem.mockResolvedValue({
      role: 'member', mode: 'assigned', grant: [],
    })

    const res = await request(app).put('/api/goals/g1/context').send({
      contextGroupId: TEAM_ID,
      contextProjectId: null,
    })

    expect(res.status).toBe(404)
    expect(res.body.error).toBe('context_not_available')
    expect(mockNarrowGoalContextSystem).not.toHaveBeenCalled()
  })

  it('keeps strict binding disabled while readiness is red', async () => {
    mockGetGoalById.mockResolvedValue(DRAFT_GOAL as never)
    const { app, contextStore } = makeApp({ userId: 'u1', role: 'member', ready: false })
    contextStore.getProjectSystem.mockResolvedValue({ id: PROJECT_ID, status: 'active' })

    const res = await request(app).put('/api/goals/g1/context').send({
      contextGroupId: null,
      contextProjectId: PROJECT_ID,
    })

    expect(res.status).toBe(409)
    expect(res.body).toMatchObject({ error: 'context_activation_blocked' })
    expect(mockNarrowGoalContextSystem).not.toHaveBeenCalled()
  })
})

describe('[COMP:api/goals-route] POST /api/goals/:id/abandon — discard', () => {
  it('401 when unauthenticated (never reads or writes the goal)', async () => {
    const { app } = makeApp({ role: 'member' })
    const res = await request(app).post('/api/goals/g1/abandon').send({})
    expect(res.status).toBe(401)
    expect(mockGetGoalById).not.toHaveBeenCalled()
    expect(mockSetGoalStatusSystem).not.toHaveBeenCalled()
  })

  it('404 when the goal is absent / the caller is not a member (RLS-scoped)', async () => {
    mockGetGoalById.mockResolvedValue(null as never)
    const { app } = makeApp({ userId: 'stranger', role: null })
    const res = await request(app).post('/api/goals/g1/abandon').send({})
    expect(res.status).toBe(404)
    expect(mockGetGoalById).toHaveBeenCalledWith('stranger', 'g1')
    expect(mockSetGoalStatusSystem).not.toHaveBeenCalled()
  })

  it('discards a draft: sets status=abandoned and returns the projected goal', async () => {
    mockGetGoalById.mockResolvedValue(DRAFT_GOAL as never)
    mockSetGoalStatusSystem.mockResolvedValue({ ...DRAFT_GOAL, status: 'abandoned' } as never)
    const { app } = makeApp({ userId: 'u1', role: 'member' })

    const res = await request(app).post('/api/goals/g1/abandon').send({})

    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(res.body.goal.status).toBe('abandoned')
    expect(mockSetGoalStatusSystem).toHaveBeenCalledWith('g1', 'abandoned')
  })

  it('409 refuses to discard a completed goal (never writes)', async () => {
    mockGetGoalById.mockResolvedValue({ ...DRAFT_GOAL, status: 'done', confirmedAt: NOW } as never)
    const { app } = makeApp({ userId: 'u1', role: 'member' })

    const res = await request(app).post('/api/goals/g1/abandon').send({})

    expect(res.status).toBe(409)
    expect(mockSetGoalStatusSystem).not.toHaveBeenCalled()
  })
})

describe('[COMP:api/goals-route] GET /api/goals/:id — drill-down detail', () => {
  // A confirmed, armed goal carrying the full acceptance contract + a verified
  // completion claim — exercises every field the detail projection adds.
  const DETAIL_GOAL = {
    ...DRAFT_GOAL,
    confirmedAt: NOW,
    means: { workflowId: 'wf1' },
    budget: { maxSpend: 50, maxIterations: 5 },
    policy: { approval: 'ask' },
    doneWhen: { kind: 'query', query: { description: 'task complete', predicate: { hostTaskDone: true } } },
    completionClaim: { because: 'all sub-tasks closed', verifiedAt: '2026-06-30T12:00:00.000Z' },
  }

  it('401 when unauthenticated (never reads the goal)', async () => {
    const { app } = makeApp({ role: 'member' })
    const res = await request(app).get('/api/goals/g1')
    expect(res.status).toBe(401)
    expect(mockGetGoalById).not.toHaveBeenCalled()
  })

  it('404 when the goal is absent / the caller is not a member (RLS-scoped read)', async () => {
    mockGetGoalById.mockResolvedValue(null as never)
    const { app } = makeApp({ userId: 'stranger', role: null })
    const res = await request(app).get('/api/goals/g1')
    expect(res.status).toBe(404)
    expect(mockGetGoalById).toHaveBeenCalledWith('stranger', 'g1')
  })

  it('200 returns the richer projection (acceptance contract + budget/policy/means + completion claim)', async () => {
    mockGetGoalById.mockResolvedValue(DETAIL_GOAL as never)
    const { app } = makeApp({ userId: 'u1', role: 'member' })
    const res = await request(app).get('/api/goals/g1')

    expect(res.status).toBe(200)
    expect(mockGetGoalById).toHaveBeenCalledWith('u1', 'g1')
    // Board fields (confirmedAt/hasWorkflow) plus the detail-only fields, with
    // Dates ISO-stamped and internal columns (workspaceId/createdByUserId) dropped.
    expect(res.body.goal).toEqual({
      id: 'g1',
      outcome: 'grow the business',
      status: 'active',
      host: { type: 'task', id: 't1' },
      hostTitle: null,
      parentGoalId: null,
      recipeId: null,
      blockerReason: null,
      contextGroupId: null,
      contextProjectId: null,
      confirmedAt: NOW.toISOString(),
      hasWorkflow: true,
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
      doneWhen: { kind: 'query', query: { description: 'task complete', predicate: { hostTaskDone: true } } },
      means: { workflowId: 'wf1' },
      budget: { maxSpend: 50, maxIterations: 5 },
      policy: { approval: 'ask' },
      completionClaim: { because: 'all sub-tasks closed', verifiedAt: '2026-06-30T12:00:00.000Z' },
    })
  })
})

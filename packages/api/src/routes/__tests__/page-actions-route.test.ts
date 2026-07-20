import { describe, it, expect, vi, beforeEach } from 'vitest'
import request from 'supertest'
import { createTestApp } from './helpers.js'

import { pageActionsRoutes, type PageActionsRouteOptions } from '../page-actions.js'
import type {
  ExecutorDeps,
  PageAction,
  WorkflowDefinition,
  WorkflowRecord,
  WorkflowRunRecord,
  WorkflowStepRunRecord,
} from '@use-brian/core'

const WS = '00000000-0000-0000-0000-000000000001'
const USER = '00000000-0000-0000-0000-000000000002'
const PAGE = '00000000-0000-0000-0000-00000000aaaa'
const ACTION = '00000000-0000-0000-0000-00000000bbbb'
const WORKFLOW = '00000000-0000-0000-0000-00000000cccc'

// A definition that completes deterministically — no consult, no tools.
const BRANCH_ONLY: WorkflowDefinition = {
  startStepId: 's1',
  steps: [
    { id: 's1', type: 'branch', condition: { '==': [1, 1] }, nextStepIdIfTrue: null, nextStepIdIfFalse: null },
  ],
}

function makeWorkflow(overrides?: Partial<WorkflowRecord>): WorkflowRecord {
  const now = new Date()
  return {
    id: WORKFLOW,
    workspaceId: WS,
    createdBy: USER,
    name: 'Send outreach email',
    description: null,
    definition: BRANCH_ONLY,
    enabled: true,
    pausedReason: null,
    trigger: { kind: 'manual' },
    webhookSlug: null,
    webhookSecret: null,
    modelAlias: 'pro',
    maxTurns: null,
    researchMode: false,
    nameManuallySet: false,
    lifecycleState: 'active',
    lifecycleTransitionedAt: null,
    lifecycleReason: null,
    pinned: false,
    digestedAt: null,
    digestVerdict: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }
}

function makeBinding(overrides?: Partial<PageAction>): PageAction {
  return {
    id: ACTION,
    workspaceId: WS,
    blueprintId: '00000000-0000-0000-0000-00000000dddd',
    pageId: null,
    label: 'Send',
    icon: null,
    confirmCopy: null,
    action: { kind: 'workflow', workflowId: WORKFLOW },
    enabled: true,
    position: 0,
    createdBy: USER,
    createdAt: '2026-07-11T00:00:00Z',
    updatedAt: '2026-07-11T00:00:00Z',
    ...overrides,
  }
}

function makeHarness(opts?: {
  binding?: PageAction | null
  workflow?: WorkflowRecord | null
  goalStore?: boolean
}) {
  const workflow = opts?.workflow === null ? null : (opts?.workflow ?? makeWorkflow())
  const binding = opts?.binding === null ? null : (opts?.binding ?? makeBinding())

  const runs = new Map<string, WorkflowRunRecord>()
  const stepRuns: WorkflowStepRunRecord[] = []
  let nextRun = 1
  let nextStep = 1

  const runStore = {
    async createRun(params: {
      workflowId: string
      workspaceId: string
      triggeredBy: string | null
      triggerKind: WorkflowRunRecord['triggerKind']
      input: Record<string, unknown>
    }) {
      const now = new Date()
      const run: WorkflowRunRecord = {
        id: `00000000-0000-0000-0000-${String(nextRun++).padStart(12, '0')}`,
        workflowId: params.workflowId,
        workspaceId: params.workspaceId,
        triggeredBy: params.triggeredBy,
        triggerKind: params.triggerKind,
        status: 'pending',
        input: params.input,
        vars: {},
        currentStepId: null,
        error: null,
        outcome: null,
        startedAt: now,
        finishedAt: null,
        lastActiveAt: now,
      }
      runs.set(run.id, run)
      return run
    },
    async getRunSystem(id: string) {
      return runs.get(id) ?? null
    },
    async getLatestOutcomeForWorkflowSystem() {
      return null
    },
    async updateRun(id: string, fields: Partial<WorkflowRunRecord>) {
      const existing = runs.get(id)
      if (!existing) return null
      const updated = { ...existing, ...fields, lastActiveAt: new Date() }
      runs.set(id, updated)
      return updated
    },
    async createStepRun(params: {
      runId: string
      stepId: string
      stepType: WorkflowStepRunRecord['stepType']
      input: Record<string, unknown>
    }) {
      const stepRun: WorkflowStepRunRecord = {
        id: `00000000-0000-0000-0000-${String(nextStep++).padStart(12, '0')}`,
        runId: params.runId,
        stepId: params.stepId,
        stepType: params.stepType,
        status: 'running',
        input: params.input,
        output: null,
        error: null,
        startedAt: new Date(),
        finishedAt: null,
      }
      stepRuns.push(stepRun)
      return stepRun
    },
    async updateStepRun(id: string, fields: Partial<WorkflowStepRunRecord>) {
      const idx = stepRuns.findIndex((s) => s.id === id)
      if (idx === -1) return null
      stepRuns[idx] = { ...stepRuns[idx], ...fields }
      return stepRuns[idx]
    },
    async listStepRuns(_userId: string, runId: string) {
      return stepRuns.filter((s) => s.runId === runId)
    },
  }

  const workflowStore = {
    getById: vi.fn(async (_u: string, id: string) => (workflow && workflow.id === id ? workflow : null)),
    findByIdSystem: vi.fn(async (id: string) => (workflow && workflow.id === id ? workflow : null)),
  }

  const executorDeps = {
    workflowStore,
    runStore,
    consultTransport: {
      async consult() {
        throw new Error('route tests must never consult')
      },
    },
    resolvePrimary: async () => USER,
    buildToolRegistry: async () => new Map(),
  } as unknown as ExecutorDeps

  const pageActionsStore = {
    create: vi.fn(async (_u: string, input: Record<string, unknown>) => makeBinding(input as never)),
    getById: vi.fn(async () => binding),
    listForBlueprint: vi.fn(async () => (binding ? [binding] : [])),
    resolveForPage: vi.fn(async () => (binding ? [binding] : [])),
    listForWorkflow: vi.fn(async () => (binding ? [binding] : [])),
    update: vi.fn(async () => binding),
    delete: vi.fn(async () => true),
  }

  const goalStore = {
    create: vi.fn(async (params: { workspaceId: string; outcome: string }) => ({
      id: '00000000-0000-0000-0000-00000000eeee',
      workspaceId: params.workspaceId,
      outcome: params.outcome,
    })),
  }

  const options: PageActionsRouteOptions = {
    pageActionsStore: pageActionsStore as never,
    workspaceStore: { getRole: vi.fn(async () => 'member') } as never,
    savedViewStore: {
      getById: vi.fn(async (_u: string, id: string) =>
        id === PAGE ? { id: PAGE, workspaceId: WS, name: 'Acme draft', clearance: 'internal' } : null,
      ),
    } as never,
    pageTemplateStore: {
      getById: vi.fn(async (_u: string, id: string) => ({ id, workspaceId: WS })),
    } as never,
    workflowStore: workflowStore as never,
    runStore: runStore as never,
    executorDeps,
    ...(opts?.goalStore === false ? {} : { goalStore: goalStore as never }),
  }

  const app = createTestApp('/api', pageActionsRoutes(options), { userId: USER })
  return { app, pageActionsStore, goalStore, runs, workflowStore }
}

beforeEach(() => vi.clearAllMocks())

describe('[COMP:api/page-actions-route] page-action routes', () => {
  it('invoke (workflow kind) creates a BUTTON run with page-event-shaped input and advances inline', async () => {
    const h = makeHarness()
    const res = await request(h.app).post(`/api/pages/${PAGE}/actions/${ACTION}/invoke`)
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ kind: 'workflow', workflowId: WORKFLOW, status: 'completed' })

    const run = [...h.runs.values()][0]
    expect(run.triggerKind).toBe('button')
    expect(run.input).toMatchObject({
      trigger: { sourceType: 'page', kind: 'button', actionId: ACTION, pageId: PAGE, actorId: USER },
      event: { pageId: PAGE, action: 'button', title: 'Acme draft' },
    })
    expect(run.status).toBe('completed')
  })

  it('refuses an action that does not resolve for the page', async () => {
    const h = makeHarness({ binding: null })
    const res = await request(h.app).post(`/api/pages/${PAGE}/actions/${ACTION}/invoke`)
    expect(res.status).toBe(404)
  })

  it('refuses a disabled bound workflow', async () => {
    const h = makeHarness({ workflow: makeWorkflow({ enabled: false }) })
    const res = await request(h.app).post(`/api/pages/${PAGE}/actions/${ACTION}/invoke`)
    expect(res.status).toBe(400)
    expect(String(res.body.error)).toContain('disabled')
  })

  it('invoke (goal kind) creates a page-hosted goal through GoalStore.create', async () => {
    const h = makeHarness({
      binding: makeBinding({ action: { kind: 'goal', outcome: 'Close the Acme deal' } }),
    })
    const res = await request(h.app).post(`/api/pages/${PAGE}/actions/${ACTION}/invoke`)
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ kind: 'goal', outcome: 'Close the Acme deal' })
    expect(h.goalStore.create).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: WS,
        host: { type: 'page', id: PAGE },
        doneWhen: { kind: 'subtasks' },
        createdByUserId: USER,
      }),
    )
  })

  it('501s a goal action when no goal store is wired', async () => {
    const h = makeHarness({
      binding: makeBinding({ action: { kind: 'goal' } }),
      goalStore: false,
    })
    const res = await request(h.app).post(`/api/pages/${PAGE}/actions/${ACTION}/invoke`)
    expect(res.status).toBe(501)
  })

  it('create validates the workflow action against the workspace', async () => {
    const h = makeHarness({ workflow: null })
    const res = await request(h.app)
      .post('/api/page-actions')
      .send({
        workspaceId: WS,
        scope: { blueprintId: '00000000-0000-0000-0000-00000000dddd' },
        label: 'Send',
        action: { kind: 'workflow', workflowId: WORKFLOW },
      })
    expect(res.status).toBe(400)
    expect(String(res.body.error)).toContain('workflowId')
  })

  it('resolves a page: GET /pages/:pageId/actions returns enabled bindings', async () => {
    const h = makeHarness()
    const res = await request(h.app).get(`/api/pages/${PAGE}/actions`)
    expect(res.status).toBe(200)
    expect(res.body.actions).toHaveLength(1)
    expect(res.body.actions[0]).toMatchObject({ id: ACTION, label: 'Send' })
  })
})

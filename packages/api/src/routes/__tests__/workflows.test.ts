/**
 * Unit tests for the workflow REST CRUD routes.
 * Component tag: [COMP:api/workflows-route].
 *
 * Mocks the core workflow schemas + advanceWorkflowRun (the schema
 * files are owned by an in-flight migration, so the route is tested
 * against stubbed parsers). Mounts workflowsRoutes() with injected
 * mock stores. Verifies the auth + workspace-membership gates, list /
 * get / create (incl. bad-definition 400) / delete + audit emit, and
 * the manual-run path's outcome → status mapping.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import request from 'supertest'
import { createTestApp } from './helpers.js'

const mockDefParse = vi.fn()
const mockTriggerParse = vi.fn()
const mockAdvance = vi.fn()

vi.mock('@use-brian/core', async (io) => ({
  ...(await io<typeof import('@use-brian/core')>()),
  WorkflowDefinitionSchema: { safeParse: (...a: unknown[]) => mockDefParse(...a) },
  WorkflowTriggerSchema: { safeParse: (...a: unknown[]) => mockTriggerParse(...a) },
  advanceWorkflowRun: (...a: unknown[]) => mockAdvance(...a),
}))

import { workflowsRoutes } from '../workflows.js'

const WS = '11111111-1111-1111-1111-111111111111'
const workflowStore = { list: vi.fn(), getById: vi.fn(), create: vi.fn(), delete: vi.fn(), update: vi.fn() }
const runStore = {
  createRun: vi.fn(),
  listStepRuns: vi.fn(),
  listRunsForWorkflow: vi.fn(),
  listRunsForPage: vi.fn(),
  getRunById: vi.fn(),
}
const workspaceStore = { getRole: vi.fn() }
const emitAudit = vi.fn()
const jobStore = {
  listTriggerJobsForWorkflowSystem: vi.fn().mockResolvedValue([]),
  create: vi.fn().mockResolvedValue({ id: 'job-1' }),
  update: vi.fn().mockResolvedValue({ id: 'job-1' }),
  delete: vi.fn().mockResolvedValue(true),
}
const resolvePrimary = vi.fn().mockResolvedValue('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')

function app(userId?: string, extra?: Record<string, unknown>) {
  return createTestApp(
    '/api',
    workflowsRoutes({
      workflowStore: workflowStore as never,
      runStore: runStore as never,
      workspaceStore: workspaceStore as never,
      executorDeps: {} as never,
      emitAudit,
      ...extra,
    }),
    userId ? { userId } : undefined,
  )
}

function wf(over: Record<string, unknown> = {}) {
  return {
    id: 'wf-1',
    workspaceId: WS,
    createdBy: 'u-1',
    name: 'My Workflow',
    description: null,
    definition: { steps: [] },
    enabled: true,
    trigger: { kind: 'manual' },
    webhookSlug: null,
    webhookSecret: null,
    createdAt: new Date('2026-05-16T00:00:00Z'),
    updatedAt: new Date('2026-05-16T00:00:00Z'),
    ...over,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  runStore.listStepRuns.mockResolvedValue([])
})

describe('[COMP:api/workflows-route] GET /workflows', () => {
  it('rejects an unauthenticated request with 401', async () => {
    expect((await request(app()).get('/api/workflows?workspaceId=' + WS)).status).toBe(401)
  })

  it('requires a workspaceId query param', async () => {
    expect((await request(app('u-1')).get('/api/workflows')).status).toBe(400)
  })

  it('rejects a non-member of the workspace with 403', async () => {
    workspaceStore.getRole.mockResolvedValueOnce(null)
    expect((await request(app('u-1')).get('/api/workflows?workspaceId=' + WS)).status).toBe(403)
  })

  it('lists workflow summaries for a member', async () => {
    workspaceStore.getRole.mockResolvedValueOnce('member')
    workflowStore.list.mockResolvedValueOnce([wf()])
    const res = await request(app('u-1')).get('/api/workflows?workspaceId=' + WS)
    expect(res.status).toBe(200)
    expect(res.body.workflows[0]).toMatchObject({ id: 'wf-1', stepCount: 0 })
  })
})

describe('[COMP:api/workflows-route] GET / POST /workflows', () => {
  it('GET /workflows/:id returns 404 for an unknown workflow', async () => {
    workflowStore.getById.mockResolvedValueOnce(null)
    expect((await request(app('u-1')).get('/api/workflows/ghost')).status).toBe(404)
  })

  it('POST /workflows rejects a body that fails the create schema', async () => {
    const res = await request(app('u-1')).post('/api/workflows').send({ name: 'No workspace' })
    expect(res.status).toBe(400)
  })

  it('POST /workflows rejects an invalid workflow definition', async () => {
    workspaceStore.getRole.mockResolvedValueOnce('admin')
    mockDefParse.mockReturnValueOnce({
      success: false,
      error: { issues: [{ path: ['steps'], message: 'required' }] },
    })
    const res = await request(app('u-1'))
      .post('/api/workflows')
      .send({ workspaceId: WS, name: 'WF', definition: {} })
    expect(res.status).toBe(400)
  })

  it('POST /workflows creates a workflow and emits a workflow.created audit event', async () => {
    workspaceStore.getRole.mockResolvedValueOnce('admin')
    mockDefParse.mockReturnValueOnce({ success: true, data: { steps: [] } })
    workflowStore.create.mockResolvedValueOnce(wf())
    const res = await request(app('u-1'))
      .post('/api/workflows')
      .send({ workspaceId: WS, name: 'My Workflow', definition: { steps: [] } })
    expect(res.status).toBe(201)
    expect(emitAudit).toHaveBeenCalledWith(expect.objectContaining({ type: 'workflow.created' }))
  })

  it('POST /workflows returns a non-blocking research-mode advisory in warnings[] (incident 2026-07-08 run 12abd640)', async () => {
    workspaceStore.getRole.mockResolvedValueOnce('admin')
    mockDefParse.mockReturnValueOnce({
      success: true,
      data: { steps: [{ id: 'find_merchants', type: 'assistant_call', researchMode: true }] },
    })
    workflowStore.create.mockResolvedValueOnce(wf())
    const res = await request(app('u-1'))
      .post('/api/workflows')
      .send({ workspaceId: WS, name: 'Discovery', definition: { steps: [] } })
    // Save still succeeds — the advisory is non-blocking, unlike a hard `issues` reject.
    expect(res.status).toBe(201)
    expect(res.body.warnings).toHaveLength(1)
    expect(res.body.warnings[0].message).toMatch(/research mode/i)
    expect(res.body.warnings[0].path).toEqual(['definition', 'steps', 0])
  })

  it('POST /workflows omits warnings[] when no step is in research mode', async () => {
    workspaceStore.getRole.mockResolvedValueOnce('admin')
    mockDefParse.mockReturnValueOnce({
      success: true,
      data: { steps: [{ id: 's1', type: 'assistant_call', researchMode: false }] },
    })
    workflowStore.create.mockResolvedValueOnce(wf())
    const res = await request(app('u-1'))
      .post('/api/workflows')
      .send({ workspaceId: WS, name: 'Plain', definition: { steps: [] } })
    expect(res.status).toBe(201)
    expect(res.body.warnings).toBeUndefined()
  })
})

describe('[COMP:api/workflows-route] delete / run', () => {
  it('DELETE /workflows/:id removes the workflow and emits an audit event', async () => {
    workflowStore.getById.mockResolvedValueOnce(wf())
    workflowStore.delete.mockResolvedValueOnce(true)
    const res = await request(app('u-1')).delete('/api/workflows/wf-1')
    expect(res.status).toBe(204)
    expect(emitAudit).toHaveBeenCalledWith(expect.objectContaining({ type: 'workflow.deleted' }))
  })

  it('POST /workflows/:id/run refuses to run a disabled workflow', async () => {
    workflowStore.getById.mockResolvedValueOnce(wf({ enabled: false }))
    const res = await request(app('u-1')).post('/api/workflows/wf-1/run').send({})
    expect(res.status).toBe(400)
    expect(res.body.error).toContain('disabled')
  })

  it('POST /workflows/:id/run starts a run and maps the completed outcome', async () => {
    workflowStore.getById.mockResolvedValueOnce(wf())
    runStore.createRun.mockResolvedValueOnce({ id: 'run-1' })
    mockAdvance.mockResolvedValueOnce({ kind: 'completed', runId: 'run-1', finalOutput: { ok: 1 } })
    const res = await request(app('u-1')).post('/api/workflows/wf-1/run').send({})
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ runId: 'run-1', status: 'completed' })
  })

  it('GET /workflows/:id/runs/:runId 404s when the run is on another workflow', async () => {
    runStore.getRunById.mockResolvedValueOnce({ id: 'run-1', workflowId: 'other-wf' })
    expect((await request(app('u-1')).get('/api/workflows/wf-1/runs/run-1')).status).toBe(404)
  })
})

describe('[COMP:api/workflows-route] schedule trigger → backing scheduled_jobs row', () => {
  const scheduleTrigger = {
    kind: 'schedule',
    schedule: { type: 'daily', time: '09:00' },
    timezone: 'UTC',
  }

  it('PATCH with trigger.kind=schedule creates the firing job (closes the never-fires gap)', async () => {
    workspaceStore.getRole.mockResolvedValue('admin')
    workflowStore.getById.mockResolvedValueOnce(wf())
    mockTriggerParse.mockReturnValueOnce({ success: true, data: scheduleTrigger })
    workflowStore.update.mockResolvedValueOnce(wf({ trigger: scheduleTrigger }))
    jobStore.listTriggerJobsForWorkflowSystem.mockResolvedValueOnce([])

    const res = await request(app('u-1', { jobStore, resolvePrimary }))
      .patch('/api/workflows/wf-1')
      .send({ trigger: scheduleTrigger })

    expect(res.status).toBe(200)
    expect(jobStore.create).toHaveBeenCalledTimes(1)
    expect(jobStore.create).toHaveBeenCalledWith(
      expect.objectContaining({ workflowId: 'wf-1', channelType: 'workflow', channelId: 'wf-1' }),
    )
  })

  it('PATCH moving the trigger OFF schedule clears the backing job', async () => {
    workspaceStore.getRole.mockResolvedValue('admin')
    workflowStore.getById.mockResolvedValueOnce(wf({ trigger: scheduleTrigger }))
    mockTriggerParse.mockReturnValueOnce({ success: true, data: { kind: 'manual' } })
    workflowStore.update.mockResolvedValueOnce(wf({ trigger: { kind: 'manual' } }))
    jobStore.listTriggerJobsForWorkflowSystem.mockResolvedValueOnce([{ id: 'job-1' }])

    const res = await request(app('u-1', { jobStore, resolvePrimary }))
      .patch('/api/workflows/wf-1')
      .send({ trigger: { kind: 'manual' } })

    expect(res.status).toBe(200)
    expect(jobStore.delete).toHaveBeenCalledWith('job-1')
    expect(jobStore.create).not.toHaveBeenCalled()
  })

  it('DELETE clears any backing scheduled-trigger job', async () => {
    workflowStore.getById.mockResolvedValueOnce(wf({ trigger: scheduleTrigger }))
    workflowStore.delete.mockResolvedValueOnce(true)
    jobStore.listTriggerJobsForWorkflowSystem.mockResolvedValueOnce([{ id: 'job-1' }])

    const res = await request(app('u-1', { jobStore, resolvePrimary })).delete('/api/workflows/wf-1')
    expect(res.status).toBe(204)
    expect(jobStore.delete).toHaveBeenCalledWith('job-1')
  })
})

describe('[COMP:api/workflows-route] GET /pages/:pageId/workflow-runs', () => {
  const PAGE = '22222222-2222-2222-2222-222222222222'

  it('rejects an unauthenticated request with 401', async () => {
    expect(
      (await request(app()).get(`/api/pages/${PAGE}/workflow-runs`)).status,
    ).toBe(401)
  })

  it('rejects a non-uuid pageId with 400', async () => {
    const res = await request(app('u-1')).get('/api/pages/not-a-uuid/workflow-runs')
    expect(res.status).toBe(400)
    expect(runStore.listRunsForPage).not.toHaveBeenCalled()
  })

  it('returns the lightweight run shape for a member', async () => {
    runStore.listRunsForPage.mockResolvedValueOnce([
      {
        runId: 'run-1',
        workflowId: 'wf-1',
        workflowName: 'Triage inbox',
        status: 'completed',
        startedAt: new Date('2026-06-29T00:00:00Z'),
        finishedAt: new Date('2026-06-29T00:01:00Z'),
        outcomeSummary: 'Filed under Q3.',
      },
    ])

    const res = await request(app('u-1')).get(`/api/pages/${PAGE}/workflow-runs`)
    expect(res.status).toBe(200)
    expect(runStore.listRunsForPage).toHaveBeenCalledWith('u-1', PAGE, { limit: 20 })
    expect(res.body.runs).toEqual([
      {
        runId: 'run-1',
        workflowId: 'wf-1',
        workflowName: 'Triage inbox',
        status: 'completed',
        startedAt: '2026-06-29T00:00:00.000Z',
        finishedAt: '2026-06-29T00:01:00.000Z',
        outcomeSummary: 'Filed under Q3.',
      },
    ])
  })

  it('passes a clamped limit through to the store', async () => {
    runStore.listRunsForPage.mockResolvedValueOnce([])
    await request(app('u-1')).get(`/api/pages/${PAGE}/workflow-runs?limit=999`)
    expect(runStore.listRunsForPage).toHaveBeenCalledWith('u-1', PAGE, { limit: 100 })
  })
})

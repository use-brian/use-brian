/**
 * Unit tests for the workflow + workflow-run stores.
 * Component tag: [COMP:api/workflow-store].
 *
 * Mocks `query` / `queryWithRLS`. Verifies createDbWorkflowStore (the
 * definition CRUD, the dynamic update + no-field re-read, the
 * enabled-only webhook-slug system lookup, the null-trigger → manual
 * default) and createDbWorkflowRunStore (system run writes vs RLS reads,
 * the last_active_at-only updateRun short-circuit, the step-run CRUD,
 * and the listRunsForWorkflow limit clamp + status filter).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../client.js', () => ({
  query: vi.fn(),
  queryWithRLS: vi.fn(),
}))

import {
  createDbWorkflowStore,
  createDbWorkflowRunStore,
  findEventTriggeredWorkflowsSystem,
  getWorkflowCreatorSystem,
} from '../workflow-store.js'
import { query, queryWithRLS } from '../client.js'

const mockQuery = vi.mocked(query)
const mockRls = vi.mocked(queryWithRLS)
const wf = createDbWorkflowStore()
const runs = createDbWorkflowRunStore()

function workflowRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'wf-1',
    workspaceId: 'ws-1',
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

function runRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'run-1',
    workflowId: 'wf-1',
    workspaceId: 'ws-1',
    triggeredBy: 'u-1',
    triggerKind: 'manual',
    status: 'running',
    input: {},
    vars: {},
    currentStepId: null,
    error: null,
    startedAt: new Date('2026-05-16T00:00:00Z'),
    finishedAt: null,
    lastActiveAt: new Date('2026-05-16T00:00:00Z'),
    ...over,
  }
}

function stepRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'sr-1',
    runId: 'run-1',
    stepId: 'step-a',
    stepType: 'tool_call',
    status: 'running',
    input: {},
    output: null,
    error: null,
    startedAt: new Date('2026-05-16T00:00:00Z'),
    finishedAt: null,
    ...over,
  }
}

beforeEach(() => {
  mockQuery.mockReset()
  mockRls.mockReset()
})

describe('[COMP:api/workflow-store] createDbWorkflowStore', () => {
  it('create inserts with the definition JSON-encoded', async () => {
    mockRls.mockResolvedValueOnce({ rows: [workflowRow()], rowCount: 1 } as never)
    const out = await wf.create({
      userId: 'u-1',
      workspaceId: 'ws-1',
      name: 'My Workflow',
      definition: { steps: [] },
    } as unknown as Parameters<typeof wf.create>[0])
    expect(out.id).toBe('wf-1')
    const [userId, sql, params] = mockRls.mock.calls[0]
    expect(userId).toBe('u-1')
    expect(sql).toContain('INSERT INTO workflows')
    expect(params?.[4]).toBe(JSON.stringify({ steps: [] }))
  })

  it('getById maps the row, defaulting a null trigger to manual', async () => {
    mockRls.mockResolvedValueOnce({ rows: [workflowRow({ trigger: null })], rowCount: 1 } as never)
    const out = await wf.getById('u-1', 'wf-1')
    expect(out?.trigger).toEqual({ kind: 'manual' })
  })

  it('list orders by most-recently-updated', async () => {
    mockRls.mockResolvedValueOnce({ rows: [workflowRow()], rowCount: 1 } as never)
    await wf.list('u-1', 'ws-1')
    expect(mockRls.mock.calls[0][1]).toContain('ORDER BY updated_at DESC')
  })

  it('update builds a dynamic SET for the supplied fields', async () => {
    mockRls.mockResolvedValueOnce({ rows: [workflowRow({ name: 'Renamed' })], rowCount: 1 } as never)
    const out = await wf.update('u-1', 'wf-1', { name: 'Renamed', enabled: false } as Parameters<typeof wf.update>[2])
    expect(out?.name).toBe('Renamed')
    const [, sql] = mockRls.mock.calls[0]
    expect(sql).toContain('UPDATE workflows SET')
    expect(sql).toContain('name = $1')
    expect(sql).toContain('enabled = $2')
  })

  it('update re-reads the current row when no fields are supplied', async () => {
    mockRls.mockResolvedValueOnce({ rows: [workflowRow()], rowCount: 1 } as never)
    await wf.update('u-1', 'wf-1', {} as Parameters<typeof wf.update>[2])
    expect(mockRls.mock.calls[0][1]).not.toContain('UPDATE')
  })

  it('delete reports whether a row was removed', async () => {
    mockRls.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never)
    expect(await wf.delete('u-1', 'wf-1')).toBe(true)
    mockRls.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
    expect(await wf.delete('u-1', 'ghost')).toBe(false)
  })

  it('findByWebhookSlugSystem resolves an enabled workflow without RLS', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [workflowRow()], rowCount: 1 } as never)
    expect((await wf.findByWebhookSlugSystem('hook-abc'))?.id).toBe('wf-1')
    expect(mockQuery.mock.calls[0][0]).toContain('enabled = true')
  })

  it('findByIdSystem resolves a workflow by id without RLS (used by the scheduled-trigger executor)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [workflowRow()], rowCount: 1 } as never)
    expect((await wf.findByIdSystem('wf-1'))?.id).toBe('wf-1')
    // System-bypass — must use the bare query helper, not queryWithRLS.
    expect(mockQuery).toHaveBeenCalledTimes(1)
    expect(mockRls).not.toHaveBeenCalled()
  })

  it('updateAutoName writes only when name_manually_set is false (mig 202)', async () => {
    mockRls.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never)
    expect(await wf.updateAutoName('u-1', 'wf-1', 'Renamed')).toBe(true)
    const [, sql] = mockRls.mock.calls[0]
    expect(sql).toContain('UPDATE workflows')
    expect(sql).toContain('name = $2')
    expect(sql).toContain('name_manually_set = false')

    // Same shape returns false when no row matched (user-renamed, so RLS
    // WHERE filter rejected the write).
    mockRls.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
    expect(await wf.updateAutoName('u-1', 'wf-1', 'Renamed')).toBe(false)
  })
})

describe('[COMP:api/workflow-store] createDbWorkflowRunStore', () => {
  it('createRun inserts the run system-level (no RLS)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [runRow()], rowCount: 1 } as never)
    const out = await runs.createRun({
      workflowId: 'wf-1',
      workspaceId: 'ws-1',
      triggeredBy: 'u-1',
      triggerKind: 'manual',
      input: { a: 1 },
    } as Parameters<typeof runs.createRun>[0])
    expect(out.id).toBe('run-1')
    expect(mockQuery.mock.calls[0][0]).toContain('INSERT INTO workflow_runs')
  })

  it('getRunById is RLS-scoped while getRunSystem bypasses RLS', async () => {
    mockRls.mockResolvedValueOnce({ rows: [runRow()], rowCount: 1 } as never)
    expect((await runs.getRunById('u-1', 'run-1'))?.id).toBe('run-1')
    mockQuery.mockResolvedValueOnce({ rows: [runRow()], rowCount: 1 } as never)
    expect((await runs.getRunSystem('run-1'))?.id).toBe('run-1')
  })

  it('updateRun short-circuits to a read when only last_active_at would change', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [runRow()], rowCount: 1 } as never)
    await runs.updateRun('run-1', {} as Parameters<typeof runs.updateRun>[1])
    expect(mockQuery.mock.calls[0][0]).not.toContain('UPDATE')
  })

  it('updateRun writes the supplied fields plus last_active_at', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [runRow({ status: 'completed' })], rowCount: 1 } as never)
    const out = await runs.updateRun('run-1', { status: 'completed' } as Parameters<typeof runs.updateRun>[1])
    expect(out?.status).toBe('completed')
    const [sql] = mockQuery.mock.calls[0]
    expect(sql).toContain('UPDATE workflow_runs')
    expect(sql).toContain('last_active_at = now()')
  })

  it('createStepRun inserts a running step run', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [stepRow()], rowCount: 1 } as never)
    const out = await runs.createStepRun({
      runId: 'run-1',
      stepId: 'step-a',
      stepType: 'tool_call',
      input: {},
    } as Parameters<typeof runs.createStepRun>[0])
    expect(out.status).toBe('running')
    expect(mockQuery.mock.calls[0][0]).toContain("'running'")
  })

  it('updateStepRun re-reads when no fields are supplied', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [stepRow()], rowCount: 1 } as never)
    await runs.updateStepRun('sr-1', {} as Parameters<typeof runs.updateStepRun>[1])
    expect(mockQuery.mock.calls[0][0]).not.toContain('UPDATE')
  })

  it('listStepRuns reads RLS-scoped, ordered by start time', async () => {
    mockRls.mockResolvedValueOnce({ rows: [stepRow()], rowCount: 1 } as never)
    await runs.listStepRuns('u-1', 'run-1')
    expect(mockRls.mock.calls[0][1]).toContain('ORDER BY started_at')
  })

  it('listRunsForWorkflow clamps the limit to 200 and applies the status filter', async () => {
    mockRls.mockResolvedValueOnce({ rows: [runRow()], rowCount: 1 } as never)
    await runs.listRunsForWorkflow('u-1', 'wf-1', { limit: 9999, status: ['running', 'failed'] })
    const [, sql, values] = mockRls.mock.calls[0]
    expect(sql).toContain('status = ANY($2::text[])')
    expect(values).toEqual(['wf-1', ['running', 'failed'], 200])
  })
})

describe('[COMP:api/workflow-store] event-trigger helpers', () => {
  it('findEventTriggeredWorkflowsSystem reads every enabled event-trigger workflow in a workspace, no RLS', async () => {
    const sources = [
      { source: { type: 'channel', channelIntegrationId: 'cint-1', channel: 'slack' } },
    ]
    mockQuery.mockResolvedValueOnce({
      rows: [{ workflowId: 'wf-1', workspaceId: 'ws-1', sources }],
      rowCount: 1,
    } as never)
    const out = await findEventTriggeredWorkflowsSystem('ws-1')
    expect(out).toEqual([{ workflowId: 'wf-1', workspaceId: 'ws-1', sources }])
    const [sql, params] = mockQuery.mock.calls[0]
    expect(sql).toContain("trigger->>'kind' = 'event'")
    expect(sql).toContain("trigger->'event'->'sources'")
    expect(sql).toContain('enabled = true')
    expect(params).toEqual(['ws-1'])
  })

  it('findEventTriggeredWorkflowsSystem defaults a null sources column to an empty list', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ workflowId: 'wf-1', workspaceId: 'ws-1', sources: null }],
      rowCount: 1,
    } as never)
    const out = await findEventTriggeredWorkflowsSystem('ws-1')
    expect(out).toEqual([{ workflowId: 'wf-1', workspaceId: 'ws-1', sources: [] }])
  })

  it('getWorkflowCreatorSystem returns the creator, or null when the workflow is unknown', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ createdBy: 'u-9' }], rowCount: 1 } as never)
    expect(await getWorkflowCreatorSystem('wf-1')).toBe('u-9')
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
    expect(await getWorkflowCreatorSystem('ghost')).toBe(null)
  })
})

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
  extractTriggerPageId,
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

  it('createRun stamps trigger_page_id from a page-source run input (mig 282)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [runRow()], rowCount: 1 } as never)
    await runs.createRun({
      workflowId: 'wf-1',
      workspaceId: 'ws-1',
      triggeredBy: null,
      triggerKind: 'manual',
      input: {
        trigger: { sourceType: 'page', pageId: 'watched-page', channelId: 'created', actorId: 'u-1' },
        event: { pageId: 'changed-page', action: 'created' },
      },
    } as Parameters<typeof runs.createRun>[0])
    const [sql, values] = mockQuery.mock.calls[0]
    expect(sql).toContain('trigger_page_id')
    // The CHANGED page (input.event.pageId), not the watched page.
    expect((values as unknown[])[5]).toBe('changed-page')
  })

  it('createRun leaves trigger_page_id null for a non-page run input', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [runRow()], rowCount: 1 } as never)
    await runs.createRun({
      workflowId: 'wf-1',
      workspaceId: 'ws-1',
      triggeredBy: 'u-1',
      triggerKind: 'manual',
      input: { trigger: { sourceType: 'channel' }, event: { pageId: 'x' } },
    } as Parameters<typeof runs.createRun>[0])
    expect((mockQuery.mock.calls[0][1] as unknown[])[5]).toBeNull()
  })

  it('createWebhookRun inserts with a workflow-scoped idempotency key and body digest', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [runRow()], rowCount: 1 } as never)
    const out = await runs.createWebhookRun!({
      workflowId: 'wf-1',
      workspaceId: 'ws-1',
      triggeredBy: 'u-1',
      triggerKind: 'manual',
      input: { event: 'signup' },
      idempotencyKey: 'user.signed_up:u-1',
      bodySha256: 'a'.repeat(64),
    })

    expect(out).toMatchObject({ kind: 'created', run: { id: 'run-1' } })
    const [sql, values] = mockQuery.mock.calls[0]
    expect(sql).toContain('ON CONFLICT (workflow_id, webhook_idempotency_key)')
    expect(values).toEqual(expect.arrayContaining(['user.signed_up:u-1', 'a'.repeat(64)]))
  })

  it('createWebhookRun returns duplicate only when the existing raw-body digest matches', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
      .mockResolvedValueOnce({
        rows: [runRow({ webhookBodySha256: 'a'.repeat(64) })],
        rowCount: 1,
      } as never)

    const duplicate = await runs.createWebhookRun!({
      workflowId: 'wf-1',
      workspaceId: 'ws-1',
      triggeredBy: 'u-1',
      triggerKind: 'manual',
      input: {},
      idempotencyKey: 'event-1',
      bodySha256: 'a'.repeat(64),
    })
    expect(duplicate).toMatchObject({ kind: 'duplicate', run: { id: 'run-1' } })

    mockQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
      .mockResolvedValueOnce({
        rows: [runRow({ webhookBodySha256: 'b'.repeat(64) })],
        rowCount: 1,
      } as never)
    const conflict = await runs.createWebhookRun!({
      workflowId: 'wf-1',
      workspaceId: 'ws-1',
      triggeredBy: 'u-1',
      triggerKind: 'manual',
      input: {},
      idempotencyKey: 'event-1',
      bodySha256: 'a'.repeat(64),
    })
    expect(conflict).toEqual({ kind: 'conflict' })
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

  // use-brian#278 — the prefix lookup backing getWorkflowRun's short-id
  // resolution. RLS-scoped, anchored, bounded: the three non-negotiable
  // properties from the issue.
  it('resolveRunsByIdPrefix reads through queryWithRLS, never the system query path', async () => {
    mockRls.mockResolvedValueOnce({ rows: [runRow()], rowCount: 1 } as never)
    await runs.resolveRunsByIdPrefix('u-1', '090aa843')
    expect(mockRls).toHaveBeenCalledTimes(1)
    expect(mockQuery).not.toHaveBeenCalled()
    expect(mockRls.mock.calls[0][0]).toBe('u-1')
  })

  it('resolveRunsByIdPrefix anchors the match to the start of id, parameterised (not a substring, not string-concatenated)', async () => {
    mockRls.mockResolvedValueOnce({ rows: [runRow()], rowCount: 1 } as never)
    await runs.resolveRunsByIdPrefix('u-1', '090aa843')
    const [, sql, values] = mockRls.mock.calls[0]
    expect(sql).toContain("id::text LIKE $1 || '%'")
    expect(sql).not.toContain('090aa843')
    expect((values as unknown[])[0]).toBe('090aa843')
  })

  it('resolveRunsByIdPrefix caps the result with a LIMIT', async () => {
    mockRls.mockResolvedValueOnce({ rows: [runRow()], rowCount: 1 } as never)
    await runs.resolveRunsByIdPrefix('u-1', '090aa843')
    const [, sql, values] = mockRls.mock.calls[0]
    expect(sql).toMatch(/LIMIT \$2/)
    expect(typeof (values as unknown[])[1]).toBe('number')
    expect((values as unknown[])[1]).toBeGreaterThan(0)
  })

  it('resolveRunsByIdPrefix orders most-recent-first', async () => {
    mockRls.mockResolvedValueOnce({ rows: [runRow()], rowCount: 1 } as never)
    await runs.resolveRunsByIdPrefix('u-1', '090aa843')
    const [, sql] = mockRls.mock.calls[0]
    expect(sql).toContain('ORDER BY started_at DESC')
  })

  it('listRunsForPage joins workflows, clamps the limit, and maps outcome.summary (mig 282)', async () => {
    mockRls.mockResolvedValueOnce({
      rows: [
        {
          runId: 'run-1',
          workflowId: 'wf-1',
          workflowName: 'Triage',
          status: 'completed',
          startedAt: new Date('2026-06-29T00:00:00Z'),
          finishedAt: new Date('2026-06-29T00:01:00Z'),
          outcome: { summary: 'done', status: 'completed' },
        },
        {
          runId: 'run-2',
          workflowId: 'wf-2',
          workflowName: 'Notify',
          status: 'running',
          startedAt: new Date('2026-06-29T00:02:00Z'),
          finishedAt: null,
          outcome: null,
        },
      ],
      rowCount: 2,
    } as never)
    const out = await runs.listRunsForPage('u-1', 'page-1', { limit: 9999 })
    const [, sql, values] = mockRls.mock.calls[0]
    expect(sql).toContain('JOIN workflows w ON w.id = r.workflow_id')
    expect(sql).toContain('WHERE r.trigger_page_id = $1')
    expect(sql).toContain('ORDER BY r.started_at DESC')
    expect(values).toEqual(['page-1', 100])
    expect(out[0].outcomeSummary).toBe('done')
    expect(out[1].outcomeSummary).toBeNull()
  })

  it('updateRun writes the JSON-encoded outcome when supplied (mig 279)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [runRow({ status: 'completed' })], rowCount: 1 } as never)
    await runs.updateRun('run-1', {
      status: 'completed',
      outcome: { status: 'completed', summary: 'done', logs: [], blockers: [], todo: [], state: {}, finishedAt: '2026-06-22T00:00:00Z' },
    } as Parameters<typeof runs.updateRun>[1])
    const [sql, values] = mockQuery.mock.calls[0] as [string, unknown[]]
    expect(sql).toContain('outcome = $')
    // outcome is JSON-stringified, not passed as a raw object.
    expect(values.some((v) => typeof v === 'string' && v.includes('"summary":"done"'))).toBe(true)
  })

  it('getLatestOutcomeForWorkflowSystem reads the latest TERMINAL run, excluding the current one, no RLS (mig 279)', async () => {
    const outcome = { status: 'completed', summary: 's', logs: [], blockers: [], todo: [], state: {}, finishedAt: '2026-06-22T00:00:00Z' }
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'run-prior', outcome }], rowCount: 1 } as never)
    // No blueprint record for that run → the plain outcome comes back.
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
    const got = await runs.getLatestOutcomeForWorkflowSystem('wf-1', 'run-current')
    const [sql, values] = mockQuery.mock.calls[0] as [string, unknown[]]
    expect(sql).toContain("status IN ('completed', 'failed', 'timeout')")
    expect(sql).toContain('id <> $2')
    expect(sql).toContain('ORDER BY finished_at DESC NULLS LAST, started_at DESC')
    expect(values).toEqual(['wf-1', 'run-current'])
    expect(got).toEqual(outcome)
  })

  it("getLatestOutcomeForWorkflowSystem enriches lastRun with the run's blueprint-record output", async () => {
    const outcome = { status: 'completed', summary: 's', logs: [], blockers: [], todo: [], state: {}, finishedAt: '2026-06-22T00:00:00Z' }
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'run-prior', outcome }], rowCount: 1 } as never)
    mockQuery.mockResolvedValueOnce({
      rows: [{ fields: { summary: 'typed', budget: 12 }, status: 'complete' }],
      rowCount: 1,
    } as never)
    const got = await runs.getLatestOutcomeForWorkflowSystem('wf-1', 'run-current')
    // The record query joins on the PRIOR run's id — this is what
    // `{{lastRun.output.<key>}}` resolves from. Both run-stamped producers
    // match: direct saves ('workflow') and the research-synthesis arm
    // ('research', whose sourceRef is the runId on workflow-origin fills).
    const [recSql, recValues] = mockQuery.mock.calls[1] as [string, unknown[]]
    expect(recSql).toContain("source_kind IN ('workflow', 'research') AND source_id = $1")
    expect(recValues).toEqual(['run-prior'])
    expect(got).toMatchObject({
      summary: 's',
      output: { summary: 'typed', budget: 12 },
      outputStatus: 'complete',
    })
  })

  it('getLatestOutcomeForWorkflowSystem returns null when there is no prior terminal run', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
    expect(await runs.getLatestOutcomeForWorkflowSystem('wf-1', 'run-current')).toBeNull()
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

describe('[COMP:api/workflow-store] extractTriggerPageId', () => {
  it('returns the changed page for a page-source input', () => {
    expect(
      extractTriggerPageId({
        trigger: { sourceType: 'page', pageId: 'watched' },
        event: { pageId: 'changed' },
      }),
    ).toBe('changed')
  })

  it('returns null for a non-page source, a missing event page, or undefined input', () => {
    expect(extractTriggerPageId({ trigger: { sourceType: 'connector' }, event: { pageId: 'x' } })).toBeNull()
    expect(extractTriggerPageId({ trigger: { sourceType: 'page' }, event: {} })).toBeNull()
    expect(extractTriggerPageId(undefined)).toBeNull()
  })
})

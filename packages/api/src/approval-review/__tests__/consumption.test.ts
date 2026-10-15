/**
 * Consumers honor delegated authority (A10): the workflow continuation uses
 * the original executor and its actual kind, never the primary fallback, and
 * stops before the effect when revalidation fails; a staged write is never
 * applied on a delegated decision; the browser poll reports a delegated
 * approval only while its receipt validates. The receipt check itself runs
 * against real PostgreSQL in resolution.integration.test.ts; here the
 * consumers are driven with in-memory fakes.
 */
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import type { ToolContext } from '@use-brian/core'

vi.mock('../../db/client.js', () => ({
  query: vi.fn(async () => ({ rows: [{ kind: 'standard' }] })),
  getPool: vi.fn(), queryWithRLS: vi.fn(),
}))
const consume = vi.fn()
vi.mock('../consumption.js', () => ({ consumeDelegatedReceipt: (...a: unknown[]) => consume(...a) }))

const { continueDelegatedWorkflowApproval } = await import('../../workflow/approval.js')
const { applyStagedWrite } = await import('../../agent-surface/staged-write.js')
const { readBrowserSendApprovalStatus } = await import('../../db/pending-approvals-store.js')
type PendingApproval = import('../../db/pending-approvals-store.js').PendingApproval

const WS = '00000000-0000-4000-8000-000000000001'
const EXECUTOR = '00000000-0000-4000-8000-000000000002'
const PRIMARY = '00000000-0000-4000-8000-000000000003'
const DELEGATOR = '00000000-0000-4000-8000-000000000004'

const approval = (over: Partial<PendingApproval> = {}): PendingApproval => ({
  id: 'ap-1', workspaceId: WS, workflowRunId: 'run-1', workflowStepRunId: 'sr-1', toolName: 'slackPostMessage',
  arguments: { channel: '#fictional', text: 'Fictional digest' }, approverUserId: DELEGATOR, deliveryChannelType: 'web',
  deliveryChannelId: null, status: 'approved', expiresAt: null, respondedAt: new Date(), respondedBy: null, rejectReason: null,
  createdAt: new Date(), kind: 'workflow_step', blockingSessionId: null, approvalPayload: {}, originatingAssistantId: EXECUTOR,
  answerText: null, resolutionOrigin: 'delegated_assistant', ...over,
})

function deps() {
  const calls: ToolContext[] = []
  const stepUpdates: Array<Record<string, unknown>> = []
  const audits: Array<Record<string, unknown>> = []
  const run = { id: 'run-1', workflowId: 'wf-1', workspaceId: WS, triggeredBy: DELEGATOR, status: 'awaiting_input', currentStepId: 'send', vars: {}, startedAt: new Date() }
  const tool = { name: 'slackPostMessage', inputSchema: z.object({}).passthrough(), execute: vi.fn(async (_i: unknown, ctx: ToolContext) => { calls.push(ctx); return { data: { ok: true } } }) }
  const d = {
    approvalsStore: {} as never,
    auditStore: { append: vi.fn(async (a: Record<string, unknown>) => { audits.push(a) }) },
    workflowStore: { getById: vi.fn(async () => ({ id: 'wf-1', createdBy: DELEGATOR, definition: { startStepId: 'send', steps: [{ id: 'send', type: 'tool_call' }] } })) },
    runStore: {
      getRunSystem: vi.fn(async () => run),
      updateStepRun: vi.fn(async (_id: string, f: Record<string, unknown>) => { stepUpdates.push(f) }),
      updateRun: vi.fn(async () => run),
    },
    buildToolRegistry: vi.fn(async () => new Map([['slackPostMessage', tool]])),
    resolvePrimary: vi.fn(async () => PRIMARY),
    deliveries: async () => {},
    executorDeps: {},
  }
  return { d: d as never as Parameters<typeof continueDelegatedWorkflowApproval>[0], raw: d, calls, stepUpdates, audits, tool }
}

describe('[COMP:api/approval-review-consumption] delegated consumers', () => {
  it('runs the gated tool with the original executor and its own kind, never resolving the primary', async () => {
    const t = deps()
    const r = await continueDelegatedWorkflowApproval(t.d, approval(), DELEGATOR, async () => ({ ok: true }))
    expect(r).toEqual({ status: 'completed', runId: 'run-1' })
    expect(t.calls).toHaveLength(1)
    expect(t.calls[0]).toMatchObject({ assistantId: EXECUTOR, assistantKind: 'standard', userId: DELEGATOR })
    expect(t.raw.resolvePrimary).not.toHaveBeenCalled()
    expect(t.audits[0]).toMatchObject({ actorUserId: null, details: { origin: 'delegated_assistant' } })
  })

  it('fails attributably without an original executor instead of borrowing the primary', async () => {
    const t = deps()
    const r = await continueDelegatedWorkflowApproval(t.d, approval({ originatingAssistantId: null }), DELEGATOR, async () => ({ ok: true }))
    expect(r.status).toBe('failed')
    expect(t.stepUpdates[0]).toMatchObject({ status: 'failed', error: { reason: 'delegated_executor_missing' } })
    expect(t.calls).toHaveLength(0)
    expect(t.raw.resolvePrimary).not.toHaveBeenCalled()
  })

  it('stops before the effect when current delegated authority no longer holds', async () => {
    const t = deps()
    const r = await continueDelegatedWorkflowApproval(t.d, approval(), DELEGATOR, async () => ({ ok: false, reason: 'assignment_revoked' }))
    expect(r.status).toBe('failed')
    expect(t.tool.execute).not.toHaveBeenCalled()
    expect(t.stepUpdates[0]).toMatchObject({ error: { reason: 'delegated_authority_lost' } })
  })

  it('refuses anything that is not a delegated approval (no bare approved-status execution)', async () => {
    const t = deps()
    expect(await continueDelegatedWorkflowApproval(t.d, approval({ resolutionOrigin: 'human' }), DELEGATOR, async () => ({ ok: true })))
      .toMatchObject({ status: 'unavailable' })
    expect(await continueDelegatedWorkflowApproval(t.d, approval({ status: 'pending', resolutionOrigin: null }), DELEGATOR, async () => ({ ok: true })))
      .toMatchObject({ status: 'unavailable' })
    expect(t.raw.buildToolRegistry).not.toHaveBeenCalled()
  })

  it('never applies a staged write on a delegated decision', async () => {
    const execute = vi.fn()
    const out = await applyStagedWrite({ rawWrites: new Map([['updateAssistant', { inputSchema: z.object({}), execute } as never]]) },
      approval({ kind: 'staged_write', toolName: 'updateAssistant' }), DELEGATOR)
    expect(out).toEqual({ ok: false, error: 'delegated_staged_write_unsupported' })
    expect(execute).not.toHaveBeenCalled()
  })

  it('reports a delegated browser send as approved only while its receipt validates', async () => {
    const row = approval({ kind: 'browser_skill_send', workflowRunId: null as never, workflowStepRunId: null as never })
    const store = { getByIdSystem: vi.fn(async () => row), getById: vi.fn(async () => row) }
    consume.mockResolvedValueOnce({ ok: true })
    expect(await readBrowserSendApprovalStatus(store, row.id)).toBe('approved')
    consume.mockResolvedValueOnce({ ok: false, reason: 'pattern_revoked' })
    expect(await readBrowserSendApprovalStatus(store, row.id)).toBe('unavailable')
    const human = { ...row, resolutionOrigin: 'human' as const }
    const humanStore = { getByIdSystem: vi.fn(async () => human), getById: vi.fn(async () => human) }
    consume.mockClear()
    expect(await readBrowserSendApprovalStatus(humanStore, row.id)).toBe('approved')
    expect(consume).not.toHaveBeenCalled()
  })
})

/**
 * askQuestion suspend-resume (Phase 5) — TTL sweeper test.
 * Component tag: [COMP:api/question-ttl-sweeper].
 *
 * Asserts:
 *   - calls `expireDueQuestions` on the store
 *   - for each expired row, enqueues a `session_resume` scheduled job
 *     via the same Path B mechanism the user-answered route uses, with
 *     decision='rejected' so the replay emits the expired-question note
 *   - skips rows that lack the required FK refs (blocking_session_id /
 *     originating_assistant_id) instead of crashing the sweep
 *   - returns the count of enqueued resume jobs
 */

import { describe, it, expect, vi } from 'vitest'
import { sweepExpiredQuestions } from '../approval.js'
import type { PendingApproval, PendingApprovalsStore } from '../../db/pending-approvals-store.js'

function row(over: Partial<PendingApproval> = {}): PendingApproval {
  return {
    id: 'ap-q-1',
    workspaceId: 'ws-1',
    workflowRunId: null as unknown as string,
    workflowStepRunId: null as unknown as string,
    toolName: 'askQuestion',
    arguments: { question: 'Which one?' },
    approverUserId: 'u-1',
    deliveryChannelType: 'web',
    deliveryChannelId: null,
    status: 'expired',
    expiresAt: new Date('2026-05-26T00:00:00Z'),
    respondedAt: new Date(),
    respondedBy: null,
    rejectReason: null,
    createdAt: new Date('2026-05-25T00:00:00Z'),
    kind: 'question',
    blockingSessionId: 'sess-1',
    approvalPayload: { question: 'Which one?' },
    originatingAssistantId: 'asst-1',
    answerText: null,
    ...over,
  }
}

function makeDeps(rows: PendingApproval[]) {
  const expireDueQuestions = vi.fn(async () => rows)
  const getByApprovalId = vi.fn(async () => ({
    sessionId: 'sess-1',
    approvalId: 'ap-q-1',
    suspendedToolName: 'askQuestion',
    suspendedToolInput: { question: 'Which one?' },
    loopStepIndex: 0,
    createdAt: new Date(),
  }))
  const jobCreate = vi.fn(async (_params: unknown) => ({ id: 'job-1' }))
  const setState = vi.fn(async (_id: string, _state: unknown) => undefined)
  return {
    approvalsStore: {
      expireDueQuestions,
    } as unknown as PendingApprovalsStore,
    sessionResumeStore: { getByApprovalId } as never,
    jobStore: { create: jobCreate, setState } as never,
    spies: { expireDueQuestions, getByApprovalId, jobCreate, setState },
  }
}

describe('[COMP:api/question-ttl-sweeper] sweepExpiredQuestions', () => {
  it('enqueues a session_resume job per expired question row', async () => {
    const deps = makeDeps([row()])
    const n = await sweepExpiredQuestions(deps)
    expect(n).toBe(1)
    expect(deps.spies.expireDueQuestions).toHaveBeenCalledTimes(1)
    expect(deps.spies.jobCreate).toHaveBeenCalledTimes(1)
    const setStateCall = deps.spies.setState.mock.calls[0]
    expect(setStateCall[1]).toMatchObject({
      triggerKind: 'session_resume',
      resume: { sessionId: 'sess-1', approvalId: 'ap-q-1' },
    })
  })

  it('skips rows missing required FK refs without crashing', async () => {
    const deps = makeDeps([
      row({ blockingSessionId: null }),                  // no chat session
      row({ id: 'ap-q-2', originatingAssistantId: null }), // no assistant
      row({ id: 'ap-q-3' }),                             // OK
    ])
    const n = await sweepExpiredQuestions(deps)
    expect(n).toBe(1)
    expect(deps.spies.jobCreate).toHaveBeenCalledTimes(1)
  })

  it('returns zero when nothing was due', async () => {
    const deps = makeDeps([])
    const n = await sweepExpiredQuestions(deps)
    expect(n).toBe(0)
    expect(deps.spies.jobCreate).not.toHaveBeenCalled()
  })

  it('continues on per-row enqueue failure (logged, not thrown)', async () => {
    const deps = makeDeps([row(), row({ id: 'ap-q-2' })])
    // First call throws; second succeeds.
    deps.spies.jobCreate.mockRejectedValueOnce(new Error('jobs DB down'))
    const n = await sweepExpiredQuestions(deps)
    // Only the second succeeded.
    expect(n).toBe(1)
    expect(deps.spies.jobCreate).toHaveBeenCalledTimes(2)
  })
})

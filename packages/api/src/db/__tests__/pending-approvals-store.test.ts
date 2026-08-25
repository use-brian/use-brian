/**
 * Unit tests for the pending-approvals store.
 * Component tag: [COMP:api/pending-approvals-store].
 *
 * `pending_approvals` is the company-brain unified approval substrate
 * (mig 117 + 137 — four kinds: workflow_step / tool_invocation /
 * staged_write / distribution_draft). This suite mocks the `query` /
 * `queryWithRLS` client helpers and covers every store method: the two
 * insert paths, the RLS-gated reads, the atomic idempotent `respond`,
 * and the `expireDue` sweep.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const tx = vi.hoisted(() => ({
  query: vi.fn(),
  release: vi.fn(),
}))

vi.mock('../client.js', () => ({
  query: vi.fn(),
  queryWithRLS: vi.fn(),
  getPool: vi.fn(() => ({
    connect: async () => tx,
  })),
}))

vi.mock('../decision-event-store.js', () => ({
  appendDecisionEvent: vi.fn(async (event: unknown) => ({
    event: { id: 'decision-1', ...(event as object), createdAt: new Date() },
    inserted: true,
  })),
}))

import { createPendingApprovalsStore } from '../pending-approvals-store.js'
import { query, queryWithRLS } from '../client.js'
import { appendDecisionEvent } from '../decision-event-store.js'

const mockQuery = vi.mocked(query)
const mockQueryWithRLS = vi.mocked(queryWithRLS)
const mockAppendDecisionEvent = vi.mocked(appendDecisionEvent)
const store = createPendingApprovalsStore()

/** A pending_approvals row as the COLS projection returns it (camelCase aliases). */
function makeRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'ap-1',
    workspaceId: 'ws-1',
    workflowRunId: 'run-1',
    workflowStepRunId: 'step-1',
    toolName: 'sendEmail',
    arguments: { to: 'a@b.c' },
    approverUserId: 'u-1',
    deliveryChannelType: 'web',
    deliveryChannelId: null,
    status: 'pending',
    expiresAt: null,
    respondedAt: null,
    respondedBy: null,
    rejectReason: null,
    createdAt: new Date('2026-05-15T00:00:00Z'),
    kind: 'workflow_step',
    blockingSessionId: null,
    approvalPayload: {},
    originatingAssistantId: null,
    answerText: null,
    ...over,
  }
}

beforeEach(() => {
  mockQuery.mockReset()
  mockQueryWithRLS.mockReset()
  mockAppendDecisionEvent.mockClear()
  tx.query.mockReset()
  tx.release.mockReset()
  tx.query.mockImplementation(async (sql: string, params?: unknown[]) => {
    if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
      return { rows: [], rowCount: 0 } as never
    }
    return mockQuery(sql, params)
  })
})

describe('[COMP:api/pending-approvals-store] create', () => {
  it('inserts a workflow-shaped approval row', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [makeRow()], rowCount: 1 } as never)
    const approval = await store.create({
      workspaceId: 'ws-1',
      workflowRunId: 'run-1',
      workflowStepRunId: 'step-1',
      originatingAssistantId: 'assistant-1',
      toolName: 'sendEmail',
      arguments: { to: 'a@b.c' },
      approvalPayload: { displayLines: ['• From: sales@example.com'] },
      approverUserId: 'u-1',
      deliveryChannelType: 'web',
    })
    expect(approval.id).toBe('ap-1')
    expect(approval.kind).toBe('workflow_step')
    const [sql, params] = mockQuery.mock.calls[0]
    expect(sql).toContain('INSERT INTO pending_approvals')
    // arguments is JSON-encoded at the wire layer.
    expect(params?.[4]).toBe(JSON.stringify({ to: 'a@b.c' }))
    expect(params?.[5]).toBe(JSON.stringify({ displayLines: ['• From: sales@example.com'] }))
    expect(params?.[10]).toBe('assistant-1')
  })
})

describe('[COMP:api/pending-approvals-store] createToolInvocation', () => {
  it("inserts a kind='tool_invocation' row carrying the queue-UI payload", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [makeRow({ kind: 'tool_invocation', blockingSessionId: 'sess-1' })],
      rowCount: 1,
    } as never)
    const approval = await store.createToolInvocation({
      workspaceId: 'ws-1',
      blockingSessionId: 'sess-1',
      originatingAssistantId: 'a-1',
      approverUserId: 'u-1',
      toolName: 'sendEmail',
      arguments: { to: 'x@y.z' },
      approvalPayload: {
        description: 'Send the proposal email',
        displayLines: ['To: x@y.z'],
        allowPersistentApproval: true,
      },
      deliveryChannelType: 'web',
    })
    expect(approval.kind).toBe('tool_invocation')
    expect(approval.blockingSessionId).toBe('sess-1')
    const [sql] = mockQuery.mock.calls[0]
    expect(sql).toContain("'tool_invocation'")
  })

  it('strips undefined payload keys so JSONB stays symmetric', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [makeRow({ kind: 'tool_invocation' })], rowCount: 1 } as never)
    await store.createToolInvocation({
      workspaceId: 'ws-1',
      blockingSessionId: 'sess-1',
      originatingAssistantId: 'a-1',
      approverUserId: 'u-1',
      toolName: 'sendEmail',
      arguments: {},
      // Only `description` set — displayLines + allowPersistentApproval omitted.
      approvalPayload: { description: 'desc only' },
      deliveryChannelType: 'web',
    })
    const params = mockQuery.mock.calls[0][1]
    // approval_payload is param index 6 (0-based) in the INSERT.
    const payloadJson = params?.[6] as string
    expect(JSON.parse(payloadJson)).toEqual({ description: 'desc only' })
  })
})

describe('[COMP:api/pending-approvals-store] listPendingForWorkspace', () => {
  it('reads through RLS, filtering to status=pending for the workspace', async () => {
    mockQueryWithRLS.mockResolvedValueOnce({
      rows: [makeRow(), makeRow({ id: 'ap-2', kind: 'tool_invocation' })],
      rowCount: 2,
    } as never)
    const rows = await store.listPendingForWorkspace('u-1', 'ws-1')
    expect(rows).toHaveLength(2)
    expect(rows[1].kind).toBe('tool_invocation')
    const [userId, sql, params] = mockQueryWithRLS.mock.calls[0]
    expect(userId).toBe('u-1')
    expect(sql).toContain("status = 'pending'")
    expect(params).toEqual(['ws-1'])
  })
})

describe('[COMP:api/pending-approvals-store] countPendingForUser', () => {
  it('returns the pending count for the approver', async () => {
    mockQueryWithRLS.mockResolvedValueOnce({ rows: [{ count: '3' }], rowCount: 1 } as never)
    expect(await store.countPendingForUser('u-1')).toBe(3)
  })

  it('returns 0 when there are no pending rows', async () => {
    mockQueryWithRLS.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
    expect(await store.countPendingForUser('u-1')).toBe(0)
  })
})

describe('[COMP:api/pending-approvals-store] getById', () => {
  it('returns the row via RLS lookup', async () => {
    mockQueryWithRLS.mockResolvedValueOnce({ rows: [makeRow()], rowCount: 1 } as never)
    const approval = await store.getById('u-1', 'ap-1')
    expect(approval?.id).toBe('ap-1')
  })

  it('returns null when the row is absent or RLS-hidden', async () => {
    mockQueryWithRLS.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
    expect(await store.getById('u-1', 'ghost')).toBeNull()
  })
})

describe('[COMP:api/pending-approvals-store] getByIdSystem', () => {
  it('bypasses RLS for the executor resume path', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [makeRow()], rowCount: 1 } as never)
    const approval = await store.getByIdSystem('ap-1')
    expect(approval?.id).toBe('ap-1')
    expect(mockQueryWithRLS).not.toHaveBeenCalled()
  })
})

describe('[COMP:api/pending-approvals-store] reviseWorkflowEmailBody', () => {
  it('supersedes and inserts the immutable body-only replacement atomically', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        makeRow({
          id: 'ap-2',
          toolName: 'imapSendMessage__sales_1a2b3c4d',
          arguments: {
            to: ['client@example.com'],
            subject: 'Re: Hello',
            body: 'Edited body',
            inReplyTo: 'INBOX:42',
          },
          approvalPayload: {
            emailDraftRevision: 2,
            supersedesApprovalId: 'ap-1',
          },
        }),
      ],
      rowCount: 1,
    } as never)
    const revised = await store.reviseWorkflowEmailBody(
      'ap-1',
      'Edited body',
      'u-1',
    )
    expect(revised?.id).toBe('ap-2')
    expect(revised?.arguments.body).toBe('Edited body')
    expect(revised?.approvalPayload.emailDraftRevision).toBe(2)
    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]]
    expect(sql).toContain("SET status = 'superseded'")
    expect(sql).toContain("split_part(tool_name, '__', 1) = 'imapSendMessage'")
    expect(sql).toContain("jsonb_set(arguments, '{body}'")
    expect(sql).toContain("'supersedesApprovalId', id")
    expect(sql).toContain('originating_assistant_id')
    expect(params).toEqual(['ap-1', 'Edited body', 'u-1'])
  })

  it('returns null when the source row no longer owns the pending cursor', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
    expect(
      await store.reviseWorkflowEmailBody('ap-1', 'Edited body', 'u-1'),
    ).toBeNull()
  })
})

describe('[COMP:api/pending-approvals-store] staged-skill dedupe finders', () => {
  it('findPendingStagedSkillUpdate keys on workspace + payload targetSkillId, pending only', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [makeRow({ id: 'ap-7', kind: 'staged_skill_update' })],
      rowCount: 1,
    } as never)
    const row = await store.findPendingStagedSkillUpdate('ws-1', 'skill-1')
    expect(row?.id).toBe('ap-7')
    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]]
    expect(sql).toContain("kind = 'staged_skill_update'")
    expect(sql).toContain("status = 'pending'")
    expect(sql).toContain("approval_payload->>'targetSkillId'")
    expect(params).toEqual(['ws-1', 'skill-1'])
    // System read — the worker has no acting user.
    expect(mockQueryWithRLS).not.toHaveBeenCalled()
  })

  it('findPendingStagedSkillUpdate returns null when nothing is pending', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
    expect(await store.findPendingStagedSkillUpdate('ws-1', 'skill-1')).toBeNull()
  })

  it('findPendingStagedSkillCreation keys on workspace + proposed umbrella slug', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [makeRow({ id: 'ap-8', kind: 'staged_skill_creation' })],
      rowCount: 1,
    } as never)
    const row = await store.findPendingStagedSkillCreation('ws-1', 'weekly-report')
    expect(row?.id).toBe('ap-8')
    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]]
    expect(sql).toContain("kind = 'staged_skill_creation'")
    expect(sql).toContain("arguments->'umbrella'->>'slug'")
    expect(params).toEqual(['ws-1', 'weekly-report'])
  })

  it('findPendingStagedSkillCreation returns null when nothing is pending', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
    expect(await store.findPendingStagedSkillCreation('ws-1', 'weekly-report')).toBeNull()
  })
})

describe('[COMP:api/pending-approvals-store] respond', () => {
  it('flips a pending row to approved and stamps the responder', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [makeRow({ status: 'approved', respondedBy: 'u-1' })],
      rowCount: 1,
    } as never)
    const updated = await store.respond('ap-1', 'approved', 'u-1')
    expect(updated?.status).toBe('approved')
    const [sql, params] = mockQuery.mock.calls[0]
    // Atomic guard — only flips a row still in 'pending'.
    expect(sql).toContain("WHERE id = $1 AND status = 'pending'")
    expect(params).toEqual(['ap-1', 'approved', 'u-1', null])
  })

  it('records the reject reason on rejection', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [makeRow({ status: 'rejected', rejectReason: 'not now' })],
      rowCount: 1,
    } as never)
    const updated = await store.respond('ap-1', 'rejected', 'u-1', 'not now')
    expect(updated?.rejectReason).toBe('not now')
    expect(mockQuery.mock.calls[0][1]?.[3]).toBe('not now')
  })

  it('returns null when the row is already non-pending (idempotent double-click)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
    expect(await store.respond('ap-1', 'approved', 'u-1')).toBeNull()
  })
})

describe('[COMP:api/decision-capture] atomic approval evidence', () => {
  it('preserves an inline persistent denial as always_deny', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [makeRow({
        status: 'rejected',
        kind: 'tool_invocation',
        toolName: 'sendMessage__mailbox_12345678',
        blockingSessionId: '00000000-0000-4000-8000-000000000010',
        originatingAssistantId: '00000000-0000-4000-8000-000000000011',
      })],
      rowCount: 1,
    } as never)
    await store.respond('ap-1', 'rejected', 'u-1', 'Do not send this', 'always_deny')
    expect(mockAppendDecisionEvent).toHaveBeenCalledTimes(1)
    expect(mockAppendDecisionEvent.mock.calls[0][0]).toMatchObject({
      eventKind: 'approval.decided',
      declaredScope: 'tool',
      reason: 'Do not send this',
      payload: {
        approvalKind: 'tool_invocation',
        toolName: 'sendMessage',
        resolution: 'always_deny',
      },
    })
    expect(tx.query.mock.calls.map((call) => call[0])).toEqual([
      'BEGIN',
      expect.stringContaining('UPDATE pending_approvals'),
      'COMMIT',
    ])
  })

  it('rolls back the approval update when event capture fails', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [makeRow({ status: 'approved' })],
      rowCount: 1,
    } as never)
    mockAppendDecisionEvent.mockRejectedValueOnce(new Error('journal unavailable'))
    await expect(store.respond('ap-1', 'approved', 'u-1')).rejects.toThrow('journal unavailable')
    expect(tx.query.mock.calls.at(-1)?.[0]).toBe('ROLLBACK')
  })

  it('captures reviewed-email revision ids but no body, recipient, subject, or arguments', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [makeRow({
        id: '00000000-0000-4000-8000-000000000020',
        toolName: 'imapSendMessage',
        arguments: {
          to: ['reviewer@example.test'],
          subject: 'Private subject',
          body: 'Edited private body',
          inReplyTo: 'message-1',
          account: 'mailbox-primary',
        },
        approvalPayload: {
          emailDraftRevision: 2,
          supersedesApprovalId: '00000000-0000-4000-8000-000000000019',
        },
        originatingAssistantId: '00000000-0000-4000-8000-000000000011',
      })],
      rowCount: 1,
    } as never)
    await store.reviseWorkflowEmailBody(
      '00000000-0000-4000-8000-000000000019',
      'Edited private body',
      '00000000-0000-4000-8000-000000000012',
    )
    const event = mockAppendDecisionEvent.mock.calls[0][0]
    expect(event).toMatchObject({
      eventKind: 'email.draft_revised',
      payload: {
        previousApprovalId: '00000000-0000-4000-8000-000000000019',
        replacementApprovalId: '00000000-0000-4000-8000-000000000020',
        previousRevision: 1,
        newRevision: 2,
        accountKey: 'mailbox-primary',
      },
    })
    expect(JSON.stringify(event)).not.toMatch(/Edited private body|reviewer@example|Private subject|"arguments"/)
  })
})

describe('[COMP:api/pending-approvals-store] expireDue', () => {
  it('flips every pending row past its expiry to expired', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [makeRow({ status: 'expired' })],
      rowCount: 1,
    } as never)
    const expired = await store.expireDue()
    expect(expired).toHaveLength(1)
    expect(expired[0].status).toBe('expired')
    const [sql] = mockQuery.mock.calls[0]
    expect(sql).toContain("status = 'expired'")
    expect(sql).toContain('expires_at <= now()')
  })
})

describe('[COMP:api/pending-approvals-store] createQuestion', () => {
  it('inserts a kind=question row with question + toolUseId in payload', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [makeRow({
        kind: 'question',
        toolName: 'askQuestion',
        arguments: { question: 'Which MeshJS?' },
        approvalPayload: { question: 'Which MeshJS?', toolUseId: 'call_42' },
        blockingSessionId: 'sess-1',
        originatingAssistantId: 'asst-1',
      })],
      rowCount: 1,
    } as never)
    const row = await store.createQuestion({
      workspaceId: 'ws-1',
      blockingSessionId: 'sess-1',
      originatingAssistantId: 'asst-1',
      approverUserId: 'u-1',
      question: 'Which MeshJS?',
      toolUseId: 'call_42',
      deliveryChannelType: 'web',
    })
    expect(row.kind).toBe('question')
    expect(row.toolName).toBe('askQuestion')
    expect(row.approvalPayload).toMatchObject({ question: 'Which MeshJS?', toolUseId: 'call_42' })
    const [sql, values] = mockQuery.mock.calls[0] as [string, unknown[]]
    expect(sql).toContain("'question'")
    expect(sql).toContain("'askQuestion'")
    expect(values).toContain('sess-1')
    expect(values).toContain('asst-1')
  })
})

describe('[COMP:api/pending-approvals-store] recordAnswer', () => {
  it('flips a pending question row to approved with answer_text', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [makeRow({
        kind: 'question',
        status: 'approved',
        answerText: 'the Cardano SDK',
        respondedAt: new Date(),
        respondedBy: 'u-1',
      })],
      rowCount: 1,
    } as never)
    const updated = await store.recordAnswer('ap-1', 'the Cardano SDK', 'u-1')
    expect(updated?.status).toBe('approved')
    expect(updated?.answerText).toBe('the Cardano SDK')
    const [sql, values] = mockQuery.mock.calls[0] as [string, unknown[]]
    expect(sql).toContain('answer_text = $2')
    expect(sql).toContain("status = 'pending'")
    expect(sql).toContain("kind = 'question'")
    expect(values).toEqual(['ap-1', 'the Cardano SDK', 'u-1'])
  })

  it('returns null when the row is already non-pending (idempotency)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
    const updated = await store.recordAnswer('ap-1', 'ignored', 'u-1')
    expect(updated).toBeNull()
  })
})

describe('[COMP:api/pending-approvals-store] expireDueQuestions', () => {
  it('flips only kind=question rows past their TTL to expired', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [makeRow({ kind: 'question', status: 'expired' })],
      rowCount: 1,
    } as never)
    const expired = await store.expireDueQuestions()
    expect(expired).toHaveLength(1)
    expect(expired[0].kind).toBe('question')
    expect(expired[0].status).toBe('expired')
    const [sql] = mockQuery.mock.calls[0]
    expect(sql).toContain("kind = 'question'")
    expect(sql).toContain('expires_at <= now()')
  })

  it('returns empty when nothing is due', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
    const expired = await store.expireDueQuestions()
    expect(expired).toEqual([])
  })
})

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PendingApproval } from '../../db/pending-approvals-store.js'
import { externalActionConfirmation } from '../confirmation.js'

function row(over: Partial<PendingApproval> = {}): PendingApproval {
  return {
    id: 'approval-1', kind: 'external_action', status: 'pending', approverUserId: 'user-1',
    workspaceId: 'workspace-1', originatingAssistantId: 'assistant-1',
    blockingSessionId: null, deliveryChannelType: 'web', deliveryChannelId: 'session-1',
    createdAt: new Date('2026-01-01'), expiresAt: new Date('2099-01-01'),
    approvalPayload: { request: { method: 'confirm', title: 'Deploy' } },
    ...over,
  } as PendingApproval
}

describe('externalActionConfirmation', () => {
  it.each(['confirm', 'select'])('preserves the full exact frozen %s text', (method) => {
    const title = '  <Title>\n' + 'x'.repeat(16300) + '\t '
    const message = ' \n<Message>\t' + 'y'.repeat(32600) + '\n '
    const request = { method, title, message, ...(method === 'select' ? { options: ['Allow once', 'Deny'] } : {}) }
    const approval = row({ approvalPayload: { request } })
    expect(externalActionConfirmation(approval)).toEqual({
      approvalId: 'approval-1', title, message,
      ...(method === 'select' ? { options: ['Allow once', 'Deny'] } : {}),
      expiresAt: '2099-01-01T00:00:00.000Z',
    })
    expect(approval.approvalPayload.request).toEqual(request)
  })

  it('omits optional fields absent from a confirm request', () => {
    expect(externalActionConfirmation(row())).toEqual({
      approvalId: 'approval-1', title: 'Deploy', expiresAt: '2099-01-01T00:00:00.000Z',
    })
  })

  it.each([
    null, [], {}, { method: 'execute', title: 'No' }, { method: 'confirm' },
    { method: 'confirm', title: 1 }, { method: 'confirm', title: 'No', message: null },
    { method: 'confirm', title: 'No', options: ['Allow once', 'Deny'] },
    { method: 'select', title: 'No' }, { method: 'select', title: 'No', options: ['Deny', 'Allow once'] },
    { method: 'select', title: 'No', options: ['Allow once', 'Deny', 'Always allow'] },
    { method: 'select', title: 'No', options: [' Allow once', 'Deny'] },
  ])('rejects malformed requests (%j)', (request) => {
    expect(externalActionConfirmation(row({ approvalPayload: { request } }))).toBeNull()
  })

  it.each([
    { kind: 'tool_invocation' }, { status: 'approved' }, { expiresAt: null },
    { expiresAt: new Date(NaN) }, { expiresAt: new Date(0) },
    { approvalPayload: null }, { approvalPayload: [] },
  ])('rejects ineligible rows (%j)', (over) => {
    expect(externalActionConfirmation(row(over as Partial<PendingApproval>))).toBeNull()
  })

  it('rejects expiry at exactly now', () => {
    const now = Date.now()
    vi.spyOn(Date, 'now').mockReturnValueOnce(now)
    expect(externalActionConfirmation(row({ expiresAt: new Date(now) }))).toBeNull()
    vi.restoreAllMocks()
  })
})

const mocks = vi.hoisted(() => ({
  listPending: vi.fn(), effectiveAssignment: vi.fn(),
}))
vi.mock('../../db/client.js', () => ({
  getPool: () => ({ query: vi.fn(async () => ({ rows: [] })) }),
  queryWithRLS: vi.fn(async () => ({ rows: [] })),
}))
vi.mock('../../db/pending-approvals-store.js', () => ({
  createPendingApprovalsStore: () => ({ listPendingForWorkspace: mocks.listPending }),
}))
vi.mock('../../db/approval-review-store.js', () => ({
  getReceiptForViewer: vi.fn(), latestAttemptsForViewer: vi.fn(async () => new Map()),
  listAttentionSeen: vi.fn(async () => new Set()), listOpenRouteBlockersForViewer: vi.fn(async () => []),
  markAttentionSeen: vi.fn(),
}))
vi.mock('../../approval-review/common.js', () => ({ workspaceRole: vi.fn(async () => 'member') }))
vi.mock('../../approval-review/source.js', () => ({ loadRequestFacts: vi.fn(async () => ({ projectIds: [] })) }))
vi.mock('../../approval-review/patterns.js', () => ({ effectiveAssignmentFor: mocks.effectiveAssignment }))
vi.mock('../../approval-review/resolution.js', () => ({ checkReview: vi.fn() }))
import { listAttention } from '../../approval-review/attention.js'

describe('external confirmation Attention projection', () => {
  beforeEach(() => {
    mocks.listPending.mockReset()
    mocks.effectiveAssignment.mockReset()
  })

  it('projects the same confirmation into scoped web Attention without delegating external actions', async () => {
    const approval = row()
    mocks.listPending.mockResolvedValue([approval])
    const result = await listAttention({ userId: 'user-1', origin: 'ui' as const, human: true }, 'workspace-1', { sessionId: 'session-1' })
    expect(result.items).toHaveLength(1)
    expect(result.items[0]).toMatchObject({
      kind: 'approval_waiting', sessionId: 'session-1', review: null,
      confirmation: externalActionConfirmation(approval),
    })
    expect(mocks.effectiveAssignment).not.toHaveBeenCalled()
  })

  it.each([
    { deliveryChannelType: 'web', deliveryChannelId: null },
    { deliveryChannelType: 'web', deliveryChannelId: 'queue' },
    { deliveryChannelType: 'slack', deliveryChannelId: 'session-1' },
  ])('keeps inbox/non-web requests sessionless (%j)', async (delivery) => {
    mocks.listPending.mockResolvedValue([row(delivery as Partial<PendingApproval>)])
    const actor = { userId: 'user-1', origin: 'ui' as const, human: true }
    const result = await listAttention(actor, 'workspace-1')
    expect(result.items[0]).toMatchObject({ sessionId: null, review: null })
    expect((await listAttention(actor, 'workspace-1', { sessionId: 'session-1' })).items).toEqual([])
    expect(mocks.effectiveAssignment).not.toHaveBeenCalled()
  })

  it('keeps every external confirmation reachable beyond the legacy 100 item slice', async () => {
    mocks.listPending.mockResolvedValue(Array.from({ length: 101 }, (_, i) => row({ id: `approval-${i}`, deliveryChannelId: 'queue' })))
    const result = await listAttention({ userId: 'user-1', origin: 'ui' as const, human: true }, 'workspace-1')
    expect(result.items).toHaveLength(101)
    expect(result.items[100]).toMatchObject({ confirmation: { approvalId: 'approval-100' }, sessionId: null })
  })

  it('omits the optional confirmation for malformed frozen requests', async () => {
    mocks.listPending.mockResolvedValue([row({ approvalPayload: { request: {} } })])
    const result = await listAttention({ userId: 'user-1', origin: 'ui' as const, human: true }, 'workspace-1')
    expect(result.items[0]).not.toHaveProperty('confirmation')
  })
})


it('projects full literal questions and omits absent optional settings',()=>{
  for(const extra of [{},{options:[' A ','B']},{options:['A'],allowCustom:true}]) {
    const request={method:'question',title:'  '+ 'x'.repeat(16300)+'\n',message:' '+ 'y'.repeat(32700)+'\t',...extra}
    expect(externalActionConfirmation(row({approvalPayload:{request}}))).toEqual({approvalId:'approval-1',...request,expiresAt:'2099-01-01T00:00:00.000Z'})
  }
  expect(externalActionConfirmation(row({approvalPayload:{request:{method:'question',title:'Q',allowCustom:false}}}))).toBeNull()
})

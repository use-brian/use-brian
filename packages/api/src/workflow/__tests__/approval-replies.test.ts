/**
 * Unit tests for the inbound channel approval-reply handler.
 * Component tag: [COMP:channels/approval-replies].
 *
 * Mocks `query` and `resumeFromApproval`. Verifies maybeHandleApprovalReply:
 * the `approve|reject <id> [reason]` regex (case-insensitivity + the
 * 6-char id-prefix floor), the user/workspace/assistant-scoped workflow-only lookup, the
 * stale / ambiguous-prefix → consumed guards, and the dispatch to
 * resumeFromApproval on a unique match.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../external-approvals/sql-store.js', () => ({ canReadExternalApproval: vi.fn() }))
vi.mock('../../external-approvals/service.js', () => ({
  externalApprovals: () => ({ resolve: externalResolve }),
  ExternalApprovalError: class extends Error {},
}))
const { externalResolve } = vi.hoisted(() => ({ externalResolve: vi.fn() }))

vi.mock('../../db/client.js', () => ({ query: vi.fn() }))
vi.mock('../approval.js', () => ({ resumeFromApproval: vi.fn() }))

import { maybeHandleApprovalReply } from '../approval-replies.js'
import { canReadExternalApproval } from '../../external-approvals/sql-store.js'
import { query } from '../../db/client.js'
import { resumeFromApproval } from '../approval.js'

const mockQuery = vi.mocked(query)
const mockResume = vi.mocked(resumeFromApproval)

type Deps = Parameters<typeof maybeHandleApprovalReply>[0]
const deps = { approvalsStore: {}, bridgeDeps: {} } as unknown as Deps

beforeEach(() => {
  mockQuery.mockReset()
  mockResume.mockReset()
})

describe('[COMP:channels/approval-replies] maybeHandleApprovalReply', () => {
  it('returns null for a message that is not an approval reply', async () => {
    expect(await maybeHandleApprovalReply(deps, 'u-1', 'hello there')).toBeNull()
    expect(mockQuery).not.toHaveBeenCalled()
  })

  it('returns null when the id prefix is shorter than 6 chars', async () => {
    expect(await maybeHandleApprovalReply(deps, 'u-1', 'approve abc')).toBeNull()
    expect(mockQuery).not.toHaveBeenCalled()
  })

  it('resolves a unique "approve <id>" reply and dispatches to resumeFromApproval', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'abc123de-full' }], rowCount: 1 } as never)
    mockResume.mockResolvedValueOnce({ status: 'approved', runId: 'run-7' } as never)
    const res = await maybeHandleApprovalReply(deps, 'u-1', 'approve abc123de')
    expect(res).toEqual({
      decision: 'approved',
      approvalId: 'abc123de-full',
      reason: undefined,
      status: 'approved',
      runId: 'run-7',
    })
    expect(mockResume).toHaveBeenCalledWith(deps.bridgeDeps, 'abc123de-full', 'approved', 'u-1', undefined, undefined)
  })

  it('parses a reject reply with a trailing reason', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'abc123de-full' }], rowCount: 1 } as never)
    mockResume.mockResolvedValueOnce({ status: 'rejected', runId: null } as never)
    const res = await maybeHandleApprovalReply(deps, 'u-1', 'reject abc123de changed my mind')
    expect(res?.decision).toBe('rejected')
    expect(res?.reason).toBe('changed my mind')
    expect(mockResume).toHaveBeenCalledWith(deps.bridgeDeps, 'abc123de-full', 'rejected', 'u-1', 'changed my mind', undefined)
  })

  it('matches case-insensitively and lowercases the id prefix for the lookup', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'abc123de-full' }], rowCount: 1 } as never)
    mockResume.mockResolvedValueOnce({ status: 'approved', runId: null } as never)
    await maybeHandleApprovalReply(deps, 'u-1', 'APPROVE ABC123DE')
    const [sql, params] = mockQuery.mock.calls[0]
    expect(sql).toContain("status = 'pending'")
    expect(sql).toContain('approver_user_id = $1')
    expect(params).toEqual(['u-1', 'abc123de', null, null, null, null, null])
    expect(sql).toContain("kind IN ('workflow_step', 'external_action')")
    expect(sql).toContain('expires_at > now()')
  })

  it('consumes commands when no pending approval matches the prefix', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
    expect(await maybeHandleApprovalReply(deps, 'u-1', 'approve abc123de')).toMatchObject({ status: 'unavailable', runId: null })
    expect(mockResume).not.toHaveBeenCalled()
  })

  it('consumes commands for an ambiguous prefix matching multiple pending rows', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'x1' }, { id: 'x2' }], rowCount: 2 } as never)
    expect(await maybeHandleApprovalReply(deps, 'u-1', 'approve abc123de')).toMatchObject({ status: 'unavailable', runId: null })
    expect(mockResume).not.toHaveBeenCalled()
  })
})

it('checks fresh authorization before lookup and constrains workspace and assistant', async () => {
  const scope = { workspaceId: 'ws', assistantId: 'asst', authorized: vi.fn(async () => false) }
  expect(await maybeHandleApprovalReply(deps, 'u', 'approve abc123', scope)).toMatchObject({ status: 'unavailable' })
  expect(mockQuery).not.toHaveBeenCalled()
  scope.authorized.mockResolvedValue(true)
  mockQuery.mockResolvedValue({ rows: [] } as never)
  await maybeHandleApprovalReply(deps, 'u', 'approve abc123', scope)
  expect(mockQuery).toHaveBeenCalledWith(expect.stringContaining('originating_assistant_id = $4'), ['u', 'abc123', 'ws', 'asst', null, null, null])
})

it.each(['authorization', 'lookup'] as const)('does not resume approval after cancellation during %s', async stage => {
  const controller = new AbortController()
  let release!: () => void
  const paused = new Promise<void>(resolve => { release = resolve })
  let enter!: () => void
  const entered = new Promise<void>(resolve => { enter = resolve })
  const pause = async () => { enter(); await paused }
  const authorized = vi.fn(async () => { if (stage === 'authorization') await pause(); return true })
  mockQuery.mockImplementationOnce(async () => {
    if (stage === 'lookup') await pause()
    return { rows: [{ id: 'abc123de-full' }], rowCount: 1 } as never
  })
  const result = maybeHandleApprovalReply(deps, 'u', 'approve abc123', {
    workspaceId: 'ws', assistantId: 'asst', authorized, abortSignal: controller.signal,
  })
  await entered
  controller.abort()
  release()
  expect(await result).toMatchObject({ status: 'cancelled', runId: null })
  expect(mockResume).not.toHaveBeenCalled()
  if (stage === 'authorization') expect(mockQuery).not.toHaveBeenCalled()
})

describe('external channel member replies', () => {
  const scope = { workspaceId: 'ws', assistantId: 'asst', channelId: 'conversation',
    channelIntegrationId: 'integration', providerUserId: 'verified-provider-sender', threadRef: 'root', authorized: vi.fn(async () => true) }
  beforeEach(() => {
    vi.mocked(canReadExternalApproval).mockReset()
    externalResolve.mockReset()
    scope.authorized.mockReset().mockResolvedValue(true)
  })
  it('filters foreign prefix collisions before deciding as an authorized member', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [
      { id: 'abc123-foreign', kind: 'external_action' },
      { id: 'abc123-member', kind: 'external_action' },
    ] } as never)
    vi.mocked(canReadExternalApproval).mockImplementation(async (_user, id) => id === 'abc123-member')
    externalResolve.mockResolvedValueOnce({ status: 'approved' })
    const result = await maybeHandleApprovalReply(deps, 'member', 'approve abc123', scope)
    expect(result).toMatchObject({ approvalId: 'abc123-member', status: 'approved', runId: null })
    expect(externalResolve).toHaveBeenCalledWith('abc123-member', 'approved', {
      userId: 'member', human: true, origin: 'channel', channelId: 'conversation', channelIntegrationId: 'integration',
      providerUserId: 'verified-provider-sender', threadRef: 'root',
    })
    expect(mockResume).not.toHaveBeenCalled()
    expect(mockQuery.mock.calls[0][0]).not.toContain('LIMIT 2')
    expect(mockQuery.mock.calls[0][0]).toContain('s.channel_integration_id::text = $6')
    expect(mockQuery.mock.calls[0][0]).toContain('s.thread_ref IS NOT DISTINCT FROM $7::text')
    expect(mockQuery.mock.calls[0][1]).toEqual(['member','abc123','ws','asst','conversation','integration','root'])
  })
  it.each([undefined, { ...scope, channelId: undefined }, { ...scope, channelIntegrationId: undefined }])(
    'does not resolve external requests without exact scope', async badScope => {
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 'abc123-member', kind: 'external_action' }] } as never)
      expect(await maybeHandleApprovalReply(deps, 'member', 'approve abc123', badScope)).toMatchObject({ status: 'unavailable' })
      expect(externalResolve).not.toHaveBeenCalled()
      expect(mockResume).not.toHaveBeenCalled()
    },
  )
  it('reuses current authorization immediately before external resolution', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'abc123-member', kind: 'external_action' }] } as never)
    vi.mocked(canReadExternalApproval).mockResolvedValue(true)
    scope.authorized.mockResolvedValueOnce(true).mockResolvedValueOnce(false)
    expect(await maybeHandleApprovalReply(deps, 'member', 'approve abc123', scope)).toMatchObject({ status: 'unavailable' })
    expect(externalResolve).not.toHaveBeenCalled()
    expect(mockResume).not.toHaveBeenCalled()
  })
})

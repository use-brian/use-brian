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

vi.mock('../../db/client.js', () => ({ query: vi.fn() }))
vi.mock('../approval.js', () => ({ resumeFromApproval: vi.fn() }))

import { maybeHandleApprovalReply } from '../approval-replies.js'
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
    expect(mockResume).toHaveBeenCalledWith(deps.bridgeDeps, 'abc123de-full', 'approved', 'u-1', undefined)
  })

  it('parses a reject reply with a trailing reason', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'abc123de-full' }], rowCount: 1 } as never)
    mockResume.mockResolvedValueOnce({ status: 'rejected', runId: null } as never)
    const res = await maybeHandleApprovalReply(deps, 'u-1', 'reject abc123de changed my mind')
    expect(res?.decision).toBe('rejected')
    expect(res?.reason).toBe('changed my mind')
    expect(mockResume).toHaveBeenCalledWith(deps.bridgeDeps, 'abc123de-full', 'rejected', 'u-1', 'changed my mind')
  })

  it('matches case-insensitively and lowercases the id prefix for the lookup', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'abc123de-full' }], rowCount: 1 } as never)
    mockResume.mockResolvedValueOnce({ status: 'approved', runId: null } as never)
    await maybeHandleApprovalReply(deps, 'u-1', 'APPROVE ABC123DE')
    const [sql, params] = mockQuery.mock.calls[0]
    expect(sql).toContain("status = 'pending'")
    expect(sql).toContain('approver_user_id = $1')
    expect(params).toEqual(['u-1', 'abc123de', null, null])
    expect(sql).toContain("kind = 'workflow_step'")
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
  expect(mockQuery).toHaveBeenCalledWith(expect.stringContaining('originating_assistant_id = $4'), ['u', 'abc123', 'ws', 'asst'])
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

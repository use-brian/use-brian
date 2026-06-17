/**
 * Unit tests for the inbound channel approval-reply handler.
 * Component tag: [COMP:channels/approval-replies].
 *
 * Mocks `query` and `resumeFromApproval`. Verifies maybeHandleApprovalReply:
 * the `approve|reject <id> [reason]` regex (case-insensitivity + the
 * 6-char id-prefix floor), the user-scoped + pending-only lookup, the
 * no-match / ambiguous-prefix → null guards, and the dispatch to
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
    expect(params).toEqual(['u-1', 'abc123de'])
  })

  it('returns null when no pending approval matches the prefix', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
    expect(await maybeHandleApprovalReply(deps, 'u-1', 'approve abc123de')).toBeNull()
    expect(mockResume).not.toHaveBeenCalled()
  })

  it('returns null for an ambiguous prefix matching multiple pending rows', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'x1' }, { id: 'x2' }], rowCount: 2 } as never)
    expect(await maybeHandleApprovalReply(deps, 'u-1', 'approve abc123de')).toBeNull()
    expect(mockResume).not.toHaveBeenCalled()
  })
})

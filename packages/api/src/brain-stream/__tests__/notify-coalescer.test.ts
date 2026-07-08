/**
 * Coalescer tests for the workspace-change NOTIFY emitter.
 * [COMP:api/brain-stream-fanout]
 *
 * The realtime-sync generalization (docs/plans/realtime-sync-audit.md §5.3)
 * routes every emit through a per-(workspaceId, primitive) leading+trailing
 * throttle so bounded-but-chatty writers (a many-step workflow run, an
 * approvals expiry sweep) cannot storm the Postgres channel. These tests pin
 * that contract by stubbing the db client and driving fake timers — no
 * Postgres round-trip.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const queryMock = vi.hoisted(() =>
  vi.fn(async (..._args: unknown[]) => ({ rows: [] as unknown[], rowCount: 0 })),
)

vi.mock('../../db/client.js', () => ({
  query: queryMock,
  queryWithRLS: vi.fn(),
}))

import { _resetCoalescerForTests, notifyBrainChange, notifyWorkspaceChange } from '../notify.js'

function sentPayloads(): Array<{ workspaceId: string; primitive: string; action: string; rowId?: string }> {
  return queryMock.mock.calls
    .filter((call) => typeof call[0] === 'string' && (call[0] as string).includes('pg_notify'))
    .map((call) => JSON.parse((call[1] as string[])[1] as string))
}

beforeEach(() => {
  vi.useFakeTimers()
  queryMock.mockClear()
})

afterEach(() => {
  _resetCoalescerForTests()
  vi.useRealTimers()
})

describe('[COMP:api/brain-stream-fanout] notify coalescer', () => {
  it('passes the first emit through immediately (leading edge)', async () => {
    await notifyBrainChange({ workspaceId: 'ws-a', primitive: 'workflow', action: 'create', rowId: 'w1' })
    expect(sentPayloads()).toEqual([
      { workspaceId: 'ws-a', primitive: 'workflow', action: 'create', rowId: 'w1' },
    ])
  })

  it('collapses a burst into one trailing emit carrying the last payload', async () => {
    await notifyBrainChange({ workspaceId: 'ws-a', primitive: 'workflow_run', action: 'create', rowId: 'r1' })
    await notifyBrainChange({ workspaceId: 'ws-a', primitive: 'workflow_run', action: 'update', rowId: 'r1' })
    await notifyBrainChange({ workspaceId: 'ws-a', primitive: 'workflow_run', action: 'update', rowId: 'r2' })
    expect(sentPayloads()).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(2_100)
    const sent = sentPayloads()
    expect(sent).toHaveLength(2)
    // Trailing emit reuses the LAST payload — the refetch reads truth anyway.
    expect(sent[1]).toEqual({ workspaceId: 'ws-a', primitive: 'workflow_run', action: 'update', rowId: 'r2' })
  })

  it('keys the window by (workspaceId, primitive) — no cross-talk', async () => {
    await notifyBrainChange({ workspaceId: 'ws-a', primitive: 'workflow', action: 'update' })
    await notifyBrainChange({ workspaceId: 'ws-a', primitive: 'approval', action: 'create' })
    await notifyBrainChange({ workspaceId: 'ws-b', primitive: 'workflow', action: 'update' })
    // Three distinct keys → three leading emits, no coalescing between them.
    expect(sentPayloads()).toHaveLength(3)
  })

  it('re-opens the leading edge after a quiet window', async () => {
    await notifyBrainChange({ workspaceId: 'ws-a', primitive: 'skill', action: 'update' })
    await vi.advanceTimersByTimeAsync(2_100)
    await notifyBrainChange({ workspaceId: 'ws-a', primitive: 'skill', action: 'update' })
    // Both were leading emits; no trailing fire pending with nothing queued.
    expect(sentPayloads()).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(2_100)
    expect(sentPayloads()).toHaveLength(2)
  })

  it('drops payloads without a workspaceId', async () => {
    await notifyBrainChange({ workspaceId: '', primitive: 'workflow', action: 'update' })
    notifyWorkspaceChange(null, 'workflow', 'update', 'w1')
    notifyWorkspaceChange(undefined, 'workflow', 'update', 'w1')
    expect(sentPayloads()).toHaveLength(0)
  })

  it('notifyWorkspaceChange forwards fields verbatim', async () => {
    notifyWorkspaceChange('ws-c', 'scheduled_job', 'delete', 'j9')
    await vi.advanceTimersByTimeAsync(0)
    expect(sentPayloads()).toEqual([
      { workspaceId: 'ws-c', primitive: 'scheduled_job', action: 'delete', rowId: 'j9' },
    ])
  })
})

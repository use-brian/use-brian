/**
 * [COMP:api/turn-lease] — the turn lease over `sessions.status='running'`.
 *
 * `status='running'` is a lock. Migration 424 gave it an owner
 * (`turn_lease_token`) and a lease (`turn_heartbeat_at`) because it had
 * neither, and the 2026-08-08 incident is what that cost: a workspace room sat
 * `running` for ~31 minutes with no turn in flight anywhere, every member's
 * Live card spinning, every addressed message queueing behind a lock nobody
 * held.
 *
 * Two invariants here are regression guards, not preferences:
 *
 *   1. Staleness is measured on the LEASE, never on `last_active_at` alone.
 *      `findSessionById` writes `last_active_at = now()` on every read, so a
 *      client watching a stuck session refreshed the old sweep predicate
 *      faster than its 6-minute threshold could ever expire. A liveness clock
 *      that reads can refresh is not a liveness clock.
 *   2. Every lease operation is token-guarded. Once a stale lease can be
 *      reclaimed, an orphaned turn can wake up holding a token for a session
 *      somebody else now owns — and without the guard it would heartbeat,
 *      cancel or unlock the SUCCESSOR's turn. The recovery path would corrupt
 *      the state it exists to repair.
 *
 * Spec: docs/architecture/context-engine/session-messages.md
 *       → "Turn lease and recovery".
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../client.js', () => ({
  query: vi.fn(),
}))

import {
  startTurnLease,
  touchTurnLease,
  releaseTurnLease,
  requestTurnCancel,
  reclaimStaleTurn,
  sweepStuckSessions,
  TURN_HEARTBEAT_INTERVAL_MS,
  TURN_LEASE_STALE_AFTER_MS,
} from '../sessions.js'
import { query } from '../client.js'

const mockQuery = vi.mocked(query)

/** Collapse whitespace so assertions read as SQL, not as formatting. */
const sqlOf = (callIndex = 0): string =>
  String(mockQuery.mock.calls[callIndex]?.[0] ?? '').replace(/\s+/g, ' ')

beforeEach(() => {
  mockQuery.mockReset()
})

describe('[COMP:api/turn-lease] staleness never reads last_active_at alone', () => {
  it('sweepStuckSessions measures the heartbeat, coalescing only for pre-424 rows', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
    await sweepStuckSessions(90_000)

    const sql = sqlOf()
    expect(sql).toContain('COALESCE(turn_heartbeat_at, last_active_at)')
    // The 2026-08-08 predicate. If this ever comes back, a watched session
    // becomes unsweepable again.
    expect(sql).not.toMatch(/WHERE status = 'running' AND last_active_at </)
  })

  it('reclaimStaleTurn measures the heartbeat too', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
    await reclaimStaleTurn('s-1')

    expect(sqlOf()).toContain('COALESCE(turn_heartbeat_at, last_active_at)')
  })

  it('reclaims only a RUNNING session, so an idle one is never disturbed', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
    await reclaimStaleTurn('s-1')

    expect(sqlOf()).toContain("status = 'running'")
  })

  it('defaults the reclaim window to the lease threshold, several heartbeats wide', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
    await reclaimStaleTurn('s-1')

    expect(mockQuery.mock.calls[0]?.[1]).toEqual(['s-1', String(TURN_LEASE_STALE_AFTER_MS)])
    // A live turn under GC pressure or DB latency must never be stolen.
    expect(TURN_LEASE_STALE_AFTER_MS).toBeGreaterThanOrEqual(TURN_HEARTBEAT_INTERVAL_MS * 3)
  })

  it('returns swept rows with visibility so rooms can be told their turn ended', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 's-1', mode: null, user_id: 'u-1', visibility: 'workspace' }],
      rowCount: 1,
    } as never)

    await expect(sweepStuckSessions(90_000)).resolves.toEqual([
      { id: 's-1', mode: null, userId: 'u-1', visibility: 'workspace' },
    ])
  })
})

describe('[COMP:api/turn-lease] ownership guards', () => {
  it('startTurnLease mints a token and clears the previous turn s cancel + reason', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ turn_lease_token: 'tok-1' }],
      rowCount: 1,
    } as never)

    await expect(startTurnLease('s-1')).resolves.toBe('tok-1')
    const sql = sqlOf()
    expect(sql).toContain('gen_random_uuid()')
    expect(sql).toContain('cancel_requested_at = NULL')
    expect(sql).toContain('turn_end_reason = NULL')
  })

  it('touchTurnLease refreshes and reads the cancel flag in ONE statement', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ cancel_requested_at: null }],
      rowCount: 1,
    } as never)

    await expect(touchTurnLease('s-1', 'tok-1')).resolves.toEqual({
      held: true,
      cancelRequested: false,
    })
    // One round trip is what makes a cross-process stop cheap enough to sit on
    // a 20s timer.
    expect(mockQuery).toHaveBeenCalledTimes(1)
    expect(sqlOf()).toContain('RETURNING cancel_requested_at')
    expect(sqlOf()).toContain('turn_lease_token = $2')
  })

  it('reports a requested cancel to the holder', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ cancel_requested_at: new Date() }],
      rowCount: 1,
    } as never)

    await expect(touchTurnLease('s-1', 'tok-1')).resolves.toEqual({
      held: true,
      cancelRequested: true,
    })
  })

  it('reports held:false when the lease was reclaimed under us', async () => {
    // No row matched: our token is no longer the session's. The caller must
    // abort rather than write a reply into a turn it does not own.
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)

    await expect(touchTurnLease('s-1', 'stale-tok')).resolves.toEqual({
      held: false,
      cancelRequested: false,
    })
  })

  it('releaseTurnLease is token-guarded so an orphan cannot unlock its successor', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never)
    await releaseTurnLease('s-1', 'completed', 'tok-1')

    const sql = sqlOf()
    expect(sql).toContain('turn_lease_token = $4')
    expect(mockQuery.mock.calls[0]?.[1]).toEqual(['idle', 'completed', 's-1', 'tok-1'])
  })

  it('releases without a token only for an administrative stop', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never)
    await releaseTurnLease('s-1', 'stopped_by_user', null)

    expect(sqlOf()).not.toContain('turn_lease_token = $4')
    expect(mockQuery.mock.calls[0]?.[1]).toEqual(['idle', 'stopped_by_user', 's-1'])
  })

  it('rests an abnormal ending at timeout, keeping the debugging signal', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never)
    await releaseTurnLease('s-1', 'stalled_reclaimed', null)

    // 'timeout' blocks nothing (only 'running' does) but records that this
    // turn did not end the way it was supposed to.
    expect(mockQuery.mock.calls[0]?.[1]?.[0]).toBe('timeout')
  })

  it('a user-chosen stop rests at idle, because nothing went wrong', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never)
    await releaseTurnLease('s-1', 'stopped_by_user', null)

    expect(mockQuery.mock.calls[0]?.[1]?.[0]).toBe('idle')
  })

  it('requestTurnCancel only marks a session that is actually running', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)

    await expect(requestTurnCancel('s-1')).resolves.toBe(false)
    expect(sqlOf()).toContain("status = 'running'")
  })
})

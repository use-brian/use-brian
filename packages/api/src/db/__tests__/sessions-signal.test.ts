/**
 * Store-seam emission of the `session` workspace primitive (Live roster —
 * docs/architecture/features/live-work.md §4).
 * Component tag: [COMP:api/session-signal].
 *
 * The seams — and ONLY the seams — emit: `updateSessionStatus`,
 * `releaseTurnLease`, `reclaimStaleTurn`, `sweepStuckSessions`. A read
 * (`findSessionById`) must never signal; a guarded write that touched no
 * row must not either. Emission is fire-and-forget through
 * `notifyWorkspaceChange`, resolved to the workspace via the owning
 * assistant.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../client.js', () => ({
  query: vi.fn(),
  queryWithRLS: vi.fn(),
  getPool: vi.fn(),
}))
vi.mock('../../brain-stream/notify.js', () => ({
  notifyWorkspaceChange: vi.fn(),
}))

import {
  claimTurnLeaseOutcome,
  updateSessionStatus,
  releaseTurnLease,
  reclaimStaleTurn,
  sweepStuckSessions,
  findSessionById,
} from '../sessions.js'
import { query } from '../client.js'
import { notifyWorkspaceChange } from '../../brain-stream/notify.js'

const mockQuery = vi.mocked(query)
const mockNotify = vi.mocked(notifyWorkspaceChange)

const SID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const WS = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
const TURN = 'a'.repeat(64)
let transitionResult: unknown
let releaseResult: unknown

/** Flush the fire-and-forget notify IIFE (query await + notify call). */
async function flushSignals() {
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))
}

beforeEach(() => {
  mockQuery.mockReset()
  mockNotify.mockReset()
  releaseResult = { turnId: TURN, reason: 'completed' }
  transitionResult = { state: 'recovered', recovered: { turnId: TURN, reason: 'stalled_reclaimed' } }
  // Default: every write touches one row; the workspace-resolve SELECT
  // finds the owning assistant's workspace.
  mockQuery.mockImplementation(async (sql: string) => {
    if (typeof sql === 'string' && sql.includes('JOIN assistants a')) {
      return { rows: [{ workspaceId: WS }], rowCount: 1 } as never
    }
    if (sql.includes('native_session_release_turn')) return { rows: [{ value: releaseResult }], rowCount: 1 } as never
    if (sql.includes('native_session_turn_transition')) return { rows: [{ value: transitionResult }], rowCount: 1 } as never
    return { rows: [], rowCount: 1 } as never
  })
})

describe('[COMP:api/session-signal] store-seam emission', () => {
  it('resolves the Live destination after a successful claim and isolates a notification failure', async () => {
    const token = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
    transitionResult = { state: 'claimed', token, turnId: TURN, recovered: null }
    mockNotify.mockImplementationOnce(() => { throw new Error('Fictional notification failure') })
    expect(await claimTurnLeaseOutcome(SID)).toEqual({ token, turnId: TURN })
    await flushSignals()
    expect(mockQuery.mock.calls.map(([sql]) => String(sql))).toEqual([
      expect.stringContaining('native_session_turn_transition'), expect.stringContaining('JOIN assistants a'),
    ])
    expect(mockNotify).toHaveBeenCalledWith(WS, 'session', 'update', SID)
    transitionResult = { state: 'busy' }
    expect(await claimTurnLeaseOutcome(SID)).toBeNull()
    expect(mockNotify).toHaveBeenCalledTimes(1)
  })
  it('updateSessionStatus emits one session signal', async () => {
    await updateSessionStatus(SID, 'running')
    await flushSignals()
    expect(mockNotify).toHaveBeenCalledWith(WS, 'session', 'update', SID)
  })

  it('releaseTurnLease emits when the lock was actually released', async () => {
    expect(await releaseTurnLease(SID, 'completed', 'token-1')).toBe(true)
    expect(mockQuery).toHaveBeenCalledWith(expect.any(String), [SID, 'token-1', 'completed'])
    await flushSignals()
    expect(mockNotify).toHaveBeenCalledWith(WS, 'session', 'update', SID)
  })

  it('releaseTurnLease does NOT emit when the guard matched nothing', async () => {
    releaseResult = null
    expect(await releaseTurnLease(SID, 'completed', 'stale-token')).toBe(false)
    await flushSignals()
    expect(mockNotify).not.toHaveBeenCalled()
  })

  it('reclaimStaleTurn emits only when a row was reclaimed', async () => {
    await reclaimStaleTurn(SID)
    await flushSignals()
    expect(mockNotify).toHaveBeenCalledWith(WS, 'session', 'update', SID)

    mockNotify.mockReset()
    transitionResult = { state: 'superseded' }
    await reclaimStaleTurn(SID)
    await flushSignals()
    expect(mockNotify).not.toHaveBeenCalled()
  })

  it('sweepStuckSessions emits only for the captured owners actually recovered', async () => {
    const other = 'cccccccc-cccc-cccc-cccc-cccccccccccc'
    const candidates = [SID, other].map((id, i) => ({ id, token: `owner-${i}`, mode: null,
      userId: `u${i}`, visibility: 'personal', channelType: 'web', anchorKind: 'none' }))
    mockQuery.mockImplementation(async (sql: string, values?: unknown[]) => {
      if (sql.includes('JOIN assistants a')) return { rows: [{ workspaceId: WS }], rowCount: 1 } as never
      if (sql.includes('native_session_turn_transition')) {
        // The second candidate acquired a successor after candidate discovery.
        return { rows: [{ value: values?.[0] === SID ? transitionResult : { state: 'superseded' } }], rowCount: 1 } as never
      }
      return { rows: candidates, rowCount: 2 } as never
    })
    const recovered = await sweepStuckSessions(90_000)
    await flushSignals()
    expect(mockNotify).toHaveBeenCalledTimes(1)
    expect(mockNotify).toHaveBeenCalledWith(WS, 'session', 'update', SID)
    expect(recovered).toEqual([{ id: SID, mode: null, userId: 'u0', visibility: 'personal',
      channelType: 'web', anchorKind: 'none', turnId: TURN, reason: 'stalled_reclaimed' }])
    for (const [i, id] of [SID, other].entries()) {
      expect(mockQuery).toHaveBeenCalledWith(expect.any(String), [id, 'reclaim', null, null, '90000', `owner-${i}`, null, true])
    }
  })

  it('rejects an invalid release result without announcing success', async () => {
    releaseResult = { turnId: 'raw-private-token', reason: 'completed' }
    await expect(releaseTurnLease(SID, 'completed', 'token-1')).rejects.toThrow()
    await flushSignals()
    expect(mockNotify).not.toHaveBeenCalled()
  })

  it('a READ never signals or refreshes recency', async () => {
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 } as never)
    await findSessionById(SID)
    await flushSignals()
    expect(mockNotify).not.toHaveBeenCalled()
  })

  it('a personal-assistant session resolves to a null workspace and is dropped by notifyWorkspaceChange', async () => {
    mockQuery.mockImplementation(async (sql: string) => {
      if (typeof sql === 'string' && sql.includes('JOIN assistants a')) {
        return { rows: [{ workspaceId: null }], rowCount: 1 } as never
      }
      return { rows: [], rowCount: 1 } as never
    })
    await updateSessionStatus(SID, 'idle')
    await flushSignals()
    // The emitter is still invoked — notifyWorkspaceChange's own null guard
    // is the drop point (asserted against the real module elsewhere).
    expect(mockNotify).toHaveBeenCalledWith(null, 'session', 'update', SID)
  })
})

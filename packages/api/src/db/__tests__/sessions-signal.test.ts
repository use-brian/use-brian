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

/** Flush the fire-and-forget notify IIFE (query await + notify call). */
async function flushSignals() {
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))
}

beforeEach(() => {
  mockQuery.mockReset()
  mockNotify.mockReset()
  // Default: every write touches one row; the workspace-resolve SELECT
  // finds the owning assistant's workspace.
  mockQuery.mockImplementation(async (sql: string) => {
    if (typeof sql === 'string' && sql.includes('JOIN assistants a')) {
      return { rows: [{ workspaceId: WS }], rowCount: 1 } as never
    }
    return { rows: [], rowCount: 1 } as never
  })
})

describe('[COMP:api/session-signal] store-seam emission', () => {
  it('updateSessionStatus emits one session signal', async () => {
    await updateSessionStatus(SID, 'running')
    await flushSignals()
    expect(mockNotify).toHaveBeenCalledWith(WS, 'session', 'update', SID)
  })

  it('releaseTurnLease emits when the lock was actually released', async () => {
    await releaseTurnLease(SID, 'completed', 'token-1')
    await flushSignals()
    expect(mockNotify).toHaveBeenCalledWith(WS, 'session', 'update', SID)
  })

  it('releaseTurnLease does NOT emit when the guard matched nothing', async () => {
    mockQuery.mockImplementation(async (sql: string) => {
      if (typeof sql === 'string' && sql.includes('JOIN assistants a')) {
        return { rows: [{ workspaceId: WS }], rowCount: 1 } as never
      }
      return { rows: [], rowCount: 0 } as never
    })
    await releaseTurnLease(SID, 'completed', 'stale-token')
    await flushSignals()
    expect(mockNotify).not.toHaveBeenCalled()
  })

  it('reclaimStaleTurn emits only when a row was reclaimed', async () => {
    await reclaimStaleTurn(SID)
    await flushSignals()
    expect(mockNotify).toHaveBeenCalledWith(WS, 'session', 'update', SID)

    mockNotify.mockReset()
    mockQuery.mockImplementation(async (sql: string) => {
      if (typeof sql === 'string' && sql.includes('JOIN assistants a')) {
        return { rows: [{ workspaceId: WS }], rowCount: 1 } as never
      }
      return { rows: [], rowCount: 0 } as never
    })
    await reclaimStaleTurn(SID)
    await flushSignals()
    expect(mockNotify).not.toHaveBeenCalled()
  })

  it('sweepStuckSessions emits per swept session (coalescer folds per workspace)', async () => {
    const other = 'cccccccc-cccc-cccc-cccc-cccccccccccc'
    mockQuery.mockImplementation(async (sql: string) => {
      if (typeof sql === 'string' && sql.includes('JOIN assistants a')) {
        return { rows: [{ workspaceId: WS }], rowCount: 1 } as never
      }
      return {
        rows: [
          { id: SID, mode: null, user_id: 'u1', visibility: 'owner' },
          { id: other, mode: null, user_id: 'u2', visibility: 'owner' },
        ],
        rowCount: 2,
      } as never
    })
    await sweepStuckSessions(90_000)
    await flushSignals()
    expect(mockNotify).toHaveBeenCalledTimes(2)
    expect(mockNotify).toHaveBeenCalledWith(WS, 'session', 'update', SID)
    expect(mockNotify).toHaveBeenCalledWith(WS, 'session', 'update', other)
  })

  it('a READ never signals (findSessionById refreshes recency, not liveness)', async () => {
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

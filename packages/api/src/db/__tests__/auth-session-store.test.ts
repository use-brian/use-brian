import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createAuthSessionStore,
  deviceLabelFromUserAgent,
} from '../auth-session-store.js'

const USER_ID = '00000000-0000-4000-a000-000000000001'
const SESSION_ID = '00000000-0000-4000-a000-000000000002'

const query = vi.fn()
const txQuery = vi.fn()
const release = vi.fn()
const pool = { connect: vi.fn(async () => ({ query: txQuery, release })) }

function store() {
  return createAuthSessionStore({ query } as never, pool as never)
}

beforeEach(() => {
  vi.resetAllMocks()
})

describe('[COMP:api/auth-sessions] auth session store', () => {
  it('creates a session at the user current auth version', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: SESSION_ID, authVersion: 3 }], rowCount: 1 })
    await expect(store().create(USER_ID, {
      deviceLabel: 'Chrome on macOS',
      userAgent: 'Chrome',
      ipAddress: '203.0.113.10',
    })).resolves.toEqual({ id: SESSION_ID, authVersion: 3 })
    expect(query.mock.calls[0]?.[0]).toContain('INSERT INTO auth_sessions')
  })

  it('admits rollout-era legacy tokens only while auth_version remains zero', async () => {
    query.mockResolvedValueOnce({
      rows: [{ authVersion: 0, sessionId: null, sessionVersion: null, lastSeenAt: null }],
      rowCount: 1,
    })
    await expect(store().validateAccess({ userId: USER_ID })).resolves.toBe(true)
    expect(query.mock.calls[0]?.[1]).toEqual([USER_ID, null, 0])
  })

  it('rejects a claimed session that is revoked, expired, or belongs to another user', async () => {
    query.mockResolvedValueOnce({
      rows: [{ authVersion: 0, sessionId: null, sessionVersion: null, lastSeenAt: null }],
      rowCount: 1,
    })
    await expect(store().validateAccess({
      userId: USER_ID,
      sessionId: SESSION_ID,
      authVersion: 0,
    })).resolves.toBe(false)
  })

  it('upgrades a valid legacy refresh into a tracked session', async () => {
    query
      .mockResolvedValueOnce({
        rows: [{ authVersion: 0, sessionId: null, sessionVersion: null, lastSeenAt: null }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [{ id: SESSION_ID, authVersion: 0 }], rowCount: 1 })
    await expect(store().validateRefresh(
      { userId: USER_ID },
      { deviceLabel: 'Browser', userAgent: null, ipAddress: null },
    )).resolves.toEqual({ id: SESSION_ID, authVersion: 0 })
  })

  it('does not upgrade a legacy refresh across a concurrent logout version bump', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ authVersion: 0, sessionId: null, sessionVersion: null, lastSeenAt: null }] })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
    await expect(store().validateRefresh(
      { userId: USER_ID },
      { deviceLabel: 'Browser', userAgent: null, ipAddress: null },
    )).resolves.toBeNull()
    expect(query.mock.calls[1]?.[0]).toContain('auth_version = $5')
    expect(query.mock.calls[1]?.[1]).toEqual([USER_ID, 'Browser', null, null, 0])
  })

  it('revokes one session only inside its owning account', async () => {
    query.mockResolvedValueOnce({ rows: [], rowCount: 1 })
    await expect(store().revokeForUser(USER_ID, SESSION_ID)).resolves.toBe(true)
    expect(query.mock.calls[0]?.[1]).toEqual([SESSION_ID, USER_ID])
    expect(query.mock.calls[0]?.[0]).toContain('WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL')
  })

  it('returns false without admission when a session is already revoked or absent', async () => {
    query.mockResolvedValueOnce({ rows: [], rowCount: 0 })
    await expect(store().revokeForUser(USER_ID, SESSION_ID)).resolves.toBe(false)
    expect(query).toHaveBeenCalledOnce()
    expect(query.mock.calls[0]?.[0]).toContain('UPDATE auth_sessions')
  })

  it('does not revoke fresh sessions when a concurrent legacy logout already bumped the version', async () => {
    txQuery
      .mockResolvedValueOnce({ rows: [], rowCount: null })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [], rowCount: null })
    await expect(store().revokeAllForUser(USER_ID, 0)).resolves.toBe(false)
    expect(txQuery.mock.calls[1]?.[0]).toContain('auth_version = $2')
    expect(txQuery.mock.calls[1]?.[1]).toEqual([USER_ID, 0])
    expect(txQuery.mock.calls.map((call) => call[0])).toEqual([
      'BEGIN', expect.stringContaining('UPDATE users'), 'ROLLBACK',
    ])
    expect(release).toHaveBeenCalledOnce()
  })

  it('atomically bumps auth_version and revokes every session', async () => {
    txQuery
      .mockResolvedValueOnce({ rows: [], rowCount: null })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 2 })
      .mockResolvedValueOnce({ rows: [], rowCount: null })
    await expect(store().revokeAllForUser(USER_ID)).resolves.toBe(true)
    expect(txQuery.mock.calls.map((call) => call[0])).toEqual([
      'BEGIN',
      expect.stringContaining('auth_version = auth_version + 1'),
      expect.stringContaining('UPDATE auth_sessions'),
      'COMMIT',
    ])
    expect(release).toHaveBeenCalledOnce()
  })
})

describe('[COMP:api/auth-sessions] device labels', () => {
  it('derives a concise browser and operating-system label', () => {
    expect(deviceLabelFromUserAgent(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/140.0 Safari/537.36',
    )).toBe('Chrome on macOS')
  })
})

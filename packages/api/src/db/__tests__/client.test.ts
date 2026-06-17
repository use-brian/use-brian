import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock the pg module before importing client
vi.mock('pg', () => {
  const mockClient = {
    query: vi.fn(),
    release: vi.fn(),
  }
  const mockPool = {
    connect: vi.fn().mockResolvedValue(mockClient),
    query: vi.fn(),
    on: vi.fn(),
  }
  return {
    default: {
      Pool: vi.fn(() => mockPool),
    },
    Pool: vi.fn(() => mockPool),
    __mockPool: mockPool,
    __mockClient: mockClient,
  }
})

import {
  getPool,
  getAppPool,
  query,
  queryWithRLS,
  rollbackAndRelease,
  resolvePoolMax,
  seedCurrentUserIdSentinel,
} from '../client.js'
import pg from 'pg'

// Get the mock pool and client from the mocked pg module
const MockPool = vi.mocked(pg.Pool)
const mockPool = new MockPool() as unknown as {
  connect: ReturnType<typeof vi.fn>
  query: ReturnType<typeof vi.fn>
}
const mockClient = (await mockPool.connect()) as unknown as {
  query: ReturnType<typeof vi.fn>
  release: ReturnType<typeof vi.fn>
}

describe('[COMP:api/db-client] Database client', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mockPool.connect.mockResolvedValue(mockClient)
    mockPool.query.mockResolvedValue({ rows: [], rowCount: 0 })
    mockClient.query.mockResolvedValue({ rows: [], rowCount: 0 })
  })

  // ── pools (two-role model) ──────────────────────────────────

  it('getPool() returns a singleton (the system pool / owner role)', () => {
    expect(getPool()).toBe(getPool())
  })

  it('getAppPool() returns a singleton and seeds current_user_id on connect', () => {
    const appPool = getAppPool()
    expect(appPool).toBe(getAppPool())
    // The app pool installs the connect-seed so SET LOCAL has a valid value to
    // revert to (the Cloud SQL revert-to-'' quirk). The system pool needs none —
    // the owner bypasses RLS, so it never evaluates the current_user_id cast.
    expect((appPool as unknown as { on: ReturnType<typeof vi.fn> }).on).toHaveBeenCalledWith(
      'connect',
      seedCurrentUserIdSentinel,
    )
  })

  it('seedCurrentUserIdSentinel SETs ONLY the nil-UUID current_user_id (no system_bypass GUC anymore)', () => {
    const fakeClient = { query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }) }
    seedCurrentUserIdSentinel(fakeClient as unknown as Parameters<typeof seedCurrentUserIdSentinel>[0])
    expect(fakeClient.query).toHaveBeenCalledWith(
      "SET app.current_user_id = '00000000-0000-0000-0000-000000000000'",
    )
    const seeded = fakeClient.query.mock.calls.map((c) => c[0]).join(' ')
    expect(seeded).not.toContain('system_bypass')
  })

  // ── resolvePoolMax() — fleet connection budget ──────────────

  it('defaults to a budget-safe 4 per pool when PG_POOL_MAX is unset', () => {
    // Two pools per process against the db-f1-micro 25-slot ceiling: a service
    // whose deploy script forgets PG_POOL_MAX must not be able to starve the
    // fleet (the 2026-06-12 brain-500s incident — doc-sync + api-admin ran an
    // unbounded 120-per-pool default and sidanclaw-api could not get a slot).
    expect(resolvePoolMax(undefined)).toBe(4)
  })

  it('honors an explicit PG_POOL_MAX and rejects garbage values', () => {
    expect(resolvePoolMax('8')).toBe(8)
    expect(resolvePoolMax('not-a-number')).toBe(4)
    expect(resolvePoolMax('0')).toBe(4)
    expect(resolvePoolMax('-2')).toBe(4)
  })

  // ── query() — system pool ───────────────────────────────────

  it('executes a bare query on the system pool (owner bypasses RLS)', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [{ id: 'u_1' }], rowCount: 1 })
    const result = await query('SELECT * FROM users WHERE id = $1', ['u_1'])
    expect(result.rows).toEqual([{ id: 'u_1' }])
  })

  // ── queryWithRLS() — app pool, RLS-enforced ─────────────────

  it('scopes via SET LOCAL current_user_id inside a transaction, and sets NO bypass GUC', async () => {
    mockClient.query.mockResolvedValue({ rows: [], rowCount: 0 })

    await queryWithRLS('u_1', 'SELECT * FROM memories', [])

    const calls = mockClient.query.mock.calls.map((c) => c[0])
    expect(calls).toContain('BEGIN')
    expect(calls).toContain("SET LOCAL app.current_user_id = 'u_1'")
    expect(calls).toContain('COMMIT')
    // The defining behavioral change of the two-role model: enforcement comes
    // from the app_user role, NOT from disabling a bypass GUC. If a refactor
    // reintroduces `SET … system_bypass`, this fails.
    expect(calls.some((c: string) => c.includes('system_bypass'))).toBe(false)
  })

  it('releases the client (via rollbackAndRelease) on success and on failure', async () => {
    mockClient.query.mockResolvedValue({ rows: [], rowCount: 0 })
    await queryWithRLS('u_1', 'SELECT 1', [])
    expect(mockClient.release).toHaveBeenCalled()

    vi.clearAllMocks()
    mockClient.query.mockImplementation((sql: string) =>
      sql === 'ROLLBACK' ? Promise.resolve({ rows: [], rowCount: 0 }) : Promise.reject(new Error('DB error')),
    )
    // The mock above rejects everything except ROLLBACK, so the inner query throws.
    await expect(queryWithRLS('u_1', 'BAD SQL', [])).rejects.toThrow()
    expect(mockClient.release).toHaveBeenCalled()
  })

  it('escapes single quotes in userId to prevent SQL injection', async () => {
    mockClient.query.mockResolvedValue({ rows: [], rowCount: 0 })
    await queryWithRLS("user'; DROP TABLE--", 'SELECT 1', [])
    const userIdCall = mockClient.query.mock.calls
      .map((c) => c[0])
      .find((c: string) => c.includes('current_user_id') && c.includes('DROP'))
    expect(userIdCall).toContain("user''; DROP TABLE--")
  })

  // ── rollbackAndRelease() ────────────────────────────────────

  it('ROLLBACKs then releases the client cleanly on the happy path', async () => {
    mockClient.query.mockResolvedValue({ rows: [], rowCount: 0 })
    await rollbackAndRelease(mockClient as unknown as Parameters<typeof rollbackAndRelease>[0])
    expect(mockClient.query).toHaveBeenCalledWith('ROLLBACK')
    // Clean release (no error arg) — pg.Pool re-uses the connection.
    expect(mockClient.release).toHaveBeenCalledWith()
  })

  it('destroys the connection when ROLLBACK fails — never returns a half-aborted client to the pool', async () => {
    const rollbackErr = new Error('Connection terminated unexpectedly')
    mockClient.query.mockImplementation((sql: string) =>
      sql === 'ROLLBACK' ? Promise.reject(rollbackErr) : Promise.resolve({ rows: [], rowCount: 0 }),
    )
    await rollbackAndRelease(mockClient as unknown as Parameters<typeof rollbackAndRelease>[0])
    // release(err) is the truthy "destroy" signal pg.Pool uses.
    expect(mockClient.release).toHaveBeenCalledWith(rollbackErr)
  })

  it('does not throw — cleanup failure must never shadow the caller error', async () => {
    mockClient.query.mockRejectedValue(new Error('boom'))
    await expect(
      rollbackAndRelease(mockClient as unknown as Parameters<typeof rollbackAndRelease>[0]),
    ).resolves.toBeUndefined()
  })
})

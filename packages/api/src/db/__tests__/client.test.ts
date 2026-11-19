import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

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
  resolveStatementTimeoutMs,
  INTERACTIVE_STATEMENT_TIMEOUT_MS,
  BACKGROUND_STATEMENT_TIMEOUT_MS,
  seedCurrentUserIdSentinel,
  transactionReleaseDecision,
  instrumentPoolClient,
  runWithAgentAccess,
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
    // unbounded 120-per-pool default and brian-api could not get a slot).
    expect(resolvePoolMax(undefined)).toBe(4)
  })

  it('honors an explicit PG_POOL_MAX and rejects garbage values', () => {
    expect(resolvePoolMax('8')).toBe(8)
    expect(resolvePoolMax('not-a-number')).toBe(4)
    expect(resolvePoolMax('0')).toBe(4)
    expect(resolvePoolMax('-2')).toBe(4)
  })

  // ── resolveStatementTimeoutMs() — backend lifetime (B1a) ────

  it('defaults to the interactive 15s when PG_STATEMENT_TIMEOUT_MS is unset', () => {
    expect(resolveStatementTimeoutMs(undefined)).toBe(INTERACTIVE_STATEMENT_TIMEOUT_MS)
    expect(resolveStatementTimeoutMs('')).toBe(INTERACTIVE_STATEMENT_TIMEOUT_MS)
    expect(INTERACTIVE_STATEMENT_TIMEOUT_MS).toBe(15_000)
  })

  it('honors the background lane value and an explicit 0 (disabled)', () => {
    expect(resolveStatementTimeoutMs(String(BACKGROUND_STATEMENT_TIMEOUT_MS))).toBe(120_000)
    expect(resolveStatementTimeoutMs(' 120000 ')).toBe(120_000)
    // 0 is the documented escape hatch: no statement_timeout at all.
    expect(resolveStatementTimeoutMs('0')).toBe(0)
  })

  it('falls back to the interactive value on garbage — never to unbounded', () => {
    // A typo'd env var must not silently restore the orphan-backend class that
    // pinned 24 of 25 Cloud SQL slots on 2026-07-29.
    for (const raw of ['not-a-number', '-1', 'NaN', '12s']) {
      expect(resolveStatementTimeoutMs(raw), raw).toBe(INTERACTIVE_STATEMENT_TIMEOUT_MS)
    }
  })

  // ── query() — system pool ───────────────────────────────────

  it('executes a bare query on the system pool (owner bypasses RLS)', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [{ id: 'u_1' }], rowCount: 1 })
    const result = await query('SELECT * FROM users WHERE id = $1', ['u_1'])
    expect(result.rows).toEqual([{ id: 'u_1' }])
  })

  // ── queryWithRLS() — app pool, RLS-enforced ─────────────────

  it('scopes current_user_id transaction-locally with bound parameters and no bypass GUC', async () => {
    mockClient.query.mockResolvedValue({ rows: [], rowCount: 0 })

    await queryWithRLS('u_1', 'SELECT * FROM memories', [])

    const calls = mockClient.query.mock.calls.map((c) => c[0])
    expect(calls).toContain('BEGIN')
    expect(mockClient.query.mock.calls).toContainEqual([
      expect.stringContaining('set_config(setting.name, setting.value, true)'),
      [['app.current_user_id'], ['u_1']],
    ])
    expect(calls).toContain('COMMIT')
    // The defining behavioral change of the two-role model: enforcement comes
    // from the app_user role, NOT from disabling a bypass GUC. If a refactor
    // reintroduces `SET … system_bypass`, this fails.
    expect(calls.some((c: string) => c.includes('system_bypass'))).toBe(false)
  })

  it('disables repeated JIT compilation with the transaction-local agent settings', async () => {
    await runWithAgentAccess({ clearance: 'internal', compartments: [] },
      () => queryWithRLS('u_1', 'SELECT 1'))

    const setup = mockClient.query.mock.calls.find(([sql]) => sql.includes('set_config'))!
    expect(setup[0]).toContain('set_config(setting.name, setting.value, true)')
    const [names, values] = setup[1] as [string[], string[]]
    expect(values[names.indexOf('jit')]).toBe('off')
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

  it('binds hostile userId text as data without SQL interpolation', async () => {
    mockClient.query.mockResolvedValue({ rows: [], rowCount: 0 })
    await queryWithRLS("user'; DROP TABLE--", 'SELECT 1', [])
    const config = mockClient.query.mock.calls.find(c => c[0].includes('set_config'))!
    expect(config[0]).not.toContain('DROP')
    expect(config[1]).toEqual([['app.current_user_id'], ["user'; DROP TABLE--"]])
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

  // ── committed-state release contract ────────────────────────
  // Spec: database-schema.md → "Transaction completion and release".

  it('queryWithRLS sends exactly BEGIN, set_config, the statement and COMMIT, then releases without ROLLBACK', async () => {
    mockClient.query.mockResolvedValue({ rows: [], rowCount: 0 })
    await queryWithRLS('u_1', 'SELECT 1', [])
    const calls = mockClient.query.mock.calls.map((c) => c[0] as string)
    expect(calls).toHaveLength(4)
    expect(calls[0]).toBe('BEGIN')
    expect(calls[1]).toContain('set_config(setting.name, setting.value, true)')
    expect(calls[2]).toBe('SELECT 1')
    expect(calls[3]).toBe('COMMIT')
    expect(calls).not.toContain('ROLLBACK')
    expect(mockClient.release).toHaveBeenCalledTimes(1)
    expect(mockClient.release).toHaveBeenCalledWith()
  })

  it('queryWithRLS destroys the client when COMMIT itself throws (uncertain outcome)', async () => {
    const commitErr = new Error('could not serialize access')
    mockClient.query.mockImplementation((sql: string) =>
      sql === 'COMMIT' ? Promise.reject(commitErr) : Promise.resolve({ rows: [], rowCount: 0 }),
    )
    await expect(queryWithRLS('u_1', 'SELECT 1', [])).rejects.toBe(commitErr)
    expect(mockClient.release).toHaveBeenCalledTimes(1)
    expect(mockClient.release).toHaveBeenCalledWith(commitErr)
    expect(mockClient.query.mock.calls.map((c) => c[0])).not.toContain('ROLLBACK')
  })

  function statefulClient(state: { status?: string | null; ready?: boolean; queryable?: boolean }) {
    const client = {
      query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
      release: vi.fn(),
      readyForQuery: state.ready ?? true,
      _queryable: state.queryable ?? true,
      _ending: false,
      getTransactionStatus: () => state.status ?? null,
    }
    return client as typeof client & Parameters<typeof rollbackAndRelease>[0]
  }

  it('releases an idle (committed) client directly — no ROLLBACK round trip', async () => {
    const client = statefulClient({ status: 'I' })
    expect(transactionReleaseDecision(client)).toBe('release')
    await rollbackAndRelease(client)
    expect(client.query).not.toHaveBeenCalled()
    expect(client.release).toHaveBeenCalledWith()
  })

  it('rolls back an unfinished or failed transaction, and an idle status while a statement is in flight', async () => {
    for (const state of [{ status: 'T' }, { status: 'E' }, { status: 'I', ready: false }, { status: null }]) {
      const client = statefulClient(state)
      expect(transactionReleaseDecision(client), JSON.stringify(state)).toBe('rollback')
      await rollbackAndRelease(client)
      expect(client.query).toHaveBeenCalledWith('ROLLBACK')
      expect(client.release).toHaveBeenCalledWith()
    }
  })

  it('destroys a broken connection without attempting ROLLBACK', async () => {
    const client = statefulClient({ status: 'T', queryable: false })
    await rollbackAndRelease(client)
    expect(client.query).not.toHaveBeenCalled()
    expect(client.release).toHaveBeenCalledWith(expect.any(Error))
  })

  it('a store-style raw COMMIT rejection on an instrumented client destroys it at release', async () => {
    const commitErr = new Error('deferred constraint violated')
    class FakeClient {
      readyForQuery = true
      release = vi.fn()
      getTransactionStatus() { return 'I' }
      query(sql: string) { return sql === 'COMMIT' ? Promise.reject(commitErr) : Promise.resolve({ rows: [], rowCount: 0 }) }
    }
    const client = new FakeClient()
    instrumentPoolClient(client as unknown as Parameters<typeof instrumentPoolClient>[0], 'app')
    instrumentPoolClient(client as unknown as Parameters<typeof instrumentPoolClient>[0], 'app') // idempotent
    const pooled = client as unknown as Parameters<typeof rollbackAndRelease>[0]
    try {
      await pooled.query('BEGIN')
      await pooled.query('COMMIT')
    } catch (err) {
      expect(err).toBe(commitErr)
    } finally {
      await rollbackAndRelease(pooled)
    }
    expect(client.release).toHaveBeenCalledWith(commitErr)
  })

  it('instrumentation forwards callback and promise overloads unchanged', async () => {
    class FakeClient {
      query(sql: string, values?: unknown, cb?: (err: Error | null, res?: unknown) => void) {
        if (typeof values === 'function') { cb = values as typeof cb; values = undefined }
        const res = { rows: [{ sql }], rowCount: 1 }
        if (cb) { setImmediate(() => cb!(null, res)); return undefined }
        return Promise.resolve(res)
      }
    }
    const client = new FakeClient()
    instrumentPoolClient(client as unknown as Parameters<typeof instrumentPoolClient>[0], 'system')
    await expect(client.query('SELECT 1')).resolves.toEqual({ rows: [{ sql: 'SELECT 1' }], rowCount: 1 })
    const viaCallback = await new Promise((resolve) => client.query('SELECT 2', [], (_err, res) => resolve(res)))
    expect(viaCallback).toEqual({ rows: [{ sql: 'SELECT 2' }], rowCount: 1 })
  })

  it('installs the instrumentation on both pools', async () => {
    vi.resetModules()
    vi.stubEnv('PG_SINGLE_CONNECTION', '')
    vi.stubEnv('DATABASE_URL_APP', 'postgres://app_user@localhost/db')
    try {
      const fresh = await import('../client.js')
      const pool = mockPool as unknown as { on: ReturnType<typeof vi.fn> }
      pool.on.mockClear()
      fresh.getPool()
      fresh.getAppPool()
      const events = pool.on.mock.calls.map((c) => c[0])
      expect(events.filter((e) => e === 'acquire')).toHaveLength(2)
      expect(events.filter((e) => e === 'connect')).toHaveLength(3) // two instrumentations + the app seed
    } finally {
      vi.unstubAllEnvs()
    }
  })
})

// ── getAppPool production fail-closed ──────────────────────────
//
// A missing DATABASE_URL_APP used to warn and silently fall back to the
// OWNER connection — which bypasses RLS — in every environment. In a
// production context (NODE_ENV=production or Cloud Run's K_SERVICE) that
// fallback must be a boot failure, not a silent isolation-off.
describe('[COMP:api/db-client] getAppPool production fail-closed', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  async function freshClient() {
    vi.resetModules()
    return await import('../client.js')
  }

  it('throws under NODE_ENV=production when DATABASE_URL_APP is unset', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('DATABASE_URL_APP', '')
    vi.stubEnv('PG_SINGLE_CONNECTION', '')
    const fresh = await freshClient()
    expect(() => fresh.getAppPool()).toThrow(/DATABASE_URL_APP/)
  })

  it('throws on Cloud Run (K_SERVICE) even without NODE_ENV=production', async () => {
    vi.stubEnv('NODE_ENV', 'test')
    vi.stubEnv('K_SERVICE', 'brian-api')
    vi.stubEnv('DATABASE_URL_APP', '')
    vi.stubEnv('PG_SINGLE_CONNECTION', '')
    const fresh = await freshClient()
    expect(() => fresh.getAppPool()).toThrow(/DATABASE_URL_APP/)
  })

  it('applies statement_timeout as a startup option on BOTH pools, never as a SET', async () => {
    // B1a (corpus-substrate-hardening §3): the cap must arrive in the libpq
    // startup packet, not from a fire-and-forget `connect` handler that races
    // the checkout's first query.
    vi.stubEnv('NODE_ENV', 'test')
    vi.stubEnv('PG_SINGLE_CONNECTION', '')
    vi.stubEnv('PG_STATEMENT_TIMEOUT_MS', '')
    vi.stubEnv('DATABASE_URL_APP', 'postgres://app_user@localhost/db')
    const fresh = await freshClient()
    const Pool = vi.mocked((await import('pg')).default.Pool)
    Pool.mockClear()
    fresh.getPool()
    fresh.getAppPool()
    const configs = Pool.mock.calls.map((c) => c[0] as { options?: string })
    expect(configs).toHaveLength(2)
    for (const cfg of configs) {
      expect(cfg.options).toBe('-c statement_timeout=15000')
    }
  })

  it('omits the option entirely when the timeout is disabled with 0', async () => {
    vi.stubEnv('NODE_ENV', 'test')
    vi.stubEnv('PG_SINGLE_CONNECTION', '')
    vi.stubEnv('PG_STATEMENT_TIMEOUT_MS', '0')
    vi.stubEnv('DATABASE_URL_APP', 'postgres://app_user@localhost/db')
    const fresh = await freshClient()
    const Pool = vi.mocked((await import('pg')).default.Pool)
    Pool.mockClear()
    fresh.getPool()
    const cfg = Pool.mock.calls[0]?.[0] as { options?: string }
    expect(cfg.options).toBeUndefined()
  })

  it('PG_SINGLE_CONNECTION collapses to ONE pool that still carries the interactive cap', async () => {
    // The PGLite OSS path: one pool, interactive value — there is no second
    // lane to hand a different timeout to.
    vi.stubEnv('NODE_ENV', 'test')
    vi.stubEnv('PG_SINGLE_CONNECTION', '1')
    vi.stubEnv('PG_STATEMENT_TIMEOUT_MS', '')
    const fresh = await freshClient()
    const Pool = vi.mocked((await import('pg')).default.Pool)
    Pool.mockClear()
    expect(fresh.getAppPool()).toBe(fresh.getPool())
    expect(Pool.mock.calls).toHaveLength(1)
    const cfg = Pool.mock.calls[0]![0] as { options?: string; max?: number }
    expect(cfg.options).toBe('-c statement_timeout=15000')
    expect(cfg.max).toBe(1)
  })

  it('falls back with a loud warning outside production', async () => {
    vi.stubEnv('NODE_ENV', 'test')
    vi.stubEnv('DATABASE_URL_APP', '')
    vi.stubEnv('PG_SINGLE_CONNECTION', '')
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const fresh = await freshClient()
      expect(fresh.getAppPool()).toBeDefined()
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('DATABASE_URL_APP'))
    } finally {
      warnSpy.mockRestore()
    }
  })
})

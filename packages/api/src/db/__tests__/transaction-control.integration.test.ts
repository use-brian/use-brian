import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * Transaction-control statements at the real PostgreSQL boundary.
 *
 * Counts what one protected `queryWithRLS` actually sends on its pooled
 * connection, and what the server says back, through an outer proxy that is
 * independent of the db-layer instrumentation: the issued statement texts,
 * the protocol ReadyForQuery messages (round trips) and server notices (the
 * old helper drew `there is no transaction in progress` after every commit).
 * Also proves the failure half of the contract: a failing statement rolls
 * back and the connection is reused idle; a failing COMMIT and a terminated
 * backend destroy the client, for `queryWithRLS` and for a store-style
 * manual transaction alike.
 *
 * Runs only inside the maintained disposable fixture (BRIAN_ASSURANCE_FIXTURE,
 * see docs/workflow/testing.md); never against an ambient developer database.
 *
 * Spec: docs/architecture/platform/database-schema.md → "Transaction
 * completion and release (committed-state contract)" and "Per-turn SQL
 * accounting frames". Component-map tags: [COMP:api/db-client],
 * [COMP:api/db-turn-sql-accounting].
 */

// One backend per pool, so "same connection reused" vs "destroyed" is observable.
process.env.PG_POOL_MAX = '1'

const fixture = Boolean(process.env.BRIAN_ASSURANCE_FIXTURE && process.env.DATABASE_URL)
const describeIf = fixture ? describe : describe.skip
if (!fixture) console.log('[transaction-control integration] skipped — run inside the disposable fixture (BRIAN_ASSURANCE_FIXTURE).')

const { query, queryWithRLS, getPool, getAppPool, rollbackAndRelease, applyRLSGucs, commitTransaction } = await import('../client.js')
const { withTurnFrame, setTurnSqlRecording, takeTurnSqlLedger, turnSqlCounters } = await import('../turn-sql-accounting.js')

const USER = '00000000-0000-4000-8000-0000000000a1'
const TABLE = `_txcontrol_probe_${randomUUID().replace(/-/g, '').slice(0, 12)}`

type Observed = { statements: string[]; readyForQuery: number; notices: string[] }
let observed: Observed = { statements: [], readyForQuery: 0, notices: [] }
const releases: Array<{ destroyed: boolean }> = []
const observedClients = new WeakSet<object>()

function observe(client: pg.PoolClient): void {
  if (observedClients.has(client)) return
  observedClients.add(client)
  const inner = client.query
  // Outer proxy over the db-layer instrumentation: records only what is sent.
  ;(client as unknown as { query: (...args: unknown[]) => unknown }).query = function (this: unknown, ...args: unknown[]) {
    const first = args[0] as string | { text?: string }
    observed.statements.push(typeof first === 'string' ? first : first?.text ?? '<submittable>')
    return Reflect.apply(inner as (...a: unknown[]) => unknown, this, args)
  }
  ;(client as unknown as { connection: { on(event: string, fn: () => void): void } }).connection
    .on('readyForQuery', () => { observed.readyForQuery++ })
  client.on('notice', (msg) => { observed.notices.push(msg.message ?? '') })
  // A backend terminated while checked out must not crash the test process.
  client.on('error', () => {})
}

function reset(): void {
  observed = { statements: [], readyForQuery: 0, notices: [] }
  releases.length = 0
}

const backendPid = async () => (await queryWithRLS<{ pid: number }>(USER, 'SELECT pg_backend_pid() AS pid')).rows[0]!.pid

beforeAll(async () => {
  if (!fixture) return
  const app = getAppPool()
  app.on('acquire', (client) => observe(client))
  app.on('release', (err) => { releases.push({ destroyed: Boolean(err) }) })
  const role = (await queryWithRLS<{ u: string }>(USER, 'SELECT current_user AS u')).rows[0]!.u
  await query(`CREATE TABLE ${TABLE} (id int UNIQUE DEFERRABLE INITIALLY DEFERRED)`)
  await query(`GRANT SELECT, INSERT, DELETE ON ${TABLE} TO "${role.replace(/"/g, '""')}"`)
})

afterAll(async () => {
  if (fixture) await query(`DROP TABLE IF EXISTS ${TABLE}`).catch(() => {})
  setTurnSqlRecording(undefined)
  await getPool().end().catch(() => {})
  await getAppPool().end().catch(() => {})
})

describe('[COMP:api/db-client] Transaction control at the PostgreSQL boundary', () => {
  describeIf('committed-state release contract', () => {
    it('one successful protected query is BEGIN, set_config, the statement and COMMIT — no ROLLBACK, no warning', async () => {
      await backendPid() // warm the connection so the connect seed is not counted
      reset()
      const result = await queryWithRLS<{ one: number }>(USER, 'SELECT 1 AS one')
      expect(result.rows).toEqual([{ one: 1 }])
      expect(observed.statements).toHaveLength(4)
      expect(observed.statements[0]).toBe('BEGIN')
      expect(observed.statements[1]).toContain('set_config(setting.name, setting.value, true)')
      expect(observed.statements[2]).toBe('SELECT 1 AS one')
      expect(observed.statements[3]).toBe('COMMIT')
      expect(observed.statements.filter((s) => /ROLLBACK/i.test(s))).toEqual([])
      expect(observed.readyForQuery).toBe(4)
      expect(observed.notices).toEqual([])
      expect(releases).toEqual([{ destroyed: false }])
    })

    it('keeps the RLS settings transaction-local: nothing survives onto the pooled connection', async () => {
      const inside = await queryWithRLS<{ u: string }>(USER, "SELECT current_setting('app.current_user_id', true) AS u")
      expect(inside.rows[0]!.u).toBe(USER)
      const client = await getAppPool().connect()
      try {
        const after = await client.query<{ u: string | null }>("SELECT current_setting('app.current_user_id', true) AS u")
        expect(after.rows[0]!.u).not.toBe(USER)
      } finally {
        await rollbackAndRelease(client)
      }
    })

    it('a failing statement rolls back and the same connection is reused, idle', async () => {
      const pid = await backendPid()
      reset()
      await expect(queryWithRLS(USER, 'SELECT * FROM _txcontrol_missing_relation')).rejects.toMatchObject({ code: '42P01' })
      expect(observed.statements.at(-1)).toBe('ROLLBACK')
      expect(observed.notices).toEqual([])
      expect(releases).toEqual([{ destroyed: false }])
      expect(await backendPid()).toBe(pid)
    })

    it('a failing COMMIT destroys the client instead of pooling it', async () => {
      const pid = await backendPid()
      reset()
      await expect(queryWithRLS(USER, `INSERT INTO ${TABLE} (id) VALUES (1), (1)`)).rejects.toMatchObject({ code: '23505' })
      expect(observed.statements.at(-1)).toBe('COMMIT')
      expect(observed.statements.filter((s) => /ROLLBACK/i.test(s))).toEqual([])
      expect(releases).toEqual([{ destroyed: true }])
      expect(await backendPid()).not.toBe(pid)
      expect((await query<{ n: number }>(`SELECT count(*)::int AS n FROM ${TABLE}`)).rows[0]!.n).toBe(0)
    })

    it('a store-style manual transaction releases without ROLLBACK after COMMIT', async () => {
      await backendPid()
      reset()
      const client = await getAppPool().connect()
      try {
        await client.query('BEGIN')
        await applyRLSGucs(client, USER)
        await client.query(`INSERT INTO ${TABLE} (id) VALUES (10)`)
        await client.query('COMMIT')
      } finally {
        await rollbackAndRelease(client)
      }
      expect(observed.statements.filter((s) => /ROLLBACK/i.test(s))).toEqual([])
      expect(observed.notices).toEqual([])
      expect(releases).toEqual([{ destroyed: false }])
      await query(`DELETE FROM ${TABLE}`)
    })

    it('a store-style raw COMMIT failure destroys the client too', async () => {
      const pid = await backendPid()
      reset()
      const client = await getAppPool().connect()
      try {
        await client.query('BEGIN')
        await applyRLSGucs(client, USER)
        await client.query(`INSERT INTO ${TABLE} (id) VALUES (2), (2)`)
        await expect(client.query('COMMIT')).rejects.toMatchObject({ code: '23505' })
      } finally {
        await rollbackAndRelease(client)
      }
      expect(releases).toEqual([{ destroyed: true }])
      expect(await backendPid()).not.toBe(pid)
    })

    it('an unfinished store transaction is rolled back and its writes discarded', async () => {
      reset()
      const client = await getAppPool().connect()
      try {
        await client.query('BEGIN')
        await applyRLSGucs(client, USER)
        await client.query(`INSERT INTO ${TABLE} (id) VALUES (3)`)
        // caller returns early without COMMIT
      } finally {
        await rollbackAndRelease(client)
      }
      expect(observed.statements.at(-1)).toBe('ROLLBACK')
      expect(releases).toEqual([{ destroyed: false }])
      expect((await query<{ n: number }>(`SELECT count(*)::int AS n FROM ${TABLE}`)).rows[0]!.n).toBe(0)
    })

    it('a terminated backend is destroyed, not returned to the pool', async () => {
      const pid = await backendPid()
      reset()
      const client = await getAppPool().connect()
      try {
        await client.query('BEGIN')
        // A role may signal its own backends, so this needs no owner privilege.
        await expect(client.query('SELECT pg_terminate_backend(pg_backend_pid())')).rejects.toBeTruthy()
      } finally {
        await rollbackAndRelease(client)
      }
      // The FATAL reply can reach the caller before the socket close marks the
      // client unqueryable, so a ROLLBACK may be attempted; it fails and the
      // client is destroyed either way. What must never happen is a clean release.
      expect(releases).toEqual([{ destroyed: true }])
      expect(await backendPid()).not.toBe(pid)
    })

    it('commitTransaction marks an uncertain outcome for its caller', async () => {
      reset()
      const client = await getAppPool().connect()
      try {
        await client.query('BEGIN')
        await client.query(`INSERT INTO ${TABLE} (id) VALUES (4), (4)`)
        await expect(commitTransaction(client)).rejects.toMatchObject({ code: '23505' })
      } finally {
        await rollbackAndRelease(client)
      }
      expect(releases).toEqual([{ destroyed: true }])
    })
  })
})

describe('[COMP:api/db-turn-sql-accounting] Per-turn SQL accounting on the real pools', () => {
  describeIf('recorder', () => {
    it('attributes one protected query to its frame: four statements, three control, app pool, no ROLLBACK', async () => {
      await backendPid()
      setTurnSqlRecording(true)
      try {
        await withTurnFrame({ turnId: 'turn-int', frameId: 'protected-read' }, () =>
          queryWithRLS(USER, `SELECT id FROM ${TABLE} WHERE id = $1 OR id = 7`, [5]))
      } finally {
        setTurnSqlRecording(undefined)
      }
      const ledger = takeTurnSqlLedger('turn-int')!
      expect(ledger.statements.map((s) => s.shape)).toEqual([
        'BEGIN',
        'SELECT set_config(setting.name, setting.value, true) FROM unnest(?::text[], ?::text[]) AS setting(name, value)',
        `SELECT id FROM ${TABLE} WHERE id = ? OR id = ?`,
        'COMMIT',
      ])
      expect(ledger.statements.every((s) => s.pool === 'app' && s.frameId === 'protected-read' && s.ok)).toBe(true)
      expect(ledger.statements.map((s) => s.paramCount)).toEqual([0, 2, 1, 0])
      expect(turnSqlCounters(ledger)).toMatchObject({ sql_statement_count: 4, sql_control_count: 3, sql_app_count: 4, sql_system_count: 0 })
    })

    it('charges callback-form pool.query to the submitting frame across nested frames and a waited checkout', async () => {
      // PG_POOL_MAX=1: the system pool has one connection. Open it inside frame
      // `f`, so its socket completions run in f's async context. Then frames g1
      // and g2 submit concurrently with the callback form `pool.query` uses
      // (the lease helpers' path); g2 waits for g1's release.
      const callbackQuery = (sql: string) => new Promise<void>((resolve, reject) =>
        getPool().query(sql, [], (err: Error | undefined) => (err ? reject(err) : resolve())))
      // Destroy the pooled connection, so the next one is opened inside f.
      const recycled = await getPool().connect()
      recycled.release(new Error('recycle for frame-attribution test'))
      setTurnSqlRecording(true)
      try {
        await withTurnFrame({ turnId: 'turn-cb', frameId: 'f' }, async () => {
          await new Promise<void>((resolve, reject) =>
            getPool().query('SELECT 1 AS opened_in_f', [], (err: Error | undefined) => (err ? reject(err) : resolve())))
          await Promise.all([
            withTurnFrame({ turnId: 'turn-cb', frameId: 'g1' }, () => callbackQuery('SELECT 2 AS claim')),
            withTurnFrame({ turnId: 'turn-cb', frameId: 'g2' }, () => callbackQuery('SELECT 3 AS heartbeat')),
          ])
        })
      } finally {
        setTurnSqlRecording(undefined)
      }
      const ledger = takeTurnSqlLedger('turn-cb')!
      expect(ledger.statements.map((s) => [s.shape, s.frameId, s.pool])).toEqual([
        ['SELECT ? AS opened_in_f', 'f', 'system'],
        ['SELECT ? AS claim', 'g1', 'system'],
        ['SELECT ? AS heartbeat', 'g2', 'system'],
      ])
      expect(ledger.statements.slice(1).every((s) => s.parentFrameId === 'f')).toBe(true)
    })

    it('records nothing outside a frame on the real pools', async () => {
      setTurnSqlRecording(true)
      try {
        await queryWithRLS(USER, 'SELECT 1')
        await query('SELECT 1')
      } finally {
        setTurnSqlRecording(undefined)
      }
      expect(takeTurnSqlLedger('turn-int')).toBeUndefined()
    })
  })
})

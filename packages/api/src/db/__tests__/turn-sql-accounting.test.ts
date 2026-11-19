import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  TURN_SQL_MAX_FINGERPRINTS,
  TURN_SQL_MAX_STATEMENTS,
  TURN_SQL_MAX_TURNS,
  TURN_SQL_SHAPE_MAX_CHARS,
  currentTurnFrame,
  fingerprintSql,
  isControlStatement,
  readTurnSqlLedger,
  recordTurnSqlStatement,
  resetTurnSqlLedgers,
  setTurnSqlRecording,
  takeTurnSqlLedger,
  turnSqlCounters,
  turnSqlRecordingEnabled,
  withTurnFrame,
} from '../turn-sql-accounting.js'
import { instrumentPoolClient } from '../client.js'

/**
 * Spec: docs/architecture/platform/database-schema.md → "Per-turn SQL
 * accounting frames". The real-pool path is covered in
 * transaction-control.integration.test.ts.
 */

const record = (text: string, extra: Partial<Parameters<typeof recordTurnSqlStatement>[0]> = {}) =>
  recordTurnSqlStatement({ text, paramCount: 0, pool: 'app', elapsedMs: 1, ok: true, ...extra })

describe('[COMP:api/db-turn-sql-accounting] Per-turn SQL accounting', () => {
  beforeEach(() => {
    resetTurnSqlLedgers()
    setTurnSqlRecording(true)
  })
  afterEach(() => {
    setTurnSqlRecording(undefined)
    resetTurnSqlLedgers()
  })

  describe('fingerprint normalization', () => {
    it('strips string, numeric and placeholder literals and collapses whitespace', () => {
      const a = fingerprintSql(`SELECT *   FROM memories\n WHERE user_id = 'alice@example.com' AND score > 0.75 AND id = $1 LIMIT 20`)
      const b = fingerprintSql(`select *   FROM memories WHERE user_id = 'bob' AND score > 3 AND id = $7 LIMIT 5;`.replace('select', 'SELECT'))
      expect(a.shape).toBe('SELECT * FROM memories WHERE user_id = ? AND score > ? AND id = ? LIMIT ?')
      expect(a.hash).toBe(b.hash)
      expect(a.hash).toMatch(/^[0-9a-f]{16}$/)
      expect(a.shape).not.toContain('alice')
    })

    it('handles escaped quotes, E-strings, dollar quotes and comments in one pass', () => {
      const { shape } = fingerprintSql(
        `/* caller: it's here */ SELECT 'it''s', E'a\\'b', $body$ secret -- text $body$, $$x$$ -- trailing 'note\nFROM t`,
      )
      expect(shape).toBe('SELECT ?, ?, ?, ? FROM t')
      expect(shape).not.toMatch(/secret|note|caller/)
    })

    it('keeps identifiers with digits and quoted identifiers, collapses value lists', () => {
      expect(fingerprintSql('SELECT t1.col_2 FROM "Table9" t1 WHERE id IN (1, 2, 3)').shape)
        .toBe('SELECT t1.col_2 FROM "Table9" t1 WHERE id IN (?...)')
      expect(fingerprintSql('INSERT INTO x VALUES ($1, $2), ($3, $4), ($5, $6)').shape)
        .toBe('INSERT INTO x VALUES (?...),...')
      expect(fingerprintSql('SELECT ARRAY[1,2,3]').shape).toBe('SELECT ARRAY[?...]')
    })

    it('truncates the retained shape but hashes the full normalized text', () => {
      const long = `SELECT ${Array.from({ length: 200 }, (_, i) => `col_${i}`).join(', ')} FROM t`
      const other = long.replace('col_199', 'col_x')
      const a = fingerprintSql(long), b = fingerprintSql(other)
      expect(a.shape).toHaveLength(TURN_SQL_SHAPE_MAX_CHARS)
      expect(a.shape).toBe(b.shape)
      expect(a.hash).not.toBe(b.hash)
    })

    it('classifies transaction and setting statements as control', () => {
      for (const sql of ['BEGIN', 'COMMIT', 'ROLLBACK', 'SAVEPOINT s1', 'RELEASE SAVEPOINT s1', "SET app.current_user_id = 'x'",
        'SELECT set_config(setting.name, setting.value, true) FROM unnest($1::text[], $2::text[]) AS setting(name, value)']) {
        expect(isControlStatement(sql), sql).toBe(true)
      }
      for (const sql of ['SELECT 1', 'UPDATE sessions SET status = $1', 'WITH x AS (SELECT 1) SELECT * FROM x']) {
        expect(isControlStatement(sql), sql).toBe(false)
      }
    })
  })

  describe('frames', () => {
    it('records nothing without an active frame', () => {
      record('SELECT 1')
      expect(currentTurnFrame()).toBeUndefined()
      expect(readTurnSqlLedger('t-none')).toBeUndefined()
    })

    it('records nothing while recording is disabled, even inside a frame', () => {
      setTurnSqlRecording(false)
      expect(turnSqlRecordingEnabled()).toBe(false)
      withTurnFrame({ turnId: 't-off', frameId: 'f' }, () => record('SELECT 1'))
      expect(readTurnSqlLedger('t-off')).toBeUndefined()
    })

    it('defaults off when the environment flag is absent', () => {
      setTurnSqlRecording(undefined)
      expect(turnSqlRecordingEnabled()).toBe(process.env.BRIAN_TURN_SQL_ACCOUNTING === '1')
    })

    it('nests frames, sharing the ledger of the same turn and attributing parents', async () => {
      await withTurnFrame({ turnId: 't1', frameId: 'admission' }, async () => {
        record('BEGIN')
        await withTurnFrame({ turnId: 't1', frameId: 'audience' }, async () => {
          await Promise.resolve()
          expect(currentTurnFrame()).toEqual({ turnId: 't1', frameId: 'audience', parentFrameId: 'admission', depth: 1 })
          record('SELECT 1 FROM members WHERE id = $1', { paramCount: 1 })
        })
        expect(currentTurnFrame()?.frameId).toBe('admission')
        record('COMMIT')
      })
      const ledger = readTurnSqlLedger('t1')!
      expect(ledger.statements.map((s) => [s.frameId, s.parentFrameId, s.depth, s.control])).toEqual([
        ['admission', null, 0, true],
        ['audience', 'admission', 1, false],
        ['admission', null, 0, true],
      ])
      expect(ledger.statements[1]!.paramCount).toBe(1)
      expect(ledger.totals).toMatchObject({ statements: 3, control: 2, frames: 2 })
    })

    it('a nested frame of a different turn records only into its own ledger', () => {
      withTurnFrame({ turnId: 'outer', frameId: 'a' }, () => {
        record('SELECT 1')
        withTurnFrame({ turnId: 'inner', frameId: 'b' }, () => record('SELECT 2'))
      })
      expect(readTurnSqlLedger('outer')!.totals.statements).toBe(1)
      const inner = readTurnSqlLedger('inner')!
      expect(inner.totals.statements).toBe(1)
      expect(inner.statements[0]!.parentFrameId).toBe('a')
    })

    it('isolates concurrent frames across awaits', async () => {
      await Promise.all(['x', 'y'].map((turnId) => withTurnFrame({ turnId, frameId: turnId }, async () => {
        for (let i = 0; i < 5; i++) { await new Promise((r) => setTimeout(r, 1)); record(`SELECT ${i}`) }
      })))
      expect(readTurnSqlLedger('x')!.statements.every((s) => s.frameId === 'x')).toBe(true)
      expect(readTurnSqlLedger('y')!.totals.statements).toBe(5)
    })
  })

  describe('bounds', () => {
    it('caps retained statements and fingerprints but keeps complete totals', () => {
      const extra = 25
      withTurnFrame({ turnId: 'big', frameId: 'f' }, () => {
        for (let i = 0; i < TURN_SQL_MAX_STATEMENTS + extra; i++) record(`SELECT col_${i % (TURN_SQL_MAX_FINGERPRINTS + 10)} FROM t`)
      })
      const ledger = readTurnSqlLedger('big')!
      expect(ledger.statements).toHaveLength(TURN_SQL_MAX_STATEMENTS)
      expect(ledger.totals.statements).toBe(TURN_SQL_MAX_STATEMENTS + extra)
      expect(ledger.overflow.statements).toBe(extra)
      expect(ledger.fingerprints).toHaveLength(TURN_SQL_MAX_FINGERPRINTS)
      expect(ledger.overflow.fingerprints).toBeGreaterThan(0)
      const counters = turnSqlCounters(ledger)
      expect(counters.sql_statement_count).toBe(TURN_SQL_MAX_STATEMENTS + extra)
      expect(counters.sql_statement_overflow_count).toBe(extra)
      expect(Object.values(counters).every(Number.isInteger)).toBe(true)
    })

    it('retains at most TURN_SQL_MAX_TURNS turns, evicting the oldest', () => {
      for (let i = 0; i <= TURN_SQL_MAX_TURNS; i++) withTurnFrame({ turnId: `turn-${i}`, frameId: 'f' }, () => record('SELECT 1'))
      expect(readTurnSqlLedger('turn-0')).toBeUndefined()
      expect(readTurnSqlLedger(`turn-${TURN_SQL_MAX_TURNS}`)).toBeDefined()
    })

    it('returns immutable snapshots and take() forgets the turn', () => {
      withTurnFrame({ turnId: 'snap', frameId: 'f' }, () => { record('SELECT 1'); record('SELECT 2'); record('ROLLBACK', { ok: false }) })
      const ledger = takeTurnSqlLedger('snap')!
      expect(Object.isFrozen(ledger.statements)).toBe(true)
      expect(turnSqlCounters(ledger)).toMatchObject({
        sql_statement_count: 3, sql_control_count: 1, sql_failed_count: 1, sql_fingerprint_count: 2, sql_repeat_count: 1,
      })
      expect(readTurnSqlLedger('snap')).toBeUndefined()
    })
  })

  describe('pool client recorder', () => {
    class FakeClient {
      query(_sql: string | { text: string; values?: unknown[] }, values?: unknown[]) {
        void values
        return Promise.resolve({ rows: [], rowCount: 0 })
      }
    }

    it('records statements issued on an instrumented client inside a frame, without parameter values', async () => {
      const client = new FakeClient()
      instrumentPoolClient(client as unknown as Parameters<typeof instrumentPoolClient>[0], 'system')
      await client.query('SELECT 1') // outside a frame: not recorded
      await withTurnFrame({ turnId: 'pool', frameId: 'f' }, async () => {
        await client.query("SELECT * FROM users WHERE email = $1 AND note = 'private note'", ['alice@example.com'])
        await client.query({ text: 'UPDATE t SET a = $1 WHERE b = $2', values: [1, 2] })
      })
      const ledger = readTurnSqlLedger('pool')!
      expect(ledger.statements.map((s) => [s.shape, s.paramCount, s.pool])).toEqual([
        ['SELECT * FROM users WHERE email = ? AND note = ?', 1, 'system'],
        ['UPDATE t SET a = ? WHERE b = ?', 2, 'system'],
      ])
      expect(JSON.stringify(ledger)).not.toMatch(/alice|private note/)
    })

    it('attributes a callback-form statement to the frame that submitted it, not the one it completes in', async () => {
      // Models a pooled connection: completions are delivered from the socket,
      // in the async context of the frame that opened the connection (`f`).
      class SocketClient {
        pending: Array<() => void> = []
        query(_sql: string, _values: unknown[], cb: (err: Error | null, res?: unknown) => void) {
          this.pending.push(() => cb(null, { rows: [], rowCount: 0 }))
        }
      }
      const client = new SocketClient()
      instrumentPoolClient(client as unknown as Parameters<typeof instrumentPoolClient>[0], 'system')
      const submit = (sql: string) => new Promise<void>((resolve) => client.query(sql, [], () => resolve()))
      let done: Promise<unknown> = Promise.resolve()
      withTurnFrame({ turnId: 'cb', frameId: 'f' }, () => {
        const deliver = () => { for (const complete of client.pending.splice(0)) complete() }
        withTurnFrame({ turnId: 'cb', frameId: 'g' }, () => {
          done = Promise.all([submit('SELECT claim'), submit('SELECT heartbeat')])
        })
        // Completions run here, in frame f.
        deliver()
      })
      await done
      const ledger = readTurnSqlLedger('cb')!
      expect(ledger.statements.map((s) => [s.shape, s.frameId, s.parentFrameId])).toEqual([
        ['SELECT claim', 'g', 'f'],
        ['SELECT heartbeat', 'g', 'f'],
      ])
    })

    it('drops a callback statement submitted outside any frame even if it completes inside one', async () => {
      class SocketClient {
        pending: Array<() => void> = []
        query(_sql: string, _values: unknown[], cb: (err: Error | null) => void) { this.pending.push(() => cb(null)) }
      }
      const client = new SocketClient()
      instrumentPoolClient(client as unknown as Parameters<typeof instrumentPoolClient>[0], 'system')
      const done = new Promise<void>((resolve) => client.query('SELECT outside', [], () => resolve()))
      withTurnFrame({ turnId: 'late', frameId: 'f' }, () => { for (const complete of client.pending.splice(0)) complete() })
      await done
      expect(readTurnSqlLedger('late')).toBeUndefined()
    })
  })
})

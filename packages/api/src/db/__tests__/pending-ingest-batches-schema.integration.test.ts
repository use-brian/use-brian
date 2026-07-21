import { describe, it, expect, afterAll, beforeEach } from 'vitest'
import pg from 'pg'

/**
 * Schema-application test for migration 131 (pending_ingest_batches).
 * Verifies the table shape, the partial drain index, the events JSONB
 * default, and ON DELETE CASCADE on both rule_id and workspace_id.
 * Skips silently when the local `Use Brian` database is unavailable.
 */

let pool: pg.Pool | undefined

async function canConnect(): Promise<boolean> {
  const p = new pg.Pool({ database: 'sidanclaw', connectionTimeoutMillis: 2000 })
  try {
    const client = await p.connect()
    try {
      await client.query('SELECT 1 FROM pending_ingest_batches LIMIT 1')
    } finally {
      client.release()
    }
    pool = p
    return true
  } catch {
    await p.end().catch(() => {})
    return false
  }
}

const ok = await canConnect()
const describeIf = ok ? describe : describe.skip

afterAll(async () => {
  if (pool) await pool.end()
})

async function makeUser(client: pg.PoolClient): Promise<string> {
  const r = await client.query(
    `INSERT INTO users (id, auth_provider, auth_provider_id)
     VALUES (gen_random_uuid(), 'test', 'pending-batches-' || gen_random_uuid())
     RETURNING id`,
  )
  return r.rows[0].id
}

async function makeWorkspace(client: pg.PoolClient, ownerId: string): Promise<string> {
  const r = await client.query(
    `INSERT INTO workspaces (id, name, purpose, owner_user_id, is_personal)
     VALUES (gen_random_uuid(), 'pending-batches-test-ws', 'test', $1, true)
     RETURNING id`,
    [ownerId],
  )
  return r.rows[0].id
}

async function makeConnectorInstance(client: pg.PoolClient, userId: string): Promise<string> {
  const r = await client.query(
    `INSERT INTO connector_instance (scope, user_id, provider, label, connected)
     VALUES ('user', $1, 'gmail', 'Test Gmail', true)
     RETURNING id`,
    [userId],
  )
  return r.rows[0].id
}

async function makeIngestRule(client: pg.PoolClient, ciId: string): Promise<string> {
  const r = await client.query(
    `INSERT INTO ingest_rules
       (connector_instance_id, source, rule_order, filter_type, routing_mode, routing_schedule)
     VALUES ($1, 'gmail', 1, 'always', 'scheduled', '0 9 * * *')
     RETURNING id`,
    [ciId],
  )
  return r.rows[0].id
}

const EXPECTED_COLUMNS = new Set([
  'id',
  'workspace_id',
  'rule_id',
  'source',
  'fires_at',
  'events',
  'processed_at',
  'created_at',
])

const EXPECTED_INDEXES = new Set([
  'pending_ingest_batches_pkey',
  'idx_pending_batches_due',
])

describeIf('[COMP:brain/pending-ingest-batches] pending_ingest_batches table schema (mig 131)', () => {
  describe('Table shape', () => {
    it('has all expected columns', async () => {
      const r = await pool!.query(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'pending_ingest_batches'`,
      )
      const got = new Set(r.rows.map((row) => row.column_name as string))
      for (const expected of EXPECTED_COLUMNS) {
        expect(got, `missing column ${expected}`).toContain(expected)
      }
    })

    it('has the expected named indexes', async () => {
      const r = await pool!.query(
        `SELECT indexname FROM pg_indexes
         WHERE schemaname = 'public' AND tablename = 'pending_ingest_batches'`,
      )
      const got = new Set(r.rows.map((row) => row.indexname as string))
      for (const expected of EXPECTED_INDEXES) {
        expect(got, `missing index ${expected}`).toContain(expected)
      }
    })

    it('idx_pending_batches_due is a partial index on processed_at IS NULL', async () => {
      const r = await pool!.query(
        `SELECT indexdef FROM pg_indexes
         WHERE schemaname = 'public'
           AND tablename = 'pending_ingest_batches'
           AND indexname = 'idx_pending_batches_due'`,
      )
      expect(r.rows[0]?.indexdef).toMatch(/WHERE\s*\(?\s*processed_at IS NULL\s*\)?/i)
    })
  })

  describe('Constraints', () => {
    let userId: string
    let workspaceId: string
    let ciId: string
    let ruleId: string

    beforeEach(async () => {
      const client = await pool!.connect()
      try {
        userId = await makeUser(client)
        workspaceId = await makeWorkspace(client, userId)
        ciId = await makeConnectorInstance(client, userId)
        ruleId = await makeIngestRule(client, ciId)
      } finally {
        client.release()
      }
    })

    it('workspace_id NOT NULL is enforced', async () => {
      const client = await pool!.connect()
      try {
        await expect(
          client.query(
            `INSERT INTO pending_ingest_batches
               (rule_id, source, fires_at)
             VALUES ($1, 'gmail', now() + interval '1 hour')`,
            [ruleId],
          ),
        ).rejects.toThrow(/workspace_id|not.null/i)
      } finally {
        client.release()
      }
    })

    it('rule_id ON DELETE CASCADE removes batches with the parent rule', async () => {
      const client = await pool!.connect()
      try {
        await client.query(
          `INSERT INTO pending_ingest_batches
             (workspace_id, rule_id, source, fires_at)
           VALUES ($1, $2, 'gmail', now() + interval '1 hour')`,
          [workspaceId, ruleId],
        )
        await client.query(`DELETE FROM ingest_rules WHERE id = $1`, [ruleId])
        const r = await client.query(
          `SELECT id FROM pending_ingest_batches WHERE rule_id = $1`,
          [ruleId],
        )
        expect(r.rowCount).toBe(0)
      } finally {
        client.release()
      }
    })

    it('workspace_id ON DELETE CASCADE removes batches with the parent workspace', async () => {
      const client = await pool!.connect()
      try {
        await client.query(
          `INSERT INTO pending_ingest_batches
             (workspace_id, rule_id, source, fires_at)
           VALUES ($1, $2, 'gmail', now() + interval '1 hour')`,
          [workspaceId, ruleId],
        )
        await client.query(`DELETE FROM workspaces WHERE id = $1`, [workspaceId])
        const r = await client.query(
          `SELECT id FROM pending_ingest_batches WHERE workspace_id = $1`,
          [workspaceId],
        )
        expect(r.rowCount).toBe(0)
      } finally {
        client.release()
      }
    })

    it('events defaults to []::jsonb and processed_at defaults to NULL', async () => {
      const client = await pool!.connect()
      try {
        const ins = await client.query(
          `INSERT INTO pending_ingest_batches
             (workspace_id, rule_id, source, fires_at)
           VALUES ($1, $2, 'gmail', now() + interval '1 hour')
           RETURNING events, processed_at`,
          [workspaceId, ruleId],
        )
        expect(ins.rows[0].events).toEqual([])
        expect(ins.rows[0].processed_at).toBeNull()
      } finally {
        client.release()
      }
    })

    it('accepts a populated events array', async () => {
      const client = await pool!.connect()
      try {
        const events = [
          { id: 'evt-1', subject: 'hello' },
          { id: 'evt-2', subject: 'world' },
        ]
        const ins = await client.query(
          `INSERT INTO pending_ingest_batches
             (workspace_id, rule_id, source, fires_at, events)
           VALUES ($1, $2, 'gmail', now() + interval '1 hour', $3::jsonb)
           RETURNING events`,
          [workspaceId, ruleId, JSON.stringify(events)],
        )
        expect(ins.rows[0].events).toEqual(events)
      } finally {
        client.release()
      }
    })
  })
})

import { describe, it, expect, afterAll, beforeEach } from 'vitest'
import pg from 'pg'

/**
 * Schema-application test for migration 130 (ingest_rules). Verifies
 * the table exists with the expected column shape, the routing-mode
 * CHECK + routing_schedule conditional CHECK fire, the UNIQUE
 * (connector_instance_id, rule_order) constraint, and the
 * ON DELETE CASCADE on the parent connector_instance FK. Requires a
 * local PostgreSQL `Use Brian` database with migrations applied;
 * skips silently when unavailable.
 */

let pool: pg.Pool | undefined

async function canConnect(): Promise<boolean> {
  const p = new pg.Pool({ database: 'sidanclaw', connectionTimeoutMillis: 2000 })
  try {
    const client = await p.connect()
    try {
      await client.query('SELECT 1 FROM ingest_rules LIMIT 1')
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
     VALUES (gen_random_uuid(), 'test', 'ingest-rules-' || gen_random_uuid())
     RETURNING id`,
  )
  return r.rows[0].id
}

async function makeWorkspace(client: pg.PoolClient, ownerId: string): Promise<string> {
  const r = await client.query(
    `INSERT INTO workspaces (id, name, purpose, owner_user_id, is_personal)
     VALUES (gen_random_uuid(), 'ingest-rules-test-ws', 'test', $1, true)
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

const EXPECTED_COLUMNS = new Set([
  'id',
  'connector_instance_id',
  'source',
  'rule_order',
  'filter_type',
  'filter_params',
  'routing_mode',
  'routing_schedule',
  'routing_timezone',
  'alert',
  'created_at',
])

const EXPECTED_INDEXES = new Set([
  'ingest_rules_pkey',
  'idx_ingest_rules_eval',
])

describeIf('[COMP:brain/ingest-rules] ingest_rules table schema (mig 130)', () => {
  describe('Table shape', () => {
    it('has all expected columns', async () => {
      const r = await pool!.query(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'ingest_rules'`,
      )
      const got = new Set(r.rows.map((row) => row.column_name as string))
      for (const expected of EXPECTED_COLUMNS) {
        expect(got, `missing column ${expected}`).toContain(expected)
      }
    })

    it('has expected named indexes', async () => {
      const r = await pool!.query(
        `SELECT indexname FROM pg_indexes
         WHERE schemaname = 'public' AND tablename = 'ingest_rules'`,
      )
      const got = new Set(r.rows.map((row) => row.indexname as string))
      for (const expected of EXPECTED_INDEXES) {
        expect(got, `missing index ${expected}`).toContain(expected)
      }
    })

    it('has a UNIQUE (connector_instance_id, rule_order) constraint', async () => {
      const r = await pool!.query(
        `SELECT conname FROM pg_constraint
         WHERE conrelid = 'ingest_rules'::regclass
           AND contype  = 'u'`,
      )
      expect(r.rowCount, 'expected at least one UNIQUE constraint').toBeGreaterThan(0)
    })
  })

  describe('Constraints', () => {
    let userId: string
    let workspaceId: string
    let ciId: string

    beforeEach(async () => {
      const client = await pool!.connect()
      try {
        userId = await makeUser(client)
        workspaceId = await makeWorkspace(client, userId)
        // workspaceId unused after creation but kept so the user's
        // membership chain is set up consistently with other tests.
        void workspaceId
        ciId = await makeConnectorInstance(client, userId)
      } finally {
        client.release()
      }
    })

    it('routing_mode CHECK rejects an unknown mode', async () => {
      const client = await pool!.connect()
      try {
        await expect(
          client.query(
            `INSERT INTO ingest_rules
               (connector_instance_id, source, rule_order, filter_type, routing_mode)
             VALUES ($1, 'gmail', 1, 'always', 'asap')`,
            [ciId],
          ),
        ).rejects.toThrow(/check constraint|routing_mode/i)
      } finally {
        client.release()
      }
    })

    it('routing_mode=scheduled requires routing_schedule NOT NULL', async () => {
      const client = await pool!.connect()
      try {
        await expect(
          client.query(
            `INSERT INTO ingest_rules
               (connector_instance_id, source, rule_order, filter_type, routing_mode, routing_schedule)
             VALUES ($1, 'gmail', 1, 'always', 'scheduled', NULL)`,
            [ciId],
          ),
        ).rejects.toThrow(/check constraint|routing_schedule/i)
      } finally {
        client.release()
      }
    })

    it('routing_mode=realtime requires routing_schedule NULL', async () => {
      const client = await pool!.connect()
      try {
        await expect(
          client.query(
            `INSERT INTO ingest_rules
               (connector_instance_id, source, rule_order, filter_type, routing_mode, routing_schedule)
             VALUES ($1, 'gmail', 1, 'always', 'realtime', '0 9 * * *')`,
            [ciId],
          ),
        ).rejects.toThrow(/check constraint|routing_schedule/i)
      } finally {
        client.release()
      }
    })

    it('routing_mode=drop requires routing_schedule NULL', async () => {
      const client = await pool!.connect()
      try {
        await expect(
          client.query(
            `INSERT INTO ingest_rules
               (connector_instance_id, source, rule_order, filter_type, routing_mode, routing_schedule)
             VALUES ($1, 'gmail', 1, 'always', 'drop', '0 0 * * *')`,
            [ciId],
          ),
        ).rejects.toThrow(/check constraint|routing_schedule/i)
      } finally {
        client.release()
      }
    })

    it('UNIQUE (connector_instance_id, rule_order) rejects duplicates', async () => {
      const client = await pool!.connect()
      try {
        await client.query(
          `INSERT INTO ingest_rules
             (connector_instance_id, source, rule_order, filter_type, routing_mode)
           VALUES ($1, 'gmail', 1, 'always', 'realtime')`,
          [ciId],
        )
        await expect(
          client.query(
            `INSERT INTO ingest_rules
               (connector_instance_id, source, rule_order, filter_type, routing_mode)
             VALUES ($1, 'gmail', 1, 'always', 'realtime')`,
            [ciId],
          ),
        ).rejects.toThrow(/duplicate key|unique/i)
      } finally {
        client.release()
      }
    })

    it('connector_instance_id ON DELETE CASCADE removes rules with the parent', async () => {
      const client = await pool!.connect()
      try {
        await client.query(
          `INSERT INTO ingest_rules
             (connector_instance_id, source, rule_order, filter_type, routing_mode)
           VALUES ($1, 'gmail', 1, 'always', 'realtime')`,
          [ciId],
        )
        await client.query(`DELETE FROM connector_instance WHERE id = $1`, [ciId])
        const r = await client.query(
          `SELECT id FROM ingest_rules WHERE connector_instance_id = $1`,
          [ciId],
        )
        expect(r.rowCount).toBe(0)
      } finally {
        client.release()
      }
    })

    it('accepts a valid realtime rule, a scheduled+cron rule, and a drop rule', async () => {
      const client = await pool!.connect()
      try {
        const realtime = await client.query(
          `INSERT INTO ingest_rules
             (connector_instance_id, source, rule_order, filter_type, filter_params, routing_mode, alert)
           VALUES ($1, 'gmail', 1, 'sender_match', '{"values": ["a@b.com"]}'::jsonb, 'realtime', true)
           RETURNING id`,
          [ciId],
        )
        expect(realtime.rowCount).toBe(1)

        const scheduled = await client.query(
          `INSERT INTO ingest_rules
             (connector_instance_id, source, rule_order, filter_type, routing_mode, routing_schedule, routing_timezone)
           VALUES ($1, 'gmail', 2, 'always', 'scheduled', '0 9 * * 1-5', 'Asia/Hong_Kong')
           RETURNING id`,
          [ciId],
        )
        expect(scheduled.rowCount).toBe(1)

        const drop = await client.query(
          `INSERT INTO ingest_rules
             (connector_instance_id, source, rule_order, filter_type, routing_mode)
           VALUES ($1, 'gmail', 3, 'actor_match', 'drop')
           RETURNING id`,
          [ciId],
        )
        expect(drop.rowCount).toBe(1)
      } finally {
        client.release()
      }
    })
  })
})

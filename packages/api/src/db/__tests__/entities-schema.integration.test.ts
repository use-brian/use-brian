import { describe, it, expect, afterAll, beforeEach } from 'vitest'
import pg from 'pg'

/**
 * Schema-application test for migration 125 (entities). Verifies the
 * table exists with the expected column shape, the CHECK constraints
 * fire, the indexes are present, and pgvector is installed. Requires
 * a local PostgreSQL `sidanclaw` database with migrations applied;
 * skips silently when unavailable.
 */

let pool: pg.Pool | undefined

async function canConnect(): Promise<boolean> {
  const p = new pg.Pool({ database: 'sidanclaw', connectionTimeoutMillis: 2000 })
  try {
    const client = await p.connect()
    try {
      await client.query('SELECT 1 FROM entities LIMIT 1')
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
     VALUES (gen_random_uuid(), 'test', 'entities-' || gen_random_uuid())
     RETURNING id`,
  )
  return r.rows[0].id
}

async function makeWorkspace(client: pg.PoolClient, ownerId: string): Promise<string> {
  const r = await client.query(
    `INSERT INTO workspaces (id, name, purpose, owner_user_id, is_personal)
     VALUES (gen_random_uuid(), 'entities-test-ws', 'test', $1, true)
     RETURNING id`,
    [ownerId],
  )
  return r.rows[0].id
}

const EXPECTED_COLUMNS = new Set([
  'id',
  'kind',
  'display_name',
  'canonical_id',
  'sensitivity',
  'user_id',
  'assistant_id',
  'workspace_id',
  'created_by_user_id',
  'created_by_assistant_id',
  'source_episode_id',
  'source',
  'verified_by_user_id',
  'verified_at',
  'valid_from',
  'valid_to',
  'superseded_by',
  'retracted_at',
  'retracted_reason',
  'retracted_by',
  'attributes',
  'centrality',
  'centrality_computed_at',
  'embedding',
  'embedding_model_id',
  'content_hash',
  'embedding_failed_at',
  'embedding_failure_reason',
  'embedding_updated_at',
  'created_at',
  'updated_at',
])

const EXPECTED_INDEXES = new Set([
  'entities_pkey',
  'idx_entities_canonical',
  'idx_entities_kind_name',
  'idx_entities_visibility',
  'idx_entities_valid',
])

describeIf('[COMP:brain/entity-registry] entities table schema (mig 125)', () => {
  describe('Table shape', () => {
    it('has all expected columns', async () => {
      const r = await pool!.query(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'entities'`,
      )
      const got = new Set(r.rows.map((row) => row.column_name as string))
      for (const expected of EXPECTED_COLUMNS) {
        expect(got, `missing column ${expected}`).toContain(expected)
      }
    })

    it('has all expected indexes', async () => {
      const r = await pool!.query(
        `SELECT indexname FROM pg_indexes
         WHERE schemaname = 'public' AND tablename = 'entities'`,
      )
      const got = new Set(r.rows.map((row) => row.indexname as string))
      for (const expected of EXPECTED_INDEXES) {
        expect(got, `missing index ${expected}`).toContain(expected)
      }
    })

    it('pgvector extension is installed', async () => {
      const r = await pool!.query(
        `SELECT 1 AS ok FROM pg_extension WHERE extname = 'vector'`,
      )
      expect(r.rowCount).toBe(1)
    })

    it('embedding column has type vector', async () => {
      const r = await pool!.query(
        `SELECT format_type(a.atttypid, a.atttypmod) AS type_name
         FROM pg_attribute a
         JOIN pg_class c ON c.oid = a.attrelid
         WHERE c.relname = 'entities' AND a.attname = 'embedding'`,
      )
      expect(r.rows[0]?.type_name).toMatch(/^vector\(768\)$/)
    })
  })

  describe('Constraints', () => {
    let userId: string
    let workspaceId: string

    beforeEach(async () => {
      const client = await pool!.connect()
      try {
        userId = await makeUser(client)
        workspaceId = await makeWorkspace(client, userId)
      } finally {
        client.release()
      }
    })

    it('valid_kind CHECK rejects unknown kind', async () => {
      const client = await pool!.connect()
      try {
        await expect(
          client.query(
            `INSERT INTO entities (kind, display_name, workspace_id, user_id, created_by_user_id, source)
             VALUES ('unknown', 'X', $1, $2, $2, 'user')`,
            [workspaceId, userId],
          ),
        ).rejects.toThrow(/valid_kind|check constraint/i)
      } finally {
        client.release()
      }
    })

    it('valid_kind CHECK accepts each of the 6 canonical kinds', async () => {
      const client = await pool!.connect()
      try {
        for (const kind of ['person', 'company', 'project', 'product', 'deal', 'repository']) {
          const r = await client.query(
            `INSERT INTO entities (kind, display_name, workspace_id, user_id, created_by_user_id, source)
             VALUES ($1, 'X-' || $1, $2, $3, $3, 'user')
             RETURNING id`,
            [kind, workspaceId, userId],
          )
          expect(r.rowCount).toBe(1)
        }
      } finally {
        client.release()
      }
    })

    it('entities_visibility_check rejects (user_id NULL, assistant_id NULL)', async () => {
      const client = await pool!.connect()
      try {
        await expect(
          client.query(
            `INSERT INTO entities (kind, display_name, workspace_id, created_by_user_id, source)
             VALUES ('person', 'X', $1, $2, 'user')`,
            [workspaceId, userId],
          ),
        ).rejects.toThrow(/entities_visibility_check|check constraint/i)
      } finally {
        client.release()
      }
    })

    it('entities_visibility_check accepts user_id set, assistant_id NULL', async () => {
      const client = await pool!.connect()
      try {
        const r = await client.query(
          `INSERT INTO entities (kind, display_name, workspace_id, user_id, created_by_user_id, source)
           VALUES ('person', 'X', $1, $2, $2, 'user')
           RETURNING id`,
          [workspaceId, userId],
        )
        expect(r.rowCount).toBe(1)
      } finally {
        client.release()
      }
    })

    it('created_by_user_id NOT NULL is enforced', async () => {
      const client = await pool!.connect()
      try {
        await expect(
          client.query(
            `INSERT INTO entities (kind, display_name, workspace_id, user_id, source)
             VALUES ('person', 'X', $1, $2, 'user')`,
            [workspaceId, userId],
          ),
        ).rejects.toThrow(/created_by_user_id|not.null/i)
      } finally {
        client.release()
      }
    })
  })
})

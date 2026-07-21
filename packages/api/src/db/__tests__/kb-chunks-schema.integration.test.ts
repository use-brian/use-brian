import { describe, it, expect, afterAll, beforeEach } from 'vitest'
import pg from 'pg'

/**
 * Schema-application test for migration 132 (kb_chunks). Verifies the
 * column set (kind-specific + universal), the visibility CHECK, NOT
 * NULL enforcement on the load-bearing columns, the chunk_text
 * non-empty CHECK, and the index set. Skips silently when the local
 * `Use Brian` database is unavailable.
 */

let pool: pg.Pool | undefined

async function canConnect(): Promise<boolean> {
  const p = new pg.Pool({ database: 'sidanclaw', connectionTimeoutMillis: 2000 })
  try {
    const client = await p.connect()
    try {
      await client.query('SELECT 1 FROM kb_chunks LIMIT 1')
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
     VALUES (gen_random_uuid(), 'test', 'kb-chunks-' || gen_random_uuid())
     RETURNING id`,
  )
  return r.rows[0].id
}

async function makeWorkspace(client: pg.PoolClient, ownerId: string): Promise<string> {
  const r = await client.query(
    `INSERT INTO workspaces (id, name, purpose, owner_user_id, is_personal)
     VALUES (gen_random_uuid(), 'kb-chunks-test-ws', 'test', $1, true)
     RETURNING id`,
    [ownerId],
  )
  return r.rows[0].id
}

const EXPECTED_COLUMNS = new Set([
  // pk
  'id',
  // kind-specific
  'chunk_text',
  'chunk_index',
  'source_path',
  'source_sha',
  'title',
  'tags',
  'metadata',
  // cognitive
  'sensitivity',
  // visibility double + workspace
  'user_id',
  'assistant_id',
  'workspace_id',
  // authorship
  'created_by_user_id',
  'created_by_assistant_id',
  'source_episode_id',
  // trust signals
  'source',
  'verified_by_user_id',
  'verified_at',
  // bi-temporal
  'valid_from',
  'valid_to',
  'superseded_by',
  // retraction
  'retracted_at',
  'retracted_reason',
  'retracted_by',
  // embedding scaffolding
  'embedding',
  'embedding_model_id',
  'content_hash',
  'embedding_failed_at',
  'embedding_failure_reason',
  'embedding_updated_at',
  // usage tracking
  'recall_count',
  'useful_recall_count',
  'last_recalled_at',
  'query_hashes',
  'recall_days',
  // timestamps
  'created_at',
  'updated_at',
])

const EXPECTED_INDEXES = new Set([
  'kb_chunks_pkey',
  'idx_kb_chunks_workspace_visibility',
  'idx_kb_chunks_source_path',
  'idx_kb_chunks_valid',
  'idx_kb_chunks_episode',
  'idx_kb_chunks_content_hash',
])

describeIf('[COMP:brain/kb-chunks] kb_chunks table schema (mig 132)', () => {
  describe('Table shape', () => {
    it('has all expected columns', async () => {
      const r = await pool!.query(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'kb_chunks'`,
      )
      const got = new Set(r.rows.map((row) => row.column_name as string))
      for (const expected of EXPECTED_COLUMNS) {
        expect(got, `missing column ${expected}`).toContain(expected)
      }
    })

    it('has all expected indexes', async () => {
      const r = await pool!.query(
        `SELECT indexname FROM pg_indexes
         WHERE schemaname = 'public' AND tablename = 'kb_chunks'`,
      )
      const got = new Set(r.rows.map((row) => row.indexname as string))
      for (const expected of EXPECTED_INDEXES) {
        expect(got, `missing index ${expected}`).toContain(expected)
      }
    })

    it('embedding column is vector(768)', async () => {
      const r = await pool!.query(
        `SELECT format_type(a.atttypid, a.atttypmod) AS type_name
         FROM pg_attribute a
         JOIN pg_class c ON c.oid = a.attrelid
         WHERE c.relname = 'kb_chunks' AND a.attname = 'embedding'`,
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

    it('accepts a happy-path INSERT (user-only visibility)', async () => {
      const client = await pool!.connect()
      try {
        const r = await client.query(
          `INSERT INTO kb_chunks
             (chunk_text, source, workspace_id, user_id, created_by_user_id)
           VALUES ('hello world', 'kb_sync', $1, $2, $2)
           RETURNING id`,
          [workspaceId, userId],
        )
        expect(r.rowCount).toBe(1)
      } finally {
        client.release()
      }
    })

    it('kb_chunks_visibility_check rejects (user_id NULL, assistant_id NULL)', async () => {
      const client = await pool!.connect()
      try {
        await expect(
          client.query(
            `INSERT INTO kb_chunks
               (chunk_text, source, workspace_id, created_by_user_id)
             VALUES ('hello world', 'kb_sync', $1, $2)`,
            [workspaceId, userId],
          ),
        ).rejects.toThrow(/kb_chunks_visibility_check|check constraint/i)
      } finally {
        client.release()
      }
    })

    it('workspace_id NOT NULL is enforced', async () => {
      const client = await pool!.connect()
      try {
        await expect(
          client.query(
            `INSERT INTO kb_chunks
               (chunk_text, source, user_id, created_by_user_id)
             VALUES ('hello world', 'kb_sync', $1, $1)`,
            [userId],
          ),
        ).rejects.toThrow(/workspace_id|not.null/i)
      } finally {
        client.release()
      }
    })

    it('created_by_user_id NOT NULL is enforced', async () => {
      const client = await pool!.connect()
      try {
        await expect(
          client.query(
            `INSERT INTO kb_chunks
               (chunk_text, source, workspace_id, user_id)
             VALUES ('hello world', 'kb_sync', $1, $2)`,
            [workspaceId, userId],
          ),
        ).rejects.toThrow(/created_by_user_id|not.null/i)
      } finally {
        client.release()
      }
    })

    it('chunk_text NOT NULL is enforced', async () => {
      const client = await pool!.connect()
      try {
        await expect(
          client.query(
            `INSERT INTO kb_chunks
               (chunk_text, source, workspace_id, user_id, created_by_user_id)
             VALUES (NULL, 'kb_sync', $1, $2, $2)`,
            [workspaceId, userId],
          ),
        ).rejects.toThrow(/chunk_text|not.null/i)
      } finally {
        client.release()
      }
    })

    it('chunk_text non-empty CHECK rejects empty string', async () => {
      const client = await pool!.connect()
      try {
        await expect(
          client.query(
            `INSERT INTO kb_chunks
               (chunk_text, source, workspace_id, user_id, created_by_user_id)
             VALUES ('', 'kb_sync', $1, $2, $2)`,
            [workspaceId, userId],
          ),
        ).rejects.toThrow(/check constraint|chunk_text/i)
      } finally {
        client.release()
      }
    })
  })
})

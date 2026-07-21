import { describe, it, expect, afterAll, beforeEach } from 'vitest'
import pg from 'pg'

/**
 * Schema-application test for migration 129 (episodes). Verifies the
 * table exists with the expected append-only column shape (no universal
 * column set — episodes are immutable per data-model.md §"Episodes are
 * immutable"), the CHECK constraints fire, the indexes are present,
 * and the deferred FKs from migrations 125 / 126 (`entities` and
 * `entity_links` `source_episode_id` columns) are now in place.
 * Requires a local PostgreSQL `Use Brian` database with migrations
 * applied; skips silently when unavailable.
 */

let pool: pg.Pool | undefined

async function canConnect(): Promise<boolean> {
  const p = new pg.Pool({ database: 'sidanclaw', connectionTimeoutMillis: 2000 })
  try {
    const client = await p.connect()
    try {
      await client.query('SELECT 1 FROM episodes LIMIT 1')
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
     VALUES (gen_random_uuid(), 'test', 'episodes-' || gen_random_uuid())
     RETURNING id`,
  )
  return r.rows[0].id
}

async function makeWorkspace(client: pg.PoolClient, ownerId: string): Promise<string> {
  const r = await client.query(
    `INSERT INTO workspaces (id, name, purpose, owner_user_id, is_personal)
     VALUES (gen_random_uuid(), 'episodes-test-ws', 'test', $1, true)
     RETURNING id`,
    [ownerId],
  )
  return r.rows[0].id
}

const EXPECTED_COLUMNS = new Set([
  'id',
  'source_kind',
  'source_ref',
  'occurred_at',
  'ingested_at',
  'status',
  'last_checkpoint_at',
  'idle_threshold_secs',
  'content_ref',
  'summary_text',
  'attachments',
  'sensitivity',
  'user_id',
  'assistant_id',
  'workspace_id',
  'created_by_user_id',
  'created_by_assistant_id',
  'parent_episode_id',
  'extraction_locked',
  'created_at',
])

const EXPECTED_INDEXES = new Set([
  'episodes_pkey',
  'idx_episodes_source',
  'idx_episodes_status',
  'idx_episodes_visibility',
])

describeIf('[COMP:brain/episodes-schema] episodes table schema (mig 129)', () => {
  describe('Table shape', () => {
    it('has all expected columns', async () => {
      const r = await pool!.query(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'episodes'`,
      )
      const got = new Set(r.rows.map((row) => row.column_name as string))
      for (const expected of EXPECTED_COLUMNS) {
        expect(got, `missing column ${expected}`).toContain(expected)
      }
    })

    it('does NOT carry the universal column set (episodes are append-only)', async () => {
      const r = await pool!.query(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'episodes'`,
      )
      const got = new Set(r.rows.map((row) => row.column_name as string))
      for (const banned of [
        'valid_from',
        'valid_to',
        'superseded_by',
        'retracted_at',
        'retracted_reason',
        'retracted_by',
        'verified_by_user_id',
        'verified_at',
        'embedding',
        'embedding_model_id',
      ]) {
        expect(got, `episodes must not carry ${banned}`).not.toContain(banned)
      }
    })

    it('has all expected indexes', async () => {
      const r = await pool!.query(
        `SELECT indexname FROM pg_indexes
         WHERE schemaname = 'public' AND tablename = 'episodes'`,
      )
      const got = new Set(r.rows.map((row) => row.indexname as string))
      for (const expected of EXPECTED_INDEXES) {
        expect(got, `missing index ${expected}`).toContain(expected)
      }
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

    it('valid_status CHECK rejects unknown status', async () => {
      const client = await pool!.connect()
      try {
        await expect(
          client.query(
            `INSERT INTO episodes
               (source_kind, source_ref, occurred_at, status,
                workspace_id, user_id, created_by_user_id)
             VALUES ('web_chat', '{}'::jsonb, now(), 'gibberish',
                     $1, $2, $2)`,
            [workspaceId, userId],
          ),
        ).rejects.toThrow(/valid_status|check constraint/i)
      } finally {
        client.release()
      }
    })

    it('valid_status CHECK accepts each canonical status', async () => {
      const client = await pool!.connect()
      try {
        for (const status of ['open', 'extracting', 'archived']) {
          const r = await client.query(
            `INSERT INTO episodes
               (source_kind, source_ref, occurred_at, status,
                workspace_id, user_id, created_by_user_id)
             VALUES ('web_chat', '{}'::jsonb, now(), $1, $2, $3, $3)
             RETURNING id`,
            [status, workspaceId, userId],
          )
          expect(r.rowCount).toBe(1)
        }
      } finally {
        client.release()
      }
    })

    it('episodes_visibility_check rejects (user_id NULL, assistant_id NULL)', async () => {
      const client = await pool!.connect()
      try {
        await expect(
          client.query(
            `INSERT INTO episodes
               (source_kind, source_ref, occurred_at,
                workspace_id, created_by_user_id)
             VALUES ('web_chat', '{}'::jsonb, now(), $1, $2)`,
            [workspaceId, userId],
          ),
        ).rejects.toThrow(/episodes_visibility_check|check constraint/i)
      } finally {
        client.release()
      }
    })

    it('episodes_visibility_check accepts user_id set, assistant_id NULL', async () => {
      const client = await pool!.connect()
      try {
        const r = await client.query(
          `INSERT INTO episodes
             (source_kind, source_ref, occurred_at,
              workspace_id, user_id, created_by_user_id)
           VALUES ('web_chat', '{}'::jsonb, now(), $1, $2, $2)
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
            `INSERT INTO episodes
               (source_kind, source_ref, occurred_at,
                workspace_id, user_id)
             VALUES ('web_chat', '{}'::jsonb, now(), $1, $2)`,
            [workspaceId, userId],
          ),
        ).rejects.toThrow(/created_by_user_id|not.null/i)
      } finally {
        client.release()
      }
    })

    it('attachments default is empty JSON array', async () => {
      const client = await pool!.connect()
      try {
        const r = await client.query(
          `INSERT INTO episodes
             (source_kind, source_ref, occurred_at,
              workspace_id, user_id, created_by_user_id)
           VALUES ('web_chat', '{}'::jsonb, now(), $1, $2, $2)
           RETURNING attachments, extraction_locked`,
          [workspaceId, userId],
        )
        expect(r.rows[0].attachments).toEqual([])
        expect(r.rows[0].extraction_locked).toBe(false)
      } finally {
        client.release()
      }
    })
  })

  describe('Deferred foreign keys from migrations 125 and 126', () => {
    it('entities.source_episode_id has FK to episodes.id', async () => {
      const r = await pool!.query(
        `SELECT 1 AS ok
         FROM information_schema.table_constraints
         WHERE table_schema = 'public'
           AND table_name = 'entities'
           AND constraint_name = 'entities_source_episode_id_fkey'
           AND constraint_type = 'FOREIGN KEY'`,
      )
      expect(r.rowCount).toBe(1)
    })

    it('entity_links.source_episode_id has FK to episodes.id', async () => {
      const r = await pool!.query(
        `SELECT 1 AS ok
         FROM information_schema.table_constraints
         WHERE table_schema = 'public'
           AND table_name = 'entity_links'
           AND constraint_name = 'entity_links_source_episode_id_fkey'
           AND constraint_type = 'FOREIGN KEY'`,
      )
      expect(r.rowCount).toBe(1)
    })
  })
})

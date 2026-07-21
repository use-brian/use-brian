import { describe, it, expect, afterAll, beforeEach } from 'vitest'
import pg from 'pg'

/**
 * Schema-application test for migration 126 (entity_link_types +
 * entity_links). Verifies the lookup is seeded with the locked
 * vocabulary, the edge_type FK rejects unknown types, the visibility
 * CHECK fires, and indexes are present. Skips silently when the
 * local `Use Brian` database is unavailable.
 */

let pool: pg.Pool | undefined

async function canConnect(): Promise<boolean> {
  const p = new pg.Pool({ database: 'sidanclaw', connectionTimeoutMillis: 2000 })
  try {
    const client = await p.connect()
    try {
      await client.query('SELECT 1 FROM entity_links LIMIT 1')
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
     VALUES (gen_random_uuid(), 'test', 'edges-' || gen_random_uuid())
     RETURNING id`,
  )
  return r.rows[0].id
}

async function makeWorkspace(client: pg.PoolClient, ownerId: string): Promise<string> {
  const r = await client.query(
    `INSERT INTO workspaces (id, name, purpose, owner_user_id, is_personal)
     VALUES (gen_random_uuid(), 'edges-test-ws', 'test', $1, true)
     RETURNING id`,
    [ownerId],
  )
  return r.rows[0].id
}

const EXPECTED_LINKS_COLUMNS = new Set([
  'id',
  'source_kind',
  'source_id',
  'target_kind',
  'target_id',
  'edge_type',
  'attributes',
  'source',
  'verified_by_user_id',
  'verified_at',
  'valid_from',
  'valid_to',
  'retracted_at',
  'retracted_reason',
  'source_episode_id',
  'sensitivity',
  'user_id',
  'assistant_id',
  'workspace_id',
  'created_at',
  'updated_at', // mig 267 — parity with sibling primitive tables; backs markVerifiedGeneric()
])

const EXPECTED_LINKS_INDEXES = new Set([
  'entity_links_pkey',
  'idx_links_source',
  'idx_links_target',
  'idx_links_type',
  'idx_links_episode',
  'idx_links_valid',
])

const EXPECTED_EDGE_TYPES = [
  'works_at',
  'attended',
  'discussed_in',
  'represents',
  'mentioned',
  'signed_contract_with',
  'competes_with',
  'customer_since',
  'engagement_of',
  'target_investor',
  'outreach_strategy_for',
  'mutual_connection',
  'discussed_with',
  'depends_on',
  'mentioned_publicly_at',
  'target_competitor',
  'documented_by',
  'platform_engagement_for',
  'replies_to',
  // mig 250 — canvas/doc detail-page edge.
  'detail_page_of',
  // mig 260 — skills as a procedural brain primitive.
  'requires_connector',
  'references_entity',
  'learned_from',
  'refines',
]

describeIf('[COMP:brain/entity-links] entity_links table schema (mig 126)', () => {
  describe('entity_link_types lookup', () => {
    it('contains exactly the seeded edge-type vocabulary (mig 126 + 250 + 260)', async () => {
      const r = await pool!.query(
        `SELECT edge_type FROM entity_link_types ORDER BY edge_type`,
      )
      const got = r.rows.map((row) => row.edge_type as string).sort()
      const expected = [...EXPECTED_EDGE_TYPES].sort()
      expect(got).toEqual(expected)
    })

    it('every row has a non-empty description', async () => {
      const r = await pool!.query(
        `SELECT edge_type, description FROM entity_link_types
         WHERE description IS NULL OR length(description) = 0`,
      )
      expect(r.rowCount).toBe(0)
    })
  })

  describe('entity_links table shape', () => {
    it('has all expected columns', async () => {
      const r = await pool!.query(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'entity_links'`,
      )
      const got = new Set(r.rows.map((row) => row.column_name as string))
      for (const expected of EXPECTED_LINKS_COLUMNS) {
        expect(got, `missing column ${expected}`).toContain(expected)
      }
    })

    it('has all expected indexes', async () => {
      const r = await pool!.query(
        `SELECT indexname FROM pg_indexes
         WHERE schemaname = 'public' AND tablename = 'entity_links'`,
      )
      const got = new Set(r.rows.map((row) => row.indexname as string))
      for (const expected of EXPECTED_LINKS_INDEXES) {
        expect(got, `missing index ${expected}`).toContain(expected)
      }
    })
  })

  describe('Constraints', () => {
    let userId: string
    let workspaceId: string
    let sourceId: string
    let targetId: string

    beforeEach(async () => {
      const client = await pool!.connect()
      try {
        userId = await makeUser(client)
        workspaceId = await makeWorkspace(client, userId)
        // Two real entity rows so polymorphic source/target ids point at something.
        const a = await client.query(
          `INSERT INTO entities (kind, display_name, workspace_id, user_id, created_by_user_id, source)
           VALUES ('person', 'A', $1, $2, $2, 'user') RETURNING id`,
          [workspaceId, userId],
        )
        const b = await client.query(
          `INSERT INTO entities (kind, display_name, workspace_id, user_id, created_by_user_id, source)
           VALUES ('company', 'B', $1, $2, $2, 'user') RETURNING id`,
          [workspaceId, userId],
        )
        sourceId = a.rows[0].id
        targetId = b.rows[0].id
      } finally {
        client.release()
      }
    })

    it('edge_type FK rejects an unknown type', async () => {
      const client = await pool!.connect()
      try {
        await expect(
          client.query(
            `INSERT INTO entity_links (source_kind, source_id, target_kind, target_id, edge_type,
                                       source, user_id, workspace_id)
             VALUES ('entity', $1, 'entity', $2, 'totally_bogus_edge', 'user', $3, $4)`,
            [sourceId, targetId, userId, workspaceId],
          ),
        ).rejects.toThrow(/foreign key|entity_link_types|edge_type/i)
      } finally {
        client.release()
      }
    })

    it('edge_type FK accepts a seeded type (works_at)', async () => {
      const client = await pool!.connect()
      try {
        const r = await client.query(
          `INSERT INTO entity_links (source_kind, source_id, target_kind, target_id, edge_type,
                                     source, user_id, workspace_id)
           VALUES ('entity', $1, 'entity', $2, 'works_at', 'user', $3, $4)
           RETURNING id`,
          [sourceId, targetId, userId, workspaceId],
        )
        expect(r.rowCount).toBe(1)
      } finally {
        client.release()
      }
    })

    it('entity_links_visibility_check rejects (user_id NULL, assistant_id NULL)', async () => {
      const client = await pool!.connect()
      try {
        await expect(
          client.query(
            `INSERT INTO entity_links (source_kind, source_id, target_kind, target_id, edge_type,
                                       source, workspace_id)
             VALUES ('entity', $1, 'entity', $2, 'works_at', 'user', $3)`,
            [sourceId, targetId, workspaceId],
          ),
        ).rejects.toThrow(/entity_links_visibility_check|check constraint/i)
      } finally {
        client.release()
      }
    })

    it('workspace_id NOT NULL is enforced', async () => {
      const client = await pool!.connect()
      try {
        await expect(
          client.query(
            `INSERT INTO entity_links (source_kind, source_id, target_kind, target_id, edge_type,
                                       source, user_id)
             VALUES ('entity', $1, 'entity', $2, 'works_at', 'user', $3)`,
            [sourceId, targetId, userId],
          ),
        ).rejects.toThrow(/workspace_id|not.null/i)
      } finally {
        client.release()
      }
    })
  })
})

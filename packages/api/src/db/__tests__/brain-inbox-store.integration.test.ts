/**
 * Integration test for brain-inbox-store dangling entity_link handling.
 * Component tag: [COMP:brain/inbox-store].
 *
 * Covers the review-queue orphan regression (2026-07-09): an
 * `entity_link` whose endpoint was deleted must drop out of the inbox
 * list + count and be swept by `pruneDanglingEntityLinks` — for EVERY
 * delete flavor, not just hard delete. Soft delete (`valid_to`) is the
 * platform's DEFAULT delete (corrections.md D.4, including the review
 * UI's own Delete button), and it used to leave the relationship row
 * stuck in the review queue pointing at a dead endpoint.
 *
 * Skips when the local `sidanclaw` DB (or the brain tables) isn't
 * available, matching the other `.integration.test.ts` suites here.
 *
 * Spec: docs/architecture/brain/corrections.md → "Dangling-edge
 * auto-prune — soft-delete parity (2026-07-09)".
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import pg from 'pg'

let pool: pg.Pool | undefined

async function canConnect(): Promise<boolean> {
  const p = new pg.Pool({ database: 'sidanclaw', connectionTimeoutMillis: 2000 })
  try {
    const client = await p.connect()
    try {
      await client.query('SELECT 1 FROM memories LIMIT 1')
      await client.query('SELECT 1 FROM entities LIMIT 1')
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
     VALUES (gen_random_uuid(), 'test', 'inbox-' || gen_random_uuid())
     RETURNING id`,
  )
  return r.rows[0].id
}

async function makeWorkspace(client: pg.PoolClient, ownerId: string): Promise<string> {
  const r = await client.query(
    `INSERT INTO workspaces (id, name, purpose, owner_user_id, is_personal)
     VALUES (gen_random_uuid(), 'inbox-test-ws', 'test', $1, false)
     RETURNING id`,
    [ownerId],
  )
  return r.rows[0].id
}

async function addMember(client: pg.PoolClient, workspaceId: string, userId: string): Promise<void> {
  await client.query(
    `INSERT INTO workspace_members (id, workspace_id, user_id, role)
     VALUES (gen_random_uuid(), $1, $2, 'owner')`,
    [workspaceId, userId],
  )
}

/** Model-authored, unverified memory — one review item. */
async function makeMemory(
  client: pg.PoolClient,
  workspaceId: string,
  userId: string,
): Promise<string> {
  const r = await client.query(
    `INSERT INTO memories (user_id, workspace_id, summary, source)
     VALUES ($1, $2, 'daily research digest', 'model')
     RETURNING id`,
    [userId, workspaceId],
  )
  return r.rows[0].id
}

/** Model-authored, unverified non-CRM entity — a resolvable edge endpoint. */
async function makeEntity(
  client: pg.PoolClient,
  workspaceId: string,
  userId: string,
): Promise<string> {
  const r = await client.query(
    `INSERT INTO entities (kind, display_name, workspace_id, created_by_user_id, user_id, source)
     VALUES ('project', 'inbox-test-project', $1, $2, $2, 'model')
     RETURNING id`,
    [workspaceId, userId],
  )
  return r.rows[0].id
}

/** Model-authored, unverified memory→entity `mentioned` edge — one review item. */
async function makeEdge(
  client: pg.PoolClient,
  workspaceId: string,
  userId: string,
  memoryId: string,
  entityId: string,
): Promise<string> {
  const r = await client.query(
    `INSERT INTO entity_links
       (source_kind, source_id, target_kind, target_id, edge_type, source, user_id, workspace_id)
     VALUES ('memory', $1, 'entity', $2, 'mentioned', 'model', $3, $4)
     RETURNING id`,
    [memoryId, entityId, userId, workspaceId],
  )
  return r.rows[0].id
}

describeIf('[COMP:brain/inbox-store] entity_link dangling detection (integration)', () => {
  let store: typeof import('../brain-inbox-store.js')

  let userId: string
  let workspaceId: string
  let memoryId: string
  let entityId: string
  let edgeId: string

  beforeAll(async () => {
    process.env.DATABASE_URL ??= 'postgres:///sidanclaw'
    store = await import('../brain-inbox-store.js')
  })

  beforeEach(async () => {
    const client = await pool!.connect()
    try {
      userId = await makeUser(client)
      workspaceId = await makeWorkspace(client, userId)
      await addMember(client, workspaceId, userId)
      memoryId = await makeMemory(client, workspaceId, userId)
      entityId = await makeEntity(client, workspaceId, userId)
      edgeId = await makeEdge(client, workspaceId, userId, memoryId, entityId)
    } finally {
      client.release()
    }
  })

  async function edgeIds(): Promise<string[]> {
    const { rows } = await store.listBrainInbox({
      workspaceId,
      primitive: 'entity_link',
    })
    return rows.map((r) => r.id)
  }

  async function edgeCount(): Promise<number> {
    const { byPrimitive } = await store.countBrainInbox(workspaceId)
    return byPrimitive.entity_link
  }

  it('lists + counts an edge whose endpoints are both live, with resolved labels', async () => {
    expect(await edgeIds()).toContain(edgeId)
    expect(await edgeCount()).toBe(1)

    const { rows } = await store.listBrainInbox({ workspaceId, primitive: 'entity_link' })
    const edge = rows.find((r) => r.id === edgeId)
    expect(edge?.body.source_label).toBe('daily research digest')
    expect(edge?.body.target_label).toBe('inbox-test-project')
  })

  it('SOFT-deleted endpoint (valid_to — the D.4 default delete) orphans the edge: excluded from list + count, swept by prune', async () => {
    const client = await pool!.connect()
    try {
      await client.query(`UPDATE memories SET valid_to = now() WHERE id = $1`, [memoryId])
    } finally {
      client.release()
    }

    expect(await edgeIds()).not.toContain(edgeId)
    expect(await edgeCount()).toBe(0)

    expect(await store.pruneDanglingEntityLinks(workspaceId)).toBe(1)
    const { rows } = await pool!.query(
      `SELECT valid_to FROM entity_links WHERE id = $1`,
      [edgeId],
    )
    expect(rows[0].valid_to).not.toBeNull()
    // Idempotent — a second sweep touches nothing.
    expect(await store.pruneDanglingEntityLinks(workspaceId)).toBe(0)
  })

  it('RETRACTED endpoint orphans the edge the same way', async () => {
    const client = await pool!.connect()
    try {
      await client.query(
        `UPDATE entities SET retracted_at = now(), retracted_reason = 'test' WHERE id = $1`,
        [entityId],
      )
    } finally {
      client.release()
    }

    expect(await edgeIds()).not.toContain(edgeId)
    expect(await edgeCount()).toBe(0)
    expect(await store.pruneDanglingEntityLinks(workspaceId)).toBe(1)
  })

  it('HARD-deleted endpoint still orphans the edge (original behavior preserved)', async () => {
    const client = await pool!.connect()
    try {
      await client.query(`DELETE FROM entity_links WHERE id = $1`, [edgeId])
      // Re-create the edge AFTER deleting the entity so only the endpoint is gone.
      await client.query(`DELETE FROM entities WHERE id = $1`, [entityId])
      edgeId = await makeEdge(client, workspaceId, userId, memoryId, entityId)
    } finally {
      client.release()
    }

    expect(await edgeIds()).not.toContain(edgeId)
    expect(await edgeCount()).toBe(0)
    expect(await store.pruneDanglingEntityLinks(workspaceId)).toBe(1)
  })

  it('a live edge is NOT swept by prune', async () => {
    expect(await store.pruneDanglingEntityLinks(workspaceId)).toBe(0)
    expect(await edgeIds()).toContain(edgeId)
  })
})

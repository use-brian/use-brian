/**
 * [COMP:doc/page-tree-store] reparent + reorderSiblings — DB path.
 *
 * Integration test for the doc page-tree mutations on
 * `saved_views` (migration 210: `nest_parent_id` + `position`).
 *
 * Requires a local `Use Brian` PostgreSQL database with migration 210
 * applied. Skips silently otherwise (probe selects the new columns).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import pg from 'pg'
import type { SavedViewStore } from '@use-brian/core'

let pool: pg.Pool | undefined

async function canConnect(): Promise<boolean> {
  const p = new pg.Pool({ database: 'sidanclaw', connectionTimeoutMillis: 2000 })
  try {
    const client = await p.connect()
    try {
      await client.query('SELECT nest_parent_id, position FROM saved_views LIMIT 1')
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
     VALUES (gen_random_uuid(), 'test', 'pt-' || gen_random_uuid())
     RETURNING id`,
  )
  return r.rows[0].id
}

async function makeWorkspace(client: pg.PoolClient, ownerUserId: string): Promise<string> {
  const r = await client.query(
    `INSERT INTO workspaces (id, name, purpose, owner_user_id, is_personal)
     VALUES (gen_random_uuid(), 'pt-ws', 'test', $1, false)
     RETURNING id`,
    [ownerUserId],
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

describeIf('[COMP:doc/page-tree-store] reparent + reorderSiblings', () => {
  let store: SavedViewStore
  let userId: string
  let workspaceId: string

  beforeAll(async () => {
    process.env.DATABASE_URL ??= 'postgres:///sidanclaw'
    const mod = await import('../saved-views-store.js')
    store = mod.createDbSavedViewStore()
  })

  beforeEach(async () => {
    const client = await pool!.connect()
    try {
      userId = await makeUser(client)
      workspaceId = await makeWorkspace(client, userId)
      await addMember(client, workspaceId, userId)
    } finally {
      client.release()
    }
  })

  /** Create a draft page; returns its id. */
  async function page(name: string, nestParentId: string | null = null): Promise<string> {
    const v = await store.createDraft({
      userId,
      workspaceId,
      name,
      entity: 'tasks',
      viewType: 'table',
      binding: { entity: 'tasks', viewType: 'table' },
      page: { blocks: [] },
      nestParentId,
    })
    return v.id
  }

  async function positionsUnder(nestParentId: string | null): Promise<Array<{ id: string; position: number }>> {
    const client = await pool!.connect()
    try {
      const r = await client.query<{ id: string; position: number }>(
        `SELECT id, position FROM saved_views
          WHERE workspace_id = $1 AND nest_parent_id IS NOT DISTINCT FROM $2
          ORDER BY position ASC, id ASC`,
        [workspaceId, nestParentId],
      )
      return r.rows
    } finally {
      client.release()
    }
  }

  it('createDraft files the row under the supplied nest parent', async () => {
    const parent = await page('Parent')
    const child = await page('Child', parent)
    const view = await store.getById(userId, child)
    expect(view?.nestParentId).toBe(parent)
  })

  it('reparent moves a root page under a parent and reindexes siblings 0..n-1', async () => {
    const parent = await page('Parent')
    const a = await page('A', parent)
    const b = await page('B', parent)
    const mover = await page('Mover') // currently root

    // Insert the mover at position 1 (between A and B).
    const moved = await store.reparent(userId, mover, parent, 1)
    expect(moved).toBe(true)

    const rows = await positionsUnder(parent)
    // Three children now, contiguous 0,1,2; mover sits at slot 1.
    expect(rows.map((r) => r.position)).toEqual([0, 1, 2])
    const moverRow = rows.find((r) => r.id === mover)
    expect(moverRow?.position).toBe(1)
    // A stays before mover, B is pushed after.
    const ids = rows.map((r) => r.id)
    expect(ids.indexOf(a)).toBeLessThan(ids.indexOf(mover))
    expect(ids.indexOf(mover)).toBeLessThan(ids.indexOf(b))
  })

  it('reparent to null promotes a child to the workspace root', async () => {
    const parent = await page('Parent')
    const child = await page('Child', parent)
    const moved = await store.reparent(userId, child, null, 0)
    expect(moved).toBe(true)
    const view = await store.getById(userId, child)
    expect(view?.nestParentId).toBeNull()
  })

  it('reparent rejects a self-parent (cycle guard) and leaves the row untouched', async () => {
    const parent = await page('Parent')
    const child = await page('Child', parent)
    const moved = await store.reparent(userId, child, child, 0)
    expect(moved).toBe(false)
    const view = await store.getById(userId, child)
    expect(view?.nestParentId).toBe(parent) // unchanged
  })

  it('reparent rejects nesting a page under its own descendant', async () => {
    const a = await page('A')
    const b = await page('B', a)
    const c = await page('C', b)
    // Move A under C (A → B → C) → cycle.
    const moved = await store.reparent(userId, a, c, 0)
    expect(moved).toBe(false)
    const view = await store.getById(userId, a)
    expect(view?.nestParentId).toBeNull()
  })

  it('reparent returns false for a missing / invisible row', async () => {
    const parent = await page('Parent')
    const moved = await store.reparent(
      userId,
      '00000000-0000-0000-0000-0000000000ff',
      parent,
      0,
    )
    expect(moved).toBe(false)
  })

  it('reorderSiblings sets each id to its array index', async () => {
    const parent = await page('Parent')
    const a = await page('A', parent)
    const b = await page('B', parent)
    const c = await page('C', parent)

    await store.reorderSiblings(userId, parent, [c, a, b])
    const rows = await positionsUnder(parent)
    const byId = new Map(rows.map((r) => [r.id, r.position]))
    expect(byId.get(c)).toBe(0)
    expect(byId.get(a)).toBe(1)
    expect(byId.get(b)).toBe(2)
  })

  it('reorderSiblings is a no-op on an empty list', async () => {
    await expect(store.reorderSiblings(userId, null, [])).resolves.toBeUndefined()
  })
})

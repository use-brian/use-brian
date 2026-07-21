import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import pg from 'pg'
import { randomUUID } from 'node:crypto'

/**
 * Integration test for the supersession + history machinery added in
 * WU-2.4 (workspace_files store update). Schema is mig 119 + mig 128;
 * supersession SQL lives in `workspace-files.ts`.
 *
 * Constraint blocker: `workspace_files` carries `UNIQUE (workspace_id,
 * path)` from mig 119 (not relaxed in mig 128). The SV(2) path-stable
 * supersession the spec calls for therefore cannot run end-to-end yet
 * — those variants are marked `it.todo()` until a follow-up migration
 * makes the constraint partial on `valid_to IS NULL`. The variants
 * here use a `path` override on the supersede patch so the successor
 * lands on a fresh path; that still exercises the full transactional
 * SQL (UPDATE old + INSERT new + chain wiring).
 *
 * Skips silently when the DB is unavailable or mig 128 hasn't applied.
 */

let pool: pg.Pool | undefined

async function canConnect(): Promise<boolean> {
  const p = new pg.Pool({ database: 'sidanclaw', connectionTimeoutMillis: 2000 })
  try {
    const client = await p.connect()
    try {
      await client.query(
        `SELECT valid_from, valid_to, superseded_by, created_by_user_id
         FROM workspace_files LIMIT 1`,
      )
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

const ready = await canConnect()
const describeIf = ready ? describe : describe.skip

afterAll(async () => {
  if (pool) await pool.end()
})

async function makeUser(client: pg.PoolClient): Promise<string> {
  const r = await client.query(
    `INSERT INTO users (id, auth_provider, auth_provider_id)
     VALUES (gen_random_uuid(), 'test', 'wf-super-' || gen_random_uuid())
     RETURNING id`,
  )
  return r.rows[0].id
}

async function makeWorkspace(client: pg.PoolClient, ownerId: string): Promise<string> {
  const r = await client.query(
    `INSERT INTO workspaces (id, name, purpose, owner_user_id, is_personal)
     VALUES (gen_random_uuid(), 'wf-super-test', 'test', $1, false)
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

describeIf('[COMP:files/supersession] workspace_files supersession (integration)', () => {
  let store: import('@use-brian/core').WorkspaceFilesStore

  beforeAll(async () => {
    process.env.DATABASE_URL ??= 'postgres:///sidanclaw'
    const mod = await import('../workspace-files-store.js')
    store = mod.createDbWorkspaceFilesStore()
  })

  let userId: string
  let workspaceId: string

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

  async function seedFile(path: string, opts: { tags?: string[]; sizeBytes?: number } = {}) {
    return store.create(userId, {
      id: randomUUID(),
      workspaceId,
      path,
      parentPath: path.includes('/', 1) ? path.slice(0, path.lastIndexOf('/')) : '/',
      name: path.slice(path.lastIndexOf('/') + 1),
      mime: 'text/markdown',
      sizeBytes: opts.sizeBytes ?? 10,
      storageUri: `gs://test/${workspaceId}/${randomUUID()}`,
      tags: opts.tags ?? [],
      createdByUserId: userId,
    })
  }

  it('supersede closes the old window and inserts a successor', async () => {
    const v1 = await seedFile('/drafts/x.md', { tags: ['draft'], sizeBytes: 10 })

    // Use a path override to dodge the mig-119 UNIQUE(workspace_id, path)
    // constraint until the follow-up migration relaxes it. This still
    // exercises the full supersession SQL — UPDATE old + INSERT new in
    // one transaction, chain wiring, and the universal-column carry-over.
    const v2 = await store.supersede(userId, workspaceId, v1.id, {
      editorUserId: userId,
      storageUri: `gs://test/${workspaceId}/${randomUUID()}`,
      sizeBytes: 20,
      tags: ['draft'],
      path: '/drafts/x.v2.md',
      parentPath: '/drafts',
      name: 'x.v2.md',
    })

    expect(v2).not.toBeNull()
    expect(v2!.id).not.toBe(v1.id)
    expect(v2!.sizeBytes).toBe(20)
    expect(v2!.validTo).toBeNull()
    expect(v2!.supersededBy).toBeNull()
    expect(v2!.createdByUserId).toBe(userId)

    // Direct SELECT of the old row to verify the window closed.
    const old = await pool!.query<{ valid_to: Date | null; superseded_by: string | null }>(
      `SELECT valid_to, superseded_by FROM workspace_files WHERE id = $1`,
      [v1.id],
    )
    expect(old.rows[0].valid_to).not.toBeNull()
    expect(old.rows[0].superseded_by).toBe(v2!.id)
  })

  it('reads of superseded rows return null by default', async () => {
    const v1 = await seedFile('/drafts/y.md')
    const v2 = await store.supersede(userId, workspaceId, v1.id, {
      editorUserId: userId,
      storageUri: `gs://test/${workspaceId}/${randomUUID()}`,
      sizeBytes: 30,
      path: '/drafts/y.v2.md',
    })
    expect(v2).not.toBeNull()

    // The old row is no longer the current version — `getById` filters it.
    const oldRead = await store.getById({ workspaceId, userId, assistantId: userId, assistantKind: 'standard' }, v1.id)
    expect(oldRead).toBeNull()

    // The new row is current and reachable.
    const newRead = await store.getById({ workspaceId, userId, assistantId: userId, assistantKind: 'standard' }, v2!.id)
    expect(newRead?.sizeBytes).toBe(30)

    // `getByPath` on the old path returns nothing — the old row is
    // closed; the new row owns a different path.
    const byOldPath = await store.getByPath({ workspaceId, userId, assistantId: userId, assistantKind: 'standard' }, '/drafts/y.md')
    expect(byOldPath).toBeNull()
    const byNewPath = await store.getByPath({ workspaceId, userId, assistantId: userId, assistantKind: 'standard' }, '/drafts/y.v2.md')
    expect(byNewPath?.id).toBe(v2!.id)
  })

  it('supersede on a non-existent or already-superseded row returns null', async () => {
    const v1 = await seedFile('/drafts/z.md')

    const v2 = await store.supersede(userId, workspaceId, v1.id, {
      editorUserId: userId,
      storageUri: `gs://test/${workspaceId}/${randomUUID()}`,
      sizeBytes: 15,
      path: '/drafts/z.v2.md',
    })
    expect(v2).not.toBeNull()

    // Trying to supersede the already-closed v1 returns null.
    const orphan = await store.supersede(userId, workspaceId, v1.id, {
      editorUserId: userId,
      storageUri: `gs://test/${workspaceId}/${randomUUID()}`,
      sizeBytes: 7,
      path: '/drafts/z.v3.md',
    })
    expect(orphan).toBeNull()

    // Random UUID — no row at all.
    const ghost = await store.supersede(userId, workspaceId, randomUUID(), {
      editorUserId: userId,
      storageUri: `gs://test/${workspaceId}/${randomUUID()}`,
      sizeBytes: 1,
      path: '/drafts/ghost.md',
    })
    expect(ghost).toBeNull()
  })

  it('getHistory returns every version in the chain ordered by valid_from', async () => {
    const v1 = await seedFile('/drafts/chain.md', { sizeBytes: 1 })

    const v2 = await store.supersede(userId, workspaceId, v1.id, {
      editorUserId: userId,
      storageUri: `gs://test/${workspaceId}/${randomUUID()}`,
      sizeBytes: 2,
      path: '/drafts/chain.v2.md',
    })
    expect(v2).not.toBeNull()

    const v3 = await store.supersede(userId, workspaceId, v2!.id, {
      editorUserId: userId,
      storageUri: `gs://test/${workspaceId}/${randomUUID()}`,
      sizeBytes: 3,
      path: '/drafts/chain.v3.md',
    })
    expect(v3).not.toBeNull()

    const history = await store.getHistory({ workspaceId, userId, assistantId: userId, assistantKind: 'standard' }, v2!.id)
    const ids = history.map((r) => r.id)
    const sizes = history.map((r) => r.sizeBytes)
    expect(ids).toEqual([v1.id, v2!.id, v3!.id])
    expect(sizes).toEqual([1, 2, 3])

    // Default `getById` only sees the latest.
    const current = await store.getById({ workspaceId, userId, assistantId: userId, assistantKind: 'standard' }, v3!.id)
    expect(current?.id).toBe(v3!.id)
    expect(current?.validTo).toBeNull()
  })

  it.todo('path-stable supersession (SV(2) convention) — blocked by UNIQUE(workspace_id, path) on mig 119; needs follow-up migration to make the constraint partial on valid_to IS NULL')

  it.todo('path-stable transitive chain — blocked by the same UNIQUE constraint as the path-reuse single-step case')
})

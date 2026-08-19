import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import pg from 'pg'
import { randomUUID } from 'node:crypto'

/**
 * Integration test for the supersession + history machinery added in
 * WU-2.4 (workspace_files store update). Schema is mig 119 + mig 128;
 * supersession SQL lives in `workspace-files.ts`.
 *
 * Path uniqueness: mig 445 replaced mig 119's unscoped `UNIQUE
 * (workspace_id, path)` with the partial `uq_workspace_files_current_path
 * ... WHERE valid_to IS NULL`, so the key belongs to the CURRENT version
 * only. That is what makes path-stable supersession and re-upload after a
 * Brain delete possible; both are covered below alongside the still-live
 * guarantee that two current rows cannot share a path. The older variants
 * keep their `path` override on the patch — a rename is a real supersession
 * shape and still exercises the same transactional SQL.
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

    // Rename variant: the successor lands on a fresh path. Exercises the full
    // supersession SQL — UPDATE old + INSERT new in one transaction, chain
    // wiring, and the universal-column carry-over. The path-STABLE variant
    // (mig 445) is covered separately below.
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

  it('a soft-deleted file releases its path, so the same file can be uploaded again', async () => {
    const v1 = await seedFile('/uploads/report.pdf')

    // Exactly what DELETE /api/brain-inbox/:ws/workspace_file/:id writes.
    await pool!.query(`UPDATE workspace_files SET valid_to = now() WHERE id = $1`, [v1.id])

    // Before mig 445 this threw 23505: the row was gone from every
    // current-version read (so the upload pre-checks waved it through) yet
    // still owned the path, and the user could never re-upload the file they
    // had just deleted.
    const v2 = await seedFile('/uploads/report.pdf')
    expect(v2.id).not.toBe(v1.id)
    expect(v2.validTo).toBeNull()

    const current = await store.getByPath(
      { workspaceId, userId, assistantId: userId, assistantKind: 'standard' },
      '/uploads/report.pdf',
    )
    expect(current?.id).toBe(v2.id)
  })

  it('two CURRENT rows still cannot share a path', async () => {
    await seedFile('/uploads/dup.pdf')
    await expect(seedFile('/uploads/dup.pdf')).rejects.toMatchObject({ code: '23505' })
  })

  it('supersession can keep the path (the successor claims it in the same transaction)', async () => {
    const v1 = await seedFile('/drafts/stable.md', { sizeBytes: 10 })

    const v2 = await store.supersede(userId, workspaceId, v1.id, {
      editorUserId: userId,
      storageUri: `gs://test/${workspaceId}/${randomUUID()}`,
      sizeBytes: 20,
    })

    expect(v2).not.toBeNull()
    expect(v2!.path).toBe('/drafts/stable.md')
    expect(v2!.id).not.toBe(v1.id)
    expect(v2!.validTo).toBeNull()
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

  it('a path-stable chain keeps three versions at one path, only the last current', async () => {
    const v1 = await seedFile('/drafts/stable-chain.md', { sizeBytes: 1 })
    const v2 = await store.supersede(userId, workspaceId, v1.id, {
      editorUserId: userId,
      storageUri: `gs://test/${workspaceId}/${randomUUID()}`,
      sizeBytes: 2,
    })
    const v3 = await store.supersede(userId, workspaceId, v2!.id, {
      editorUserId: userId,
      storageUri: `gs://test/${workspaceId}/${randomUUID()}`,
      sizeBytes: 3,
    })

    const rows = await pool!.query<{ id: string; path: string; valid_to: Date | null }>(
      `SELECT id, path, valid_to FROM workspace_files
        WHERE workspace_id = $1 AND path = '/drafts/stable-chain.md'
        ORDER BY valid_from`,
      [workspaceId],
    )
    expect(rows.rows.map((r) => r.id)).toEqual([v1.id, v2!.id, v3!.id])
    // Three rows share the path; exactly one is current, which is the whole
    // point of scoping the unique index to `valid_to IS NULL`.
    expect(rows.rows.filter((r) => r.valid_to === null)).toHaveLength(1)
    expect(rows.rows[2].valid_to).toBeNull()
  })
})

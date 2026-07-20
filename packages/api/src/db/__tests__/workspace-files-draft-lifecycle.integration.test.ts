import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import pg from 'pg'
import { randomUUID } from 'node:crypto'
import { workspaceFileStatus } from '@use-brian/core'

/**
 * Integration test for the SV(2) draft lifecycle conventions on
 * `workspace_files`. Validates the tag-convention support added in
 * WU-2.4 — the underlying storage already supports tags from mig 119;
 * what's new is the in-place lock-in flow (remove 'draft', add 'final')
 * + the universal-column projection through the store.
 *
 * Skips silently when the DB or mig 128 are absent.
 */

let pool: pg.Pool | undefined

async function canConnect(): Promise<boolean> {
  const p = new pg.Pool({ database: 'Use Brian', connectionTimeoutMillis: 2000 })
  try {
    const client = await p.connect()
    try {
      await client.query(
        `SELECT valid_from, valid_to, created_by_user_id FROM workspace_files LIMIT 1`,
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
     VALUES (gen_random_uuid(), 'test', 'wf-draft-' || gen_random_uuid())
     RETURNING id`,
  )
  return r.rows[0].id
}

async function makeWorkspace(client: pg.PoolClient, ownerId: string): Promise<string> {
  const r = await client.query(
    `INSERT INTO workspaces (id, name, purpose, owner_user_id, is_personal)
     VALUES (gen_random_uuid(), 'wf-draft-test', 'test', $1, false)
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

describeIf('[COMP:files/draft-lifecycle] workspace_files draft lifecycle (integration)', () => {
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

  async function seedDraft(path: string, tags: string[] = ['draft']) {
    return store.create(userId, {
      id: randomUUID(),
      workspaceId,
      path,
      parentPath: path.includes('/', 1) ? path.slice(0, path.lastIndexOf('/')) : '/',
      name: path.slice(path.lastIndexOf('/') + 1),
      mime: 'text/markdown',
      sizeBytes: 12,
      storageUri: `gs://test/${workspaceId}/${randomUUID()}`,
      tags,
      createdByUserId: userId,
    })
  }

  it('new file with tags [draft] reads as active', async () => {
    const file = await seedDraft('/drafts/spec.md')
    expect(file.tags).toContain('draft')
    expect(file.validTo).toBeNull()
    expect(workspaceFileStatus(file)).toBe('active')
  })

  it('lock-in via tag patch: remove draft, add final (in-place)', async () => {
    const draft = await seedDraft('/drafts/lock.md')

    const finalized = await store.updateMeta(userId, workspaceId, draft.id, {
      tags: ['final'],
    })
    expect(finalized).not.toBeNull()
    expect(finalized!.id).toBe(draft.id) // same row — in-place edit
    expect(finalized!.tags).toEqual(['final'])
    expect(finalized!.validTo).toBeNull()
    expect(workspaceFileStatus(finalized!)).toBe('active')
  })

  it('lock-in with final:<commit_sha> tag preserved', async () => {
    const draft = await seedDraft('/drafts/sha.md')
    const finalized = await store.updateMeta(userId, workspaceId, draft.id, {
      tags: ['final:abc123'],
    })
    expect(finalized!.tags).toEqual(['final:abc123'])
  })

  it('search by tag isolates drafts from non-drafts', async () => {
    await seedDraft('/drafts/a.md', ['draft'])
    await seedDraft('/drafts/b.md', ['final'])
    await seedDraft('/drafts/c.md', ['draft', 'finance'])

    const drafts = await store.searchByText({ workspaceId, userId, assistantId: userId, assistantKind: 'standard' }, { tag: 'draft' })
    const draftPaths = drafts.map((r) => r.path).sort()
    expect(draftPaths).toEqual(['/drafts/a.md', '/drafts/c.md'])

    const finals = await store.searchByText({ workspaceId, userId, assistantId: userId, assistantKind: 'standard' }, { tag: 'final' })
    expect(finals.map((r) => r.path)).toEqual(['/drafts/b.md'])
  })

  it('updateMeta on a superseded row returns null (current-version gate)', async () => {
    const v1 = await seedDraft('/drafts/closed.md')

    // Simulate a supersession by closing the window directly. (The
    // full supersede call is covered in the supersession suite — here
    // we just need a closed-window row to confirm updateMeta gates.)
    await pool!.query(
      `UPDATE workspace_files SET valid_to = now(), superseded_by = $1 WHERE id = $2`,
      [randomUUID(), v1.id],
    )

    const result = await store.updateMeta(userId, workspaceId, v1.id, { tags: ['final'] })
    expect(result).toBeNull()
  })
})

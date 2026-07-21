import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import pg from 'pg'

/**
 * Integration tests for indexFileArtifact + the workspace-files lifecycle
 * propagation (large-content-artifacts §Phase 2.1). Component tag:
 * [COMP:files/artifact-index].
 *
 * Requires a local `Use Brian` DB with migration 297 applied; skips silently
 * when unavailable.
 */

let pool: pg.Pool | undefined

async function canConnect(): Promise<boolean> {
  const p = new pg.Pool({ database: 'sidanclaw', connectionTimeoutMillis: 2000 })
  try {
    const client = await p.connect()
    try {
      await client.query('SELECT 1 FROM file_segments LIMIT 1')
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

const DOC = ['# Handbook', 'Alpha section body with several sentences about onboarding and access.', '## Security', 'Passwords rotate quarterly and hardware keys are mandatory for admin roles.'].join('\n\n')

describeIf('[COMP:files/artifact-index] indexFileArtifact + lifecycle propagation (integration)', () => {
  let indexMod: typeof import('../artifact-index.js')
  let wfStore: typeof import('../../db/workspace-files.js')
  let userId: string
  let workspaceId: string
  let fileId: string

  beforeAll(async () => {
    process.env.DATABASE_URL ??= 'postgres:///sidanclaw'
    indexMod = await import('../artifact-index.js')
    wfStore = await import('../../db/workspace-files.js')
  })

  beforeEach(async () => {
    const client = await pool!.connect()
    try {
      const u = await client.query(
        `INSERT INTO users (id, auth_provider, auth_provider_id)
         VALUES (gen_random_uuid(), 'test', 'ai-idx-' || gen_random_uuid()) RETURNING id`,
      )
      userId = u.rows[0].id
      const w = await client.query(
        `INSERT INTO workspaces (id, name, purpose, owner_user_id, is_personal)
         VALUES (gen_random_uuid(), 'ai-idx-ws', 'test', $1, false) RETURNING id`,
        [userId],
      )
      workspaceId = w.rows[0].id
      await client.query(
        `INSERT INTO workspace_members (id, workspace_id, user_id, role)
         VALUES (gen_random_uuid(), $1, $2, 'owner')`,
        [workspaceId, userId],
      )
      const f = await client.query(
        `INSERT INTO workspace_files (id, workspace_id, path, name, title, storage_uri, created_by_user_id, tags)
         VALUES (gen_random_uuid(), $1, '/uploads/handbook.md', 'handbook.md', 'Handbook', 'gs://test/' || gen_random_uuid(), $2, '{draft}')
         RETURNING id`,
        [workspaceId, userId],
      )
      fileId = f.rows[0].id
    } finally {
      client.release()
    }
  })

  it('chunks, inherits the parent verbatim, and stamps metadata.indexing ready', async () => {
    const res = await indexMod.indexFileArtifact({ fileId, workspaceId, text: DOC, actingUserId: userId })
    expect(res.segmentsInserted).toBeGreaterThan(0)
    expect(res.truncated).toBe(false)

    const client = await pool!.connect()
    try {
      const segs = await client.query(
        `SELECT user_id, assistant_id, sensitivity, tags, source FROM file_segments WHERE file_id = $1`,
        [fileId],
      )
      expect(segs.rows.length).toBe(res.segmentCount)
      for (const s of segs.rows) {
        expect(s.user_id).toBeNull() // parent is NULL/NULL workspace-shared
        expect(s.assistant_id).toBeNull()
        expect(s.sensitivity).toBe('internal')
        expect(s.tags).toEqual(['draft'])
        expect(s.source).toBe('user')
      }
      const wf = await client.query(`SELECT metadata FROM workspace_files WHERE id = $1`, [fileId])
      const indexing = wf.rows[0].metadata.indexing
      expect(indexing.status).toBe('ready')
      expect(indexing.segments).toBe(res.segmentCount)
    } finally {
      client.release()
    }
  })

  it('re-index is idempotent (0 new inserts)', async () => {
    await indexMod.indexFileArtifact({ fileId, workspaceId, text: DOC, actingUserId: userId })
    const again = await indexMod.indexFileArtifact({ fileId, workspaceId, text: DOC, actingUserId: userId })
    expect(again.segmentsInserted).toBe(0)
    expect(again.segmentCount).toBeGreaterThan(0)
  })

  it('a sensitivity raise on the parent propagates to every segment', async () => {
    await indexMod.indexFileArtifact({ fileId, workspaceId, text: DOC, actingUserId: userId })
    const updated = await wfStore.updateWorkspaceFileMeta(userId, workspaceId, fileId, {
      sensitivity: 'confidential',
      tags: ['final'],
    })
    expect(updated).not.toBeNull()
    const client = await pool!.connect()
    try {
      const segs = await client.query(`SELECT sensitivity, tags FROM file_segments WHERE file_id = $1`, [fileId])
      for (const s of segs.rows) {
        expect(s.sensitivity).toBe('confidential')
        expect(s.tags).toEqual(['final'])
      }
    } finally {
      client.release()
    }
  })

  it('supersession closes the old version segments in the same transaction', async () => {
    await indexMod.indexFileArtifact({ fileId, workspaceId, text: DOC, actingUserId: userId })
    const next = await wfStore.supersedeWorkspaceFile(userId, workspaceId, fileId, {
      editorUserId: userId,
      storageUri: `gs://test/${fileId}-v2`,
      sizeBytes: 42,
      path: `/uploads/handbook-v2-${fileId}.md`,
    })
    expect(next).not.toBeNull()
    const client = await pool!.connect()
    try {
      const open = await client.query(
        `SELECT count(*) AS c FROM file_segments WHERE file_id = $1 AND valid_to IS NULL`,
        [fileId],
      )
      expect(Number(open.rows[0].c)).toBe(0)
      const all = await client.query(`SELECT count(*) AS c FROM file_segments WHERE file_id = $1`, [fileId])
      expect(Number(all.rows[0].c)).toBeGreaterThan(0) // history preserved
    } finally {
      client.release()
    }
  })

  it('deleting the parent CASCADE-deletes its segments', async () => {
    await indexMod.indexFileArtifact({ fileId, workspaceId, text: DOC, actingUserId: userId })
    const deleted = await wfStore.deleteWorkspaceFile(userId, workspaceId, fileId)
    expect(deleted).toBe(true)
    const client = await pool!.connect()
    try {
      const segs = await client.query(`SELECT count(*) AS c FROM file_segments WHERE file_id = $1`, [fileId])
      expect(Number(segs.rows[0].c)).toBe(0)
    } finally {
      client.release()
    }
  })
})

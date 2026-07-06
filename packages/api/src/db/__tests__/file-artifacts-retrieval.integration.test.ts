import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import pg from 'pg'
import type { RetrievalActor } from '@sidanclaw/core'
import { chunkFileText } from '../file-segments-store.js'

/**
 * Integration tests for the file_segments retrieval path — the Phase-1.5
 * BARRIER proof (large-content-artifacts): a document's segments are
 * insertable and retrievable via `searchFileSegments` / `readFileSegmentRange`
 * AND surface capped through general `search()` BEFORE any Phase-2 writer
 * targets the store. Component tags: [COMP:retrieval/file-segments],
 * [COMP:brain/file-segments-store].
 *
 * Requires a local `sidanclaw` DB with migration 297 applied. Skips silently
 * when the DB is unavailable or the table is missing (mirrors the
 * transcript-segments retrieval integration skip pattern).
 *
 * What it exercises that the unit tests can't:
 *   - Insert stamps every universal column; the access predicate reads it back.
 *   - NULL/NULL visibility (workspace-shared, the deliberate no-CHECK deviation)
 *     is readable by a workspace member.
 *   - `searchFileSegments` ILIKE arm + `readFileSegmentRange` ordered paging.
 *   - General `search()` surfaces `file_segment` hits with the per-artifact
 *     group cap (≤ 2 slots per file in the final page).
 *   - Idempotent re-insert; cross-tenant isolation.
 */

let pool: pg.Pool | undefined

async function canConnect(): Promise<boolean> {
  const p = new pg.Pool({ database: 'sidanclaw', connectionTimeoutMillis: 2000 })
  try {
    const client = await p.connect()
    try {
      await client.query('SELECT id, file_id, segment_index, content FROM file_segments LIMIT 1')
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
     VALUES (gen_random_uuid(), 'test', 'fs-retrieval-' || gen_random_uuid())
     RETURNING id`,
  )
  return r.rows[0].id
}

async function makeWorkspace(client: pg.PoolClient, ownerId: string): Promise<string> {
  const r = await client.query(
    `INSERT INTO workspaces (id, name, purpose, owner_user_id, is_personal)
     VALUES (gen_random_uuid(), 'fs-retrieval-test-ws', 'test', $1, false)
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

async function makeAssistant(client: pg.PoolClient, ownerId: string, workspaceId: string): Promise<string> {
  const r = await client.query(
    `INSERT INTO assistants (id, name, owner_user_id, workspace_id)
     VALUES (gen_random_uuid(), 'fs-retrieval-test-assistant', $1, $2)
     RETURNING id`,
    [ownerId, workspaceId],
  )
  return r.rows[0].id
}

/** Create the workspace_files artifact row (file_id FK target), NULL/NULL visibility. */
async function makeArtifact(client: pg.PoolClient, workspaceId: string, userId: string, name: string): Promise<string> {
  const r = await client.query(
    `INSERT INTO workspace_files (id, workspace_id, path, name, title, storage_uri, created_by_user_id)
     VALUES (gen_random_uuid(), $1, '/uploads/' || $3, $3, $3, 'gs://test-bucket/' || gen_random_uuid(), $2)
     RETURNING id`,
    [workspaceId, userId, name],
  )
  return r.rows[0].id
}

const SAMPLE_DOC = [
  '# Q3 Report',
  'The quarter opened with steady pipeline growth across all regions and a notable uptick in enterprise renewals that the sales team attributed to the new pricing structure introduced in June.',
  '## Finance',
  'Revenue grew eighteen percent quarter over quarter, driven primarily by the Acme renewal and two new enterprise contracts signed in September that together added a substantial recurring baseline.',
  '## Hiring',
  'Two senior engineers joined the platform team in August, and the recruiting pipeline for the developer-experience role remains active with four candidates in final rounds.',
].join('\n\n')

describeIf('[COMP:retrieval/file-segments] file_segments retrieval (integration)', () => {
  let store: typeof import('../file-segments-store.js')
  let retrieval: typeof import('../retrieval-store.js')
  let userId: string
  let workspaceId: string
  let assistantId: string
  let fileId: string
  let actor: RetrievalActor

  beforeAll(async () => {
    process.env.DATABASE_URL ??= 'postgres:///sidanclaw'
    store = await import('../file-segments-store.js')
    retrieval = await import('../retrieval-store.js')
  })

  beforeEach(async () => {
    const client = await pool!.connect()
    try {
      userId = await makeUser(client)
      workspaceId = await makeWorkspace(client, userId)
      await addMember(client, workspaceId, userId)
      assistantId = await makeAssistant(client, userId, workspaceId)
      fileId = await makeArtifact(client, workspaceId, userId, 'q3-report.md')
      actor = { workspaceId, userId, assistantId, assistantKind: 'standard', clearance: 'confidential' }
    } finally {
      client.release()
    }
  })

  async function insertSample(targetFileId = fileId, text = SAMPLE_DOC): Promise<number> {
    const { segments } = chunkFileText(text)
    return store.insertFileSegments({
      fileId: targetFileId,
      workspaceId,
      createdByUserId: userId,
      // Workspace-shared parent (filesApi default) — the deliberate NULL/NULL
      // shape migration 297 permits by omitting the visibility CHECK.
      visibility: { userId: null, assistantId: null },
      sensitivity: 'internal',
      compartments: [],
      tags: null,
      source: 'user',
      segments,
    })
  }

  it('inserts NULL/NULL-visibility segments and a member retrieves them by ILIKE with heading_path', async () => {
    const n = await insertSample()
    expect(n).toBeGreaterThan(0)

    const hits = await retrieval.searchFileSegments(actor, { fileId, query: 'Revenue grew' })
    expect(hits.length).toBeGreaterThan(0)
    const hit = hits.find((h) => /Revenue grew/i.test(h.content))
    expect(hit).toBeDefined()
    expect(hit!.heading_path).toContain('Finance')
    expect(typeof hit!.char_start).toBe('number')
    expect(hit!.char_end).toBeGreaterThan(hit!.char_start)
  })

  it('pages all segments in order via readFileSegmentRange', async () => {
    await insertSample()
    const range = await retrieval.readFileSegmentRange(actor, { fileId, fromIndex: 0, toIndex: 1000 })
    expect(range.length).toBeGreaterThan(0)
    expect(range.map((s) => s.segment_index)).toEqual(range.map((_, i) => i))
    // Reassembled ranges are exact slices of the source — verbatim quoting works.
    expect(range[0].content.startsWith('# Q3 Report')).toBe(true)
  })

  it('general search() surfaces file_segment hits capped at 2 per artifact', async () => {
    // A document where MANY segments match the query term.
    const spam = Array.from(
      { length: 25 },
      (_, i) =>
        `## Section ${i}\n\nZebrafish observation number ${i}: the zebrafish colony continues to expand with remarkable zebrafish behaviors recorded daily in the west tank throughout the entire observation period.`,
    ).join('\n\n')
    await insertSample(fileId, spam)

    const res = await retrieval.search(actor, { query: 'zebrafish', limit: 20 })
    const segHits = res.data.filter((r) => r.primitive === 'file_segment')
    expect(segHits.length).toBeGreaterThan(0)
    expect(segHits.length).toBeLessThanOrEqual(2)
    const first = segHits[0] as { file_id?: string; segment_index?: number; file_name?: string | null }
    expect(first.file_id).toBe(fileId)
    expect(typeof first.segment_index).toBe('number')
    expect(first.file_name).toBe('q3-report.md')
  })

  it('scoped search({scope:"file_segment"}) returns only segments', async () => {
    await insertSample()
    const res = await retrieval.search(actor, { query: 'renewals', scope: 'file_segment', limit: 10 })
    expect(res.data.length).toBeGreaterThan(0)
    for (const r of res.data) expect(r.primitive).toBe('file_segment')
  })

  it('is idempotent on (file_id, segment_index) — re-insert does not duplicate', async () => {
    const first = await insertSample()
    const second = await insertSample()
    expect(second).toBe(0)
    const client = await pool!.connect()
    try {
      const r = await client.query<{ c: string }>('SELECT count(*) AS c FROM file_segments WHERE file_id = $1', [
        fileId,
      ])
      expect(Number(r.rows[0].c)).toBe(first)
    } finally {
      client.release()
    }
  })

  it('cross-tenant: an actor in another workspace retrieves nothing', async () => {
    await insertSample()
    const client = await pool!.connect()
    let otherUser: string
    let otherWs: string
    let otherAssistant: string
    try {
      otherUser = await makeUser(client)
      otherWs = await makeWorkspace(client, otherUser)
      await addMember(client, otherWs, otherUser)
      otherAssistant = await makeAssistant(client, otherUser, otherWs)
    } finally {
      client.release()
    }
    const otherActor: RetrievalActor = {
      workspaceId: otherWs,
      userId: otherUser,
      assistantId: otherAssistant,
      assistantKind: 'standard',
      clearance: 'confidential',
    }
    const hits = await retrieval.searchFileSegments(otherActor, { fileId, query: 'Revenue' })
    expect(hits).toEqual([])
    const range = await retrieval.readFileSegmentRange(otherActor, { fileId, fromIndex: 0, toIndex: 1000 })
    expect(range).toEqual([])
    const general = await retrieval.search(otherActor, { query: 'renewals', scope: 'file_segment', limit: 10 })
    expect(general.data).toEqual([])
  })
})

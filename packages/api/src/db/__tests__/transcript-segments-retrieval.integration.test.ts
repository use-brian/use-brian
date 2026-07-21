import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import pg from 'pg'
import type { RetrievalActor } from '@use-brian/core'
import { segmentTranscript, type Utterance } from '../transcript-segments-store.js'

/**
 * Integration tests for the dedicated `transcript_segments` retrieval path
 * (recording-to-brain Phase 3) — the BARRIER proof: a recording's segments are
 * insertable and retrievable via `searchRecording` / `readRecordingRange`
 * BEFORE the Phase-2 transcription writer targets them. Component tag:
 * [COMP:brain/transcript-segments-store].
 *
 * Requires a local `Use Brian` DB with migration 280 applied. Skips silently
 * when the DB is unavailable or the table is missing (mirrors the
 * entity-instance retrieval integration skip pattern).
 *
 * What it exercises that the unit test can't:
 *   - The insert stamps every universal column so the access predicate reads it.
 *   - `searchRecording` ILIKE arm returns matching segments with timestamps.
 *   - `readRecordingRange` pages ordered segments for whole-section recall.
 *   - Idempotent re-insert on (recording_id, segment_index) does not duplicate.
 *   - Cross-tenant isolation: a different workspace's actor sees nothing.
 */

let pool: pg.Pool | undefined

async function canConnect(): Promise<boolean> {
  const p = new pg.Pool({ database: 'sidanclaw', connectionTimeoutMillis: 2000 })
  try {
    const client = await p.connect()
    try {
      await client.query('SELECT id, recording_id, segment_index, segment_text FROM transcript_segments LIMIT 1')
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
     VALUES (gen_random_uuid(), 'test', 'ts-retrieval-' || gen_random_uuid())
     RETURNING id`,
  )
  return r.rows[0].id
}

async function makeWorkspace(client: pg.PoolClient, ownerId: string): Promise<string> {
  const r = await client.query(
    `INSERT INTO workspaces (id, name, purpose, owner_user_id, is_personal)
     VALUES (gen_random_uuid(), 'ts-retrieval-test-ws', 'test', $1, false)
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
     VALUES (gen_random_uuid(), 'ts-retrieval-test-assistant', $1, $2)
     RETURNING id`,
    [ownerId, workspaceId],
  )
  return r.rows[0].id
}

/** Create the recording's provenance Episode (recording_id FK target). */
async function makeRecordingEpisode(client: pg.PoolClient, workspaceId: string, userId: string): Promise<string> {
  const r = await client.query(
    `INSERT INTO episodes (id, source_kind, source_ref, occurred_at, workspace_id, created_by_user_id, user_id)
     VALUES (gen_random_uuid(), 'recording', '{"name":"call.m4a"}'::jsonb, now(), $1, $2, $2)
     RETURNING id`,
    [workspaceId, userId],
  )
  return r.rows[0].id
}

const SAMPLE: Utterance[] = [
  { startMs: 0, endMs: 8000, speaker: 'Priya', text: 'I really think the Q3 pricing pushback from Acme is a serious risk we have to address before the renewal.' },
  { startMs: 8000, endMs: 15000, speaker: 'Sam', text: 'Agreed. Let us prepare a discount proposal and a revised SOW for them by Friday afternoon.' },
  { startMs: 15000, endMs: 22000, speaker: 'Priya', text: 'Good. I will also loop in finance on the margin impact so we do not give away too much.' },
]

describeIf('[COMP:brain/transcript-segments-store] transcript_segments retrieval (integration)', () => {
  let store: typeof import('../transcript-segments-store.js')
  let retrieval: typeof import('../retrieval-store.js')
  let userId: string
  let workspaceId: string
  let assistantId: string
  let recordingId: string
  let actor: RetrievalActor

  beforeAll(async () => {
    process.env.DATABASE_URL ??= 'postgres:///sidanclaw'
    store = await import('../transcript-segments-store.js')
    retrieval = await import('../retrieval-store.js')
  })

  beforeEach(async () => {
    const client = await pool!.connect()
    try {
      userId = await makeUser(client)
      workspaceId = await makeWorkspace(client, userId)
      await addMember(client, workspaceId, userId)
      assistantId = await makeAssistant(client, userId, workspaceId)
      recordingId = await makeRecordingEpisode(client, workspaceId, userId)
      actor = { workspaceId, userId, assistantId, assistantKind: 'standard', clearance: 'confidential' }
    } finally {
      client.release()
    }
  })

  async function insertSample(): Promise<number> {
    return store.insertTranscriptSegments({
      recordingId,
      workspaceId,
      createdByUserId: userId,
      visibility: { userId: null, assistantId }, // workspace-shared via the assistant
      sensitivity: 'internal',
      segments: segmentTranscript(SAMPLE),
    })
  }

  it('inserts segments and retrieves them by ILIKE, with timestamps + speaker', async () => {
    const n = await insertSample()
    expect(n).toBeGreaterThan(0)

    const hits = await retrieval.searchRecording(actor, { recordingId, query: 'pricing pushback' })
    expect(hits.length).toBeGreaterThan(0)
    const hit = hits.find((h) => /pricing pushback/i.test(h.segment_text))
    expect(hit).toBeDefined()
    expect(hit!.speaker).toBe('Priya')
    expect(hit!.start_ms).toBe(0)
    expect(typeof hit!.segment_index).toBe('number')
  })

  it('pages all segments in order via readRecordingRange', async () => {
    await insertSample()
    const range = await retrieval.readRecordingRange(actor, { recordingId, fromIndex: 0, toIndex: 1000 })
    expect(range.length).toBeGreaterThan(0)
    expect(range.map((s) => s.segment_index)).toEqual(range.map((_, i) => i))
  })

  it('is idempotent on (recording_id, segment_index) — re-insert does not duplicate', async () => {
    const first = await insertSample()
    const second = await insertSample()
    expect(second).toBe(0) // all conflicted -> nothing inserted the second time
    const client = await pool!.connect()
    try {
      const r = await client.query<{ c: string }>(
        'SELECT count(*) AS c FROM transcript_segments WHERE recording_id = $1',
        [recordingId],
      )
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
    // Same recordingId, but the other actor is not a member of this workspace —
    // RLS + the access predicate must hide every segment.
    const hits = await retrieval.searchRecording(otherActor, { recordingId, query: 'pricing' })
    expect(hits).toEqual([])
    const range = await retrieval.readRecordingRange(otherActor, { recordingId, fromIndex: 0, toIndex: 1000 })
    expect(range).toEqual([])
  })
})

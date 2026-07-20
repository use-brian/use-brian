import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import pg from 'pg'
import os from 'node:os'
import path from 'node:path'
import { mkdtempSync } from 'node:fs'
import type { RetrievalActor } from '@use-brian/core'

/**
 * END-TO-END integration for the large-content-artifacts chain (goal
 * done-when #3, the psql-verifiable half):
 *
 *   promote (writeBytes + sync chunk + enqueue) → file_ingest_jobs row →
 *   worker tick (readBytes → parse → idempotent chunk → Pipeline B port w/
 *   file_upload contentRef → source_episode_id stamp → done) →
 *   searchFileContent-level retrieval (searchFileSegments / range) →
 *   paste promotion producing the manifest turn.
 *
 * Uses the LOCAL files client (disk blobs) + local PG; the Pipeline B port is
 * a spy that also creates a REAL episodes row so the content_ref->>'file_id'
 * check runs against the actual table. Embedding fill is prod-observable
 * (needs the Gemini embedder) — the ILIKE arm is what this test asserts.
 *
 * [COMP:files/artifact-e2e]
 */

let pool: pg.Pool | undefined

async function canConnect(): Promise<boolean> {
  const p = new pg.Pool({ database: 'Use Brian', connectionTimeoutMillis: 2000 })
  try {
    const client = await p.connect()
    try {
      await client.query('SELECT 1 FROM file_ingest_jobs LIMIT 1')
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

const CLAUSE_BODY =
  'covers the obligations of the vendor regarding delivery schedules, quality assurance benchmarks, escalation contacts, audit rights, data handling commitments, and the penalties that apply when service level agreements are missed, including the remediation window the parties agreed during negotiation and the reporting cadence the account team must maintain throughout the term.'
const BIG_DOC = [
  '# Vendor Contract Review',
  // ~50K chars ≈ ~12.5K tokens — comfortably over the 8K paste threshold.
  ...Array.from({ length: 120 }, (_, i) => `## Clause ${i + 1}\n\nThis clause number ${i + 1} ${CLAUSE_BODY}`),
  '## Termination',
  // Over MIN_CHARS (200) so this section stands alone with its own heading
  // rather than tail-merging into the previous clause (the designed behavior
  // for sub-MIN trailing scraps).
  'Either party may terminate this agreement with ninety days written notice delivered to the registered contact, and the walrus clause requires the vendor to return all confidential materials within thirty days of the effective termination date, certify their destruction in writing, and cooperate with any transition-of-service plan the customer reasonably requests during the notice period.',
].join('\n\n')

describeIf('[COMP:files/artifact-e2e] promote → job → worker → retrieval (integration)', () => {
  let userId: string
  let workspaceId: string
  let assistantId: string
  let actor: RetrievalActor
  let filesApi: import('@use-brian/core').FilesApi
  let promote: import('../artifact-promote.js').ArtifactPromoter
  let jobsStore: typeof import('../../db/file-ingest-jobs-store.js')
  let retrieval: typeof import('../../db/retrieval-store.js')

  beforeAll(async () => {
    process.env.DATABASE_URL ??= 'postgres:///sidanclaw'
    const { createFilesApi } = await import('../files-api.js')
    const { createLocalFilesClient } = await import('../local-files-client.js')
    const { createDbWorkspaceFilesStore } = await import('../../db/workspace-files-store.js')
    const { createArtifactPromoter } = await import('../artifact-promote.js')
    jobsStore = await import('../../db/file-ingest-jobs-store.js')
    retrieval = await import('../../db/retrieval-store.js')

    const client = await pool!.connect()
    try {
      const u = await client.query(
        `INSERT INTO users (id, auth_provider, auth_provider_id)
         VALUES (gen_random_uuid(), 'test', 'e2e-' || gen_random_uuid()) RETURNING id`,
      )
      userId = u.rows[0].id
      const w = await client.query(
        `INSERT INTO workspaces (id, name, purpose, owner_user_id, is_personal)
         VALUES (gen_random_uuid(), 'e2e-ws', 'test', $1, false) RETURNING id`,
        [userId],
      )
      workspaceId = w.rows[0].id
      await client.query(
        `INSERT INTO workspace_members (id, workspace_id, user_id, role)
         VALUES (gen_random_uuid(), $1, $2, 'owner')`,
        [workspaceId, userId],
      )
      const a = await client.query(
        `INSERT INTO assistants (id, name, owner_user_id, workspace_id)
         VALUES (gen_random_uuid(), 'e2e-assistant', $1, $2) RETURNING id`,
        [userId, workspaceId],
      )
      assistantId = a.rows[0].id
    } finally {
      client.release()
    }
    actor = { workspaceId, userId, assistantId, assistantKind: 'standard', clearance: 'confidential' }

    const baseDir = mkdtempSync(path.join(os.tmpdir(), 'artifact-e2e-'))
    filesApi = createFilesApi({
      gcs: createLocalFilesClient({ baseDir }),
      bucket: 'e2e-local',
      store: createDbWorkspaceFilesStore(),
      auditStore: { append: async () => {} } as never,
    })
    promote = createArtifactPromoter({
      filesApi,
      enqueue: (job) => jobsStore.enqueueFileIngestJob(job),
    })
  })

  it('runs the whole chain: manifest turn, segments, job → done, episode back-edge, retrieval', async () => {
    // 1. Paste promotion (the manifest turn) — same promoter the routes use.
    const { promotePastedText } = await import('../paste-promotion.js')
    const pasted = await promotePastedText({
      text: BIG_DOC,
      workspaceId,
      actingUserId: userId,
      assistantId,
      promote,
    })
    expect(pasted).not.toBeNull()
    const fileId = pasted!.fileId
    expect(pasted!.replaced).toContain(`searchFileContent with fileId="${fileId}"`)
    expect(pasted!.replaced.length).toBeLessThan(BIG_DOC.length / 4)

    // 2. Segments were chunked synchronously; the job row is pending.
    const client = await pool!.connect()
    try {
      const segs = await client.query<{ c: string }>(
        'SELECT count(*) AS c FROM file_segments WHERE file_id = $1',
        [fileId],
      )
      expect(Number(segs.rows[0].c)).toBeGreaterThan(30)
      const jobs = await client.query<{ status: string }>(
        'SELECT status FROM file_ingest_jobs WHERE file_id = $1',
        [fileId],
      )
      expect(jobs.rows).toHaveLength(1)
      expect(jobs.rows[0].status).toBe('pending')
    } finally {
      client.release()
    }

    // 3. Worker tick: drain the job with a Pipeline B port that creates a REAL
    //    episode row carrying the file_upload contentRef.
    const { createFileIngestWorker } = await import('../file-ingest-worker.js')
    const { createEpisode } = await import('../../db/episodes-store.js')
    const brainIngest = vi.fn(async (input: Record<string, unknown>) => {
      const episode = await createEpisode(userId, {
        sourceKind: 'file_upload' as never,
        sourceRef: (input.sourceRef as Record<string, unknown>) ?? {},
        contentRef: input.contentRef as Record<string, unknown>,
        occurredAt: new Date(),
        workspaceId,
        userId: null,
        assistantId,
        createdByUserId: userId,
        sensitivity: 'internal',
      } as never)
      return { episodeId: episode.id, extracted: true, entitiesWritten: [], edgesWritten: [], memoriesWritten: [], tasksWritten: [] }
    })
    const worker = createFileIngestWorker({
      claim: jobsStore.claimNextFileIngestJob,
      markDone: jobsStore.markFileIngestJobDone,
      markFailed: async (id, error) => jobsStore.markFileIngestJobFailed(id, error),
      filesApi,
      brainIngest: brainIngest as never,
    })
    await worker.tick()

    // 4. Job done; episode exists with the file back-edge; artifact stamped.
    const client2 = await pool!.connect()
    try {
      const jobs = await client2.query<{ status: string }>(
        'SELECT status FROM file_ingest_jobs WHERE file_id = $1',
        [fileId],
      )
      expect(jobs.rows[0].status).toBe('done')
      const eps = await client2.query<{ id: string; content_ref: { file_id?: string } }>(
        `SELECT id, content_ref FROM episodes WHERE content_ref->>'file_id' = $1`,
        [fileId],
      )
      expect(eps.rows.length).toBeGreaterThan(0)
      const wf = await client2.query<{ source_episode_id: string | null; metadata: { indexing?: { status?: string } } }>(
        'SELECT source_episode_id, metadata FROM workspace_files WHERE id = $1',
        [fileId],
      )
      expect(wf.rows[0].source_episode_id).toBe(eps.rows[0].id)
      expect(wf.rows[0].metadata.indexing?.status).toBe('ready')
    } finally {
      client2.release()
    }
    expect(brainIngest).toHaveBeenCalledOnce()

    // 5. Extraction retrieval — the searchFileContent store surface.
    const hits = await retrieval.searchFileSegments(actor, { fileId, query: 'walrus clause' })
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0].content).toContain('walrus clause')
    expect(hits[0].heading_path).toContain('Termination')

    const range = await retrieval.readFileSegmentRange(actor, { fileId, fromIndex: 0, toIndex: 2 })
    expect(range.length).toBe(3)
    expect(range[0].content.startsWith('# Vendor Contract Review')).toBe(true)

    // 6. General search surfaces the document, capped per artifact.
    const general = await retrieval.search(actor, { query: 'walrus clause', limit: 20 })
    const segHits = general.data.filter((r) => r.primitive === 'file_segment')
    expect(segHits.length).toBeGreaterThan(0)
    expect(segHits.length).toBeLessThanOrEqual(2)
  })
})

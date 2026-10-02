/** Full canonical schema (including migration 653), real app-role stores and local
 * disk media. Only model/Pipeline-B semantics are deterministic fixture seams. */
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Server } from 'node:http'
import express from 'express'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { getAppPool, getPool, queryWithRLS } from '../../db/client.js'
import { createDbWorkspaceGroupStore } from '../../db/workspace-group-store.js'
import { createDbSavedViewStore } from '../../db/saved-views-store.js'
import { createDbWorkspaceFilesStore } from '../../db/workspace-files-store.js'
import { createWorkspaceAuditStore } from '../../db/workspace-audit-store.js'
import { createFilesApi, type FilesClientResolver } from '../../files/files-api.js'
import { createLocalFilesClient } from '../../files/local-files-client.js'
import { localFilesTransferRoutes } from '../../routes/local-files-transfer.js'
import { openRecordingsRoutes } from '../../routes/recordings.js'
import { watchRecordingRoutes } from '../../routes/watch-recording.js'
import { claimNextRecordingJob, enqueueRecordingJob, hasCompletedRecordingJob, markRecordingJobFailed, markRecordingJobDone } from '../../db/recording-jobs-store.js'
import { captureRecordingSegmentProvenance, recordingIntakeTransaction } from '../../db/recording-intake-admission.js'
import { getRecording, updateRecording } from '../../db/recordings-store.js'
import { authorizeWatchDestination, createWatchService } from '../watch-service.js'
import { watchStore, sha256 } from '../watch-store.js'
import { processOpenRecordingWithBookkeeping } from '../process-recording.js'
import { probeRecordingDuration } from '../ffmpeg.js'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture() // Refuse ambient/dev/production DBs; existing canonical-intake fixture guard.
const pool = getPool(), exec = promisify(execFile)
const servers: Server[] = []
let directory: string, first: Buffer, second: Buffer, full: Buffer
beforeAll(async () => {
  expect((await pool.query("SELECT name FROM _migrations WHERE name IN ('643_recording_segment_publication.sql','653_watch_recording.sql') ORDER BY name")).rows).toEqual([
    { name: '643_recording_segment_publication.sql' }, { name: '653_watch_recording.sql' },
  ])
  // Same post-migration app-role fixture grant as page-placement-admission.integration.test.ts.
  await pool.query('GRANT EXECUTE ON FUNCTION lock_page_placement_teamspace(uuid,uuid) TO assurance_app')
  directory = await mkdtemp(join(tmpdir(), 'watch-canonical-media-'))
  for (const [name, frequency, duration] of [['first', 440, 1], ['second', 880, 1], ['full', 660, 2]] as const) {
    await exec('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `sine=frequency=${frequency}:sample_rate=16000:duration=${duration}`, '-c:a', 'aac', '-b:a', '48k', '-movflags', '+faststart', join(directory, `${name}.m4a`)])
  }
  first = await readFile(join(directory, 'first.m4a')); second = await readFile(join(directory, 'second.m4a')); full = await readFile(join(directory, 'full.m4a'))
}, 60000)
afterAll(async () => {
  for (const server of servers) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  await getAppPool().end(); await pool.end()
  if (directory) await rm(directory, { recursive: true, force: true })
}, 60000)

async function fixture() {
  const userId = randomUUID(), workspaceId = randomUUID(), assistantId = randomUUID(), outsider = randomUUID()
  for (const id of [userId, outsider]) await pool.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)', [id])
  await pool.query("INSERT INTO workspaces(id,name,owner_user_id) VALUES($1,'Watch canonical fixture',$2)", [workspaceId, userId])
  await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role,clearance) VALUES($1,$2,'owner','confidential')", [workspaceId, userId])
  const team = await createDbWorkspaceGroupStore().createTeam(userId, workspaceId, { name: 'Watch default', key: 'watch-default' })
  await pool.query("UPDATE workspace_access_policies SET access_mode='simple',setup_state='ready',default_department_id=$2 WHERE workspace_id=$1", [workspaceId, team.id])
  await pool.query("INSERT INTO teamspaces(workspace_id,name,sensitivity,is_default,workspace_group_id,created_by) VALUES($1,'Watch default','internal',true,$2,$3)", [workspaceId, team.id, userId])
  await pool.query("INSERT INTO assistants(id,workspace_id,name,kind,clearance) VALUES($1,$2,'Primary','primary','confidential')", [assistantId, workspaceId])
  const app = express(); app.use(express.json())
  const server = await new Promise<Server>(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) })
  servers.push(server)
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  const signingSecret = 'watch-canonical-local-transfer-secret'
  const baseDir = join(directory, workspaceId)
  const storage = createLocalFilesClient({ baseDir, apiUrl: origin, signingSecret })
  const resolver: FilesClientResolver = {
    forWorkspace: async id => { expect(id).toBe(workspaceId); return { gcs: storage, bucket: baseDir, uriScheme: 'file', byo: true } },
    forUri: async (id, uri) => { expect(id).toBe(workspaceId); expect(uri.startsWith(`file://${baseDir}/`)).toBe(true); return storage },
  }
  const files = createFilesApi({ resolver, store: createDbWorkspaceFilesStore(), auditStore: createWorkspaceAuditStore() })
  const pages = createDbSavedViewStore()
  const service = createWatchService({ files, pages, transcribe: async bytes => {
    expect(bytes.length).toBeGreaterThan(1000)
    return 'Speaker 1: Deterministic watch transcript.'
  } })
  const tokens = await watchStore.provision({ ownerId: userId, workspaceId, assistantId, deviceId: randomUUID(), deployment: 'canonical-fixture', label: 'Watch', provisioningKey: signingSecret })
  const grant = await watchStore.authenticate(tokens.accessToken, 'canonical-fixture')
  const humanAuth: express.RequestHandler = (req, _res, next) => { req.userId = userId; next() }
  app.use('/api/local-files', localFilesTransferRoutes({ client: storage, signingSecret }))
  app.use('/api/watch/v1', watchRecordingRoutes({ deployment: 'canonical-fixture', provisioningKey: signingSecret, humanAuth, authorize: authorizeWatchDestination, service }))
  app.use('/api/recordings', humanAuth, openRecordingsRoutes({ filesResolver: resolver, enqueueJob: enqueueRecordingJob, hasProcessed: hasCompletedRecordingJob,
    getRole: async (actor, workspace) => (await queryWithRLS(actor, 'SELECT role FROM workspace_members WHERE workspace_id=$1 AND user_id=$2', [workspace, actor])).rows[0]?.role ?? null,
  }))
  return { userId, outsider, workspaceId, assistantId, team, app, server, storage, resolver, files, pages, service, tokens, grant }
}

describe('watch → canonical file/Episode/recording/page → real queue/processor', () => {
  it.each(['windows', 'full'] as const)('publishes and processes %s intake once, preserving capturedAt and app-role readability', async source => {
    const f = await fixture(), clientId = randomUUID(), capturedAt = '2026-01-03T04:05:06.000Z'
    const c = await watchStore.create(f.grant, clientId, { capturedAt, title: `Watch ${source}`, source: 'apple-watch' })
    await f.service.prepare(f.grant, c) // REAL saved-view store/placement + migration-653 publication guard.
    await f.service.prepare(f.grant, c)
    expect(await f.pages.getById(f.userId, c.page_id)).toMatchObject({ id: c.page_id, workspaceId: f.workspaceId })
    const path = `/api/watch/v1/sessions/${clientId}`
    const sendWindow = (sequence: number, audio: Buffer) => request(f.server).put(`${path}/windows`)
      .query({ sequence, offsetMs: sequence * 1000, durationMs: 1000, sha256: sha256(audio) }).set('Authorization', `Bearer ${f.tokens.accessToken}`).set('Content-Type', 'audio/mp4').send(audio)
    if (source === 'windows') await sendWindow(1, second).expect(200) // out of order and real decode
    await sendWindow(0, first).expect(200)
    await sendWindow(0, first).expect(200)
    await f.service.retry(f.grant, clientId)
    expect((await pool.query('SELECT offset_ms FROM live_transcript_windows WHERE session_id=$1 ORDER BY offset_ms', [c.id])).rows).toEqual(source === 'windows' ? [{ offset_ms: 0 }, { offset_ms: 1000 }] : [{ offset_ms: 0 }])
    if (source === 'full') {
      const descriptor = { bytes: full.length, durationMs: 2000, sha256: sha256(full) }
      const initialize = () => request(f.server).post(`${path}/full-upload`).set('Authorization', `Bearer ${f.tokens.accessToken}`).send(descriptor)
      const lease = await initialize().expect(200), renewed = await initialize().expect(200)
      expect(renewed.body.sessionId).toBe(lease.body.sessionId)
      await request(f.server).put(lease.body.uploadUrl).set('Content-Type', 'audio/mp4').send(full).expect(200)
      await request(f.server).put(renewed.body.uploadUrl).set('Content-Type', 'audio/mp4').send(full).expect(200)
      expect((await pool.query('SELECT id FROM recordings WHERE workspace_id=$1', [f.workspaceId])).rows).toEqual([])
    }
    const intent = { source, expectedWindows: source === 'full' ? 0 : 2, allowIncomplete: false }
    const finalized = await f.service.finalize(f.grant, clientId, intent) // REAL createRecording/canonical intake; no store mocks.
    expect(finalized).toMatchObject({ state: 'finalized', recordingId: c.recording_id, pageId: c.page_id, processing: 'queued', pagePrepared: true })
    await f.service.finalize(f.grant, clientId, intent)
    const recording = await getRecording(f.userId, c.recording_id)
    expect(recording).toMatchObject({ id: c.recording_id, assistantId: null, status: 'queued', mime: 'audio/mp4' })
    expect(recording?.mediaFileId).toBeTruthy()
    const counts = async () => (await pool.query(`SELECT
      (SELECT count(*)::int FROM saved_views WHERE workspace_id=$1) AS pages,
      (SELECT count(*)::int FROM recordings WHERE workspace_id=$1) AS recordings,
      (SELECT count(*)::int FROM episodes WHERE workspace_id=$1 AND source_kind='recording') AS episodes,
      (SELECT count(*)::int FROM recording_jobs WHERE workspace_id=$1) AS jobs,
      (SELECT count(*)::int FROM workspace_files WHERE workspace_id=$1 AND mime='audio/mp4') AS media`, [f.workspaceId])).rows[0]
    expect(await counts()).toEqual({ pages: 1, recordings: 1, episodes: 1, jobs: 1, media: 1 })
    expect((await pool.query('SELECT linked_recording_id FROM saved_views WHERE id=$1', [c.page_id])).rows[0].linked_recording_id).toBe(c.recording_id)
    const episodeBefore = (await pool.query('SELECT occurred_at,source_ref,scope_version FROM episodes WHERE id=$1', [c.recording_id])).rows[0]
    expect(new Date(episodeBefore.occurred_at).toISOString()).toBe(capturedAt)
    const provenance = await captureRecordingSegmentProvenance({ actorUserId: f.userId }, f.workspaceId, c.recording_id)
    expect(provenance.parent.resourceId).toBe(recording!.mediaFileId)
    await recordingIntakeTransaction({ actorUserId: f.userId }, async db => {
      expect((await db.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0]).toEqual({ rolsuper: false, rolbypassrls: false })
      expect((await db.query('SELECT id FROM recordings WHERE id=$1', [c.recording_id])).rows).toHaveLength(1)
    })
    expect((await queryWithRLS(f.outsider, 'SELECT id FROM recordings WHERE id=$1', [c.recording_id])).rows).toEqual([])
    expect((await queryWithRLS(f.outsider, 'SELECT id FROM workspace_files WHERE id=$1', [recording!.mediaFileId])).rows).toEqual([])
    const playback = await request(f.server).get(`/api/recordings/${c.recording_id}/media-url`).expect(200)
    const response = await fetch(playback.body.url)
    expect(response.status).toBe(200)
    const playbackBytes = Buffer.from(await response.arrayBuffer())
    expect(playbackBytes.length).toBeGreaterThan(1000)
    if (source === 'full') expect(sha256(playbackBytes)).toBe(sha256(full))
    const duration = await probeRecordingDuration(playback.body.url)
    expect(duration).toBeGreaterThanOrEqual(1900); expect(duration).toBeLessThan(2500)
    const fileRead = await f.files.readBytes({ userId: f.userId, workspaceId: f.workspaceId, assistantId: f.assistantId }, recording!.mediaFileId!)
    expect(fileRead.ok).toBe(true)
    if (!fileRead.ok) throw new Error('canonical media not readable')
    expect(sha256(Buffer.from(fileRead.value.bytes))).toBe(sha256(playbackBytes))
    let job = await claimNextRecordingJob()
    expect(job).toMatchObject({ recordingId: c.recording_id, actingUserId: f.userId, status: 'processing' })
    if (!job) throw new Error('watch queue job missing')
    // Exhausted worker failure: only explicit /retry can start a new job.
    await pool.query('UPDATE recording_jobs SET attempts=3 WHERE id=$1', [job.id])
    expect(await markRecordingJobFailed(job.id, 'fixture exhausted failure')).toEqual({ retrying: false })
    await updateRecording(c.recording_id, { status: 'failed', lastError: 'fixture exhausted failure' })
    const retryProcessing = () => request(f.server).post(`${path}/retry`).set('Authorization', `Bearer ${f.tokens.accessToken}`)
    expect((await f.service.status(f.grant, clientId)).processing).toBe('failed')
    expect((await counts()).jobs).toBe(1) // GET must not implicitly enqueue.
    expect((await retryProcessing().expect(200)).body.processing).toBe('queued')
    expect((await retryProcessing().expect(200)).body.processing).toBe('queued')
    expect((await counts()).jobs).toBe(2)
    job = await claimNextRecordingJob()
    if (!job) throw new Error('explicit recovery job missing')
    await updateRecording(c.recording_id, { status: 'processing' })
    expect((await retryProcessing().expect(200)).body.processing).toBe('processing')
    expect((await counts()).jobs).toBe(2)
    const processed = await processOpenRecordingWithBookkeeping(job, {
      filesResolver: f.resolver, fallbackStorage: f.storage, filesApi: f.files,
      transcriber: { name: 'watch-fixture', transcribe: async input => {
        expect(input.buffer.length).toBeGreaterThan(1000)
        expect(input.durationMs).toBe(duration)
        return { utterances: [{ startMs: 0, endMs: input.durationMs, speaker: 'Speaker 1', text: 'Canonical watch transcript.' }], usages: [], windows: 1, truncated: false, degenerateWindows: 0 }
      } },
      // Pipeline B is an external semantic port; assert canonical parent handoff, don't mock DB publication.
      brainIngestor: async input => {
        expect(input.parentEpisodeId).toBe(c.recording_id)
        return { episodeId: c.recording_id, summaryText: '', entitiesWritten: [], edgesWritten: [], memoriesWritten: [], tasksWritten: [], ephemeralCount: 0, tags: [], sensitivity: null, extractionUsage: null, extracted: false, extractionState: 'skipped', applicationState: 'not_started', applicationRunId: null, applicationCounts: null }
      },
    })
    expect(processed.segmentsInserted).toBe(1)
    await markRecordingJobDone(job.id)
    const after = await getRecording(f.userId, c.recording_id)
    expect(after?.status).toBe('processed'); expect(after?.transcriptFileId).toBeTruthy()
    expect((await queryWithRLS(f.userId, 'SELECT segment_text AS text,scope_held FROM transcript_segments WHERE recording_id=$1', [c.recording_id])).rows).toEqual([{ text: 'Canonical watch transcript.', scope_held: false }])
    expect((await pool.query('SELECT occurred_at,source_ref,scope_version FROM episodes WHERE id=$1', [c.recording_id])).rows[0]).toEqual(episodeBefore)
    await f.service.finalize(f.grant, clientId, intent) // completed job must not be queued again
    expect((await retryProcessing().expect(200)).body.processing).toBe('processed')
    expect(await counts()).toEqual({ pages: 1, recordings: 1, episodes: 1, jobs: 2, media: 1 })
    expect(await claimNextRecordingJob()).toBeNull()
  }, 60000)
})

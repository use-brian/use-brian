import request from 'supertest'
import { openRecordingsRoutes } from '../../routes/recordings.js'
import { createTestApp } from '../../routes/__tests__/helpers.js'
import { enqueueRecordingJob, claimNextRecordingJob, markRecordingJobDone, getRecordingJob, hasCompletedRecordingJob } from '../recording-jobs-store.js'
import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { resolveRecordingForFile } from '../../recordings/recording-for-file.js'
import { createFilesApi } from '../../files/files-api.js'
import { createOfficeArtifactStore } from '../office-artifacts.js'
import { createTranscriptArtifactWriter } from '../../recordings/transcript-artifact.js'
import { updateRecording } from '../recordings-store.js'
import { queryWithRLS } from '../client.js'
import { processOpenRecordingWithBookkeeping, processOpenRecording } from '../../recordings/process-recording.js'
import { insertFileSegments } from '../file-segments-store.js'
import { insertTranscriptSegments } from '../transcript-segments-store.js'
import { recordingTranscriptEvidence, captureRecordingSegmentProvenance } from '../recording-intake-admission.js'
import { getAppPool, getPool } from '../client.js'
import { createDbWorkspaceGroupStore } from '../workspace-group-store.js'
import { createDbWorkspaceFilesStore } from '../workspace-files-store.js'
import { admitRecordingIntakeParent, captureRecordingIntakeParent, recordingIntakeTransaction } from '../recording-intake-admission.js'
const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
// This suite asserts the legacy (pre-v2) model, which workspaces.department_read_v2=false still
// serves as the cutover's rollback path (migration 650, decision D22); its workspaces are pinned to it.
await assertLocalFixture()
const pool = getPool()
afterAll(async () => { await getAppPool().end(); await pool.end() })
async function fixture() {
  const workspaceId = randomUUID(), userId = randomUUID(), otherId = randomUUID()
  for (const id of [userId, otherId]) await pool.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)', [id])
  await pool.query("INSERT INTO workspaces(id,name,owner_user_id,department_read_v2) VALUES($1,'Recording intake',$2,false)", [workspaceId, userId])
  for (const id of [userId, otherId]) await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role,clearance) VALUES($1,$2,'owner','confidential')", [workspaceId, id])
  const team = await createDbWorkspaceGroupStore().createTeam(userId, workspaceId, { name: 'Default', key: 'default' })
  await pool.query("UPDATE workspace_access_policies SET access_mode='simple',setup_state='ready',default_department_id=$2 WHERE workspace_id=$1", [workspaceId, team.id])
  const file = await createDbWorkspaceFilesStore().create(userId, { workspaceId, path: '/recording.wav', parentPath: '/', name: 'recording.wav', mime: 'audio/wav', sizeBytes: 3,
    storageUri: 'gs://fixture/recording', createdByUserId: userId, userId, sensitivity: 'confidential', compartments: [], projectIds: [] })
  const authority = { actorUserId: userId }
  const capture = () => captureRecordingIntakeParent(authority, workspaceId, file.id)
  return { workspaceId, userId, otherId, file, authority, capture }
}
describe('recording canonical intake parent admission (not publication)', () => {
  it('uses a non-bypass app role and retains private empty inheritance rather than the Simple default', async () => {
    const f = await fixture(), expected = await f.capture()
    await recordingIntakeTransaction(f.authority, async client => {
      expect((await client.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0]).toEqual({ rolsuper: false, rolbypassrls: false })
      expect(await admitRecordingIntakeParent(client, f.authority, f.workspaceId, expected)).toMatchObject({ userId: f.userId, assistantId: null, sensitivity: 'confidential', compartments: [], projectIds: [] })
    })
  })
  it('rejects another current owner reading a private parent', async () => {
    const f = await fixture()
    await expect(captureRecordingIntakeParent({ actorUserId: f.otherId }, f.workspaceId, f.file.id)).rejects.toThrow()
  })
  it.each(['held', 'stale', 'retracted', 'membership'] as const)('rejects late %s after capture', async change => {
    const f = await fixture(), expected = await f.capture()
    if (change === 'held') await pool.query('UPDATE workspace_files SET scope_held=true WHERE id=$1', [f.file.id])
    if (change === 'stale') await pool.query("UPDATE workspace_files SET storage_uri='fixture://changed' WHERE id=$1", [f.file.id])
    if (change === 'retracted') await pool.query('UPDATE workspace_files SET retracted_at=now() WHERE id=$1', [f.file.id])
    if (change === 'membership') await pool.query('DELETE FROM workspace_members WHERE workspace_id=$1 AND user_id=$2', [f.workspaceId, f.userId])
    await expect(recordingIntakeTransaction(f.authority, client => admitRecordingIntakeParent(client, f.authority, f.workspaceId, expected))).rejects.toThrow()
  })
  it('does not accept metadata-like forged source labels or another workspace', async () => {
    const f = await fixture(), expected = await f.capture()
    await expect(recordingIntakeTransaction(f.authority, client => admitRecordingIntakeParent(client, f.authority, f.workspaceId, { ...expected, sensitivity: 'public' }))).rejects.toThrow('recording_intake_source_changed')
    await expect(recordingIntakeTransaction(f.authority, client => admitRecordingIntakeParent(client, f.authority, randomUUID(), expected))).rejects.toThrow()
  })
})

const speech = [{ segmentIndex: 0, startMs: 0, endMs: 1000, speaker: null, speakerIds: [], text: 'Canonical transcript', utteranceRefs: [] }]
const text = [{ segmentIndex: 0, charStart: 0, charEnd: 4, headingPath: [], content: 'text' }]
describe('atomic recording and segment publication', () => {
  it.each(['meeting', 'memo'])('completes a canonical upload through the route, preserving %s and retry identity', async kind => {
    const f = await fixture()
    const app = createTestApp('/', openRecordingsRoutes({
      filesResolver: {} as never, getRole: async () => 'owner',
      enqueueJob: async () => ({ enqueued: false, jobId: null }), hasProcessed: async () => false,
      chunkedFileUploads: { complete: async (ctx: { workspaceId: string; userId: string }) => {
        expect(ctx).toEqual({ workspaceId: f.workspaceId, userId: f.userId })
        return f.file
      } } as never,
    }), { userId: f.userId })
    const body = { workspaceId: f.workspaceId, assistantId: randomUUID(), uploadId: randomUUID(), kind }
    const first = await request(app).post('/complete-upload').send(body)
    expect(first.status).toBe(200)
    const retry = await request(app).post('/complete-upload').send(body)
    expect(retry.body).toEqual(first.body)
    const rows = (await pool.query('SELECT id,kind,user_id,assistant_id FROM recordings WHERE workspace_id=$1', [f.workspaceId])).rows
    expect(rows).toEqual([{ id: first.body.recordingId, kind, user_id: f.userId, assistant_id: null }])
  })
  it('adopts through production resolver, transcribes through production processor, records exact lineage, and retries without duplicates', async () => {
    const f = await fixture()
    const first = await resolveRecordingForFile(f.file, f.userId)
    if (first.status !== 'ok') throw new Error('not adopted')
    expect(first.adopted).toBe(true)
    expect(await resolveRecordingForFile(f.file, f.userId)).toMatchObject({ recordingId: first.recordingId, adopted: false })
    const provenance = await captureRecordingSegmentProvenance(f.authority, f.workspaceId, first.recordingId)
    const storage = { signedReadUrl: async () => 'https://fixture.invalid/media' }
    const result = await processOpenRecording({ recordingId: first.recordingId, actingUserId: f.userId }, {
      filesResolver: { forUri: async () => storage } as never, fallbackStorage: storage as never,
      transcriber: { transcribe: async () => ({ utterances: [{ startMs: 0, endMs: 1000, speaker: null, text: 'Canonical transcript' }] }) } as never,
      brainIngestor: (async () => ({})) as never,
      probe: async () => 1000, extract: async () => ({ buffer: Buffer.from('audio'), mime: 'audio/wav' }) as never,
    })
    expect(result.segmentsInserted).toBe(1)
    const rows = (await pool.query('SELECT * FROM transcript_segments WHERE recording_id=$1', [first.recordingId])).rows
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ user_id: f.userId, assistant_id: null, sensitivity: 'confidential', compartments: [], project_ids: [], scope_held: false })
    const edges = (await pool.query(`SELECT s.source_kind,s.source_id,s.source_version FROM scope_derivation_sources s JOIN scope_derivations d ON d.id=s.derivation_id WHERE d.resource_kind='transcript_segment' AND d.resource_id=$1 ORDER BY s.source_kind`, [rows[0].id])).rows
    expect(edges).toEqual([
      { source_kind: 'episode', source_id: first.recordingId, source_version: provenance.episodeVersion },
      { source_kind: 'recording', source_id: first.recordingId, source_version: provenance.recordingVersion },
      { source_kind: 'workspace_file', source_id: f.file.id, source_version: provenance.parent.version },
    ])
    // Same canonical production processor on retry: no new recording/segments.
    const actualSpeech = [{ ...speech[0], utteranceRefs: [{ start_ms: 0, end_ms: 1000, speaker: null }] }]
    const params = { recordingId: first.recordingId, workspaceId: f.workspaceId, createdByUserId: f.userId, visibility: { userId: null, assistantId: null }, sensitivity: 'public', segments: actualSpeech }
    expect(await insertTranscriptSegments(params, provenance)).toBe(0)
    await expect(insertTranscriptSegments({ ...params, segments: [{ ...actualSpeech[0], text: 'different' }] }, provenance)).rejects.toThrow('segment_idempotency_conflict')
    expect((await pool.query('SELECT id FROM recordings WHERE workspace_id=$1', [f.workspaceId])).rows).toHaveLength(1)
  })
  it.each(['scope', 'delete', 'held'] as const)('propagates later file %s through Episode, recording and both segment kinds', async change => {
    const f = await fixture(), first = await resolveRecordingForFile(f.file, f.userId)
    if (first.status !== 'ok') throw new Error('not adopted')
    const p = await captureRecordingSegmentProvenance(f.authority, f.workspaceId, first.recordingId)
    const fileParams = { fileId: f.file.id, workspaceId: f.workspaceId, createdByUserId: f.userId, visibility: { userId: null, assistantId: null }, sensitivity: 'public', compartments: [], tags: null, source: 'user', segments: text }
    expect(await insertFileSegments(fileParams, { ...f.authority, parent: p.parent })).toBe(1)
    expect(await insertFileSegments(fileParams, { ...f.authority, parent: p.parent })).toBe(0)
    expect(await insertTranscriptSegments({ recordingId: first.recordingId, workspaceId: f.workspaceId, createdByUserId: f.userId, visibility: { userId: f.userId, assistantId: null }, sensitivity: 'confidential', segments: speech }, p)).toBe(1)
    if (change === 'scope') await pool.query("UPDATE workspace_files SET sensitivity='internal' WHERE id=$1", [f.file.id])
    if (change === 'held') await pool.query('UPDATE workspace_files SET scope_held=true WHERE id=$1', [f.file.id])
    if (change === 'delete') await pool.query('DELETE FROM workspace_files WHERE id=$1', [f.file.id])
    for (const table of ['episodes', 'recordings', 'transcript_segments']) {
      const held = (await pool.query(`SELECT scope_held FROM ${table} WHERE workspace_id=$1`, [f.workspaceId])).rows
      expect(held.length).toBeGreaterThan(0)
      expect(held.every(r => r.scope_held)).toBe(true)
    }
    if (change !== 'delete') expect((await pool.query('SELECT scope_held FROM file_segments WHERE file_id=$1', [f.file.id])).rows).toEqual([{ scope_held: true }])
    await expect(insertFileSegments(fileParams, { ...f.authority, parent: p.parent })).rejects.toThrow()
  })
  it('rolls back an entire segment batch on a conflicting retry and rejects late recording edits', async () => {
    const f = await fixture(), first = await resolveRecordingForFile(f.file, f.userId)
    if (first.status !== 'ok') throw new Error('not adopted')
    const p = await captureRecordingSegmentProvenance(f.authority, f.workspaceId, first.recordingId)
    const params = { recordingId: first.recordingId, workspaceId: f.workspaceId, createdByUserId: f.userId, visibility: { userId: f.userId, assistantId: null }, sensitivity: 'confidential', segments: speech }
    await insertTranscriptSegments(params, p)
    await expect(insertTranscriptSegments({ ...params, segments: [{ ...speech[0], segmentIndex: 1 }, { ...speech[0], text: 'conflict' }] }, p)).rejects.toThrow()
    expect((await pool.query('SELECT id FROM transcript_segments WHERE recording_id=$1', [first.recordingId])).rows).toHaveLength(1)
    await pool.query("UPDATE recordings SET title='edited' WHERE id=$1", [first.recordingId])
    await expect(insertTranscriptSegments(params, p)).rejects.toThrow()
  })
})

describe('publication authority and async fences', () => {
  it('retains non-default Teams, Projects and assistant partition under read-only execution authority', async () => {
    const f = await fixture(), assistantId = randomUUID(), projectId = randomUUID()
    const team = await createDbWorkspaceGroupStore().createTeam(f.userId, f.workspaceId, { name: 'Source', key: 'source' })
    await pool.query("INSERT INTO assistants(id,workspace_id,name,kind,clearance) VALUES($1,$2,'Source','primary','confidential')", [assistantId, f.workspaceId])
    await pool.query("INSERT INTO workspace_projects(id,workspace_id,name,normalized_name,created_by) VALUES($1,$2,'Project','project',$3)", [projectId, f.workspaceId, f.userId])
    await pool.query('UPDATE workspace_files SET user_id=NULL,assistant_id=$2,compartments=$3,project_ids=$4 WHERE id=$1', [f.file.id, assistantId, [team.compartmentKey], [projectId]])
    const { runWithAgentAccess } = await import('../client.js')
    const first = await runWithAgentAccess({ workspaceId: f.workspaceId, userId: f.userId, clearance: 'confidential', compartments: [team.compartmentKey!], mutationCompartments: [], projectIds: [projectId], visibilityAssistantIds: [assistantId] }, () => resolveRecordingForFile(f.file, f.userId))
    if (first.status !== 'ok') throw new Error('not adopted')
    expect((await pool.query('SELECT user_id,assistant_id,compartments,project_ids,sensitivity FROM recordings WHERE id=$1', [first.recordingId])).rows[0]).toEqual({ user_id: null, assistant_id: assistantId, compartments: [team.compartmentKey], project_ids: [projectId], sensitivity: 'confidential' })
    const p = await captureRecordingSegmentProvenance(f.authority, f.workspaceId, first.recordingId)
    await pool.query("UPDATE workspace_projects SET status='archived' WHERE id=$1", [projectId])
    await expect(insertTranscriptSegments({ recordingId: first.recordingId, workspaceId: f.workspaceId, createdByUserId: f.userId, visibility: { userId: null, assistantId }, sensitivity: 'confidential', segments: speech }, p)).rejects.toThrow()
  })
  it('does not publish transcript output when bytes change while the model is running', async () => {
    const f = await fixture(), first = await resolveRecordingForFile(f.file, f.userId)
    if (first.status !== 'ok') throw new Error('not adopted')
    let ingested = false
    await expect(processOpenRecording({ recordingId: first.recordingId, actingUserId: f.userId }, {
      filesResolver: { forUri: async () => ({ signedReadUrl: async () => 'https://fixture.invalid/media' }) } as never,
      fallbackStorage: {} as never, probe: async () => 1000, extract: async () => ({ buffer: Buffer.from('audio'), mime: 'audio/wav' }) as never,
      brainIngestor: (async () => { ingested = true }) as never,
      transcriber: { transcribe: async () => { await pool.query("UPDATE workspace_files SET storage_uri='gs://fixture/new' WHERE id=$1", [f.file.id]); return { utterances: [{ startMs: 0, endMs: 1000, speaker: null, text: 'stale' }] } } } as never,
    })).rejects.toThrow()
    expect(ingested).toBe(false)
    expect((await pool.query('SELECT id FROM transcript_segments WHERE recording_id=$1', [first.recordingId])).rows).toEqual([])
  })
  it('rejects old raw segment writers in ready mode', async () => {
    const f = await fixture()
    await expect(pool.query("INSERT INTO file_segments(workspace_id,file_id,segment_index,char_start,char_end,heading_path,content,source,created_by_user_id) VALUES($1,$2,0,0,4,'{}','text','user',$3)", [f.workspaceId, f.file.id, f.userId])).rejects.toThrow('recording_intake_provenance_required')
  })
})


async function producerFixture(f: Awaited<ReturnType<typeof fixture>>) {
  const blobs = new Map<string, Buffer>()
  const storage = { signedReadUrl: async () => 'https://fixture.invalid/media',
    writeBlob: async (key: string, bytes: Buffer) => { blobs.set(key, bytes) }, deleteBlob: async (key: string) => { blobs.delete(key) } }
  const resolver = { forUri: async () => storage as never, forWorkspace: async () => ({ gcs: storage as never, bucket: 'fixture', byo: true }) }
  const filesApi = createFilesApi({ resolver, store: createDbWorkspaceFilesStore(), auditStore: { append: async () => {} } as never })
  const deps = { filesResolver: resolver, fallbackStorage: storage as never, filesApi,
    transcriber: { transcribe: async () => ({ utterances: [{ startMs: 0, endMs: 1000, speaker: null, text: 'Private producer transcript' }], truncated: false }) } as never,
    brainIngestor: (async () => ({})) as never, probe: async () => 1000,
    extract: async () => ({ buffer: Buffer.from('audio'), mime: 'audio/wav' }) as never }
  return { deps, filesApi, blobs }
}

describe('recording producer review regressions', () => {
  it('runs the actual boot producer bookkeeping and privately publishes a hold-linked transcript', async () => {
    const f = await fixture(), first = await resolveRecordingForFile(f.file, f.userId)
    if (first.status !== 'ok') throw new Error('not adopted')
    const before = (await pool.query('SELECT source_ref,scope_version FROM episodes WHERE id=$1', [first.recordingId])).rows[0]
    const p = await captureRecordingSegmentProvenance(f.authority, f.workspaceId, first.recordingId)
    const { deps, blobs } = await producerFixture(f)
    expect((await processOpenRecordingWithBookkeeping({ recordingId: first.recordingId, actingUserId: f.userId }, deps)).segmentsInserted).toBe(1)
    expect((await pool.query('SELECT source_ref,scope_version FROM episodes WHERE id=$1', [first.recordingId])).rows[0]).toEqual(before)
    const r = (await pool.query('SELECT status,scope_held,transcript_file_id FROM recordings WHERE id=$1', [first.recordingId])).rows[0]
    expect(r).toMatchObject({ status: 'processed', scope_held: false })
    expect(r.transcript_file_id).toBeTruthy()
    const output = (await pool.query('SELECT * FROM workspace_files WHERE id=$1', [r.transcript_file_id])).rows[0]
    expect(output).toMatchObject({ user_id: f.userId, assistant_id: null, sensitivity: 'confidential', compartments: [], project_ids: [], scope_held: false })
    expect([...blobs.values()].some(bytes => bytes.toString().includes('Private producer transcript'))).toBe(true)
    expect((await queryWithRLS(f.otherId, 'SELECT id FROM workspace_files WHERE id=$1', [output.id])).rows).toEqual([])
    const edges = (await pool.query(`SELECT s.source_kind,s.source_id,s.source_version FROM scope_derivations d JOIN scope_derivation_sources s ON s.derivation_id=d.id WHERE d.resource_kind='workspace_file' AND d.resource_id=$1 ORDER BY s.source_kind`, [output.id])).rows
    expect(edges).toEqual([
      { source_kind: 'episode', source_id: first.recordingId, source_version: p.episodeVersion },
      { source_kind: 'recording', source_id: first.recordingId, source_version: p.recordingVersion },
      { source_kind: 'workspace_file', source_id: f.file.id, source_version: p.parent.version },
    ])
    // Failure/retry bookkeeping is also outside immutable Episode source data.
    for (const status of ['queued', 'failed', 'processing', 'processed'] as const) await updateRecording(first.recordingId, { status, lastError: status === 'failed' ? 'retry' : null })
    expect((await pool.query('SELECT source_ref,scope_version FROM episodes WHERE id=$1', [first.recordingId])).rows[0]).toEqual(before)
    expect((await pool.query('SELECT scope_held FROM workspace_files WHERE id=$1', [output.id])).rows[0].scope_held).toBe(false)
    await pool.query(`INSERT INTO scope_resource_states(workspace_id,resource_kind,resource_id,resource_version,review_state,classification_revision,holding_reason)
      SELECT $1,'recording',$2,read_scope_review_source($1,'recording',$2)->>'version','held',1,'source_changed'`, [f.workspaceId, first.recordingId])
    expect((await queryWithRLS(f.userId, 'SELECT id FROM workspace_files WHERE id=$1', [output.id])).rows).toEqual([])
    await pool.query("DELETE FROM scope_resource_states WHERE workspace_id=$1 AND resource_kind='recording' AND resource_id=$2", [f.workspaceId, first.recordingId])
    await pool.query("UPDATE episodes SET source_ref=source_ref || '{\"gcsKey\":\"changed\"}'::jsonb WHERE id=$1", [first.recordingId])
    expect((await pool.query('SELECT scope_held FROM workspace_files WHERE id=$1', [output.id])).rows[0].scope_held).toBe(true)
    expect((await queryWithRLS(f.userId, 'SELECT id FROM workspace_files WHERE id=$1', [output.id])).rows).toEqual([])
  })
  it('does not interpret an inherited shared General floor as an explicit General request in Simple', async () => {
    const f = await fixture()
    await pool.query('UPDATE workspace_files SET user_id=NULL WHERE id=$1', [f.file.id])
    const parent = await f.capture()
    expect(parent.compartments).toEqual([])
    await expect(recordingIntakeTransaction(f.authority, client => admitRecordingIntakeParent(client, f.authority, f.workspaceId, parent, parent))).rejects.toThrow()
    const first = await resolveRecordingForFile(f.file, f.userId)
    if (first.status !== 'ok') throw new Error('not adopted')
    const { deps } = await producerFixture(f)
    await processOpenRecordingWithBookkeeping({ recordingId: first.recordingId, actingUserId: f.userId }, deps)
    const rows = (await pool.query('SELECT user_id,compartments,project_ids FROM workspace_files WHERE workspace_id=$1 ORDER BY created_at', [f.workspaceId])).rows
    expect(rows).toHaveLength(2)
    expect(rows.every(r => r.user_id === null && r.compartments.length === 0 && r.project_ids.length === 0)).toBe(true)
    // Direct app SQL publication must preserve that same inherited empty floor.
    await recordingIntakeTransaction(f.authority, async client => {
      expect((await client.query('SELECT publish_media_segments($1::jsonb,NULL,NULL,NULL,$2::jsonb,false) AS n', [JSON.stringify(parent), JSON.stringify(text)])).rows[0].n).toBe(1)
    })
  })
  it('fences durable transcript publication after a recording source changes during byte staging', async () => {
    const f = await fixture(), first = await resolveRecordingForFile(f.file, f.userId)
    if (first.status !== 'ok') throw new Error('not adopted')
    const p = await captureRecordingSegmentProvenance(f.authority, f.workspaceId, first.recordingId)
    const storage = { writeBlob: async () => { await pool.query("UPDATE recordings SET title='changed' WHERE id=$1", [first.recordingId]) }, deleteBlob: async () => {} }
    const filesApi = createFilesApi({ resolver: { forWorkspace: async () => ({ gcs: storage as never, bucket: 'fixture', byo: true }), forUri: async () => storage as never }, store: createDbWorkspaceFilesStore(), auditStore: { append: async () => {} } as never })
    const result = await createTranscriptArtifactWriter({ filesApi })({ recordingId: first.recordingId, workspaceId: f.workspaceId, actingUserId: f.userId, assistantId: null, sensitivity: 'confidential', utterances: [{ startMs: 0, text: 'stale', speaker: null }] }, p)
    expect(result).toBeNull()
    expect((await pool.query('SELECT id FROM workspace_files WHERE workspace_id=$1', [f.workspaceId])).rows).toEqual([{ id: f.file.id }])
  })
  it('enforces live Office ACL in direct-app SQL publication and derived segment delivery', async () => {
    const f = await fixture(), artifact = await createOfficeArtifactStore().createShell({ userId: f.otherId, workspaceId: f.workspaceId, family: 'document', title: 'Office parent', templateVersionId: null, capabilityVersion: 1, sensitivity: 'confidential' }, { provenance: { kind: 'human_authored_root', actorUserId: f.otherId, workspaceId: f.workspaceId } })
    const jobId = randomUUID(), hash = 'a'.repeat(64), parentPath = `/office/artifacts/${artifact.id}/versions`, name = `1-${hash}.json`
    await pool.query(`INSERT INTO office_generation_jobs(id,workspace_id,artifact_id,initiated_by_user_id,brief,authority_projection,idempotency_key,status,lease_expires_at)
      VALUES($1::uuid,$2,$3,$4,'{}','{"creationBinding":{"protocol":"office_prompt_only_v1"}}',$1::text,'running',now()+interval '1 hour')`, [jobId, f.workspaceId, artifact.id, f.otherId])
    await pool.query(`UPDATE workspace_files SET path=$2,parent_path=$3,name=$4,mime='application/json',user_id=NULL,created_by_user_id=$5,compartments=$6,metadata=$7::jsonb WHERE id=$1`, [f.file.id, `${parentPath}/${name}`, parentPath, name, f.otherId, artifact.compartments, JSON.stringify({ noIndex: true, contentSha256: hash, officeGenerationJobId: jobId })])
    await recordingIntakeTransaction({ actorUserId: f.otherId }, async client => {
      await client.query('INSERT INTO office_generation_file_bindings(file_id,artifact_id,workspace_id,job_id,snapshot_hash) VALUES($1,$2,$3,$4,$5)', [f.file.id, artifact.id, f.workspaceId, jobId, hash])
    })
    const parent = await f.capture()
    const publish = () => recordingIntakeTransaction(f.authority, client => client.query('SELECT publish_media_segments($1::jsonb,NULL,NULL,NULL,$2::jsonb,false) AS n', [JSON.stringify(parent), JSON.stringify(text)]))
    expect((await publish()).rows[0].n).toBe(1)
    const segment = (await queryWithRLS(f.userId, 'SELECT id FROM file_segments WHERE file_id=$1', [f.file.id])).rows[0]
    expect(segment).toBeTruthy()
    const derived = await createDbWorkspaceFilesStore().createDerived(f.userId, {
      workspaceId: f.workspaceId, path: '/office-transcript.md', parentPath: '/', name: 'office-transcript.md', mime: 'text/markdown', sizeBytes: 4,
      storageUri: 'gs://fixture/office-transcript', createdByUserId: f.userId,
    }, { producer: 'recording-transcript', sources: [parent] })
    const derivedParent = await captureRecordingIntakeParent(f.authority, f.workspaceId, derived.id)
    const publishDerived = () => recordingIntakeTransaction(f.authority, client => client.query('SELECT publish_media_segments($1::jsonb,NULL,NULL,NULL,$2::jsonb,false)', [JSON.stringify(derivedParent), JSON.stringify(text)]))
    await publishDerived()
    expect((await queryWithRLS(f.userId, 'SELECT id FROM file_segments WHERE file_id=$1', [derived.id])).rows).toHaveLength(1)
    await pool.query("UPDATE office_artifacts SET default_workspace_role='deny' WHERE id=$1", [artifact.id])
    expect((await queryWithRLS(f.userId, 'SELECT id FROM workspace_files WHERE id=$1', [derived.id])).rows).toEqual([])
    expect((await queryWithRLS(f.userId, 'SELECT id FROM file_segments WHERE file_id=$1', [derived.id])).rows).toEqual([])
    await expect(publishDerived()).rejects.toThrow('recording_intake_source_changed')

    // The workspace owner is neither the Office owner nor granted Office access.
    expect((await queryWithRLS(f.userId, 'SELECT id FROM workspace_files WHERE id=$1', [f.file.id])).rows).toEqual([])
    await expect(publish()).rejects.toThrow('recording_intake_source_changed')
    await expect(recordingIntakeTransaction(f.authority, client => client.query('SELECT * FROM publish_file_recording($1::jsonb,$2)', [JSON.stringify(parent), randomUUID()]))).rejects.toThrow('recording_intake_source_changed')
    expect((await queryWithRLS(f.userId, 'SELECT id FROM file_segments WHERE id=$1', [segment.id])).rows).toEqual([])
    expect((await queryWithRLS(f.otherId, 'SELECT id FROM file_segments WHERE id=$1', [segment.id])).rows).toEqual([{ id: segment.id }])
  })
})

describe('direct app-role transcript derivation boundary', () => {
  it('cannot widen a private recording through the SQL file publisher or replay stale recording evidence', async () => {
    const f = await fixture(), first = await resolveRecordingForFile(f.file, f.userId)
    if (first.status !== 'ok') throw new Error('not adopted')
    const p = await captureRecordingSegmentProvenance(f.authority, f.workspaceId, first.recordingId)
    const evidence = recordingTranscriptEvidence(p)
    const input = { id: randomUUID(), workspaceId: f.workspaceId, userId: null, assistantId: null, createdByUserId: f.userId,
      path: '/recordings/direct.md', parentPath: '/recordings', name: 'direct.md', mime: 'text/markdown', sizeBytes: 4,
      storageUri: 'gs://fixture/direct', sensitivity: 'confidential', compartments: [], projectIds: [], tags: [], relatedIds: [] }
    const direct = () => recordingIntakeTransaction(f.authority, async client => {
      expect((await client.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0]).toEqual({ rolsuper: false, rolbypassrls: false })
      return client.query('SELECT id FROM create_source_derived_file($1::jsonb,$2::jsonb)', [JSON.stringify(input), JSON.stringify(evidence)])
    })
    await expect(direct()).rejects.toThrow('scope_visibility_incompatible')
    await pool.query("UPDATE recordings SET title='changed after capture' WHERE id=$1", [first.recordingId])
    // Use the valid private output shape on replay; denial must be freshness,
    // not just the original visibility mismatch.
    const privateInput = { ...input, userId: f.userId }
    await expect(recordingIntakeTransaction(f.authority, client => client.query('SELECT id FROM create_source_derived_file($1::jsonb,$2::jsonb)', [JSON.stringify(privateInput), JSON.stringify(evidence)]))).rejects.toThrow('scope_source_changed')
    expect((await pool.query('SELECT id FROM workspace_files WHERE workspace_id=$1', [f.workspaceId])).rows).toEqual([{ id: f.file.id }])
  })
})


describe('HTTP queue actor and canonical parent delivery', () => {
  it.each([false, true])('runs actual HTTP queue → worker as requester (revoked before worker=%s)', async revoked => {
    const f = await fixture()
    await pool.query('UPDATE workspace_files SET user_id=NULL WHERE id=$1', [f.file.id])
    await pool.query("UPDATE workspace_members SET role='member' WHERE workspace_id=$1 AND user_id=$2", [f.workspaceId, f.otherId])
    const adopted = await resolveRecordingForFile(f.file, f.userId)
    if (adopted.status !== 'ok') throw new Error('not adopted')
    const before = (await pool.query('SELECT source_ref,scope_version FROM episodes WHERE id=$1', [adopted.recordingId])).rows[0]
    const { deps } = await producerFixture(f)
    const app = createTestApp('/api/recordings', openRecordingsRoutes({
      filesResolver: deps.filesResolver, probe: deps.probe, enqueueJob: enqueueRecordingJob, hasProcessed: hasCompletedRecordingJob,
      getRole: async (actor, workspace) => (await queryWithRLS(actor, 'SELECT role FROM workspace_members WHERE workspace_id=$1 AND user_id=$2', [workspace, actor])).rows[0]?.role ?? null,
    }), { userId: f.otherId })
    const response = await request(app).post(`/api/recordings/${adopted.recordingId}/process`).send({ actingUserId: f.userId })
    expect(response.status).toBe(202)
    expect(response.body).toMatchObject({ recordingId: adopted.recordingId, status: 'queued' })
    expect((await request(app).get(`/api/recordings/${adopted.recordingId}`)).body.status).toBe('queued')
    expect((await getRecordingJob(response.body.jobId))?.actingUserId).toBe(f.otherId)
    expect((await pool.query('SELECT source_ref,scope_version FROM episodes WHERE id=$1', [adopted.recordingId])).rows[0]).toEqual(before)
    expect((await pool.query('SELECT scope_held FROM recordings WHERE id=$1', [adopted.recordingId])).rows[0].scope_held).toBe(false)
    const job = await claimNextRecordingJob()
    expect(job?.id).toBe(response.body.jobId)
    if (!job) throw new Error('job missing')
    let transcribed = false
    const original = deps.transcriber as unknown as { transcribe: () => Promise<unknown> }
    const workerDeps = { ...deps, transcriber: { transcribe: async () => { transcribed = true; return original.transcribe() } } as never }
    if (revoked) {
      await pool.query('DELETE FROM workspace_members WHERE workspace_id=$1 AND user_id=$2', [f.workspaceId, f.otherId])
      // Original creator remains authorized; a creator fallback would succeed.
      expect((await pool.query('SELECT 1 FROM workspace_members WHERE workspace_id=$1 AND user_id=$2', [f.workspaceId, f.userId])).rows).toHaveLength(1)
      await expect(processOpenRecordingWithBookkeeping(job, workerDeps)).rejects.toThrow()
      expect(transcribed).toBe(false)
      expect((await pool.query('SELECT id FROM transcript_segments WHERE recording_id=$1', [job.recordingId])).rows).toEqual([])
    } else {
      await processOpenRecordingWithBookkeeping(job, workerDeps)
      await markRecordingJobDone(job.id)
      expect(transcribed).toBe(true)
      expect((await request(app).get(`/api/recordings/${adopted.recordingId}`)).body.status).toBe('processed')
      expect((await getRecordingJob(job.id))?.status).toBe('done')
      expect((await pool.query('SELECT created_by_user_id,scope_held FROM transcript_segments WHERE recording_id=$1', [job.recordingId])).rows).toEqual([{ created_by_user_id: f.otherId, scope_held: false }])
    }
    expect((await pool.query('SELECT source_ref,scope_version FROM episodes WHERE id=$1', [adopted.recordingId])).rows[0]).toEqual(before)
  })
  it.each(['recording', 'episode'] as const)('external %s review hold hides transcript segments and transcript-file → segments transitively', async kind => {
    const f = await fixture(), adopted = await resolveRecordingForFile(f.file, f.userId)
    if (adopted.status !== 'ok') throw new Error('not adopted')
    const { deps } = await producerFixture(f)
    await processOpenRecordingWithBookkeeping({ recordingId: adopted.recordingId, actingUserId: f.userId }, deps)
    const transcriptId = (await pool.query('SELECT transcript_file_id FROM recordings WHERE id=$1', [adopted.recordingId])).rows[0].transcript_file_id
    const parent = await captureRecordingIntakeParent(f.authority, f.workspaceId, transcriptId)
    const publish = (index: number) => recordingIntakeTransaction(f.authority, client => client.query('SELECT publish_media_segments($1::jsonb,NULL,NULL,NULL,$2::jsonb,false) AS n', [JSON.stringify(parent), JSON.stringify(text.map(s => ({ ...s, segmentIndex: index })))]))
    expect((await publish(0)).rows[0].n).toBe(1)
    expect((await queryWithRLS(f.userId, 'SELECT id FROM transcript_segments WHERE recording_id=$1', [adopted.recordingId])).rows).toHaveLength(1)
    expect((await queryWithRLS(f.userId, 'SELECT id FROM file_segments WHERE file_id=$1', [transcriptId])).rows).toHaveLength(1)
    await pool.query(`INSERT INTO scope_resource_states(workspace_id,resource_kind,resource_id,resource_version,review_state,classification_revision,holding_reason)
      SELECT $1,$2,$3,read_scope_review_source($1,$2,$3)->>'version','held',1,'source_changed'`, [f.workspaceId, kind, adopted.recordingId])
    // No materialized hold: delivery must check the external state itself.
    expect((await pool.query('SELECT scope_held FROM transcript_segments WHERE recording_id=$1', [adopted.recordingId])).rows[0].scope_held).toBe(false)
    expect((await queryWithRLS(f.userId, 'SELECT id FROM transcript_segments WHERE recording_id=$1', [adopted.recordingId])).rows).toEqual([])
    expect((await queryWithRLS(f.userId, 'SELECT id FROM workspace_files WHERE id=$1', [transcriptId])).rows).toEqual([])
    expect((await queryWithRLS(f.userId, 'SELECT id FROM file_segments WHERE file_id=$1', [transcriptId])).rows).toEqual([])
    await expect(publish(1)).rejects.toThrow('recording_intake_source_changed')
  })
  it('fails closed on a cyclic lineage without recursive-policy stack overflow', async () => {
    const f = await fixture(), adopted = await resolveRecordingForFile(f.file, f.userId)
    if (adopted.status !== 'ok') throw new Error('not adopted')
    const { deps } = await producerFixture(f)
    await processOpenRecordingWithBookkeeping({ recordingId: adopted.recordingId, actingUserId: f.userId }, deps)
    const transcript = (await pool.query('SELECT f.id,f.scope_version::text AS version FROM workspace_files f JOIN recordings r ON r.transcript_file_id=f.id WHERE r.id=$1', [adopted.recordingId])).rows[0]
    expect((await queryWithRLS(f.userId, 'SELECT id FROM workspace_files WHERE id=$1', [transcript.id])).rows).toHaveLength(1)
    await pool.query(`INSERT INTO scope_derivation_sources(workspace_id,derivation_id,source_kind,source_id,source_version)
      SELECT workspace_id,id,'workspace_file',$1,$2 FROM scope_derivations WHERE resource_kind='workspace_file' AND resource_id=$1`, [transcript.id, transcript.version])
    expect((await queryWithRLS(f.userId, 'SELECT id FROM workspace_files WHERE id=$1', [transcript.id])).rows).toEqual([])
  })
})

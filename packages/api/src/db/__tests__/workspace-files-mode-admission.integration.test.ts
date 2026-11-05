import { enqueueFileIngestJob } from '../file-ingest-jobs-store.js'
import { boundScopeSource, ContextScopeAccumulator, createFileTools, type ToolContext } from '@use-brian/core'
import { createFilesApi } from '../../files/files-api.js'
import { createArtifactPromoter } from '../../files/artifact-promote.js'
import { createHash, randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it, vi } from 'vitest'
import type { AccessContext, WorkspaceFileCreateInput } from '@use-brian/core'
import { applyRLSGucs, getAppPool, getPool, rollbackAndRelease } from '../client.js'
import { runWithAgentAccess } from '../agent-access-context.js'
import { createWorkspaceFile, supersedeWorkspaceFile, updateWorkspaceFileMeta, getWorkspaceFileById } from '../workspace-files.js'
import { createDbWorkspaceFilesStore } from '../workspace-files-store.js'
import { createDbFileStore } from '../file-store.js'
import { insertFileSegments } from '../file-segments-store.js'
import { searchFileSegments, readFileSegmentRange } from '../retrieval-store.js'
import { captureRecordingIntakeParent } from '../recording-intake-admission.js'
import { createDbWorkspaceGroupStore } from '../workspace-group-store.js'
import { createEntity } from '../entities-store.js'
import { createDbEntityLinksStore } from '../entity-links-store.js'
import { createDbProvenanceStore } from '../provenance-store.js'
import { admitFileCreate } from '../../workspace-access/file-create-admission.js'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
// Root fixtures use the pre-v2 rollback model (migration 650, decision D22).
// Source-inheritance cases explicitly enable v2 after creating their source.
await assertLocalFixture()
const pool = getPool()
afterAll(async () => { await getAppPool().end(); await pool.end() })

async function fixture(mode: 'simple' | 'departments' | 'legacy' = 'simple') {
  const workspaceId = randomUUID(), userId = randomUUID(), member = randomUUID(), projectId = randomUUID()
  for (const id of [userId, member]) await pool.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)', [id])
  await pool.query("INSERT INTO workspaces(id,name,owner_user_id,department_read_v2) VALUES($1,'File admission fixture',$2,false)", [workspaceId, userId])
  for (const id of [userId, member]) await pool.query('INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,$3)', [workspaceId, id, id === userId ? 'owner' : 'member'])
  await pool.query("UPDATE workspace_members SET clearance='confidential' WHERE workspace_id=$1 AND user_id=$2", [workspaceId, userId])
  await pool.query("INSERT INTO workspace_projects(id,workspace_id,name,normalized_name,created_by) VALUES($1,$2,'Fixture','fixture',$3)", [projectId, workspaceId, userId])
  const groups = createDbWorkspaceGroupStore()
  const team = await groups.createTeam(userId, workspaceId, { name: 'Common', key: 'common' })
  const other = await groups.createTeam(userId, workspaceId, { name: 'Other', key: 'other' })
  if (mode !== 'legacy') await pool.query("UPDATE workspace_access_policies SET access_mode=$2,setup_state='ready',default_department_id=$3 WHERE workspace_id=$1", [workspaceId, mode, team.id])
  const input = (patch: Partial<WorkspaceFileCreateInput> = {}): WorkspaceFileCreateInput => ({
    workspaceId, path: `/${randomUUID()}.txt`, parentPath: '/', name: 'fixture.txt', mime: 'text/plain',
    sizeBytes: 1, storageUri: 'fixture://unpublished', createdByUserId: userId, ...patch,
  })
  const create = (patch: Partial<WorkspaceFileCreateInput> = {}) => createDbWorkspaceFilesStore().create(userId, input(patch))
  const rows = async () => (await pool.query('SELECT * FROM workspace_files WHERE workspace_id=$1', [workspaceId])).rows
  return { workspaceId, userId, member, projectId, groups, team, key: team.compartmentKey!, otherKey: other.compartmentKey!, input, create, rows }
}

describe('[COMP:api/file-derived-admission] canonical workspace-file admission', () => {

  it('defaults omitted Simple roots through the canonical store, retaining Project and sensitivity', async () => {
    const f = await fixture()
    expect(await f.create({ projectIds: [f.projectId], sensitivity: 'confidential' })).toMatchObject({
      compartments: [f.key], projectIds: [f.projectId], sensitivity: 'confidential', userId: null, assistantId: null,
    })
    expect(await f.create({ compartments: [f.key] })).toMatchObject({ compartments: [f.key] })
  })

  it('does not reinterpret explicit empty/null labels or stale preview as omission; emits no edges', async () => {
    const f = await fixture(), create = vi.fn()
    for (const patch of [{ compartments: [] }, { compartments: null }, { projectIds: null }, { compartments: [f.otherKey] }]) {
      await expect(createWorkspaceFile(f.userId, f.input(patch as never), {
        entityLinks: { create } as never, documentsEntityIds: [randomUUID()],
      })).rejects.toMatchObject({ code: 'access_mode_destination_conflict' })
    }
    await expect(createWorkspaceFile(f.userId, f.input(), { expectedPolicyRevision: '0' })).rejects.toMatchObject({ code: 'access_policy_conflict' })
    expect(create).not.toHaveBeenCalled()
    expect(await f.rows()).toHaveLength(0)
  })

  it('requires Departments selection, accepts authorized explicit labels/Project and explicit General', async () => {
    const f = await fixture('departments')
    await expect(f.create()).rejects.toMatchObject({ code: 'context_selection_required' })
    expect(await f.create({ compartments: [f.otherKey], projectIds: [f.projectId] })).toMatchObject({ compartments: [f.otherKey], projectIds: [f.projectId] })
    expect(await f.create({ compartments: [] })).toMatchObject({ compartments: [] })
    await expect(f.create({ compartments: ['team:' + randomUUID()] })).rejects.toMatchObject({ code: 'context_not_available' })
    await expect(f.create({ compartments: [f.key], projectIds: [randomUUID()] })).rejects.toMatchObject({ code: 'context_not_available' })
  })

  it.each(['simple', 'departments'] as const)('preserves explicit private ownership and sensitivity in %s', async mode => {
    const f = await fixture(mode)
    expect(await f.create({ userId: f.userId, sensitivity: 'confidential', projectIds: [f.projectId] })).toMatchObject({
      userId: f.userId, assistantId: null, sensitivity: 'confidential', compartments: [], projectIds: [f.projectId],
    })
  })

  it.each(['simple','departments'] as const)('requires shared classification for assistant-only files in %s', async mode => {
    const f=await fixture(mode),assistantId=randomUUID()
    await pool.query("INSERT INTO assistants(id,workspace_id,owner_user_id,name,kind) VALUES($1,$2,$3,'File assistant','standard')",[assistantId,f.workspaceId,f.userId])
    if(mode==='simple')expect(await f.create({assistantId})).toMatchObject({compartments:[f.key],assistantId,userId:null})
    else await expect(f.create({assistantId})).rejects.toMatchObject({code:'context_selection_required'})
    expect(await f.create({assistantId,userId:f.userId})).toMatchObject({compartments:[],assistantId,userId:f.userId})
  })
  it('admits ordinary members using current membership, without granting policy-admin access', async () => {
    const f = await fixture()
    await pool.query("UPDATE workspace_members SET team_scope_mode='assigned' WHERE workspace_id=$1 AND user_id=$2", [f.workspaceId, f.member])
    await f.groups.addMember(f.userId, f.team.id, f.member)
    const write = () => createWorkspaceFile(f.member, f.input({ createdByUserId: f.member }))
    expect((await write()).compartments).toEqual([f.key])
    await pool.query('DELETE FROM workspace_group_members WHERE group_id=$1 AND user_id=$2', [f.team.id, f.member])
    await expect(write()).rejects.toMatchObject({ code: 'context_not_available' })
    expect(await f.rows()).toHaveLength(1)
  })

  it('does not expand an ambient or explicit mutation ceiling to the Simple default', async () => {
    const f = await fixture()
    const access: AccessContext = { workspaceId: f.workspaceId, userId: f.userId, assistantId: '', assistantKind: 'primary',
      clearance: 'confidential', compartments: [f.key], mutationCompartments: [], projectIds: null }
    await expect(runWithAgentAccess({ ...access, clearance: access.clearance, compartments: access.compartments }, () => f.create())).rejects.toMatchObject({ code: 'context_not_available' })
    await expect(createWorkspaceFile(f.userId, f.input(), { access })).rejects.toMatchObject({ code: 'scope_operation_denied' })
    expect(await f.rows()).toHaveLength(0)
  })

  it('blocks unresolved system/derived/session/page provenance rather than using labels or IDs as inheritance', async () => {
    const f = await fixture()
    for (const patch of [
      { source: 'extracted', compartments: [f.key] }, { createdByUserId: f.member },
      { createdByAssistantId: randomUUID() }, { sourceEpisodeId: randomUUID() },
      { path: '/office/sessions/forged/output.txt' }, { path: '/doc/forged/media.png' },
      { metadata: { parentId: randomUUID() }, compartments: [f.otherKey] },
      { metadata: { sessionId: randomUUID() }, compartments: [f.key] },
    ]) await expect(f.create(patch)).rejects.toMatchObject({ code: 'file_admission_provenance_required' })
    await expect(createWorkspaceFile(f.member, f.input())).rejects.toMatchObject({ code: 'file_admission_provenance_required' })
    await expect(createWorkspaceFile('', f.input())).rejects.toMatchObject({ code: 'file_admission_provenance_required' })
    expect(await f.rows()).toHaveLength(0)
  })

  it('does not infer a canonical parent from parentPath or non-default labels', async () => {
    const f = await fixture()
    await expect(f.create({ parentPath: '/old/private', compartments: [f.otherKey] })).rejects.toMatchObject({ code: 'access_mode_destination_conflict' })
    expect((await f.create({ parentPath: '/ordinary/folder' })).compartments).toEqual([f.key])
  })

  it('rolls back failed insertion without emitting post-commit edges', async () => {
    const f = await fixture(), path = '/same.txt', create = vi.fn()
    await f.create({ path })
    await expect(createWorkspaceFile(f.userId, f.input({ path }), {
      entityLinks: { create } as never, documentsEntityIds: [randomUUID()],
    })).rejects.toMatchObject({ code: '23505' })
    expect(create).not.toHaveBeenCalled()
    expect(await f.rows()).toHaveLength(1)
  })

  it('leaves legacy classification unchanged', async () => {
    const f = await fixture('legacy')
    expect((await f.create()).compartments).toEqual([])
    expect((await f.create({ compartments: [], source: 'extracted' })).compartments).toEqual([])
    expect((await f.create({ compartments: [f.otherKey] })).compartments).toEqual([f.otherKey])
  })

  it('holds policy admission through the writer transaction and restores policy-read elevation', async () => {
    const f = await fixture(), writer = await getAppPool().connect(), changer = await pool.connect()
    try {
      await writer.query('BEGIN'); await applyRLSGucs(writer, f.userId)
      expect((await admitFileCreate(writer, f.userId, f.input())).compartments).toEqual([f.key])
      expect((await writer.query("SELECT current_setting('app.system_bypass',true) AS bypass")).rows[0].bypass).not.toBe('true')
      await changer.query('BEGIN'); await changer.query("SET LOCAL lock_timeout='100ms'")
      await expect(changer.query("UPDATE workspace_access_policies SET access_mode='departments' WHERE workspace_id=$1", [f.workspaceId])).rejects.toMatchObject({ code: '55P03' })
    } finally { await rollbackAndRelease(writer); await changer.query('ROLLBACK'); changer.release() }
    await pool.query("UPDATE workspace_access_policies SET access_mode='departments' WHERE workspace_id=$1", [f.workspaceId])
    await expect(f.create()).rejects.toMatchObject({ code: 'context_selection_required' })
    expect(await f.rows()).toHaveLength(0)
  })

  it.each(['simple', 'departments'] as const)('admits a verified private generated successor and draft finalization in %s', async mode => {
    const f = await fixture('legacy'), assistantId = randomUUID(), episodeId = randomUUID()
    await pool.query("INSERT INTO assistants(id,workspace_id,owner_user_id,name,kind) VALUES($1,$2,$3,'Source assistant','standard')", [assistantId,f.workspaceId,f.userId])
    await pool.query("INSERT INTO episodes(id,workspace_id,user_id,assistant_id,source_kind,source_ref,occurred_at,created_by_user_id) VALUES($1,$2,$3,$4,'web','{}',now(),$3)", [episodeId,f.workspaceId,f.userId,assistantId])
    const prior = await f.create({ source: 'extracted', sourceEpisodeId: episodeId, createdByAssistantId: assistantId,
      userId: f.userId, assistantId, sensitivity: 'confidential', compartments: [f.otherKey], projectIds: [f.projectId], tags: ['draft'] })
    await pool.query("UPDATE workspace_access_policies SET access_mode=$2,setup_state='ready',default_department_id=$3 WHERE workspace_id=$1", [f.workspaceId,mode,f.team.id])
    const next = await supersedeWorkspaceFile(f.userId,f.workspaceId,prior.id,{
      editorUserId:f.userId, expectedScopeVersion:prior.scopeVersion, storageUri:'fixture://successor', sizeBytes:2,
      compartments:[], projectIds:[],
    })
    expect(next).toMatchObject({ userId:f.userId, assistantId, source:'extracted', sourceEpisodeId:episodeId,
      sensitivity:'confidential', compartments:[f.otherKey], projectIds:[f.projectId], tags:['draft'] })
    expect(next!.id).not.toBe(prior.id)
    expect(await updateWorkspaceFileMeta(f.userId,f.workspaceId,next!.id,{ tags:['final'] })).toMatchObject({ id:next!.id,tags:['final'] })
    expect((await f.rows()).find(row => row.id===prior.id)).toMatchObject({ superseded_by:next!.id,valid_to:expect.any(Date) })
  })

  it('preserves a shared assistant-only predecessor without applying a new default', async () => {
    const f=await fixture('legacy'),assistantId=randomUUID()
    await pool.query("INSERT INTO assistants(id,workspace_id,owner_user_id,name,kind) VALUES($1,$2,$3,'Source assistant','standard')",[assistantId,f.workspaceId,f.userId])
    const prior=await f.create({assistantId,compartments:[f.otherKey]})
    await pool.query("UPDATE workspace_access_policies SET access_mode='simple',setup_state='ready',default_department_id=$2 WHERE workspace_id=$1",[f.workspaceId,f.team.id])
    expect(await supersedeWorkspaceFile(f.userId,f.workspaceId,prior.id,{editorUserId:f.userId,storageUri:'fixture://next',sizeBytes:2}))
      .toMatchObject({userId:null,assistantId,compartments:[f.otherKey]})
  })

  it('admits exact additive successor labels and Project while preserving source segments until commit', async () => {
    const f=await fixture('departments'),prior=await f.create({compartments:[f.key]})
    const parent = await captureRecordingIntakeParent({ actorUserId: f.userId }, f.workspaceId, prior.id)
    await insertFileSegments({
      workspaceId: f.workspaceId, fileId: prior.id, createdByUserId: f.userId,
      visibility: { userId: parent.userId, assistantId: parent.assistantId },
      sensitivity: parent.sensitivity, compartments: parent.compartments, tags: prior.tags, source: prior.source,
      segments: [{ segmentIndex: 0, charStart: 0, charEnd: 1, headingPath: [], content: 'x' }],
    }, { actorUserId: f.userId, parent })
    const next=await supersedeWorkspaceFile(f.userId,f.workspaceId,prior.id,{editorUserId:f.userId,storageUri:'fixture://next',sizeBytes:2,
      compartments:[f.otherKey],projectIds:[f.projectId],sensitivity:'confidential'})
    expect(next).toMatchObject({compartments:[f.key,f.otherKey].sort(),projectIds:[f.projectId],sensitivity:'confidential'})
    expect((await pool.query('SELECT valid_to FROM file_segments WHERE file_id=$1',[prior.id])).rows[0].valid_to).toBeInstanceOf(Date)
  })

  it('[COMP:retrieval/file-segments] rechecks parent visibility for canonical segment search and ranged reads', async () => {
    const f=await fixture('legacy'),file=await f.create({compartments:[],sensitivity:'internal'})
    const parent=await captureRecordingIntakeParent({actorUserId:f.userId},f.workspaceId,file.id)
    await insertFileSegments({workspaceId:f.workspaceId,fileId:file.id,createdByUserId:f.userId,
      visibility:{userId:parent.userId,assistantId:parent.assistantId},sensitivity:parent.sensitivity,
      compartments:parent.compartments,tags:null,source:file.source,
      segments:[{segmentIndex:0,charStart:0,charEnd:17,headingPath:[],content:'Fixture paragraph'}],
    },{actorUserId:f.userId,parent})
    const actor:AccessContext={workspaceId:f.workspaceId,userId:f.member,assistantId:'',assistantKind:'primary',clearance:'internal'}
    const search=()=>searchFileSegments(actor,{fileId:file.id,query:'Fixture'})
    const range=()=>readFileSegmentRange(actor,{fileId:file.id,fromIndex:0,toIndex:0})
    expect(await search()).toMatchObject([{content:'Fixture paragraph'}])
    expect(await range()).toMatchObject([{content:'Fixture paragraph'}])
    // The parent changes independently of the old segment labels. Both reads
    // must consult the parent, not trust the still-shared extracted row.
    await pool.query('UPDATE workspace_files SET user_id=$2 WHERE id=$1',[file.id,f.userId])
    expect((await pool.query('SELECT user_id FROM file_segments WHERE file_id=$1',[file.id])).rows).toEqual([{user_id:null}])
    expect(await search()).toEqual([])
    expect(await range()).toEqual([])
    // Reclassification holds the old extraction as well. Re-index through the
    // current canonical parent receipt to restore the owner's readable copy.
    expect((await pool.query('SELECT scope_held FROM file_segments WHERE file_id=$1',[file.id])).rows).toEqual([{scope_held:true}])
    const renewed=await captureRecordingIntakeParent({actorUserId:f.userId},f.workspaceId,file.id)
    await insertFileSegments({workspaceId:f.workspaceId,fileId:file.id,createdByUserId:f.userId,
      visibility:{userId:renewed.userId,assistantId:renewed.assistantId},sensitivity:renewed.sensitivity,
      compartments:renewed.compartments,tags:null,source:file.source,replace:true,
      segments:[{segmentIndex:0,charStart:0,charEnd:17,headingPath:[],content:'Fixture paragraph'}],
    },{actorUserId:f.userId,parent:renewed})
    expect(await readFileSegmentRange({...actor,userId:f.userId,clearance:'confidential'},
      {fileId:file.id,fromIndex:0,toIndex:0})).toMatchObject([{content:'Fixture paragraph'}])
    expect(await search()).toEqual([])
    expect(await range()).toEqual([])
  })

  it.each(['stale','held','foreign','execution'] as const)('denies %s successors without closing the prior', async kind => {
    const f=await fixture(),prior=await f.create(),patch={editorUserId:f.userId,storageUri:'fixture://next',sizeBytes:2}
    if(kind==='held')await pool.query('UPDATE workspace_files SET scope_held=true WHERE id=$1',[prior.id])
    const access:AccessContext={workspaceId:f.workspaceId,userId:f.userId,assistantId:'',assistantKind:'primary',clearance:'confidential',compartments:[f.key],mutationCompartments:[],projectIds:null}
    expect(await supersedeWorkspaceFile(f.userId,kind==='foreign'?randomUUID():f.workspaceId,prior.id,
      {...patch,...(kind==='stale'?{expectedScopeVersion:'0'}:{})},kind==='execution'?access:undefined)).toBeNull()
    expect(await f.rows()).toMatchObject([{id:prior.id,valid_to:null,superseded_by:null}])
  })

  it('rejects foreign destination additions and lowering sensitivity atomically', async () => {
    const f=await fixture('departments'),foreign=await fixture(),prior=await f.create({compartments:[f.key],sensitivity:'confidential'})
    const patch={editorUserId:f.userId,storageUri:'fixture://next',sizeBytes:2}
    const parent = await captureRecordingIntakeParent({ actorUserId: f.userId }, f.workspaceId, prior.id)
    await insertFileSegments({
      workspaceId: f.workspaceId, fileId: prior.id, createdByUserId: f.userId,
      visibility: { userId: parent.userId, assistantId: parent.assistantId },
      sensitivity: parent.sensitivity, compartments: parent.compartments, tags: prior.tags, source: prior.source,
      segments: [{ segmentIndex: 0, charStart: 0, charEnd: 1, headingPath: [], content: 'x' }],
    }, { actorUserId: f.userId, parent })
    await expect(supersedeWorkspaceFile(f.userId,f.workspaceId,prior.id,{...patch,compartments:[foreign.key]})).rejects.toMatchObject({code:'context_not_available'})
    await expect(supersedeWorkspaceFile(f.userId,f.workspaceId,prior.id,{...patch,projectIds:[foreign.projectId]})).rejects.toMatchObject({code:'context_not_available'})
    await expect(supersedeWorkspaceFile(f.userId,f.workspaceId,prior.id,{...patch,sensitivity:'public'})).rejects.toMatchObject({code:'scope_declassification_required'})
    expect(await f.rows()).toMatchObject([{id:prior.id,valid_to:null,superseded_by:null}])
    expect((await pool.query('SELECT valid_to FROM file_segments WHERE file_id=$1',[prior.id])).rows).toEqual([{valid_to:null}])
  })

  it('admits an authorized member editor without substituting the original author', async () => {
    const f=await fixture(),prior=await f.create()
    await pool.query("UPDATE workspace_members SET team_scope_mode='assigned' WHERE workspace_id=$1 AND user_id=$2",[f.workspaceId,f.member])
    await f.groups.addMember(f.userId,f.team.id,f.member)
    expect(await supersedeWorkspaceFile(f.member,f.workspaceId,prior.id,{editorUserId:f.member,storageUri:'fixture://member-next',sizeBytes:2}))
      .toMatchObject({createdByUserId:f.member,userId:null,compartments:[f.key]})
  })

  it('read-only department access cannot authorize a successor', async () => {
    const f=await fixture(),prior=await f.create(),requestId=randomUUID()
    await pool.query("UPDATE workspace_members SET team_scope_mode='assigned' WHERE workspace_id=$1 AND user_id=$2",[f.workspaceId,f.member])
    await pool.query(`INSERT INTO workspace_access_requests(id,workspace_id,requester_user_id,beneficiary_kind,beneficiary_id,target_team_id,reason,starts_at,expires_at,payload_hash,policy_revision,status,decided_by,decided_at)
      VALUES($1,$2,$3,'member',$3,$4,'File successor fixture',now()-interval '1 day',now()+interval '1 day',$5,1,'approved',$6,now())`,[requestId,f.workspaceId,f.member,f.team.id,'a'.repeat(64),f.userId])
    await pool.query(`INSERT INTO workspace_access_grants(workspace_id,request_id,beneficiary_kind,beneficiary_id,target_team_id,starts_at,expires_at,approved_by)
      SELECT workspace_id,id,beneficiary_kind,beneficiary_id,target_team_id,starts_at,expires_at,decided_by FROM workspace_access_requests WHERE id=$1`,[requestId])
    const access:AccessContext={workspaceId:f.workspaceId,userId:f.member,assistantId:'',assistantKind:'primary',clearance:'internal'}
    expect((await getWorkspaceFileById(access,prior.id))?.id).toBe(prior.id)
    expect(await supersedeWorkspaceFile(f.member,f.workspaceId,prior.id,{editorUserId:f.member,storageUri:'fixture://next',sizeBytes:2})).toBeNull()
    expect(await f.rows()).toMatchObject([{id:prior.id,valid_to:null,superseded_by:null}])
  })


  it('promotes a real source through the production artifact adapter using app-role read-only authority and records lineage', async () => {
    const f=await fixture(), source=await f.create(),requestId=randomUUID()
    await pool.query("UPDATE workspace_members SET team_scope_mode='assigned' WHERE workspace_id=$1 AND user_id=$2",[f.workspaceId,f.member])
    await pool.query(`INSERT INTO workspace_access_requests(id,workspace_id,requester_user_id,beneficiary_kind,beneficiary_id,target_team_id,reason,starts_at,expires_at,payload_hash,policy_revision,status,decided_by,decided_at)
      VALUES($1,$2,$3,'member',$3,$4,'Derived file fixture',now()-interval '1 day',now()+interval '1 day',$5,1,'approved',$6,now())`,[requestId,f.workspaceId,f.member,f.team.id,'a'.repeat(64),f.userId])
    await pool.query(`INSERT INTO workspace_access_grants(workspace_id,request_id,beneficiary_kind,beneficiary_id,target_team_id,starts_at,expires_at,approved_by)
      SELECT workspace_id,id,beneficiary_kind,beneficiary_id,target_team_id,starts_at,expires_at,decided_by FROM workspace_access_requests WHERE id=$1`,[requestId])
    const gcs={writeBlob:vi.fn(async()=>{}),deleteBlob:vi.fn(async()=>{})}
    const api=createFilesApi({store:createDbWorkspaceFilesStore(),gcs:gcs as never,bucket:'fixture',auditStore:{append:vi.fn()} as never})
    const promote=createArtifactPromoter({filesApi:api})
    const output=await promote({workspaceId:f.workspaceId,actingUserId:f.member,fileName:'source.txt',mime:'text/plain',
      bytes:Buffer.from('source'),parsedText:'source',storeOnly:true,compartments:[f.key],
      derivation:{producer:'artifact-promote',sources:[boundScopeSource(source)!]}})
    expect(output).not.toBeNull()
    const row=(await f.rows()).find(row=>row.id===output!.fileId)
    expect(row).toMatchObject({compartments:[f.key],user_id:null,assistant_id:null})
    expect((await pool.query("SELECT d.resource_kind,s.source_id FROM scope_derivations d JOIN scope_derivation_sources s ON s.derivation_id=d.id WHERE d.resource_id=$1",[output!.fileId])).rows)
      .toEqual([{resource_kind:'workspace_file',source_id:source.id}])
    await pool.query("UPDATE workspace_files SET title='Changed source' WHERE id=$1",[source.id])
    expect((await f.rows()).find(row=>row.id===output!.fileId).scope_held).toBe(true)
  })

  it.each([
    ['entity', 'edit'], ['entity', 'delete'], ['entity', 'hold'],
    ['workspace_file', 'edit'], ['workspace_file', 'delete'], ['workspace_file', 'hold'],
  ] as const)('invalidates the entire %s → file A → file B graph on %s', async (kind, action) => {
    const f = await fixture()
    const root = kind === 'entity'
      ? await createEntity({ workspaceId: f.workspaceId, createdByUserId: f.userId, kind: 'person', displayName: 'File source', source: 'user' })
      : await f.create()
    const snapshot = (await pool.query('SELECT read_scope_source($1,$2,$3) AS source', [f.workspaceId, kind, root.id])).rows[0].source
    const a = await createWorkspaceFile(f.userId, f.input({ source: 'extracted' }), {
      derivation: { producer: 'multihop-file-test', sources: [snapshot] },
    })
    const b = await createWorkspaceFile(f.userId, f.input({ source: 'extracted' }), {
      derivation: { producer: 'multihop-file-test', sources: [boundScopeSource(a)!] },
    })
    const table = kind === 'entity' ? 'entities' : 'workspace_files'
    const field = kind === 'entity' ? 'display_name' : 'title'
    const before = (await pool.query(`SELECT scope_version FROM ${table} WHERE id=$1`, [root.id])).rows[0].scope_version
    // A bulk descendant hold must not recursively update B in a BEFORE trigger
    // while the outer UPDATE still targets it (PostgreSQL SQLSTATE 27000).
    if (action === 'delete') await pool.query(`DELETE FROM ${table} WHERE id=$1`, [root.id])
    else await pool.query(`UPDATE ${table} SET ${action === 'hold' ? 'scope_held=true' : `${field}='Changed root'`} WHERE id=$1`, [root.id])
    const rows = await f.rows()
    for (const file of [a, b]) {
      const row = rows.find(row => row.id === file.id)
      expect(row.scope_held).toBe(true)
      expect(file.scopeVersion).toBeDefined()
      expect(BigInt(row.scope_version)).toBe(BigInt(file.scopeVersion!) + 1n)
      expect(await getWorkspaceFileById({ workspaceId: f.workspaceId, userId: f.userId, assistantId: '', assistantKind: 'primary', clearance: 'confidential' }, file.id)).toBeNull()
    }
    if (action !== 'delete') {
      const after = (await pool.query(`SELECT scope_version FROM ${table} WHERE id=$1`, [root.id])).rows[0].scope_version
      expect(BigInt(after)).toBe(BigInt(before) + 1n)
    }
  })

  it('ignores file maintenance and caller version changes without holding multihop descendants', async () => {
    const f = await fixture(), root = await f.create()
    const a = await createWorkspaceFile(f.userId, f.input({ source: 'extracted' }), {
      derivation: { producer: 'maintenance-test', sources: [boundScopeSource(root)!] },
    })
    const b = await createWorkspaceFile(f.userId, f.input({ source: 'extracted' }), {
      derivation: { producer: 'maintenance-test', sources: [boundScopeSource(a)!] },
    })
    await pool.query("UPDATE workspace_files SET updated_at=now(),content_hash='maintenance',scope_version=scope_version+100 WHERE id=$1", [root.id])
    const rows = await f.rows()
    for (const file of [root, a, b]) {
      const row = rows.find(row => row.id === file.id)
      expect(row.scope_held).toBe(false)
      expect(String(row.scope_version)).toBe(String(file.scopeVersion))
    }
  })

  it('derived file admission keeps exact private assistant, sensitivity and Project floors', async () => {
    const f=await fixture(),assistantId=randomUUID()
    await pool.query("INSERT INTO assistants(id,workspace_id,owner_user_id,name,kind) VALUES($1,$2,$3,'Derived assistant','standard')",[assistantId,f.workspaceId,f.userId])
    const source=await f.create({userId:f.userId,assistantId,sensitivity:'confidential',projectIds:[f.projectId],compartments:[f.key]})
    const file=await createWorkspaceFile(f.userId,f.input({createdByAssistantId:assistantId,source:'extracted'}),{
      derivation:{producer:'generated-file',sources:[boundScopeSource(source)!]}})
    expect(file).toMatchObject({userId:f.userId,assistantId,sensitivity:'confidential',projectIds:[f.projectId],compartments:[f.key]})
  })

  it.each(['general', 'department'] as const)('preserves validated v2 %s source scope instead of appending the author home Department', async destination => {
    const f = await fixture(), assistantId = randomUUID()
    await pool.query("INSERT INTO assistants(id,workspace_id,owner_user_id,name,kind) VALUES($1,$2,$3,'Derived writer','standard')", [assistantId,f.workspaceId,f.userId])
    const compartments = destination === 'general' ? [] : [f.otherKey]
    const source = await f.create({userId:f.userId,assistantId,sensitivity:'confidential',projectIds:[f.projectId],compartments})
    await pool.query('UPDATE workspaces SET department_read_v2=true WHERE id=$1', [f.workspaceId])
    await pool.query('UPDATE assistants SET home_department_id=$2 WHERE id=$1', [assistantId,f.team.id])
    const derived = () => createWorkspaceFile(f.userId, f.input({createdByAssistantId:assistantId,source:'extracted'}), {
      derivation:{producer:'v2-source-inheritance',sources:[boundScopeSource(source)!]},
    })
    const file = await derived()
    expect(file).toMatchObject({userId:f.userId,assistantId,sensitivity:'confidential',projectIds:[f.projectId],compartments})
    expect((await pool.query('SELECT s.source_id FROM scope_derivations d JOIN scope_derivation_sources s ON s.derivation_id=d.id WHERE d.resource_id=$1', [file.id])).rows)
      .toEqual([{source_id:source.id}])
    // Source-derived admission must not disable the ordinary home default on
    // the next writer or permit reuse of a held canonical source.
    expect(await f.create({createdByAssistantId:assistantId})).toMatchObject({compartments:[f.key]})
    await pool.query('UPDATE workspace_files SET scope_held=true WHERE id=$1', [source.id])
    await expect(derived()).rejects.toThrow()
    expect(await f.rows()).toHaveLength(3)
  })

  it('promotes a personal General chat attachment without introducing an unreadable assistant home Department', async () => {
    const f = await fixture(), assistantId = randomUUID(), sessionId = randomUUID()
    await pool.query("INSERT INTO assistants(id,workspace_id,owner_user_id,name,kind) VALUES($1,$2,$3,'Attachment writer','standard')", [assistantId,f.workspaceId,f.member])
    await pool.query("INSERT INTO sessions(id,assistant_id,user_id,channel_type,channel_id,status,visibility) VALUES($1,$2,$3,'web','web:derived-fixture','idle','personal')", [sessionId,assistantId,f.member])
    const cached = await createDbFileStore().cache({sessionId,workspaceId:f.workspaceId,userId:f.member,fileName:'source.pdf',mimeType:'application/pdf',content:'data:application/pdf;base64,c291cmNl',sizeBytes:6})
    const source = await createWorkspaceFile(f.member, f.input({createdByUserId:f.member,userId:f.member,compartments:[]}))
    const scopeAccumulator = new ContextScopeAccumulator()
    scopeAccumulator.noteSource(boundScopeSource(source)!)
    await pool.query('UPDATE workspaces SET department_read_v2=true WHERE id=$1', [f.workspaceId])
    await pool.query('UPDATE assistants SET home_department_id=$2 WHERE id=$1', [assistantId,f.team.id])
    const writeBlob = vi.fn(async (_key: string, _bytes: Buffer) => {})
    const api = createFilesApi({store:createDbWorkspaceFilesStore(),gcs:{writeBlob} as never,bucket:'fixture',auditStore:{append:vi.fn()} as never})
    const context: ToolContext = {userId:f.member,workspaceId:f.workspaceId,assistantId,assistantKind:'standard',
      appId:'fixture',sessionId,channelType:'web',channelId:'fixture',abortSignal:new AbortController().signal,
      clearance:'internal',compartments:[],mutationCompartments:[],projectIds:[],scopeAccumulator}
    const result = await createFileTools(api,{readCachedFile:async () => cached}).saveFileToBrain.execute({fileId:cached.id,path:'/saved.pdf'},context)
    expect(result.isError).not.toBe(true)
    const file = (await f.rows()).find(row => row.path === '/saved.pdf')
    expect(file).toMatchObject({user_id:f.member,compartments:[],sensitivity:'internal'})
    expect(writeBlob.mock.calls[0]?.[1]).toEqual(Buffer.from('source'))
    expect((await getWorkspaceFileById({workspaceId:f.workspaceId,userId:f.member,assistantId,assistantKind:'standard',clearance:'internal'},file.id))?.id).toBe(file.id)
  })

  it.each(['held','stale','forged','foreign','ambient','empty'] as const)('rejects %s source evidence without a derived row or lineage', async kind => {
    const f=await fixture(),source=await f.create(),snapshot=boundScopeSource(source)!
    if(kind==='held')await pool.query('UPDATE workspace_files SET scope_held=true WHERE id=$1',[source.id])
    if(kind==='stale')await pool.query("UPDATE workspace_files SET title='New source' WHERE id=$1",[source.id])
    const evidence={producer:'generated-file',sources:kind==='empty'?[]:[{...snapshot,
      ...(kind==='forged'?{compartments:[]} : {}),...(kind==='foreign'?{workspaceId:randomUUID()}: {})}]}
    const write=()=>createWorkspaceFile(f.userId,f.input({source:'extracted'}),{derivation:evidence})
    if(kind==='ambient')await expect(runWithAgentAccess({workspaceId:f.workspaceId,userId:f.userId,clearance:'confidential',compartments:[],mutationCompartments:[],projectIds:null},write)).rejects.toThrow()
    else await expect(write()).rejects.toThrow()
    expect(await f.rows()).toHaveLength(1)
    expect((await pool.query("SELECT id FROM scope_derivations WHERE workspace_id=$1 AND resource_kind='workspace_file'",[f.workspaceId])).rows).toEqual([])
  })


  it('threads real fileWrite tool source snapshots into canonical derived admission', async () => {
    const f=await fixture(),assistantId=randomUUID()
    await pool.query("INSERT INTO assistants(id,workspace_id,owner_user_id,name,kind) VALUES($1,$2,$3,'Writer','standard')",[assistantId,f.workspaceId,f.userId])
    const source=await f.create({userId:f.userId,assistantId,sensitivity:'confidential',compartments:[f.key],projectIds:[f.projectId]})
    const scopeAccumulator=new ContextScopeAccumulator()
    scopeAccumulator.noteSource(boundScopeSource(source)!)
    const api=createFilesApi({store:createDbWorkspaceFilesStore(),gcs:{writeBlob:vi.fn(async()=>{})} as never,bucket:'fixture',auditStore:{append:vi.fn()} as never})
    const context:ToolContext={userId:f.userId,workspaceId:f.workspaceId,assistantId,assistantKind:'standard',
      appId:'fixture',sessionId:randomUUID(),channelType:'web',channelId:'fixture',abortSignal:new AbortController().signal,
      clearance:'confidential',compartments:[f.key],mutationCompartments:[f.key],projectIds:[f.projectId],scopeAccumulator}
    const result=await createFileTools(api).fileWrite.execute({path:'/generated.txt',content:'Generated from actual source'},context)
    expect(result.isError).not.toBe(true)
    const row=(await f.rows()).find(row=>row.path==='/generated.txt')
    expect(row).toMatchObject({user_id:f.userId,assistant_id:assistantId,sensitivity:'confidential',compartments:[f.key],project_ids:[f.projectId]})
    expect((await pool.query("SELECT producer FROM scope_derivations WHERE resource_id=$1",[row.id])).rows).toEqual([{producer:'workspace-file-tool'}])
  })
})

describe('[COMP:retrieval/provenance] schema-safe primitive probes', () => {
  it('returns no provenance for missing and inaccessible rows without probing nonexistent edge author columns', async () => {
    const f = await fixture(), file = await f.create({userId:f.userId})
    const store = createDbProvenanceStore()
    const actor = {workspaceId:f.workspaceId,userId:f.member,assistantId:'',assistantKind:'primary' as const,clearance:'internal' as const}
    expect(await store.provenance(actor,{row_id:randomUUID()})).toBeNull()
    expect(await store.provenance(actor,{row_id:file.id})).toBeNull()
    expect((await store.provenance({...actor,userId:f.userId},{row_id:file.id}))?.data.authorship.created_by_user_id).toBe(f.userId)
    expect(await store.provenance({...actor,userId:f.userId,workspaceId:randomUUID()},{row_id:file.id})).toBeNull()
    expect(await store.provenance({...actor,userId:f.userId,clearance:'public'},{row_id:file.id})).toBeNull()
  })

  it('enforces Department, Project and assistant bounds without ambient agent context', async () => {
    const f = await fixture(), assistantId = randomUUID()
    await pool.query("INSERT INTO assistants(id,workspace_id,owner_user_id,name,kind) VALUES($1,$2,$3,'Provenance fixture','standard')", [assistantId,f.workspaceId,f.userId])
    const file = await f.create({userId:f.userId,assistantId,compartments:[f.key],projectIds:[f.projectId]})
    const actor = {workspaceId:f.workspaceId,userId:f.userId,assistantId,assistantKind:'standard' as const,clearance:'internal' as const,compartments:[f.key],projectIds:[f.projectId]}
    const store = createDbProvenanceStore()
    expect((await store.provenance(actor,{row_id:file.id}))?.data.row_id).toBe(file.id)
    expect(await store.provenance({...actor,compartments:[]},{row_id:file.id})).toBeNull()
    expect(await store.provenance({...actor,projectIds:[]},{row_id:file.id})).toBeNull()
    expect(await store.provenance({...actor,assistantId:randomUUID()},{row_id:file.id})).toBeNull()
  })

  it('keeps edge authorship unknown instead of inventing it from ownership', async () => {
    const f = await fixture()
    const source = await createEntity({workspaceId:f.workspaceId,createdByUserId:f.userId,kind:'person',displayName:'Source',source:'user'})
    const target = await createEntity({workspaceId:f.workspaceId,createdByUserId:f.userId,kind:'company',displayName:'Target',source:'user'})
    const link = await createDbEntityLinksStore().create({workspaceId:f.workspaceId,sourceKind:'entity',sourceId:source.id,targetKind:'entity',targetId:target.id,edgeType:'works_at',source:'user',userId:f.userId})
    const result = await createDbProvenanceStore().provenance({workspaceId:f.workspaceId,userId:f.userId,assistantId:'',assistantKind:'primary',clearance:'confidential'}, {row_id:link.id})
    expect(result?.data).toMatchObject({primitive:'entity_links',authorship:{created_by_user_id:'',created_by_assistant_id:null},supersession:{preceded_by:null,superseded_by:null}})
  })
})

describe('[COMP:files/upload-identity] canonical upload identity', () => {
  it('converges concurrent document and ingestion uploads on one file and one stored object', async () => {
    const f = await fixture('legacy'), blobs = new Map<string, Buffer>()
    const gcs = { writeBlob: async (key:string,bytes:Buffer) => { blobs.set(key,bytes) }, deleteBlob: async (key:string) => { blobs.delete(key) } }
    const api = createFilesApi({store:createDbWorkspaceFilesStore(),gcs:gcs as never,bucket:'fixture',auditStore:{append:async()=>{}} as never})
    const ctx = {workspaceId:f.workspaceId,userId:f.userId}
    const params = {mime:'application/pdf',bytes:Buffer.from('identical upload'),reusableUploadName:'notes.pdf'}
    const results = await Promise.all([
      api.writeBytes(ctx,{...params,path:'/doc/unique-notes.pdf'}),
      api.writeBytes(ctx,{...params,path:'/uploads/notes.pdf'}),
    ])
    expect(results.every(r=>r.ok)).toBe(true)
    expect(new Set(results.map(r=>r.ok?r.value.id:'error')).size).toBe(1)
    expect(await f.rows()).toHaveLength(1)
    expect(blobs.size).toBe(1)
    const access={workspaceId:f.workspaceId,userId:f.userId,assistantId:'',assistantKind:'primary' as const}
    const original=results[0].ok?results[0].value:null
    if(!original)throw new Error('missing upload')
    // The worker stamps source_episode_id after successful decomposition.
    await pool.query('UPDATE workspace_files SET source_episode_id=$2 WHERE id=$1',[original.id,randomUUID()])
    expect((await createDbWorkspaceFilesStore().searchByText(access,{})).map(r=>r.id)).toContain(original.id)
    const again = await api.writeBytes(ctx,{...params,path:'/doc/another-notes.pdf'})
    expect(again.ok && again.value.id).toBe(original.id)
    expect(blobs.size).toBe(1)
  })

  it('reuses a document attachment for ingestion and exposes it after explicit analysis', async () => {
    const f=await fixture('legacy'),store=createDbWorkspaceFilesStore(),writes=vi.fn(async()=>{})
    const api=createFilesApi({store,gcs:{writeBlob:writes,deleteBlob:async()=>{}} as never,bucket:'fixture',auditStore:{append:async()=>{}} as never})
    const ctx={workspaceId:f.workspaceId,userId:f.userId}
    const p={mime:'application/pdf',bytes:Buffer.from('pdf'),reusableUploadName:'notes.pdf'}
    const original=await api.writeBytes(ctx,{...p,path:'/doc/attachment-notes.pdf'})
    const reused=await api.writeBytes(ctx,{...p,path:'/uploads/notes.pdf'})
    expect(reused).toEqual(original)
    if(!original.ok)throw new Error('missing upload')
    const access={...ctx,assistantId:'',assistantKind:'primary' as const}
    expect(await store.searchByText(access,{})).toEqual([])
    await pool.query('UPDATE workspace_files SET source_episode_id=$2 WHERE id=$1',[original.value.id,randomUUID()])
    expect((await enqueueFileIngestJob({fileId:original.value.id,workspaceId:f.workspaceId,actingUserId:f.userId,onlyIfUnprocessed:true})).enqueued).toBe(false)
    expect((await store.searchByText(access,{})).map(r=>r.id)).toContain(original.value.id)
    expect((await store.listIndexRanked(access,50)).map(r=>r.id)).toContain(original.value.id)
    expect(writes).toHaveBeenCalledTimes(1)
  })

  it('resolves the ready Simple default before same-path and at-quota reuse', async () => {
    const f=await fixture(),store=createDbWorkspaceFilesStore(),gcs={writeBlob:vi.fn(async()=>{}),deleteBlob:vi.fn(async()=>{})}
    let cap=100
    const api=createFilesApi({store,gcs:gcs as never,bucket:'fixture',auditStore:{append:async()=>{}} as never,storageLimitBytesFor:async()=>cap})
    const ctx={workspaceId:f.workspaceId,userId:f.userId}
    const p={path:'/uploads/notes.pdf',mime:'application/pdf',bytes:Buffer.from('pdf'),reusableUploadName:'notes.pdf'}
    const first=await api.writeBytes(ctx,p)
    expect(first.ok && first.value.compartments).toEqual([f.key])
    cap=0
    expect(await api.writeBytes(ctx,p)).toEqual(first)
    expect(await api.writeBytes(ctx,{...p,path:'/uploads/another-path.pdf'})).toEqual(first)
    expect(gcs.writeBlob).toHaveBeenCalledTimes(1)
    expect(await f.rows()).toHaveLength(1)
  })

  it('rechecks a fresh enqueue snapshot after waiting for the worker completion stamp', async () => {
    const f=await fixture('legacy')
    const file=await f.create({path:'/uploads/queued.txt'})
    const worker=await pool.connect()
    let queued:ReturnType<typeof enqueueFileIngestJob>|undefined
    try {
      await worker.query('BEGIN')
      await worker.query('UPDATE workspace_files SET source_episode_id=$2 WHERE id=$1',[file.id,randomUUID()])
      queued=enqueueFileIngestJob({fileId:file.id,workspaceId:f.workspaceId,actingUserId:f.userId,onlyIfUnprocessed:true})
      // Prove the enqueue is actually waiting on the worker's file lock.
      let waiting=false
      for(let attempt=0;attempt<100 && !waiting;attempt++) {
        waiting=(await pool.query(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database()
          AND wait_event_type='Lock' AND query LIKE 'INSERT INTO file_ingest_jobs%') AS waiting`)).rows[0].waiting
        if(!waiting)await new Promise(resolve=>setTimeout(resolve,10))
      }
      expect(waiting).toBe(true)
      await worker.query('COMMIT')
      expect(await queued).toEqual({enqueued:false,jobId:null})
    } finally {
      await worker.query('ROLLBACK')
      worker.release()
      await queued
    }
  })

  it('separates uploader, bytes, filename and sensitivity; metadata cannot forge identity', async () => {
    const f = await fixture('legacy')
    const api = createFilesApi({store:createDbWorkspaceFilesStore(),gcs:{writeBlob:async()=>{},deleteBlob:async()=>{}} as never,bucket:'fixture',auditStore:{append:async()=>{}} as never})
    const ctx = {workspaceId:f.workspaceId,userId:f.userId}
    const p = {mime:'application/pdf',bytes:Buffer.from('pdf'),reusableUploadName:'notes.pdf'}
    const first=await api.writeBytes(ctx,{...p,path:'/doc/first.pdf'})
    for (const [i,patch] of [{bytes:Buffer.from('other')},{reusableUploadName:'renamed.pdf'},{sensitivity:'confidential' as const}].entries()) {
      const result=await api.writeBytes(ctx,{...p,...patch,path:`/doc/variant-${i}.pdf`})
      expect(result.ok && first.ok && result.value.id!==first.value.id).toBe(true)
    }
    const other=await api.writeBytes({...ctx,userId:f.member},{...p,path:'/doc/other-uploader.pdf'})
    expect(other.ok && first.ok && other.value.id!==first.value.id).toBe(true)
    for(const [i,scope] of [{writeCompartments:[f.key]},{writeCompartments:[f.otherKey]},{writeProjectIds:[f.projectId]}].entries()) {
      const separated=await api.writeBytes({...ctx,...scope},{...p,path:`/doc/scope-${i}.pdf`})
      expect(separated.ok && first.ok && separated.value.id!==first.value.id).toBe(true)
    }
    expect(await f.rows()).toHaveLength(8)
    if(!first.ok)throw new Error('missing original')
    const forged=createHash('sha256').update(JSON.stringify('notes.pdf')).update('\0').update(Buffer.from('forged')).digest('hex')
    await updateWorkspaceFileMeta(f.userId,f.workspaceId,first.value.id,{metadata:{uploadIdentity:forged,upload_identity:forged}})
    const distinct=await api.writeBytes(ctx,{...p,path:'/doc/forged-metadata.pdf',bytes:Buffer.from('forged')})
    expect(distinct.ok && distinct.value.id!==first.value.id).toBe(true)
    await expect(pool.query('UPDATE workspace_files SET upload_identity=$2 WHERE id=$1',[first.value.id,'a'.repeat(64)])).rejects.toThrow('file_upload_identity_immutable')
  })
})

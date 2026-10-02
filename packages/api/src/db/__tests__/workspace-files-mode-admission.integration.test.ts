import { boundScopeSource, ContextScopeAccumulator, createFileTools, type ToolContext } from '@use-brian/core'
import { createFilesApi } from '../../files/files-api.js'
import { createArtifactPromoter } from '../../files/artifact-promote.js'
import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it, vi } from 'vitest'
import type { AccessContext, WorkspaceFileCreateInput } from '@use-brian/core'
import { applyRLSGucs, getAppPool, getPool, rollbackAndRelease } from '../client.js'
import { runWithAgentAccess } from '../agent-access-context.js'
import { createWorkspaceFile, supersedeWorkspaceFile, updateWorkspaceFileMeta, getWorkspaceFileById } from '../workspace-files.js'
import { createDbWorkspaceFilesStore } from '../workspace-files-store.js'
import { insertFileSegments } from '../file-segments-store.js'
import { captureRecordingIntakeParent } from '../recording-intake-admission.js'
import { createDbWorkspaceGroupStore } from '../workspace-group-store.js'
import { createEntity } from '../entities-store.js'
import { admitFileCreate } from '../../workspace-access/file-create-admission.js'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
// This suite asserts the legacy (pre-v2) model, which workspaces.department_read_v2=false still
// serves as the cutover's rollback path (migration 650, decision D22); its workspaces are pinned to it.
await assertLocalFixture()
const pool = getPool()

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

describe('canonical root workspace-file mode admission', () => {
  afterAll(async () => { await getAppPool().end(); await pool.end() })

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

import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { getPool, getAppPool, queryWithRLS } from '../client.js'
import { createOfficeArtifactStore } from '../office-artifacts.js'
import { createDbWorkspaceGroupStore } from '../workspace-group-store.js'
import { runWithAgentAccess } from '../agent-access-context.js'
import type { OfficeCreateOptions } from '../../workspace-access/office-create-admission.js'
const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()
const pool = getPool(), store = createOfficeArtifactStore()
afterAll(async () => { await getAppPool().end(); await pool.end() })
type Input = Parameters<typeof store.createShell>[0]
async function fixture(mode = 'simple', ready = true) {
  const userId = randomUUID(), workspaceId = randomUUID()
  await pool.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)', [userId])
  await pool.query("INSERT INTO workspaces(id,name,owner_user_id) VALUES($1,'Office admission',$2)", [workspaceId,userId])
  await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role,clearance) VALUES($1,$2,'owner','confidential')", [workspaceId,userId])
  const groups = createDbWorkspaceGroupStore()
  const team = await groups.createTeam(userId,workspaceId,{name:'Default',key:'default'})
  const other = await groups.createTeam(userId,workspaceId,{name:'Other',key:'other'})
  await pool.query('UPDATE workspace_access_policies SET access_mode=$2,setup_state=$3,default_department_id=$4 WHERE workspace_id=$1',[workspaceId,mode,ready?'ready':'legacy',team.id])
  const input = (patch: Partial<Input> = {}): Input => ({userId,workspaceId,family:'document',title:'Authored',templateVersionId:null,capabilityVersion:1,sensitivity:'internal',...patch})
  const options: OfficeCreateOptions = {provenance:{kind:'human_authored_root',actorUserId:userId,workspaceId}}
  return {userId,workspaceId,team,other,input,options,groups}
}
describe('Office authored-root admission (actual app-role PG)', () => {
  it('defaults omitted Simple scope and persists exactly the admitted envelope', async () => {
    const f = await fixture()
    const role = (await getAppPool().query(`SELECT rolsuper,rolbypassrls,current_user=(SELECT tableowner FROM pg_tables WHERE schemaname='public' AND tablename='office_artifacts') AS owner FROM pg_roles WHERE rolname=current_user`)).rows[0]
    expect(role).toEqual({rolsuper:false,rolbypassrls:false,owner:false})
    const row = await store.createShell(f.input(),f.options)
    expect(row).toMatchObject({workspaceId:f.workspaceId,compartments:[f.team.compartmentKey],sensitivity:'internal',projectIds:[]})
    expect((await pool.query('SELECT compartments,visibility_user_ids FROM office_artifacts WHERE id=$1',[row.id])).rows[0]).toEqual({compartments:[f.team.compartmentKey],visibility_user_ids:[]})
    for (const requiredCompartments of [[],null,[f.other.compartmentKey]]) {
      await expect(store.createShell(f.input({requiredCompartments} as Partial<Input>),f.options)).rejects.toMatchObject({code:'access_mode_destination_conflict'})
    }
    await expect(store.createShell(f.input(),{...f.options,expectedPolicyRevision:'-1'})).rejects.toMatchObject({code:'access_policy_conflict'})
    expect((await pool.query('SELECT id FROM office_artifacts WHERE workspace_id=$1',[f.workspaceId])).rows).toHaveLength(1)
  })
  it('requires Departments selection, supports explicit General, and rejects null/foreign labels', async () => {
    const f = await fixture('departments'), foreign = await fixture()
    await expect(store.createShell(f.input(),f.options)).rejects.toMatchObject({code:'context_selection_required'})
    expect((await store.createShell(f.input({requiredCompartments:[]}),f.options)).compartments).toEqual([])
    expect((await store.createShell(f.input({requiredCompartments:[f.other.compartmentKey!]}),f.options)).compartments).toEqual([f.other.compartmentKey])
    for (const requiredCompartments of [null,[foreign.team.compartmentKey]]) await expect(store.createShell(f.input({requiredCompartments} as Partial<Input>),f.options)).rejects.toBeDefined()
  })
  it('preserves explicit private visibility, sensitivity and Project restrictions', async () => {
    const f = await fixture(), project = randomUUID()
    await pool.query("INSERT INTO workspace_projects(id,workspace_id,name,normalized_name,created_by) VALUES($1,$2,'Project','project',$3)",[project,f.workspaceId,f.userId])
    const input = f.input({visibilityUserIds:[f.userId],sensitivity:'confidential',projectIds:[project],requiredCompartments:[]})
    const row = await store.createShell(input,f.options)
    expect(row).toMatchObject({compartments:[],projectIds:[project],sensitivity:'confidential'})
    expect((await pool.query('SELECT visibility_user_ids FROM office_artifacts WHERE id=$1',[row.id])).rows[0].visibility_user_ids).toEqual([f.userId])
    await expect(store.createShell(f.input({visibilityUserIds:[randomUUID()]}),f.options)).rejects.toBeDefined()
    const ceiling = {workspaceId:f.workspaceId,userId:f.userId,clearance:'confidential',compartments:null,mutationCompartments:null,projectIds:[]}
    await expect(runWithAgentAccess(ceiling,()=>store.createShell(input,f.options))).rejects.toBeDefined()
    await expect(store.createShell(f.input({projectIds:[randomUUID()]}),f.options)).rejects.toBeDefined()
  })
  it('uses current member mutation authority and ambient ceilings, not owner inference', async () => {
    const f = await fixture('departments'), member = randomUUID()
    await pool.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)',[member])
    await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role,clearance,team_scope_mode) VALUES($1,$2,'member','internal','assigned')",[f.workspaceId,member])
    await f.groups.addMember(f.userId,f.team.id,member)
    const options: OfficeCreateOptions = {provenance:{kind:'human_authored_root',actorUserId:member,workspaceId:f.workspaceId}}
    expect((await store.createShell(f.input({userId:member,requiredCompartments:[f.team.compartmentKey!]}),options)).compartments).toEqual([f.team.compartmentKey])
    await expect(store.createShell(f.input({userId:member,requiredCompartments:[f.other.compartmentKey!]}),options)).rejects.toBeDefined()
    const ceiling = {workspaceId:f.workspaceId,userId:f.userId,clearance:'confidential',compartments:null,mutationCompartments:null,projectIds:null}
    for (const change of [{mutationCompartments:[]},{compartments:[]},{clearance:'public'},{workspaceId:randomUUID()},{userId:member}]) {
      await expect(runWithAgentAccess({...ceiling,...change},()=>store.createShell(f.input({requiredCompartments:[f.team.compartmentKey!]}),f.options))).rejects.toBeDefined()
    }
    await pool.query('DELETE FROM workspace_members WHERE workspace_id=$1 AND user_id=$2',[f.workspaceId,member])
    await expect(store.createShell(f.input({userId:member,requiredCompartments:[f.team.compartmentKey!]}),options)).rejects.toBeDefined()
  })
  it('admits ordinary Simple members but never turns a read grant into create authority', async () => {
    const f = await fixture(), member = randomUUID()
    await pool.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)',[member])
    await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role,clearance,team_scope_mode) VALUES($1,$2,'member','internal','assigned')",[f.workspaceId,member])
    await f.groups.addMember(f.userId,f.team.id,member)
    const options: OfficeCreateOptions = {provenance:{kind:'human_authored_root',actorUserId:member,workspaceId:f.workspaceId}}
    expect((await store.createShell(f.input({userId:member}),options)).compartments).toEqual([f.team.compartmentKey])
    await pool.query("UPDATE workspace_access_policies SET access_mode='departments' WHERE workspace_id=$1",[f.workspaceId])
    const source = await store.createShell(f.input({requiredCompartments:[f.other.compartmentKey!]}),f.options)
    const request = randomUUID()
    await pool.query(`INSERT INTO workspace_access_requests(id,workspace_id,requester_user_id,beneficiary_kind,beneficiary_id,target_team_id,reason,starts_at,expires_at,payload_hash,policy_revision,status,decided_by,decided_at)
      VALUES($1,$2,$3,'member',$3,$4,'Office read grant',now()-interval '1 day',now()+interval '1 day',$5,1,'approved',$6,now())`,[request,f.workspaceId,member,f.other.id,'a'.repeat(64),f.userId])
    await pool.query(`INSERT INTO workspace_access_grants(workspace_id,request_id,beneficiary_kind,beneficiary_id,target_team_id,starts_at,expires_at,approved_by)
      SELECT workspace_id,id,beneficiary_kind,beneficiary_id,target_team_id,starts_at,expires_at,decided_by FROM workspace_access_requests WHERE id=$1`,[request])
    expect((await queryWithRLS(member,'SELECT id FROM office_artifacts WHERE id=$1',[source.id])).rows).toEqual([{id:source.id}])
    await expect(store.createShell(f.input({userId:member,requiredCompartments:[f.other.compartmentKey!]}),options)).rejects.toBeDefined()
  })
  it('waits on workspace-first policy serialization and resolves the committed mode', async () => {
    const f = await fixture(), lock = await pool.connect()
    let pending: Promise<unknown> | undefined
    try {
      await lock.query('BEGIN')
      await lock.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE',[f.workspaceId])
      pending = store.createShell(f.input(),f.options).then(value => ({value}), error => ({error}))
      // Prove the writer reached and is blocked on the workspace lock rather
      // than relying on a timing delay to establish transaction ordering.
      let waiting = false
      for (let i=0; i<100; i++) {
        const state = await lock.query("SELECT 1 FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE 'SELECT id FROM workspaces WHERE id=$1 FOR UPDATE%'")
        if (state.rows.length) { waiting = true; break }
        await new Promise(resolve => setTimeout(resolve,10))
      }
      expect(waiting).toBe(true)
      await lock.query("UPDATE workspace_access_policies SET access_mode='departments' WHERE workspace_id=$1",[f.workspaceId])
      await lock.query('COMMIT')
      expect(await pending).toMatchObject({error:{code:'context_selection_required'}})
      expect((await pool.query('SELECT id FROM office_artifacts WHERE workspace_id=$1',[f.workspaceId])).rows).toEqual([])
    } finally {
      await lock.query('ROLLBACK')
      lock.release()
      await pending
    }
  })
  it('blocks unproved generated/import/template shells and payload-forged provenance', async () => {
    const f = await fixture()
    await expect(store.createShell({...f.input(),...f.options})).rejects.toMatchObject({code:'office_admission_provenance_required'})
    for (const patch of [{templateVersionId:randomUUID()},{mode:'template' as const}]) await expect(store.createShell(f.input(patch),f.options)).rejects.toMatchObject({code:'office_admission_provenance_required'})
    await expect(store.createShell(f.input(),{provenance:{kind:'human_authored_root',actorUserId:randomUUID(),workspaceId:f.workspaceId}})).rejects.toMatchObject({code:'office_admission_provenance_required'})
    expect((await pool.query('SELECT id FROM office_artifacts WHERE workspace_id=$1',[f.workspaceId])).rows).toHaveLength(0)
  })
  it('blocks ready-mode copies (current, held snapshot, and foreign source) without publishing any children', async () => {
    const f = await fixture('simple',false), foreign = await fixture('simple',false)
    const source = await store.createShell(f.input({visibilityUserIds:[f.userId],sensitivity:'confidential',requiredCompartments:[f.other.compartmentKey!]}))
    const fileId = randomUUID()
    await pool.query("INSERT INTO workspace_files(id,workspace_id,path,name,storage_uri) VALUES($1,$2,'/snapshot','snapshot','fixture://snapshot')",[fileId,f.workspaceId])
    const version = await store.commitVersion({userId:f.userId,artifactId:source.id,snapshotTitle:'Source',expectedVersion:0,snapshotFileId:fileId,snapshotHash:'a'.repeat(64),operationClock:new Uint8Array(),schemaVersion:1,capabilityVersion:1,origin:'manual',authorType:'user',authorUserId:f.userId,summary:'Source'})
    const foreignSource = await store.createShell(foreign.input())
    await pool.query("UPDATE workspace_access_policies SET setup_state='ready' WHERE workspace_id=$1",[f.workspaceId])
    for (const state of ['current','held','foreign']) {
      if (state === 'held') await pool.query('UPDATE workspace_files SET scope_held=true WHERE id=$1',[fileId])
      await expect(store.createCopiedArtifact({userId:f.userId,workspaceId:f.workspaceId,artifactId:randomUUID(),versionId:randomUUID(),family:'document',title:'Copy',templateVersionId:null,capabilityVersion:1,sensitivity:'public',compartments:[],projectIds:[],snapshotFileId:fileId,snapshotHash:'a'.repeat(64),operationClock:new Uint8Array(),schemaVersion:1,snapshotCapabilityVersion:1,liveUpdate:new Uint8Array(),liveStateVector:new Uint8Array(),sourceArtifactId:state==='foreign'?foreignSource.id:source.id,sourceVersionId:version!.id})).rejects.toMatchObject({code:'office_admission_provenance_required'})
    }
    expect((await pool.query('SELECT id FROM office_artifacts WHERE workspace_id=$1',[f.workspaceId])).rows).toEqual([{id:source.id}])
    expect((await pool.query('SELECT id FROM office_artifact_sources WHERE workspace_id=$1',[f.workspaceId])).rows).toEqual([])
  })
  it('preserves legacy shell semantics and operation RLS without provenance', async () => {
    const f = await fixture('departments',false)
    expect((await store.createShell(f.input())).compartments).toEqual([])
    const row = await store.createShell(f.input({requiredCompartments:[f.other.compartmentKey!],visibilityUserIds:[f.userId]}))
    expect(row.compartments).toEqual([f.other.compartmentKey])
    expect((await queryWithRLS(f.userId,'SELECT id FROM office_artifacts WHERE id=$1',[row.id])).rows).toEqual([{id:row.id}])
  })
})

import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { getPool, getAppPool, applyRLSGucs, rollbackAndRelease } from '../client.js'
import { createMemory, updateMemory } from '../memories.js'
import { createEpisode } from '../episodes-store.js'
import { createDbWorkspaceGroupStore } from '../workspace-group-store.js'
import { runWithAgentAccess } from '../agent-access-context.js'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
// This suite asserts the legacy (pre-v2) model, which workspaces.department_read_v2=false still
// serves as the cutover's rollback path (migration 650, decision D22); its workspaces are pinned to it.
await assertLocalFixture()
const pool = getPool()
// The disposable role is created after migrations; grant only migration628's
// authorized entry point, mirroring its production app_user grant.
await pool.query('GRANT EXECUTE ON FUNCTION hold_memory_successor_descendants(uuid,uuid,bigint) TO assurance_app')
afterAll(async () => { await getAppPool().end(); await pool.end() })
async function fixture(mode = 'simple', ready = true) {
  const userId = randomUUID(), workspaceId = randomUUID(), assistantId = randomUUID()
  await pool.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)', [userId])
  await pool.query("INSERT INTO workspaces(id,name,owner_user_id,department_read_v2) VALUES($1,'Brain admission',$2,false)", [workspaceId,userId])
  await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'owner')", [workspaceId,userId])
  await pool.query("INSERT INTO assistants(id,workspace_id,owner_user_id,name,kind) VALUES($1,$2,$3,'Brain','standard')", [assistantId,workspaceId,userId])
  const groups = createDbWorkspaceGroupStore()
  const team = await groups.createTeam(userId,workspaceId,{ name:'Default',key:'default' })
  const other = await groups.createTeam(userId,workspaceId,{ name:'Other',key:'other' })
  await pool.query('UPDATE workspace_access_policies SET access_mode=$2,setup_state=$3,default_department_id=$4 WHERE workspace_id=$1', [workspaceId,mode,ready?'ready':'legacy',team.id])
  const memory = (patch: Record<string,unknown> = {}) => createMemory({assistantId,workspaceId,userId:null,createdByUserId:userId,summary:'Admission',sensitivity:'internal',...patch})
  const episode = (patch: Record<string,unknown> = {}) => createEpisode(userId,{assistantId,workspaceId,userId:null,createdByUserId:userId,sourceKind:'chat',sourceRef:{},occurredAt:new Date(),...patch})
  return {userId,workspaceId,assistantId,team,other,memory,episode}
}
describe('memory/episode ready-mode canonical admission', () => {
  it.each(['memory','episode'] as const)('%s defaults only omitted shared labels and preserves private work', async kind => {
    const f = await fixture(), create = f[kind]
    expect((await create()).compartments).toEqual([f.team.compartmentKey])
    await expect(create({compartments:[]})).rejects.toMatchObject({code:'access_mode_destination_conflict'})
    await expect(create({compartments:null})).rejects.toMatchObject({code:'access_mode_destination_conflict'})
    await expect(create({compartments:[f.other.compartmentKey]})).rejects.toMatchObject({code:'access_mode_destination_conflict'})
    expect((await create({userId:f.userId})).compartments).toEqual([])
    await expect(create({createdByUserId:randomUUID()})).rejects.toBeDefined()
    await expect(runWithAgentAccess({workspaceId:f.workspaceId,userId:f.userId,clearance:'confidential',compartments:null,mutationCompartments:[],projectIds:null},async () => { await create() })).rejects.toMatchObject({code:'context_not_available'})
  })
  it.each(['memory','episode'] as const)('%s requires Departments selection and retains explicit General', async kind => {
    const f = await fixture('departments'), create = f[kind]
    await expect(create()).rejects.toMatchObject({code:'context_selection_required'})
    expect((await create({compartments:[]})).compartments).toEqual([])
    expect((await create({compartments:[f.other.compartmentKey]})).compartments).toEqual([f.other.compartmentKey])
    await expect(create({compartments:['team:'+randomUUID()]})).rejects.toMatchObject({code:'context_not_available'})
    await expect(create({projectIds:[randomUUID()],compartments:[]})).rejects.toMatchObject({code:'context_not_available'})
  })
  it.each(['private','secret','confidential'])('persists %s episode input as the authorized canonical confidential floor', async sensitivity => {
    const f=await fixture('departments')
    await pool.query("UPDATE workspace_members SET clearance='confidential' WHERE workspace_id=$1 AND user_id=$2",[f.workspaceId,f.userId])
    const parent=await f.episode({sensitivity,userId:f.userId,compartments:[f.other.compartmentKey]})
    expect(parent).toMatchObject({sensitivity:'confidential',userId:f.userId})
    const child=await f.episode({parentEpisodeId:parent.id,sensitivity:'public'})
    expect(child).toMatchObject({sensitivity:'confidential',userId:f.userId,compartments:[f.other.compartmentKey]})
    const snapshot=(await pool.query("SELECT read_scope_source($1,'episode',$2) AS source",[f.workspaceId,child.id])).rows[0].source
    expect(snapshot.sensitivity).toBe('confidential')
    await expect(runWithAgentAccess({workspaceId:f.workspaceId,userId:f.userId,clearance:'internal',compartments:null,mutationCompartments:null,projectIds:null},()=>f.episode({sensitivity,compartments:[]}))).rejects.toMatchObject({code:'context_not_available'})
  })
  it('preserves legacy omitted/empty labels', async () => {
    const f=await fixture('simple',false)
    expect((await f.memory()).compartments).toEqual([])
    expect((await f.episode({compartments:[]})).compartments).toEqual([])
  })
  it('inherits locked episode floors, not a changed default; rejects held and conflicting ownership', async () => {
    const f=await fixture('departments')
    const parent=await f.episode({userId:f.userId,compartments:[f.other.compartmentKey],sensitivity:'internal'})
    await pool.query("UPDATE workspace_access_policies SET access_mode='simple' WHERE workspace_id=$1",[f.workspaceId])
    expect(await f.episode({parentEpisodeId:parent.id})).toMatchObject({userId:f.userId,compartments:[f.other.compartmentKey],sensitivity:'internal'})
    await expect(f.episode({parentEpisodeId:parent.id,userId:randomUUID()})).rejects.toMatchObject({code:'context_not_available'})
    await pool.query('UPDATE episodes SET scope_held=true WHERE id=$1',[parent.id])
    await expect(f.episode({parentEpisodeId:parent.id})).rejects.toMatchObject({code:'context_not_available'})
  })
  it('uses the caller transaction and restores metadata bypass for an app-role memory insert', async () => {
    const f=await fixture(), client=await getAppPool().connect()
    try {
      await client.query('BEGIN'); await applyRLSGucs(client,f.userId)
      const row=await createMemory({assistantId:f.assistantId,workspaceId:f.workspaceId,userId:null,createdByUserId:f.userId,summary:'Rollback',sensitivity:'internal'},undefined,client)
      expect(row.compartments).toEqual([f.team.compartmentKey])
      expect((await client.query("SELECT current_setting('app.system_bypass',true) AS bypass")).rows[0].bypass).not.toBe('true')
    } finally { await rollbackAndRelease(client) }
    expect((await pool.query('SELECT id FROM memories WHERE workspace_id=$1',[f.workspaceId])).rows).toHaveLength(0)
  })
  it('retains validated memory lineage across default changes and rejects stale versions and forged additions', async () => {
    const f=await fixture('departments')
    const parent=await f.memory({compartments:[f.other.compartmentKey],sensitivity:'confidential'})
    const source={workspaceId:f.workspaceId,userId:parent.userId,assistantId:parent.assistantId,sensitivity:parent.sensitivity,
      compartments:parent.compartments,projectIds:parent.projectIds,resourceKind:'memory' as const,resourceId:parent.id,version:parent.scopeVersion}
    await pool.query("UPDATE workspace_access_policies SET access_mode='simple' WHERE workspace_id=$1",[f.workspaceId])
    const derivation={producer:'admission-test',sources:[source]}
    expect(await f.memory({derivation})).toMatchObject({compartments:[f.other.compartmentKey],sensitivity:'confidential'})
    await expect(f.memory({derivation,compartments:['team:'+randomUUID()]})).rejects.toMatchObject({code:'context_not_available'})
    await pool.query('UPDATE memories SET scope_held=true WHERE id=$1',[parent.id])
    await expect(f.memory({derivation})).rejects.toThrow('scope_source_changed')
  })
  it.each([false,true])('rejects a foreign derivation workspace when workspaceId is omitted (origin ready=%s)', async ready => {
    const origin=await fixture('departments',ready),target=await fixture('departments')
    const root=await target.memory({compartments:[target.team.compartmentKey]})
    const source=(await pool.query("SELECT read_scope_source($1,'memory',$2) AS source",[target.workspaceId,root.id])).rows[0].source
    await expect(origin.memory({workspaceId:undefined,derivation:{producer:'cross-workspace-test',sources:[source]}})).rejects.toThrow('scope_workspace_mismatch')
    expect((await pool.query('SELECT id FROM memories WHERE workspace_id=$1',[target.workspaceId])).rows).toHaveLength(1)
    expect((await pool.query('SELECT id FROM memories WHERE workspace_id=$1',[origin.workspaceId])).rows).toHaveLength(0)
    expect((await pool.query('SELECT 1 FROM scope_derivations WHERE workspace_id IN($1,$2)',[origin.workspaceId,target.workspaceId])).rows).toHaveLength(0)
  })
  it('admits ready successors with exact primary/private partition and no system author fallback', async () => {
    const f=await fixture()
    await pool.query("UPDATE assistants SET kind='primary' WHERE id=$1",[f.assistantId])
    const old=await f.memory({userId:f.userId})
    const access={userId:f.userId,workspaceId:f.workspaceId,assistantId:f.assistantId,assistantKind:'primary' as const}
    await expect(updateMemory(old.id,{summary:'Unattributed'})).rejects.toMatchObject({code:'context_not_available'})
    const next=await updateMemory(old.id,{summary:'Edited'},access)
    expect(next).toMatchObject({summary:'Edited',userId:f.userId,assistantId:null,createdByUserId:f.userId,compartments:[]})
    expect(next!.id).not.toBe(old.id)
    expect((await pool.query('SELECT superseded_by FROM memories WHERE id=$1',[old.id])).rows[0].superseded_by).toBe(next!.id)
    expect(await updateMemory(old.id,{summary:'Again'},access)).toBeNull()
  })
  it('admits shared successors and rolls back receipt/resource writes in the existing owner transaction', async () => {
    const f=await fixture(),old=await f.memory(),client=await getPool().connect()
    const access={userId:f.userId,workspaceId:f.workspaceId,assistantId:f.assistantId,assistantKind:'standard' as const}
    try {
      await client.query('BEGIN'); await applyRLSGucs(client,f.userId)
      expect(await updateMemory(old.id,{summary:'Successor'},access,client)).toMatchObject({compartments:[f.team.compartmentKey],summary:'Successor'})
      expect((await client.query("SELECT current_setting('app.creation_admission',true) AS receipt,current_setting('app.system_bypass',true) AS bypass")).rows[0]).toMatchObject({receipt:''})
      expect((await client.query("SELECT current_setting('app.system_bypass',true) AS bypass")).rows[0].bypass).not.toBe('true')
    } finally { await rollbackAndRelease(client) }
    expect((await pool.query('SELECT valid_to FROM memories WHERE id=$1',[old.id])).rows[0].valid_to).toBeNull()
    const appClient=await getAppPool().connect()
    try {
      await appClient.query('BEGIN'); await applyRLSGucs(appClient,f.userId)
      expect(await updateMemory(old.id,{summary:'App role'},access,appClient)).toMatchObject({summary:'App role',compartments:[f.team.compartmentKey]})
    } finally { await rollbackAndRelease(appClient) }
    const successor=await updateMemory(old.id,{summary:'Committed'},access)
    expect(successor).toMatchObject({compartments:[f.team.compartmentKey]})
  })
  it('requires predecessor mutation but permits newly inherited live read-grant source floors', async () => {
    const f=await fixture('departments'),member=randomUUID(),request=randomUUID()
    await pool.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)',[member])
    await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role,team_scope_mode) VALUES($1,$2,'member','assigned')",[f.workspaceId,member])
    await createDbWorkspaceGroupStore().addMember(f.userId,f.team.id,member)
    await pool.query(`INSERT INTO workspace_access_requests(id,workspace_id,requester_user_id,beneficiary_kind,beneficiary_id,target_team_id,reason,starts_at,expires_at,payload_hash,policy_revision,status,decided_by,decided_at)
      VALUES($1,$2,$3,'member',$3,$4,'Fixture',now()-interval '1 day',now()+interval '1 day',$5,1,'approved',$6,now())`,[request,f.workspaceId,member,f.other.id,'a'.repeat(64),f.userId])
    await pool.query(`INSERT INTO workspace_access_grants(workspace_id,request_id,beneficiary_kind,beneficiary_id,target_team_id,starts_at,expires_at,approved_by)
      SELECT workspace_id,id,beneficiary_kind,beneficiary_id,target_team_id,starts_at,expires_at,decided_by FROM workspace_access_requests WHERE id=$1`,[request])
    const target=await f.memory({compartments:[f.team.compartmentKey]}),source=await f.memory({compartments:[f.other.compartmentKey]})
    const snapshot=(await pool.query("SELECT read_scope_source($1,'memory',$2) AS source",[f.workspaceId,source.id])).rows[0].source
    const access={userId:member,workspaceId:f.workspaceId,assistantId:f.assistantId,assistantKind:'standard' as const,clearance:'internal' as const,
      compartments:[f.team.compartmentKey!,f.other.compartmentKey!],mutationCompartments:[f.team.compartmentKey!],projectIds:[]}
    const derivation={producer:'successor-test',sources:[snapshot]}
    expect(await updateMemory(source.id,{summary:'Forbidden',derivation},access)).toBeNull()
    const next=await updateMemory(target.id,{summary:'Derived',derivation},access)
    expect(next).toMatchObject({summary:'Derived',createdByUserId:f.userId,compartments:[f.team.compartmentKey!,f.other.compartmentKey!].sort()})
    expect(await updateMemory(next!.id,{summary:'Cannot edit read-only inherited floor'},access)).toBeNull()
    const another=await f.memory({compartments:[f.team.compartmentKey]})
    await pool.query('UPDATE workspace_access_grants SET revoked_at=now(),revoked_by=$2 WHERE request_id=$1',[request,f.userId])
    expect(await updateMemory(another.id,{summary:'Revoked',derivation},access)).toBeNull()
    expect((await pool.query('SELECT valid_to FROM memories WHERE id=$1',[another.id])).rows[0].valid_to).toBeNull()
  })
  it('does not silently rewrite ready reclassification or accept held/stale derivation sources', async () => {
    const f=await fixture('departments')
    await pool.query("UPDATE workspace_members SET clearance='confidential' WHERE workspace_id=$1 AND user_id=$2",[f.workspaceId,f.userId])
    const old=await f.memory({sensitivity:'confidential',compartments:[f.other.compartmentKey]})
    const access={userId:f.userId,workspaceId:f.workspaceId,assistantId:f.assistantId,assistantKind:'standard' as const}
    await expect(updateMemory(old.id,{sensitivity:'internal'},access)).rejects.toMatchObject({code:'access_mode_destination_conflict'})
    await expect(updateMemory(old.id,{compartments:[]},access)).rejects.toMatchObject({code:'access_mode_destination_conflict'})
    expect((await pool.query('SELECT valid_to,sensitivity FROM memories WHERE id=$1',[old.id])).rows[0]).toMatchObject({valid_to:null,sensitivity:'confidential'})
    const snapshot=(await pool.query("SELECT read_scope_source($1,'memory',$2) AS source",[f.workspaceId,old.id])).rows[0].source
    const target=await f.memory({compartments:[]})
    await pool.query('UPDATE memories SET scope_held=true WHERE id=$1',[old.id])
    expect(await updateMemory(old.id,{summary:'Held'},access)).toBeNull()
    await expect(updateMemory(target.id,{derivation:{producer:'stale-successor',sources:[snapshot]}},access)).rejects.toThrow('scope_source_changed')
    expect((await pool.query('SELECT valid_to FROM memories WHERE id=$1',[target.id])).rows[0].valid_to).toBeNull()
  })
  it('fails closed for source identifiers without validated memory evidence', async () => {
    const f=await fixture()
    await expect(f.memory({sourceSessionId:randomUUID()})).rejects.toThrow('scope_evidence_missing')
    await expect(f.memory({sourceEpisodeId:randomUUID()})).rejects.toThrow('scope_evidence_missing')
  })
})

import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import type { PoolClient } from 'pg'
import type { AccessContext } from '@use-brian/core'
import { applyRLSGucs, getAppPool, getPool, rollbackAndRelease } from '../client.js'
import { createMemory, updateMemory, type Memory } from '../memories.js'
import { createDbWorkspaceGroupStore } from '../workspace-group-store.js'
import { runWithAgentAccess } from '../agent-access-context.js'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()
const pool = getPool()
// The fixture creates assurance_app after migrations, unlike production app_user.
await pool.query('GRANT EXECUTE ON FUNCTION hold_memory_successor_descendants(uuid,uuid,bigint) TO assurance_app')
afterAll(async () => { await getAppPool().end(); await pool.end() })

async function fixture() {
  const workspaceId=randomUUID(),owner=randomUUID(),editor=randomUUID(),reader=randomUUID(),assistantId=randomUUID(),projectId=randomUUID()
  for (const id of [owner,editor,reader]) await pool.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)',[id])
  await pool.query("INSERT INTO workspaces(id,name,owner_user_id) VALUES($1,'Successor app fixture',$2)",[workspaceId,owner])
  for (const id of [owner,editor,reader]) await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role,clearance,team_scope_mode) VALUES($1,$2,$3,'confidential','assigned')",[workspaceId,id,id===owner?'owner':'member'])
  await pool.query("INSERT INTO assistants(id,workspace_id,owner_user_id,name,kind) VALUES($1,$2,$3,'Fixture','standard')",[assistantId,workspaceId,owner])
  const groups=createDbWorkspaceGroupStore(),team=await groups.createTeam(owner,workspaceId,{name:'Product',key:'product'})
  await groups.addMember(owner,team.id,editor)
  await pool.query("INSERT INTO workspace_projects(id,workspace_id,name,normalized_name,created_by) VALUES($1,$2,'Project','project',$3)",[projectId,workspaceId,owner])
  for (const id of [editor,reader]) await pool.query('INSERT INTO workspace_project_members(project_id,user_id) VALUES($1,$2)',[projectId,id])
  const request=randomUUID()
  await pool.query(`INSERT INTO workspace_access_requests(id,workspace_id,requester_user_id,beneficiary_kind,beneficiary_id,target_team_id,reason,starts_at,expires_at,payload_hash,policy_revision,status,decided_by,decided_at)
    VALUES($1,$2,$3,'member',$3,$4,'Read fixture',now()-interval '1 day',now()+interval '1 day',$5,1,'approved',$6,now())`,[request,workspaceId,reader,team.id,'a'.repeat(64),owner])
  await pool.query(`INSERT INTO workspace_access_grants(workspace_id,request_id,beneficiary_kind,beneficiary_id,target_team_id,starts_at,expires_at,approved_by)
    SELECT workspace_id,id,beneficiary_kind,beneficiary_id,target_team_id,starts_at,expires_at,decided_by FROM workspace_access_requests WHERE id=$1`,[request])
  await pool.query("UPDATE workspace_access_policies SET setup_state='ready',access_mode='departments',default_department_id=$2 WHERE workspace_id=$1",[workspaceId,team.id])
  const base={workspaceId,assistantId,userId:null,createdByUserId:owner,summary:'Original',sensitivity:'internal' as const,compartments:[team.compartmentKey!],projectIds:[projectId]}
  const root=await createMemory(base)
  const source=async (row:Memory) => (await pool.query("SELECT read_scope_source($1,'memory',$2) AS source",[workspaceId,row.id])).rows[0].source
  const child=await createMemory({...base,summary:'Private derived',derivationTarget:{userId:owner,assistantId:null},derivation:{producer:'app-successor-test',sources:[await source(root)]}})
  const grandchild=await createMemory({...base,userId:owner,summary:'Transitive derived',derivation:{producer:'app-successor-test',sources:[await source(child)]}})
  const access=(userId=editor):AccessContext=>({userId,workspaceId,assistantId,assistantKind:'standard',clearance:'confidential',compartments:[team.compartmentKey!],mutationCompartments:userId===reader?[]:[team.compartmentKey!],projectIds:[projectId]})
  const state=async()=> (await pool.query('SELECT id,scope_held,valid_to,superseded_by FROM memories WHERE id=ANY($1::uuid[]) ORDER BY id',[[root.id,child.id,grandchild.id]])).rows
  const revision=async()=> (await pool.query('SELECT revision::text FROM workspace_access_policies WHERE workspace_id=$1',[workspaceId])).rows[0].revision as string
  return {workspaceId,owner,editor,reader,assistantId,projectId,team,base,root,child,grandchild,access,state,revision}
}
async function appTransaction<T>(actor:string, action:(client:PoolClient)=>Promise<T>, commit=false):Promise<T> {
  const client=await getAppPool().connect()
  try {
    await client.query('BEGIN'); await applyRLSGucs(client,actor)
    const result=await action(client)
    if(commit) await client.query('COMMIT')
    return result
  } finally { await rollbackAndRelease(client) }
}

describe('migration628 authorized app-role memory successor invalidation',()=>{
  it('commits a changed-content successor while holding inaccessible transitive descendants and retaining authorship/Projects',async()=>{
    const f=await fixture(),before=await f.revision()
    const next=await appTransaction(f.editor,async client=>{
      expect((await client.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0]).toEqual({rolsuper:false,rolbypassrls:false})
      expect((await client.query("SELECT has_function_privilege(current_user,'hold_scope_descendants(uuid,text,uuid)','EXECUTE') AS allowed")).rows[0].allowed).toBe(false)
      const row=await updateMemory(f.root.id,{summary:'Actual edit'},f.access(),client)
      expect(row).toMatchObject({summary:'Actual edit',createdByUserId:f.owner,userId:null,assistantId:f.assistantId,projectIds:[f.projectId],compartments:[f.team.compartmentKey]})
      const gucs=(await client.query("SELECT current_setting('app.system_bypass',true) AS bypass,current_setting('app.creation_admission',true) AS receipt")).rows[0]
      expect(gucs.bypass).not.toBe('true');expect(gucs.receipt).toBe('')
      return row!
    },true)
    const rows=await f.state()
    expect(rows.find(r=>r.id===f.root.id)).toMatchObject({scope_held:false,superseded_by:next.id})
    for(const row of rows.filter(r=>r.id!==f.root.id)) expect(row.scope_held).toBe(true)
    expect(BigInt(await f.revision())).toBeGreaterThan(BigInt(before))
  })
  it('rolls back all holds, policy revision, successor and tombstone in the same app transaction',async()=>{
    const f=await fixture(),before=await f.state(),revision=await f.revision()
    const next=await appTransaction(f.editor,client=>updateMemory(f.root.id,{detail:'Rolled back edit'},f.access(),client))
    expect(next).not.toBeNull();expect(await f.state()).toEqual(before);expect(await f.revision()).toBe(revision)
    expect((await pool.query('SELECT id FROM memories WHERE id=$1',[next!.id])).rowCount).toBe(0)
  })
  it('denies a read grantee both at the canonical edit and the direct wrapper without holding descendants',async()=>{
    const f=await fixture(),before=await f.state(),revision=await f.revision()
    expect(await appTransaction(f.reader,client=>updateMemory(f.root.id,{summary:'Forbidden'},f.access(f.reader),client))).toBeNull()
    await expect(appTransaction(f.reader,client=>client.query('SELECT hold_memory_successor_descendants($1,$2,$3)',[f.workspaceId,f.root.id,f.root.scopeVersion]))).rejects.toMatchObject({code:'42501'})
    expect(await f.state()).toEqual(before);expect(await f.revision()).toBe(revision)
  })
  it.each(['private','project','stale','workspace','held','assistant','mutation','clearance','actor'] as const)('direct wrapper fails closed for %s scope',async denial=>{
    const f=await fixture()
    let id=f.root.id,version=f.root.scopeVersion,workspace=f.workspaceId
    if(denial==='private'){id=f.child.id;version=f.child.scopeVersion}
    if(denial==='project') await pool.query('DELETE FROM workspace_project_members WHERE project_id=$1 AND user_id=$2',[f.projectId,f.editor])
    if(denial==='stale') version=String(BigInt(version)+1n)
    if(denial==='workspace') workspace=randomUUID()
    if(denial==='held') await pool.query('UPDATE memories SET scope_held=true WHERE id=$1',[id])
    const before=await f.state(),revision=await f.revision()
    await expect(appTransaction(f.editor,async client=>{
      if(denial==='assistant') await client.query("SELECT set_config('app.agent_visibility_assistants','[]',true)")
      if(denial==='mutation') await client.query("SELECT set_config('app.agent_mutation_compartments','[]',true)")
      if(denial==='clearance') await client.query("SELECT set_config('app.agent_clearance','public',true)")
      if(denial==='actor') await client.query("SELECT set_config('app.agent_actor_id',$1,true)",[f.owner])
      return client.query('SELECT hold_memory_successor_descendants($1,$2,$3)',[workspace,id,version])
    })).rejects.toMatchObject({code:'42501'})
    expect(await f.state()).toEqual(before);expect(await f.revision()).toBe(revision)
  })
  it('rejects a foreign Project on the canonical app-role edit even with a stale client projection',async()=>{
    const f=await fixture(),before=await f.state()
    await pool.query('DELETE FROM workspace_project_members WHERE project_id=$1 AND user_id=$2',[f.projectId,f.editor])
    await expect(appTransaction(f.editor,client=>updateMemory(f.root.id,{summary:'Stale project access'},f.access(),client))).rejects.toMatchObject({code:'42501'})
    expect(await f.state()).toEqual(before)
  })
  it('denies another actor’s private predecessor at the app-role canonical edit',async()=>{
    const f=await fixture(),before=await f.state(),revision=await f.revision()
    expect(await appTransaction(f.editor,client=>updateMemory(f.child.id,{summary:'Private edit'},f.access(),client))).toBeNull()
    expect(await f.state()).toEqual(before);expect(await f.revision()).toBe(revision)
  })
  it('rolls invalidation back when successor admission rejects reclassification',async()=>{
    const f=await fixture(),before=await f.state(),revision=await f.revision()
    await expect(appTransaction(f.editor,client=>updateMemory(f.root.id,{compartments:[]},f.access(),client))).rejects.toMatchObject({code:'access_mode_destination_conflict'})
    expect(await f.state()).toEqual(before);expect(await f.revision()).toBe(revision)
  })
  it('respects ambient mutation ceilings on the app-role canonical edit',async()=>{
    const f=await fixture(),before=await f.state()
    const execution={...f.access(),clearance:'confidential',compartments:[f.team.compartmentKey!],projectIds:[f.projectId],mutationCompartments:[]}
    expect(await runWithAgentAccess(execution,()=>appTransaction(f.editor,client=>updateMemory(f.root.id,{summary:'Read-only turn'},f.access(),client)))).toBeNull()
    expect(await f.state()).toEqual(before)
  })
})

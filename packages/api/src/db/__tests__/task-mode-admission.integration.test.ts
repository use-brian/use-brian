import {randomUUID} from 'node:crypto'
import {afterAll,describe,expect,it,vi} from 'vitest'
import {boundScopeSource,ContextScopeAccumulator,createTaskTools,scopeEvidenceFromRows,type AccessContext,type ToolContext} from '@use-brian/core'
import {applyRLSGucs,getAppPool,getPool,rollbackAndRelease} from '../client.js'
import {runWithAgentAccess} from '../agent-access-context.js'
import {createDbTaskStore} from '../tasks-store.js'
import {createTask,findRecentDuplicateTask} from '../tasks.js'
import {createDbWorkspaceGroupStore} from '../workspace-group-store.js'
import * as lifecycle from '../../task-event-fanout.js'

const {assertLocalFixture}=await import(new URL('../../../../../scripts/crm/local-fixture.mjs',import.meta.url).href)
// This suite asserts the legacy (pre-v2) model, which workspaces.department_read_v2=false still
// serves as the cutover's rollback path (migration 650, decision D22); its workspaces are pinned to it.
await assertLocalFixture()
const pool=getPool()

async function fixture(){
  const workspaceId=randomUUID(),userId=randomUUID(),otherUser=randomUUID(),assistantId=randomUUID(),projectId=randomUUID()
  for(const id of [userId,otherUser])await pool.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)',[id])
  await pool.query("INSERT INTO workspaces(id,name,owner_user_id,department_read_v2) VALUES($1,'Task scope fixture',$2,false)",[workspaceId,userId])
  for(const id of [userId,otherUser])await pool.query('INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,$3)',[workspaceId,id,id===userId?'owner':'member'])
  await pool.query("UPDATE workspace_members SET clearance='confidential' WHERE workspace_id=$1 AND user_id=$2",[workspaceId,userId])
  await pool.query("INSERT INTO assistants(id,workspace_id,owner_user_id,name,kind) VALUES($1,$2,$3,'Task fixture assistant','standard')",[assistantId,workspaceId,userId])
  await pool.query("INSERT INTO workspace_projects(id,workspace_id,name,normalized_name,created_by) VALUES($1,$2,'Fixture','fixture',$3)",[projectId,workspaceId,userId])
  const groups=createDbWorkspaceGroupStore(),team=await groups.createTeam(userId,workspaceId,{name:'Product',key:'product'}),other=await groups.createTeam(userId,workspaceId,{name:'Research',key:'research'})
  const key=team.compartmentKey!,otherKey=other.compartmentKey!
  const onCreate=vi.fn(),onTerminal=vi.fn(),store=createDbTaskStore({onTaskCreate:onCreate,onTaskTerminal:onTerminal})
  const base={userId,workspaceId,title:'Task fixture',compartments:[key],projectIds:[projectId]}
  const create=(patch:Partial<Parameters<typeof store.create>[0]>={})=>store.create({...base,...patch})
  const access:AccessContext={userId,workspaceId,assistantId,assistantKind:'standard',clearance:'confidential',compartments:[key,otherKey],mutationCompartments:[key],projectIds:[projectId],visibilityAssistantIds:[assistantId]}
  const execution=(mutationCompartments:string[]|null=[key])=>({...access,clearance:access.clearance,compartments:access.compartments,mutationCompartments})
  const context:ToolContext={...access,appId:'fixture',sessionId:randomUUID(),channelType:'web',channelId:'fixture',abortSignal:new AbortController().signal,assistantDefaultCompartments:[key],assistantDefaultProjectIds:[projectId]}
  const rows=async()=> (await pool.query('SELECT id,title,sensitivity,compartments,project_ids,user_id,assistant_id,parent_id,valid_to,superseded_by,scope_held FROM tasks WHERE workspace_id=$1 ORDER BY created_at,id',[workspaceId])).rows
  return {workspaceId,userId,otherUser,assistantId,projectId,key,otherKey,team,groups,store,base,create,access,execution,context,onCreate,onTerminal,rows}
}

describe('active-mode task create admission',()=>{
  afterAll(async()=>{await getAppPool().end();await pool.end()})
  async function active(mode='simple') {
    const f=await fixture()
    await pool.query("UPDATE workspace_access_policies SET access_mode=$2,setup_state='ready',default_department_id=$3 WHERE workspace_id=$1",[f.workspaceId,mode,f.team.id])
    const root=(patch:Record<string,unknown>={})=>f.store.create({userId:f.userId,workspaceId:f.workspaceId,title:'Active root',...patch})
    return {...f,root}
  }
  it('defaults before dedup and emits one autopilot callback',async()=>{
    const f=await active(),first=await f.root()
    expect(first.compartments).toEqual([f.key])
    expect((await f.root()).id).toBe(first.id)
    expect(f.onCreate).toHaveBeenCalledTimes(1)
    await expect(f.root({compartments:[]})).rejects.toMatchObject({code:'access_mode_destination_conflict'})
    await expect(f.root({compartments:null})).rejects.toMatchObject({code:'access_mode_destination_conflict'})
    await expect(f.root({expectedPolicyRevision:'0'})).rejects.toMatchObject({code:'access_policy_conflict'})
    expect(await f.rows()).toHaveLength(1)
  })
  it('admits direct and supplied-transaction writers, and guards standalone duplicate lookup',async()=>{
    const f=await active(), params={workspaceId:f.workspaceId,title:'Direct task'}
    const task=await createTask(f.userId,params)
    expect(task.compartments).toEqual([f.key])
    expect((await findRecentDuplicateTask(f.userId,params))?.id).toBe(task.id)
    await expect(findRecentDuplicateTask(f.userId,{...params,compartments:[]})).rejects.toMatchObject({code:'access_mode_destination_conflict'})
    const client=await getAppPool().connect()
    try {
      await client.query('BEGIN')
      await applyRLSGucs(client,f.userId)
      expect((await createTask(f.userId,{...params,title:'Rolled back'},undefined,client)).compartments).toEqual([f.key])
      expect((await client.query("SELECT current_setting('app.system_bypass',true) AS bypass")).rows[0].bypass).not.toBe('true')
    } finally {await rollbackAndRelease(client)}
    expect(await f.rows()).toHaveLength(1)
  })
  it.each(['simple','departments'])('does not mistake assistant-only shared tasks for personal work in %s',async(mode)=>{
    const f=await active(mode),input={visibility:{userId:null,assistantId:f.assistantId}}
    if(mode==='simple')expect((await f.root(input)).compartments).toEqual([f.key])
    else await expect(f.root(input)).rejects.toMatchObject({code:'context_selection_required'})
    expect((await f.root({visibility:{userId:f.userId,assistantId:f.assistantId}})).compartments).toEqual([])
  })
  it('admits a Simple member without policy administrator rights',async()=>{
    const f=await active()
    await f.groups.addMember(f.userId,f.team.id,f.otherUser)
    expect((await f.root({userId:f.otherUser})).compartments).toEqual([f.key])
  })
  it('rejects a hidden or superseded parent before dedup and retains Simple inherited floors',async()=>{
    const f=await fixture()
    const existing=await f.create({compartments:[f.otherKey],sensitivity:'confidential'})
    await pool.query("UPDATE workspace_access_policies SET access_mode='simple',setup_state='ready',default_department_id=$2 WHERE workspace_id=$1",[f.workspaceId,f.team.id])
    const child=()=>f.store.create({userId:f.userId,workspaceId:f.workspaceId,title:'Inherited',parentId:existing.id})
    expect(await child()).toMatchObject({compartments:[f.otherKey],sensitivity:'confidential'})
    await f.store.update(f.userId,existing.id,{title:'New version'})
    await expect(child()).rejects.toMatchObject({code:'context_not_available'})
  })
  it('Departments requires selection; validates labels and preserves explicit General',async()=>{
    const f=await active('departments')
    await expect(f.root()).rejects.toMatchObject({code:'context_selection_required'})
    expect((await f.root({compartments:[]})).compartments).toEqual([])
    expect((await f.root({compartments:[f.otherKey]})).compartments).toEqual([f.otherKey])
    await expect(f.root({compartments:['team:'+randomUUID()]})).rejects.toMatchObject({code:'context_not_available'})
    await pool.query("UPDATE workspace_groups SET status='archived' WHERE id=$1",[f.otherKey.slice(5)])
    await expect(f.root({compartments:[f.otherKey]})).rejects.toMatchObject({code:'context_not_available'})
  })
  it('inherits canonical private parent sensitivity, Teams, Project and ownership',async()=>{
    const f=await active('departments')
    const parent=await f.root({title:'Private parent',sensitivity:'confidential',compartments:[f.otherKey],projectIds:[f.projectId],visibility:{userId:f.userId,assistantId:f.assistantId}})
    const child=await f.root({title:'Child',parentId:parent.id})
    expect(child).toMatchObject({sensitivity:'confidential',compartments:[f.otherKey],projectIds:[f.projectId]})
    expect((await f.rows()).find(r=>r.id===child.id)).toMatchObject({user_id:f.userId,assistant_id:f.assistantId})
    await pool.query('UPDATE tasks SET scope_held=true WHERE id=$1',[parent.id])
    await expect(f.root({title:'Child',parentId:parent.id})).rejects.toMatchObject({code:'context_not_available'})
  })
  it('does not widen an ambient mutation ceiling to the Simple default',async()=>{
    const f=await active()
    await expect(runWithAgentAccess(f.execution([]),()=>f.root())).rejects.toMatchObject({code:'context_not_available'})
    expect(await f.rows()).toHaveLength(0)
    const privateTask=await f.root({visibility:{userId:f.userId,assistantId:null}})
    expect(privateTask.compartments).toEqual([])
  })
  it.each(['project','project_member','assistant','assistant_compartments','assistant_defaults','assistant_project'])('serializes %s authority changes against the admission transaction',async(kind)=>{
    const f=await active()
    await pool.query('INSERT INTO workspace_project_members(project_id,user_id) VALUES($1,$2)',[f.projectId,f.otherUser])
    await pool.query('INSERT INTO assistant_project_grants(assistant_id,project_id) VALUES($1,$2)',[f.assistantId,f.projectId])
    const statement=kind==='project'?"UPDATE workspace_projects SET status='archived' WHERE id=$1":kind==='project_member'?'DELETE FROM workspace_project_members WHERE project_id=$1':kind==='assistant'?"UPDATE assistants SET clearance='public' WHERE id=$1":kind==='assistant_compartments'?"UPDATE assistants SET compartments='{}'::text[] WHERE id=$1":kind==='assistant_defaults'?"UPDATE assistants SET default_compartments='{}'::text[] WHERE id=$1":'DELETE FROM assistant_project_grants WHERE project_id=$1'
    const id=['assistant','assistant_compartments','assistant_defaults'].includes(kind)?f.assistantId:f.projectId
    const writer=await getAppPool().connect(),changer=await pool.connect()
    const revision=(await pool.query('SELECT revision::text FROM workspace_access_policies WHERE workspace_id=$1',[f.workspaceId])).rows[0].revision
    try{
      await writer.query('BEGIN');await applyRLSGucs(writer,f.userId)
      await createTask(f.userId,{workspaceId:f.workspaceId,title:'Concurrent admission',projectIds:[f.projectId]},undefined,writer)
      await changer.query('BEGIN');await changer.query("SET LOCAL lock_timeout='100ms'")
      await expect(changer.query(statement,[id])).rejects.toMatchObject({code:'55P03'})
      await changer.query('ROLLBACK');await writer.query('COMMIT')
    }finally{await rollbackAndRelease(writer);await changer.query('ROLLBACK');changer.release()}
    await pool.query(statement,[id])
    expect(BigInt((await pool.query('SELECT revision::text FROM workspace_access_policies WHERE workspace_id=$1',[f.workspaceId])).rows[0].revision)).toBeGreaterThan(BigInt(revision))
    await expect(f.root({expectedPolicyRevision:revision})).rejects.toMatchObject({code:'access_policy_conflict'})
  })
  it('uses current mutation membership rather than a read grant or a prior duplicate',async()=>{
    const f=await active('departments')
    await pool.query("UPDATE workspace_members SET team_scope_mode='assigned' WHERE workspace_id=$1 AND user_id=$2",[f.workspaceId,f.otherUser])
    await f.groups.addMember(f.userId,f.team.id,f.otherUser)
    const create=()=>f.root({userId:f.otherUser,compartments:[f.key]})
    await create()
    await pool.query('DELETE FROM workspace_group_members WHERE group_id=$1 AND user_id=$2',[f.team.id,f.otherUser])
    await expect(create()).rejects.toMatchObject({code:'context_not_available'})
    expect(await f.rows()).toHaveLength(1)
  })
})

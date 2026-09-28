import {randomUUID} from 'node:crypto'
import {afterAll,describe,expect,it,vi} from 'vitest'
import {boundScopeSource,ContextScopeAccumulator,createTaskTools,scopeEvidenceFromRows,type AccessContext,type ToolContext} from '@use-brian/core'
import {getAppPool,getPool} from '../client.js'
import {runWithAgentAccess} from '../agent-access-context.js'
import {createDbTaskStore} from '../tasks-store.js'
import {getTaskByIdSystem,getTaskHistory} from '../tasks.js'
import {createDbWorkspaceGroupStore} from '../workspace-group-store.js'
import * as lifecycle from '../../task-event-fanout.js'

const {assertLocalFixture}=await import(new URL('../../../../../scripts/crm/local-fixture.mjs',import.meta.url).href)
await assertLocalFixture()
const pool=getPool()

async function fixture(){
  const workspaceId=randomUUID(),userId=randomUUID(),otherUser=randomUUID(),assistantId=randomUUID(),projectId=randomUUID()
  for(const id of [userId,otherUser])await pool.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)',[id])
  await pool.query("INSERT INTO workspaces(id,name,owner_user_id) VALUES($1,'Task scope fixture',$2)",[workspaceId,userId])
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

describe('[COMP:api/task-mutation-scope] canonical task publication and reader evidence',()=>{
  afterAll(async()=>{await getAppPool().end();await pool.end()})
  it('checks live Team membership for edits and no-op reads with no assistant envelope',async()=>{
    const f=await fixture(),task=await f.create()
    await pool.query("UPDATE workspace_members SET team_scope_mode='assigned' WHERE workspace_id=$1 AND user_id=$2",[f.workspaceId,f.otherUser])
    expect(await f.store.update(f.otherUser,task.id,{title:'Denied'})).toBeNull()
    expect(await f.store.update(f.otherUser,task.id,{})).toBeNull()
    expect(await f.rows()).toHaveLength(1)
    await f.groups.addMember(f.userId,f.team.id,f.otherUser)
    expect(await f.store.update(f.otherUser,task.id,{title:'Authorized'})).toMatchObject({title:'Authorized'})
  })
  it('does not let task creation or recent deduplication reuse revoked membership',async()=>{
    const f=await fixture()
    await pool.query("UPDATE workspace_members SET team_scope_mode='assigned' WHERE workspace_id=$1 AND user_id=$2",[f.workspaceId,f.otherUser])
    const create=()=>f.store.create({...f.base,userId:f.otherUser})
    await expect(create()).rejects.toMatchObject({code:'scope_operation_denied'})
    expect(await f.rows()).toHaveLength(0)
    await f.groups.addMember(f.userId,f.team.id,f.otherUser)
    const task=await create()
    expect((await create()).id).toBe(task.id)
    await pool.query('DELETE FROM workspace_group_members WHERE group_id=$1 AND user_id=$2',[f.team.id,f.otherUser])
    f.onCreate.mockClear()
    await expect(create()).rejects.toMatchObject({code:'scope_operation_denied'})
    expect(f.onCreate).not.toHaveBeenCalled()
    expect(await f.rows()).toHaveLength(1)
    expect(await f.store.create({...f.base,userId:f.otherUser,title:'General allowed',compartments:[]})).toMatchObject({compartments:[]})
  })
  it.each(['explicit','ambient'])('intersects a stale %s task envelope with current member Teams',async mode=>{
    const f=await fixture(),task=await f.create()
    await pool.query("UPDATE workspace_members SET team_scope_mode='assigned' WHERE workspace_id=$1 AND user_id=$2",[f.workspaceId,f.otherUser])
    const stale={...f.access,userId:f.otherUser},edit=()=>f.store.update(f.otherUser,task.id,{title:'Denied'},mode==='explicit'?{access:stale}:undefined)
    expect(await (mode==='explicit'?edit():runWithAgentAccess({...f.execution(),userId:f.otherUser},edit))).toBeNull()
    expect((await f.rows())[0]).toMatchObject({title:'Task fixture',valid_to:null})
  })
  it.each(['explicit','ambient','none'])('checks current member clearance on task edits with %s authority',async mode=>{
    const f=await fixture(),task=await f.create({sensitivity:'confidential'})
    await pool.query("UPDATE workspace_members SET team_scope_mode='assigned',clearance='internal' WHERE workspace_id=$1 AND user_id=$2",[f.workspaceId,f.otherUser])
    await f.groups.addMember(f.userId,f.team.id,f.otherUser)
    const stale={...f.access,userId:f.otherUser},edit=()=>f.store.update(f.otherUser,task.id,{title:'Denied'},mode==='explicit'?{access:stale}:undefined)
    expect(await (mode==='ambient'?runWithAgentAccess({...f.execution(),userId:f.otherUser},edit):edit())).toBeNull()
    expect(await f.store.update(f.otherUser,task.id,{})).toBeNull()
    expect((await f.rows())[0]).toMatchObject({valid_to:null,superseded_by:null})
  })
  it('checks inherited destination Teams against current membership before retiring the source',async()=>{
    const f=await fixture(),task=await f.create()
    await pool.query("UPDATE workspace_members SET team_scope_mode='assigned' WHERE workspace_id=$1 AND user_id=$2",[f.workspaceId,f.otherUser])
    await f.groups.addMember(f.userId,f.team.id,f.otherUser)
    const events=vi.spyOn(lifecycle,'publishTaskLifecycle')
    try {
      await expect(f.store.update(f.otherUser,task.id,{title:'Denied'},{scope:{compartments:[f.otherKey],projectIds:[]}})).rejects.toMatchObject({code:'scope_operation_denied'})
      expect(events).not.toHaveBeenCalled()
    } finally {events.mockRestore()}
    expect(await f.rows()).toHaveLength(1)
    expect((await f.rows())[0]).toMatchObject({valid_to:null,superseded_by:null})
  })
  it('rolls back a human-only edit when a child belongs to another Team',async()=>{
    const f=await fixture(),parent=await f.create(),child=await f.create({title:'Child',parentId:parent.id,compartments:[f.otherKey]})
    await pool.query("UPDATE workspace_members SET team_scope_mode='assigned' WHERE workspace_id=$1 AND user_id=$2",[f.workspaceId,f.otherUser])
    await f.groups.addMember(f.userId,f.team.id,f.otherUser)
    await expect(f.store.update(f.otherUser,parent.id,{title:'Denied'})).rejects.toThrow('task_reference_conflict')
    expect(await f.rows()).toHaveLength(2)
    expect((await f.rows()).find(row=>row.id===parent.id)).toMatchObject({valid_to:null,superseded_by:null})
    expect((await f.rows()).find(row=>row.id===child.id)).toMatchObject({parent_id:parent.id})
  })
  it.each(['ambient','explicit'])('permits read-only lookup but refuses task mutation through %s authority',async(mode)=>{
    const f=await fixture(),task=await f.create(),readOnly={...f.access,mutationCompartments:[]}
    const edit=()=>f.store.update(f.userId,task.id,{title:'Refused'},mode==='explicit'?{access:readOnly}:undefined)
    expect(await (mode==='explicit'?edit():runWithAgentAccess(f.execution([]),edit))).toBeNull()
    expect(await f.store.getById(readOnly,task.id)).toMatchObject({id:task.id})
    expect(await f.store.update(f.userId,task.id,{}, {access:readOnly})).toMatchObject({id:task.id})
    expect((await f.rows()).map(row=>row.title)).toEqual(['Task fixture'])
  })
  it('does not let a duplicate bypass create mutation authority',async()=>{
    const f=await fixture();await f.create();f.onCreate.mockClear()
    await expect(runWithAgentAccess(f.execution([]),()=>f.create())).rejects.toMatchObject({code:'scope_operation_denied'})
    expect(await f.rows()).toHaveLength(1);expect(f.onCreate).not.toHaveBeenCalled()
  })
  it('does not let a recent duplicate bypass an archived Project',async()=>{
    const f=await fixture();await f.create();f.onCreate.mockClear()
    await pool.query("UPDATE workspace_projects SET status='archived' WHERE id=$1",[f.projectId])
    await expect(f.create()).rejects.toThrow('context_not_available: project')
    expect(await f.rows()).toHaveLength(1);expect(f.onCreate).not.toHaveBeenCalled()
  })
  it('does not collapse scoped, differently classified or different-content creates into a General task',async()=>{
    const f=await fixture(),general=await f.create({compartments:[],projectIds:[]}),scoped=await f.create()
    const classified=await f.create({sensitivity:'confidential'}),changed=await f.create({attributes:{description:'Different body'}})
    const personal=await f.create({visibility:{userId:f.userId,assistantId:f.assistantId}})
    expect(new Set([general,scoped,classified,changed,personal].map(row=>row.id)).size).toBe(5)
    expect((await f.create()).id).toBe(scoped.id)
    expect(f.onCreate).toHaveBeenCalledTimes(5)
  })
  it('does not discard changed assignment, due date, tags, external reference or source provenance',async()=>{
    const f=await fixture(),first=await f.create()
    const member=(await pool.query('SELECT id FROM workspace_members WHERE workspace_id=$1 AND user_id=$2',[f.workspaceId,f.userId])).rows[0].id
    for(const patch of [{assigneeId:member},{due:new Date('2031-04-01T00:00:00Z')},{tags:['important']},{externalRef:{provider:'fixture',id:'task-1'}},{sourceSessionId:randomUUID()},{source:'extracted' as const}]){
      expect((await f.create(patch)).id).not.toBe(first.id)
    }
  })
  it('preserves the complete known source floor when the actual task tool creates and updates',async()=>{
    const f=await fixture(),source=await f.create({title:'Source fixture',sensitivity:'confidential',visibility:{userId:f.userId,assistantId:f.assistantId}})
    const accumulator=new ContextScopeAccumulator(scopeEvidenceFromRows([source]))
    const context={...f.context,scopeAccumulator:accumulator}
    const tools=createTaskTools(f.store)
    const saved=await runWithAgentAccess(f.execution(),()=>tools.saveTask.execute({title:'New scoped task'},context))
    expect(saved.isError).not.toBe(true)
    const row=(await f.rows()).find(row=>row.title==='New scoped task')!
    expect(row).toMatchObject({sensitivity:'confidential',user_id:f.userId,assistant_id:f.assistantId,compartments:[f.key],project_ids:[f.projectId]})
    const general=await f.create({title:'General fixture',compartments:[],projectIds:[]})
    const updated=await runWithAgentAccess(f.execution(),()=>tools.updateTask.execute({id:general.id,title:'Protected successor'},context))
    expect(updated.isError).not.toBe(true)
    expect((await f.rows()).find(row=>row.title==='Protected successor')).toMatchObject({sensitivity:'confidential',user_id:f.userId,assistant_id:f.assistantId,compartments:[f.key],project_ids:[f.projectId]})
    expect(updated.scopeEvidence?.sources?.[0].resourceKind).toBe('task')
  })
  it('retains stronger source labels and refuses incompatible inherited visibility or destination scope',async()=>{
    const f=await fixture(),task=await f.create({sensitivity:'confidential',visibility:{userId:f.userId,assistantId:f.assistantId}})
    const scope={sensitivity:'public' as const,compartments:[],projectIds:[],visibility:{userId:null,assistantId:null}}
    const updated=await f.store.update(f.userId,task.id,{title:'Retained'},{scope,access:f.access})
    expect(updated).toMatchObject({sensitivity:'confidential',compartments:[f.key],projectIds:[f.projectId]})
    await expect(f.store.update(f.userId,updated!.id,{title:'Denied'},{scope:{...scope,visibility:{userId:f.otherUser,assistantId:null}},access:f.access})).rejects.toMatchObject({code:'scope_visibility_incompatible'})
    await expect(f.store.update(f.userId,updated!.id,{title:'Denied'},{scope:{...scope,compartments:[f.otherKey]},access:f.access})).rejects.toMatchObject({code:'scope_operation_denied'})
  })
  it('binds full, compact, resolved and history reader results without serializing private source metadata',async()=>{
    const f=await fixture(),task=await f.create({visibility:{userId:f.userId,assistantId:f.assistantId}})
    const expected=boundScopeSource(task)!
    const results=[await f.store.getById(f.access,task.id),...(await f.store.list(f.access,{})),await f.store.resolveById!(f.access,task.id),...(await getTaskHistory(f.access,task.id))]
    for(const row of results){if(!row)throw new Error('Expected readable fixture task');expect(boundScopeSource(row)).toEqual(expected);expect(JSON.stringify(row)).not.toContain('scopeVersion');expect(JSON.stringify(row)).not.toContain(f.assistantId)}
  })
  it('checks each historical version and excludes held bodies from system reads',async()=>{
    const f=await fixture(),task=await f.create(),next=await f.store.update(f.userId,task.id,{title:'Restricted version'},{scope:{sensitivity:'confidential',compartments:[],projectIds:[]}})
    const low={...f.access,clearance:'internal' as const}
    expect((await getTaskHistory(low,task.id)).map(row=>row.title)).toEqual(['Task fixture'])
    expect(await f.store.getById(low,next!.id)).toBeNull()
    await pool.query('UPDATE tasks SET scope_held=true WHERE id=$1',[next!.id])
    expect(await getTaskByIdSystem(next!.id)).toBeNull()
    expect(await f.store.list({...f.access,systemRead:true},{})).toEqual([])
  })
  it('rejects a different execution actor and does not borrow a reconstructed broader context',async()=>{
    const f=await fixture(),task=await f.create()
    await expect(runWithAgentAccess(f.execution(),()=>f.store.update(f.otherUser,task.id,{title:'Wrong author'}))).rejects.toMatchObject({code:'scope_operation_denied'})
    expect(await runWithAgentAccess(f.execution([]),()=>f.store.update(f.userId,task.id,{title:'Broad context'},{access:{...f.access,compartments:null,mutationCompartments:null}}))).toBeNull()
  })
  it('serializes concurrent edits without orphaning a live successor',async()=>{
    const f=await fixture(),task=await f.create()
    const results=await Promise.all([f.store.update(f.userId,task.id,{title:'First'}),f.store.update(f.userId,task.id,{title:'Second'})])
    expect(results.filter(Boolean).length).toBeGreaterThanOrEqual(1)
    const rows=await f.rows(),live=rows.filter(row=>row.valid_to===null)
    expect(live).toHaveLength(1)
    expect((await f.store.resolveById!(f.access,task.id))!.id).toBe(live[0].id)
    for(const row of rows.filter(row=>row.valid_to!==null))expect(rows.some(next=>next.id===row.superseded_by)).toBe(true)
  })
  it.each(['department','private'])('rolls back the successor when a %s child cannot be repointed',async(kind)=>{
    const f=await fixture(),parent=await f.create(),child=await f.create({title:'Child fixture',parentId:parent.id,compartments:kind==='department'?[f.otherKey]:[f.key]})
    if(kind==='private')await pool.query('UPDATE tasks SET user_id=$2 WHERE id=$1',[child.id,f.otherUser])
    const events=vi.spyOn(lifecycle,'publishTaskLifecycle')
    try{
      await expect(runWithAgentAccess(f.execution(),()=>f.store.update(f.userId,parent.id,{title:'Refused'}))).rejects.toThrow('task_reference_conflict')
      const result=await runWithAgentAccess(f.execution(),()=>createTaskTools(f.store).updateTask.execute({id:parent.id,title:'Refused'},f.context))
      expect(result).toMatchObject({isError:true,data:expect.stringContaining('Nothing was saved. Refresh the task and review your access')})
      expect(JSON.stringify(result)).not.toContain(child.id)
      expect(JSON.stringify(result)).not.toContain('Child fixture')
      expect(events).not.toHaveBeenCalled()
    }
    finally{events.mockRestore()}
    expect(await f.rows()).toHaveLength(2)
    expect((await f.rows()).find(row=>row.id===parent.id)).toMatchObject({valid_to:null,superseded_by:null,title:'Task fixture'})
    expect((await f.rows()).find(row=>row.id===child.id)?.parent_id).toBe(parent.id)
  })
  it('repoints authorized children and retains ordinary terminal updates',async()=>{
    const f=await fixture(),parent=await f.create(),child=await f.create({title:'Child fixture',parentId:parent.id})
    const updated=await runWithAgentAccess(f.execution(),()=>f.store.update(f.userId,parent.id,{status:'done'}))
    expect(updated).toMatchObject({status:'done'})
    expect((await f.rows()).find(row=>row.id===child.id)?.parent_id).toBe(updated!.id)
  })
  it('repoints a hosted goal and refuses a transaction that leaves its old host retired',async()=>{
    const f=await fixture(),parent=await f.create()
    const goal=(await pool.query("INSERT INTO goals(workspace_id,host_type,host_id,outcome,done_when,created_by_user_id) VALUES($1,'task',$2,'Fixture outcome','{}',$3) RETURNING id",[f.workspaceId,parent.id,f.userId])).rows[0].id
    const updated=await f.store.update(f.userId,parent.id,{title:'New host'})
    expect((await pool.query('SELECT host_id FROM goals WHERE id=$1',[goal])).rows[0].host_id).toBe(updated!.id)
    const successor=await f.create({title:'Separate fixture'}),client=await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query('UPDATE tasks SET valid_to=now(),superseded_by=$2 WHERE id=$1',[updated!.id,successor.id])
      await expect(client.query('COMMIT')).rejects.toThrow('task_reference_conflict')
      await client.query('ROLLBACK')
    } finally {client.release()}
    expect((await f.rows()).find(row=>row.id===updated!.id)?.valid_to).toBeNull()
    expect((await pool.query('SELECT host_id FROM goals WHERE id=$1',[goal])).rows[0].host_id).toBe(updated!.id)
  })
})

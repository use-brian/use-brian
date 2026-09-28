import {randomUUID} from 'node:crypto'
import {afterAll,describe,expect,it} from 'vitest'
import {createTaskGuardrailTools,type AccessContext,type ToolContext} from '@use-brian/core'
import {getAppPool,getPool,queryWithRLS} from '../client.js'
import {runWithAgentAccess} from '../agent-access-context.js'
import {createDbWorkspaceGroupStore} from '../workspace-group-store.js'
import {deleteBrainInboxRow,deleteBrainInboxTasks,primitiveToTable,verifyBrainInboxRow,type BrainInboxPrimitive} from '../brain-inbox-store.js'
import {rejectTask} from '../task-admission-store.js'
import {verifyMemoryDecision} from '../memory-verifications-store.js'
import {createMemory} from '../memories.js'

const {assertLocalFixture}=await import(new URL('../../../../../scripts/crm/local-fixture.mjs',import.meta.url).href)
await assertLocalFixture()
const pool=getPool()

async function fixture(){
  const workspaceId=randomUUID(),userId=randomUUID(),member=randomUUID(),assistantId=randomUUID(),projectId=randomUUID()
  for(const id of [userId,member])await pool.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)',[id])
  await pool.query("INSERT INTO workspaces(id,name,owner_user_id) VALUES($1,'Mutation fixture',$2)",[workspaceId,userId])
  for(const id of [userId,member])await pool.query('INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,$3)',[workspaceId,id,id===userId?'owner':'member'])
  await pool.query("INSERT INTO assistants(id,name,workspace_id,owner_user_id,kind) VALUES($1,'Fixture assistant',$2,$3,'standard')",[assistantId,workspaceId,userId])
  await pool.query("INSERT INTO workspace_projects(id,workspace_id,name,normalized_name,created_by) VALUES($1,$2,'Fixture','fixture',$3)",[projectId,workspaceId,userId])
  const groups=createDbWorkspaceGroupStore(),team=await groups.createTeam(userId,workspaceId,{name:'Product',key:'product'})
  const key=team.compartmentKey!
  const access:AccessContext={userId,workspaceId,assistantId,assistantKind:'standard',clearance:'confidential',compartments:[key],mutationCompartments:[key],projectIds:[projectId],visibilityAssistantIds:[assistantId]}
  const execution=(mutationCompartments:string[]|null=[key])=>({...access,clearance:access.clearance,compartments:access.compartments,mutationCompartments})
  async function create(primitive:BrainInboxPrimitive='task'){
    let id:string=randomUUID()
    const table=primitiveToTable(primitive)
    if(table==='tasks')await pool.query("INSERT INTO tasks(id,workspace_id,title,created_by_user_id) VALUES($1,$2,'Fixture task',$3)",[id,workspaceId,userId])
    else if(table==='entities')await pool.query("INSERT INTO entities(id,workspace_id,kind,display_name,source,created_by_user_id) VALUES($1,$2,'person','Fixture entity','user',$3)",[id,workspaceId,userId])
    else if(table==='memories')id=(await createMemory({workspaceId,userId:null,assistantId,createdByUserId:userId,scope:'workspace',summary:'Fixture memory',sensitivity:'internal',compartments:[key],projectIds:[projectId]})).id
    else if(table==='workspace_files')await pool.query("INSERT INTO workspace_files(id,workspace_id,path,name,storage_uri,created_by_user_id) VALUES($1,$2,$3,'fixture.txt','gs://fixture/file',$4)",[id,workspaceId,`/${id}.txt`,userId])
    else await pool.query("INSERT INTO entity_links(id,workspace_id,source_kind,source_id,target_kind,target_id,edge_type,source,assistant_id) VALUES($1,$2,'entity',$3,'entity',$4,'mentioned','user',$5)",[id,workspaceId,await create('entity'),await create('entity'),assistantId])
    await pool.query(`UPDATE ${table} SET compartments=$2,project_ids=$3 WHERE id=$1`,[id,[key],[projectId]])
    return id
  }
  const row=async(primitive:BrainInboxPrimitive,id:string)=>(await pool.query(`SELECT valid_to,verified_by_user_id FROM ${primitiveToTable(primitive)} WHERE id=$1`,[id])).rows[0]
  const evidence=async()=>{
    const counts=[]
    for(const table of ['brain_verifications','memory_verifications','decision_events','task_tombstones','task_rules'])counts.push(Number((await pool.query(`SELECT count(*) AS n FROM ${table} WHERE workspace_id=$1`,[workspaceId])).rows[0].n))
    return counts
  }
  const remove=(primitive:BrainInboxPrimitive,id:string,ctx=access)=>deleteBrainInboxRow({primitive,rowId:id,workspaceId,deletedByUserId:userId,access:ctx})
  const verify=(primitive:BrainInboxPrimitive,id:string,ctx=access)=>verifyBrainInboxRow({primitive,rowId:id,workspaceId,verifiedByUserId:userId,access:ctx})
  return {workspaceId,userId,member,assistantId,projectId,key,team,groups,access,execution,create,row,evidence,remove,verify}
}

describe('[COMP:api/brain-mutation-scope] canonical verification, deletion and rejection',()=>{
  afterAll(async()=>{await getAppPool().end();await pool.end()})
  const primitives:BrainInboxPrimitive[]=['memory','entity','entity_link','task','contact','company','deal','workspace_file']
  it.each(primitives)('refuses read-only verification and deletion of %s through explicit or execution ceilings',async primitive=>{
    const f=await fixture(),id=await f.create(primitive),readOnly={...f.access,mutationCompartments:[]}
    expect(await f.verify(primitive,id,readOnly)).toEqual({status:'not_found',stamped:false})
    expect(await f.remove(primitive,id,readOnly)).toEqual({status:'not_found'})
    await runWithAgentAccess(f.execution([]),async()=>{
      expect(await f.verify(primitive,id)).toEqual({status:'not_found',stamped:false})
      expect(await f.remove(primitive,id)).toEqual({status:'not_found'})
    })
    expect(await f.row(primitive,id)).toEqual({valid_to:null,verified_by_user_id:null})
    expect(await f.evidence()).toEqual([0,0,0,0,0])
  })
  it.each(primitives)('commits authorized %s verification and deletion with their evidence',async primitive=>{
    const f=await fixture(),id=await f.create(primitive)
    expect(await f.verify(primitive,id)).toEqual({status:'verified',stamped:true})
    expect(await f.verify(primitive,id)).toEqual({status:'already_verified',stamped:false})
    expect(await f.remove(primitive,id)).toEqual({status:'deleted'})
    expect((await f.row(primitive,id)).valid_to).toBeInstanceOf(Date)
    expect(await f.evidence()).toEqual(primitive==='memory'?[0,2,2,0,0]:[2,0,2,0,0])
  })
  it.each(['held','retracted','retired','private','assistant','project','clearance'])('withholds a %s task from all mutation paths without evidence',async kind=>{
    const f=await fixture(),id=await f.create()
    const updates:Record<string,string>={held:'scope_held=true',retracted:'retracted_at=now()',retired:'valid_to=now()',private:`user_id='${f.member}'`,assistant:`assistant_id=NULL`,project:'project_ids=ARRAY[]::uuid[]',clearance:"sensitivity='confidential'"}
    await pool.query(`UPDATE tasks SET ${updates[kind]} WHERE id=$1`,[id])
    let ctx=f.access
    if(kind==='assistant'){
      await pool.query('UPDATE tasks SET assistant_id=$2 WHERE id=$1',[id,f.assistantId]);ctx={...ctx,visibilityAssistantIds:[]}
    }
    if(kind==='project'){
      await pool.query('UPDATE tasks SET project_ids=$2 WHERE id=$1',[id,[f.projectId]]);ctx={...ctx,projectIds:[]}
    }
    if(kind==='clearance')ctx={...ctx,clearance:'internal'}
    expect(await f.verify('task',id,ctx)).toMatchObject({status:'not_found'})
    expect(await f.remove('task',id,ctx)).toEqual({status:'not_found'})
    expect(await deleteBrainInboxTasks({taskIds:[id],workspaceId:f.workspaceId,deletedByUserId:f.userId,access:ctx})).toEqual([])
    expect(await rejectTask({workspaceId:f.workspaceId,userId:f.userId,taskId:id,reason:'Fixture rejection',access:ctx})).toBeNull()
    expect(await f.evidence()).toEqual([0,0,0,0,0])
  })
  it('enforces real member RLS even without an explicit assistant ceiling',async()=>{
    const f=await fixture(),id=await f.create()
    await pool.query("UPDATE workspace_members SET team_scope_mode='assigned' WHERE workspace_id=$1 AND user_id=$2",[f.workspaceId,f.member])
    const remove=()=>deleteBrainInboxRow({primitive:'task',rowId:id,workspaceId:f.workspaceId,deletedByUserId:f.member})
    expect(await remove()).toEqual({status:'not_found'})
    await f.groups.addMember(f.userId,f.team.id,f.member)
    expect(await remove()).toEqual({status:'deleted'})
  })
  it('returns the same result for absent and foreign records and refuses actor substitution',async()=>{
    const f=await fixture(),other=await fixture(),foreign=await other.create()
    for(const id of [foreign,randomUUID()]){
      expect(await f.remove('task',id)).toEqual({status:'not_found'})
      expect(await f.verify('task',id)).toEqual({status:'not_found',stamped:false})
    }
    const id=await f.create()
    await expect(f.remove('task',id,{...f.access,userId:f.member})).rejects.toMatchObject({code:'scope_operation_denied'})
    await expect(runWithAgentAccess({...f.execution(),userId:f.member},()=>f.remove('task',id))).rejects.toMatchObject({code:'scope_operation_denied'})
    expect(await f.evidence()).toEqual([0,0,0,0,0])
  })
  it('bulk-deletes only authorized tasks and retires only their hosted goals',async()=>{
    const f=await fixture(),allowed=await f.create(),hidden=await f.create()
    await pool.query('UPDATE tasks SET user_id=$2 WHERE id=$1',[hidden,f.member])
    for(const id of [allowed,hidden])await pool.query("INSERT INTO goals(workspace_id,host_type,host_id,outcome,done_when,created_by_user_id) VALUES($1,'task',$2,'Fixture outcome','{}',$3)",[f.workspaceId,id,f.userId])
    expect(await deleteBrainInboxTasks({taskIds:[allowed,hidden,randomUUID()],workspaceId:f.workspaceId,deletedByUserId:f.userId,access:f.access})).toEqual([allowed])
    const goals=(await pool.query('SELECT host_id,status FROM goals WHERE workspace_id=$1',[f.workspaceId])).rows
    expect(goals.find(row=>row.host_id===allowed).status).toBe('abandoned')
    expect(goals.find(row=>row.host_id===hidden).status).toBe('active')
    expect(await f.evidence()).toEqual([1,0,1,0,0])
  })
  it('serializes competing confirmations so only one stamps and journals',async()=>{
    const f=await fixture(),id=await f.create()
    const results=await Promise.all([f.verify('task',id),f.verify('task',id)])
    expect(results.filter(row=>row.stamped)).toHaveLength(1)
    expect(await f.evidence()).toEqual([1,0,1,0,0])
  })
  it('enforces mutation ceilings and current membership through assistant memory confirmation',async()=>{
    const f=await fixture(),id=await f.create('memory')
    const confirm=(access:AccessContext|undefined=f.access,verifiedBy=f.userId)=>verifyMemoryDecision({memoryId:id,workspaceId:f.workspaceId,verifiedBy,access})
    expect(await confirm({...f.access,mutationCompartments:[]})).toEqual({status:'not_found',stamped:false})
    expect(await runWithAgentAccess(f.execution([]),()=>confirm())).toEqual({status:'not_found',stamped:false})
    await pool.query("UPDATE workspace_members SET team_scope_mode='assigned' WHERE workspace_id=$1 AND user_id=$2",[f.workspaceId,f.member])
    expect(await verifyMemoryDecision({memoryId:id,workspaceId:f.workspaceId,verifiedBy:f.member})).toEqual({status:'not_found',stamped:false})
    expect(await f.evidence()).toEqual([0,0,0,0,0])
    await f.groups.addMember(f.userId,f.team.id,f.member)
    expect(await verifyMemoryDecision({memoryId:id,workspaceId:f.workspaceId,verifiedBy:f.member})).toEqual({status:'verified',stamped:true})
    expect(await confirm()).toEqual({status:'already_verified',stamped:false})
    expect(await f.evidence()).toEqual([0,1,1,0,0])
  })
  it.each(['held','retired','retracted','private'])('refuses an unavailable %s memory in assistant confirmation',async kind=>{
    const f=await fixture(),id=await f.create('memory')
    const updates:Record<string,string>={held:'scope_held=true',retired:'valid_to=now()',retracted:'retracted_at=now()',private:`user_id='${f.member}'`}
    await pool.query(`UPDATE memories SET ${updates[kind]} WHERE id=$1`,[id])
    expect(await verifyMemoryDecision({memoryId:id,workspaceId:f.workspaceId,verifiedBy:f.userId,access:f.access})).toEqual({status:'not_found',stamped:false})
    expect(await f.evidence()).toEqual([0,0,0,0,0])
  })
  it('rolls back source, goal and audit changes when the journal refuses a delete',async()=>{
    const f=await fixture(),id=await f.create()
    await pool.query("INSERT INTO goals(workspace_id,host_type,host_id,outcome,done_when,created_by_user_id) VALUES($1,'task',$2,'Fixture outcome','{}',$3)",[f.workspaceId,id,f.userId])
    const name=`fixture_journal_${randomUUID().replaceAll('-','')}`
    await pool.query(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.workspace_id='${f.workspaceId}'::uuid THEN RAISE EXCEPTION 'fixture journal refusal'; END IF; RETURN NEW; END $$`)
    await pool.query(`CREATE TRIGGER ${name} BEFORE INSERT ON decision_events FOR EACH ROW EXECUTE FUNCTION ${name}()`)
    try {await expect(f.remove('task',id)).rejects.toThrow('fixture journal refusal')}
    finally {await pool.query(`DROP TRIGGER ${name} ON decision_events`);await pool.query(`DROP FUNCTION ${name}()`)}
    expect(await f.row('task',id)).toEqual({valid_to:null,verified_by_user_id:null})
    expect((await pool.query('SELECT status FROM goals WHERE workspace_id=$1 AND host_id=$2',[f.workspaceId,id])).rows).toEqual([{status:'active'}])
    expect(await f.evidence()).toEqual([0,0,0,0,0])
  })
  it('carries the rejection tool ceiling and never writes evidence for read-only reach',async()=>{
    const f=await fixture(),id=await f.create()
    const tools=createTaskGuardrailTools({rejectTask} as Parameters<typeof createTaskGuardrailTools>[0])
    const ctx:ToolContext={...f.access,mutationCompartments:[],appId:'fixture',sessionId:randomUUID(),channelType:'web',channelId:'fixture',abortSignal:new AbortController().signal}
    const result=await tools.rejectTask.execute({id,reason:'Fixture rejection'},ctx)
    expect(result).toMatchObject({isError:true,data:expect.stringContaining('no tombstone was written')})
    expect(await f.evidence()).toEqual([0,0,0,0,0])
    const accepted=await rejectTask({workspaceId:f.workspaceId,userId:f.userId,taskId:id,reason:'Fixture rejection',createRule:true,access:f.access})
    expect(accepted?.activeRuleId).toBeTruthy()
    expect(await f.evidence()).toEqual([0,0,1,1,1])
  })
  it.each(['memory','task'] as const)('captures immutable %s audit scope and protects its journal projection',async primitive=>{
    const f=await fixture(),id=await f.create(primitive),table=primitive==='memory'?'memory_verifications':'brain_verifications'
    await f.verify(primitive,id)
    const audit=(await pool.query(`SELECT id,source_scope FROM ${table} WHERE workspace_id=$1`,[f.workspaceId])).rows[0]
    expect(audit.source_scope).toMatchObject({workspaceId:f.workspaceId,resourceId:id,resourceKind:primitive,compartments:[f.key],projectIds:[f.projectId]})
    await expect(pool.query(`UPDATE ${table} SET source_scope='{}' WHERE id=$1`,[audit.id])).rejects.toThrow('verification_scope_immutable')
    await expect(pool.query(`UPDATE ${table} SET workspace_id=$2 WHERE id=$1`,[audit.id,randomUUID()])).rejects.toThrow('verification_scope_immutable')
    await expect(pool.query(`UPDATE ${table} SET ${primitive==='memory'?'memory_id':'target_id'}=$2 WHERE id=$1`,[audit.id,randomUUID()])).rejects.toThrow('verification_scope_immutable')
    if(primitive==='task')await expect(pool.query(`UPDATE ${table} SET target_kind='entity' WHERE id=$1`,[audit.id])).rejects.toThrow('verification_scope_immutable')
    await pool.query(`UPDATE ${table} SET source_scope=source_scope WHERE id=$1`,[audit.id])
    expect((await queryWithRLS(f.userId,'SELECT verification_scope_allows($1,NULL) AS allowed',[f.workspaceId])).rows).toEqual([{allowed:false}])
    const read=async()=>{
      const audits=await queryWithRLS(f.userId,`SELECT id FROM ${table} WHERE workspace_id=$1`,[f.workspaceId])
      const events=await queryWithRLS(f.userId,'SELECT id FROM decision_events WHERE workspace_id=$1',[f.workspaceId])
      return [audits.rows.length,events.rows.length]
    }
    expect(await runWithAgentAccess(f.execution(),read)).toEqual([1,1])
    expect(await runWithAgentAccess({...f.execution(),compartments:[],mutationCompartments:[]},read)).toEqual([0,0])
    await pool.query(`UPDATE ${primitiveToTable(primitive)} SET compartments='{}',project_ids='{}' WHERE id=$1`,[id])
    expect(await runWithAgentAccess({...f.execution(),compartments:[],mutationCompartments:[]},read)).toEqual([0,0])
    const restricted=await f.groups.createTeam(f.userId,f.workspaceId,{name:'Research',key:'research'})
    await pool.query(`UPDATE ${primitiveToTable(primitive)} SET compartments=$2 WHERE id=$1`,[id,[restricted.compartmentKey!]])
    expect(await runWithAgentAccess(f.execution(),read)).toEqual([0,0])
    await pool.query(`UPDATE ${primitiveToTable(primitive)} SET compartments=$2 WHERE id=$1`,[id,[f.key]])
    await pool.query(`UPDATE ${primitiveToTable(primitive)} SET scope_held=true WHERE id=$1`,[id])
    expect(await runWithAgentAccess(f.execution(),read)).toEqual([0,0])
  })
  it.each(['memory','task'] as const)('rejects forged or cross-workspace %s verification evidence',async primitive=>{
    const f=await fixture(),id=await f.create(primitive),other=await fixture()
    const table=primitive==='memory'?'memory_verifications':'brain_verifications'
    const insert=(workspaceId=f.workspaceId,sourceId=id,scope:unknown=null,actor=f.userId)=>{
      const columns=primitive==='memory'?'memory_id':"target_id,target_kind"
      const values=primitive==='memory'?'$1':"$1,'task'"
      return queryWithRLS(f.userId,`INSERT INTO ${table}(${columns},workspace_id,verified_by,action,source_scope) VALUES(${values},$2,$3,'confirm',$4) RETURNING id`,[sourceId,workspaceId,actor,scope])
    }
    await expect(insert(f.workspaceId,id,{})).rejects.toThrow('verification_scope_server_owned')
    await expect(insert(other.workspaceId)).rejects.toThrow('verification_source_unavailable')
    await expect(insert(f.workspaceId,randomUUID())).rejects.toThrow('verification_source_unavailable')
    await expect(insert(f.workspaceId,id,null,f.member)).rejects.toThrow('row-level security')
    await expect(runWithAgentAccess(f.execution([]),()=>insert())).rejects.toThrow('row-level security')
    expect(await f.evidence()).toEqual([0,0,0,0,0])
  })
})

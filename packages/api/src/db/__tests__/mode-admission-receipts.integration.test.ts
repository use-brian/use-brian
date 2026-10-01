import {randomUUID} from 'node:crypto'
import {afterAll,describe,expect,it} from 'vitest'
import {getPool,getAppPool,applyRLSGucs,rollbackAndRelease} from '../client.js'
import {createDbWorkspaceGroupStore} from '../workspace-group-store.js'
import {admitWorkspaceResource} from '../../workspace-access/resource-admission.js'
const {assertLocalFixture}=await import(new URL('../../../../../scripts/crm/local-fixture.mjs',import.meta.url).href)
await assertLocalFixture()
const pool=getPool()
async function fixture(ready=true){
  const workspaceId=randomUUID(),userId=randomUUID(),assistantId=randomUUID(),source=randomUUID(),target=randomUUID()
  await pool.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)',[userId])
  await pool.query("INSERT INTO workspaces(id,name,owner_user_id) VALUES($1,'Receipt fixture',$2)",[workspaceId,userId])
  await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'owner')",[workspaceId,userId])
  await pool.query("INSERT INTO assistants(id,workspace_id,name,kind) VALUES($1,$2,'Receipt assistant','standard')",[assistantId,workspaceId])
  for(const id of [source,target])await pool.query("INSERT INTO entities(id,workspace_id,kind,display_name,created_by_user_id,source) VALUES($1,$2,'project','Receipt endpoint',$3,'user')",[id,workspaceId,userId])
  const team=await createDbWorkspaceGroupStore().createTeam(userId,workspaceId,{name:'Common',key:'common'})
  if(ready)await pool.query("UPDATE workspace_access_policies SET access_mode='simple',setup_state='ready',default_department_id=$2 WHERE workspace_id=$1",[workspaceId,team.id])
  const revision=(await pool.query('SELECT revision::text FROM workspace_access_policies WHERE workspace_id=$1',[workspaceId])).rows[0].revision
  return {workspaceId,userId,assistantId,source,target,key:team.compartmentKey!,revision}
}
const taskSql="INSERT INTO tasks(workspace_id,title,created_by_user_id,compartments,user_id,assistant_id) VALUES($1,'Receipt task',$2,$3,$4,$5) RETURNING id"
const denied={code:'42501',message:'workspace_creation_admission_required'}
describe('mode creation admission protocol database backstop',()=>{
  afterAll(async()=>{await getAppPool().end();await pool.end()})
  it.each(['task','memory','episode','workspace_file','entity','entity_link','knowledge_entry'])('rejects old/raw %s writers even when they guess the common label',async kind=>{
    const f=await fixture(),fields:Record<string,unknown>={workspace_id:f.workspaceId,compartments:[f.key]}
    let table:string
    if(kind==='task'){table='tasks';Object.assign(fields,{title:'Old writer',created_by_user_id:f.userId})}
    else if(kind==='memory'){table='memories';Object.assign(fields,{assistant_id:f.assistantId,created_by_user_id:f.userId,summary:'Old writer',sensitivity:'internal'})}
    else if(kind==='episode'){table='episodes';Object.assign(fields,{assistant_id:f.assistantId,created_by_user_id:f.userId,source_kind:'chat',source_ref:{},occurred_at:new Date()})}
    else if(kind==='workspace_file'){table='workspace_files';Object.assign(fields,{path:'/old.txt',parent_path:'/',name:'old.txt',mime:'text/plain',size_bytes:1,storage_uri:'fixture://old',created_by_user_id:f.userId})}
    else if(kind==='entity'){table='entities';Object.assign(fields,{kind:'project',display_name:'Old writer',created_by_user_id:f.userId,source:'user'})}
    else if(kind==='entity_link'){table='entity_links';Object.assign(fields,{source_kind:'entity',source_id:f.source,target_kind:'entity',target_id:f.target,edge_type:'related_to',source:'user'})}
    else{table='knowledge_entries';Object.assign(fields,{path:'old.md',title:'Old writer',content:'Old writer',sensitivity:'internal'})}
    const keys=Object.keys(fields)
    await expect(pool.query(`INSERT INTO ${table}(${keys.join(',')}) VALUES(${keys.map((_,i)=>`$${i+1}`).join(',')})`,Object.values(fields))).rejects.toMatchObject(denied)
  })
  it('retains legacy raw-write compatibility',async()=>{
    const f=await fixture(false)
    expect((await pool.query(taskSql,[f.workspaceId,f.userId,[],null,null])).rows).toHaveLength(1)
  })
  it('consumes exactly one app-role admission and never carries it across commit',async()=>{
    const f=await fixture(),client=await getAppPool().connect()
    try{
      await client.query('BEGIN');await applyRLSGucs(client,f.userId)
      await admitWorkspaceResource(client,f.workspaceId,f.userId,{writerKind:'task',expectedPolicyRevision:f.revision,visibility:'workspace',sensitivity:'internal'})
      await client.query(taskSql,[f.workspaceId,f.userId,[f.key],null,null])
      await client.query('SAVEPOINT second_insert')
      await expect(client.query(taskSql,[f.workspaceId,f.userId,[f.key],null,null])).rejects.toMatchObject(denied)
      await client.query('ROLLBACK TO SAVEPOINT second_insert');await client.query('COMMIT')
      await client.query('BEGIN');await applyRLSGucs(client,f.userId)
      await expect(client.query(taskSql,[f.workspaceId,f.userId,[f.key],null,null])).rejects.toMatchObject(denied)
    }finally{await rollbackAndRelease(client)}
    expect((await pool.query('SELECT id FROM tasks WHERE workspace_id=$1',[f.workspaceId])).rows).toHaveLength(1)
  })
  it.each(['kind','revision','labels','visibility','assistant_partition'])('refuses a changed %s after admission',async change=>{
    const f=await fixture(),client=await pool.connect()
    try{
      await client.query('BEGIN');await applyRLSGucs(client,f.userId)
      await admitWorkspaceResource(client,f.workspaceId,f.userId,{writerKind:change==='kind'?'entity':'task',expectedPolicyRevision:f.revision,visibility:'workspace',sensitivity:'internal'})
      if(change==='revision')await client.query('UPDATE workspace_access_policies SET revision=revision+1 WHERE workspace_id=$1',[f.workspaceId])
      await expect(client.query(taskSql,[f.workspaceId,f.userId,change==='labels'?[]:[f.key],change==='visibility'?f.userId:null,change==='assistant_partition'?f.assistantId:null])).rejects.toMatchObject(denied)
    }finally{await rollbackAndRelease(client)}
    expect((await pool.query('SELECT id FROM tasks WHERE workspace_id=$1',[f.workspaceId])).rows).toHaveLength(0)
  })
})

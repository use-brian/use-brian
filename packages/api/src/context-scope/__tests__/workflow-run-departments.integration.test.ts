import {randomUUID} from 'node:crypto'
import {afterAll,describe,expect,it} from 'vitest'
import {getPool,getAppPool,queryWithRLS,runWithAgentAccess} from '../../db/client.js'
import {readWorkflowOutcomeWithLineage} from '../../crm-operations/workflow-copy-store.js'
import {readWorkflowInputEvidence} from '../workflow-input-evidence.js'
const {assertLocalFixture}=await import(new URL('../../../../../scripts/crm/local-fixture.mjs',import.meta.url).href)
await assertLocalFixture()
const pool=getPool()
afterAll(async()=>{await getAppPool().end();await pool.end()})
async function fixture(){
 const workspace=randomUUID(),owner=randomUUID(),member=randomUUID(),departmentOwner=randomUUID(),department=randomUUID(),workflow=randomUUID(),run=randomUUID(),step=randomUUID(),assistant=randomUUID()
 for(const user of [owner,member,departmentOwner])await pool.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)',[user])
 await pool.query("INSERT INTO workspaces(id,name,owner_user_id) VALUES($1,'Fictional workflow context',$2)",[workspace,owner])
 await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role,clearance) VALUES($1,$2,'owner','confidential'),($1,$3,'member','public')",[workspace,owner,member])
 await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'member')",[workspace,departmentOwner])
 await pool.query("INSERT INTO workspace_groups(id,workspace_id,name,created_by,kind,key,compartment_key) VALUES($1::uuid,$2,'Fictional operations',$3,'team',$1::text,$4)",[department,workspace,departmentOwner,`team:${department}`])
 await pool.query("INSERT INTO workspace_compartments(workspace_id,key,label,managed_by,managed_ref_id) VALUES($1,$2,'Fictional operations','team',$3)",[workspace,`team:${department}`,department])
 await pool.query("INSERT INTO department_edges(workspace_id,department_id,principal_kind,user_id,clearance,origin) VALUES($1,$2,'user',$3,'public','store') ON CONFLICT DO NOTHING",[workspace,department,member])
 await pool.query("INSERT INTO workflows(id,workspace_id,created_by,name,definition,context_group_id) VALUES($1,$2,$3,'Fictional manual workflow','{}',$4)",[workflow,workspace,member,department])
 await pool.query("INSERT INTO workflow_runs(id,workflow_id,workspace_id,triggered_by,trigger_kind) VALUES($1,$2,$3,$4,'manual')",[run,workflow,workspace,member])
 // Model an executor-produced envelope, preserving the run's actual context.
 await pool.query("UPDATE workflow_runs SET vars=jsonb_build_object('__contextScopeEvidence',jsonb_build_object('sensitivity','public','compartments',context_compartments,'projectIds',context_project_ids)) WHERE id=$1",[run])
 await pool.query("INSERT INTO workflow_step_runs(id,run_id,step_id,step_type,status) VALUES($1,$2,'review','branch','completed')",[step,run])
 await pool.query("INSERT INTO assistants(id,name,workspace_id,owner_user_id,kind,clearance) VALUES($1,'Fictional assistant',$2,$3,'standard','confidential')",[assistant,workspace,owner])
 const read=async(user:string)=>(await queryWithRLS(user,'SELECT id FROM workflow_runs WHERE id=$1',[run])).rows
 return {workspace,owner,member,department,workflow,run,step,assistant,read}
}
describe('[COMP:workflow/context-scope] non-CRM run department floor',()=>{
 it('captures department context and protects run and step reads without an owner override',async()=>{
  const f=await fixture()
  expect((await pool.query('SELECT context_compartments FROM workflow_runs WHERE id=$1',[f.run])).rows[0].context_compartments).toEqual([`team:${f.department}`])
  expect(await f.read(f.member)).toEqual([{id:f.run}]);expect(await f.read(f.owner)).toEqual([])
  expect((await queryWithRLS(f.owner,'SELECT id FROM workflow_step_runs WHERE id=$1',[f.step])).rows).toEqual([])
  expect((await queryWithRLS(f.member,'SELECT id FROM workflow_step_runs WHERE id=$1',[f.step])).rows).toEqual([{id:f.step}])
  await pool.query('UPDATE workflows SET context_group_id=NULL WHERE id=$1',[f.workflow])
  expect(await f.read(f.owner)).toEqual([])
  await expect(pool.query("UPDATE workflow_runs SET context_compartments='{}',context_group_id=NULL WHERE id=$1",[f.run])).rejects.toThrow('workflow_run_department_immutable')
  await pool.query("UPDATE department_edges SET expires_at=clock_timestamp()-interval '1 second' WHERE department_id=$1 AND user_id=$2",[f.department,f.member])
  expect(await f.read(f.member)).toEqual([])
 })
 it('applies current credential and assistant department restrictions',async()=>{
  const f=await fixture(),grant={workspaceId:f.workspace,userId:f.member,assistantId:null,base:'public' as const,departments:{[f.department]:'public' as const},contextDepartment:null,binding:null,cap:null}
  const ctx={workspaceId:f.workspace,userId:f.member,clearance:'confidential' as const,compartments:null,projectIds:null,departmentRead:grant}
  expect(await runWithAgentAccess(ctx,()=>f.read(f.member))).toEqual([{id:f.run}])
  expect(await runWithAgentAccess({...ctx,departmentRead:{...grant,binding:[]}},()=>f.read(f.member))).toEqual([])
  await pool.query('DELETE FROM department_edges WHERE department_id=$1 AND assistant_id=$2',[f.department,f.assistant])
  expect(await runWithAgentAccess({...ctx,departmentRead:{...grant,assistantId:f.assistant}},()=>f.read(f.member))).toEqual([])
 })
 it('retains a source-run department across General copies and follows current definition restrictions',async()=>{
  const f=await fixture(),child=randomUUID(),grandchild=randomUUID()
  await pool.query('UPDATE workflows SET context_group_id=NULL WHERE id=$1',[f.workflow])
  for(const id of [child,grandchild])await pool.query("INSERT INTO workflow_runs(id,workflow_id,workspace_id,triggered_by,trigger_kind) VALUES($1,$2,$3,$4,'manual')",[id,f.workflow,f.workspace,f.member])
  for(const [target,source] of [[child,f.run],[grandchild,child]]) {
   await pool.query('INSERT INTO workflow_run_copy_sources(workspace_id,run_id,source_run_id) VALUES($1,$2,$3)',[f.workspace,target,source])
   await pool.query("UPDATE workflow_runs SET vars=jsonb_build_object('__contextScopeEvidence',$2::jsonb) WHERE id=$1",[target,JSON.stringify(await readWorkflowInputEvidence(target,f.workspace))])
  }
  expect((await queryWithRLS(f.owner,'SELECT id FROM workflow_runs WHERE id=$1',[grandchild])).rows).toEqual([])
  expect((await queryWithRLS(f.owner,'SELECT run_id FROM workflow_run_copy_sources WHERE run_id=$1',[grandchild])).rows).toEqual([])
  expect((await queryWithRLS(f.member,'SELECT id FROM workflow_runs WHERE id=$1',[grandchild])).rows).toEqual([{id:grandchild}])
  const general=randomUUID();await pool.query("INSERT INTO workflow_runs(id,workflow_id,workspace_id,trigger_kind) VALUES($1,$2,$3,'manual')",[general,f.workflow,f.workspace])
  await pool.query("UPDATE workflow_runs SET vars=jsonb_build_object('__contextScopeEvidence',$2::jsonb) WHERE id=$1",[general,JSON.stringify(await readWorkflowInputEvidence(general,f.workspace))])
  expect((await queryWithRLS(f.owner,'SELECT id FROM workflow_runs WHERE id=$1',[general])).rows).toHaveLength(1)
  await pool.query('UPDATE workflows SET context_group_id=$2 WHERE id=$1',[f.workflow,f.department])
  expect((await queryWithRLS(f.owner,'SELECT id FROM workflow_runs WHERE id=$1',[general])).rows).toEqual([])
 })
 it('refuses outcome copying and duplicate lineage admission after department revocation',async()=>{
  const f=await fixture(),consumer=randomUUID()
  await pool.query("UPDATE workflow_runs SET status='completed',finished_at=now(),outcome=$2 WHERE id=$1",[f.run,{status:'completed',summary:'Fictional protected result',logs:[],todo:[],blockers:[],state:{},finishedAt:new Date().toISOString()}])
  await pool.query('UPDATE workflows SET context_group_id=NULL WHERE id=$1',[f.workflow])
  await pool.query("INSERT INTO workflow_runs(id,workflow_id,workspace_id,triggered_by,trigger_kind) VALUES($1,$2,$3,$4,'manual')",[consumer,f.workflow,f.workspace,f.member])
  await pool.query("UPDATE department_edges SET expires_at=clock_timestamp()-interval '1 second' WHERE department_id=$1 AND user_id=$2",[f.department,f.member])
  expect(await readWorkflowOutcomeWithLineage(f.workflow,consumer)).toBeNull()
  expect((await pool.query('SELECT run_id FROM workflow_run_copy_sources WHERE run_id=$1',[consumer])).rows).toEqual([])
  await pool.query('UPDATE department_edges SET expires_at=NULL WHERE department_id=$1 AND user_id=$2',[f.department,f.member])
  await pool.query('DELETE FROM department_edges WHERE department_id=$1 AND assistant_id=$2',[f.department,f.assistant])
  const agent={workspaceId:f.workspace,userId:f.member,clearance:'confidential' as const,compartments:null,projectIds:null,departmentRead:{workspaceId:f.workspace,userId:f.member,assistantId:f.assistant,base:'public' as const,departments:{[f.department]:'public' as const},contextDepartment:null,binding:null,cap:null}}
  expect(await runWithAgentAccess(agent,()=>readWorkflowOutcomeWithLineage(f.workflow,consumer))).toBeNull()
  expect(await readWorkflowOutcomeWithLineage(f.workflow,consumer)).toMatchObject({summary:'Fictional protected result'})
  await pool.query("UPDATE department_edges SET expires_at=clock_timestamp()-interval '1 second' WHERE department_id=$1 AND user_id=$2",[f.department,f.member])
  expect(await readWorkflowOutcomeWithLineage(f.workflow,consumer)).toBeNull()
  await expect(pool.query('INSERT INTO workflow_run_copy_sources(workspace_id,run_id,source_run_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[f.workspace,consumer,f.run])).rejects.toThrow('workflow_source_scope_unavailable')
  await expect(queryWithRLS(f.member,'SELECT workflow_run_department_allows($1,$2)',[f.run,f.owner])).rejects.toMatchObject({code:'42501'})
 })
 it('does not return an older outcome when the newest source requires another department',async()=>{
  const f=await fixture(),older=randomUUID(),consumer=randomUUID()
  await pool.query("UPDATE workflow_runs SET status='completed',finished_at=now(),outcome=$2 WHERE id=$1",[f.run,{summary:'Fictional protected newest'}])
  await pool.query('UPDATE workflows SET context_group_id=NULL WHERE id=$1',[f.workflow])
  await pool.query("INSERT INTO workflow_runs(id,workflow_id,workspace_id,triggered_by,trigger_kind,status,finished_at,outcome) VALUES($1,$2,$3,$4,'manual','completed','2000-01-01',$5)",[older,f.workflow,f.workspace,f.owner,{summary:'Fictional older General'}])
  await pool.query("INSERT INTO workflow_runs(id,workflow_id,workspace_id,triggered_by,trigger_kind) VALUES($1,$2,$3,$4,'manual')",[consumer,f.workflow,f.workspace,f.owner])
  expect(await readWorkflowOutcomeWithLineage(f.workflow,consumer)).toBeNull()
  expect((await pool.query('SELECT run_id FROM workflow_run_copy_sources WHERE run_id=$1',[consumer])).rows).toEqual([])
 })
 it('checks blueprint enrichment independently of readable run context and withholds held records',async()=>{
  const f=await fixture(),consumer=randomUUID(),record=randomUUID()
  await pool.query("UPDATE workflow_runs SET status='completed',finished_at=now(),outcome=$2 WHERE id=$1",[f.run,{summary:'Fictional readable outcome'}])
  await pool.query("INSERT INTO workflow_runs(id,workflow_id,workspace_id,triggered_by,trigger_kind) VALUES($1,$2,$3,$4,'manual')",[consumer,f.workflow,f.workspace,f.member])
  await pool.query("INSERT INTO blueprint_records(id,workspace_id,spec_snapshot,subject,anchor_key,fields,source_kind,source_id,created_by,sensitivity,compartments) VALUES($1::uuid,$2,'{}','Fictional protected enrichment',$1::text,$3,'workflow',$4,$5,'confidential',$6)",[record,f.workspace,{protected:'Fictional detail'},f.run,f.member,[`team:${f.department}`]])
  expect(await f.read(f.member)).toEqual([{id:f.run}])
  expect(await readWorkflowOutcomeWithLineage(f.workflow,consumer)).toBeNull()
  expect((await pool.query('SELECT run_id FROM workflow_run_copy_sources WHERE run_id=$1',[consumer])).rows).toEqual([])
  await pool.query("UPDATE department_edges SET clearance='confidential' WHERE department_id=$1 AND user_id=$2",[f.department,f.member])
  expect(await readWorkflowOutcomeWithLineage(f.workflow,consumer)).toMatchObject({output:{protected:'Fictional detail'}})
  await pool.query("UPDATE workflow_runs SET vars=jsonb_build_object('__contextScopeEvidence',$2::jsonb) WHERE id=$1",[consumer,JSON.stringify(await readWorkflowInputEvidence(consumer,f.workspace))])
  expect((await queryWithRLS(f.member,'SELECT id FROM workflow_runs WHERE id=$1',[consumer])).rows).toEqual([{id:consumer}])
  await pool.query("UPDATE department_edges SET clearance='public' WHERE department_id=$1 AND user_id=$2",[f.department,f.member])
  expect((await queryWithRLS(f.member,'SELECT id FROM workflow_runs WHERE id=$1',[consumer])).rows).toEqual([])
  expect(await f.read(f.member)).toEqual([{id:f.run}])
  await pool.query("UPDATE department_edges SET clearance='confidential' WHERE department_id=$1 AND user_id=$2",[f.department,f.member])
  await pool.query("INSERT INTO scope_resource_states(workspace_id,resource_kind,resource_id,resource_version,review_state,classification_revision,holding_reason) VALUES($1,'blueprint_record',$2,read_scope_review_source($1,'blueprint_record',$2)->>'version','held',1,'Fictional source review')",[f.workspace,record])
  expect(await readWorkflowOutcomeWithLineage(f.workflow,consumer)).toBeNull()
  expect((await queryWithRLS(f.member,'SELECT id FROM workflow_runs WHERE id=$1',[consumer])).rows).toEqual([])
 })
 it('retains legacy workspace read behavior explicitly',async()=>{
  const f=await fixture();await pool.query('UPDATE workspaces SET department_read_v2=false WHERE id=$1',[f.workspace])
  expect(await f.read(f.owner)).toEqual([{id:f.run}])
 })
})

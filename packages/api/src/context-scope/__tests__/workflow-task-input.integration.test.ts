import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { getPool, getAppPool, queryWithRLS, runWithAgentAccess } from '../../db/client.js'
import { readWorkflowOutcomeWithLineage } from '../../crm-operations/workflow-copy-store.js'
import { createTask, updateTask } from '../../db/tasks.js'
import { createDbWorkflowStore, createDbWorkflowRunStore, findEventTriggeredWorkflowsSystem, getWorkflowCreatorSystem, pauseWorkflowForPrimitiveEventSystem } from '../../db/workflow-store.js'
import { createWorkflowEventDispatcher, pinAccessCeiling } from '@use-brian/core'
import { setTaskEventDispatcher } from '../../task-event-fanout.js'
import { setKnowledgeEventDispatcher } from '../../knowledge-event-fanout.js'
import { createDbKnowledgeStore } from '../../db/knowledge-store.js'
import { createDbWorkspaceGroupStore } from '../../db/workspace-group-store.js'
import { captureAuthoringAuthoritySystem, resolveWorkflowRunScope } from '../workflow-authority.js'
import { readWorkflowInputEvidence } from '../workflow-input-evidence.js'
const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()
const pool = getPool(), runs = createDbWorkflowRunStore()
async function fixture() {
  const workspaceId=randomUUID(),owner=randomUUID(),member=randomUUID()
  for (const id of [owner,member]) await pool.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)',[id])
  await pool.query("INSERT INTO workspaces(id,name,owner_user_id) VALUES($1,'Task source fixture',$2)",[workspaceId,owner])
  await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role,clearance,compartments) VALUES($1,$2,'owner','confidential',NULL),($1,$3,'member','public','{}')",[workspaceId,owner,member])
  async function workflow(userId:string, prepare?: (assistantId:string)=>Promise<void>, contextProjectId?: string) {
    const assistantId=randomUUID()
    await pool.query("INSERT INTO assistants(id,name,workspace_id,owner_user_id,kind,clearance,compartments) VALUES($1,'Fixture assistant',$2,$3,'standard',$4,NULL)",[assistantId,workspaceId,userId,userId===owner?'confidential':'public'])
    await prepare?.(assistantId)
    const authoringAuthority=await captureAuthoringAuthoritySystem({userId,workspaceId,assistantId,contextProjectId})
    const definition=await createDbWorkflowStore().create({userId,workspaceId,name:'Task source workflow',authoringAuthority,contextProjectId,
      definition:{startStepId:'inspect',steps:[{id:'inspect',type:'tool_call',toolName:'fixtureInspect',arguments:{}}]}})
    return {assistantId,userId,id:definition.id,authoringAuthority}
  }
  const task=await createTask(owner,{workspaceId,title:'Private fixture task',sensitivity:'confidential',visibility:{userId:owner,assistantId:null}})
  const create=async(w:Awaited<ReturnType<typeof workflow>>,taskId=task.id)=>{
    const receipt=(await pool.query('SELECT metadata FROM workflow_task_event_receipts WHERE workspace_id=$1 AND task_id=$2',[workspaceId,taskId])).rows[0]
    return runs.createRun({workflowId:w.id,workspaceId,triggeredBy:w.userId,triggerKind:'event',
    input:{trigger:{sourceType:'task'},event:{taskId,title:receipt?.metadata?.current?.title ?? task.title}}})
  }
  return {workspaceId,owner,member,task,workflow,create}
}
describe('[COMP:api/workflow-input-evidence] primitive lifecycle receipts',()=>{
  afterAll(async()=>{await getAppPool().end();await pool.end()})
  it.each([['task','user'],['task','assistant'],['knowledge','user'],['knowledge','assistant']] as const)('admits %s at its department tier and enforces Project limits plus %s revocation',async(sourceType,principal)=>{
    const f=await fixture(),groups=createDbWorkspaceGroupStore()
    const team=await groups.createTeam(f.owner,f.workspaceId,{name:'Event department',key:'event-department'})
    await groups.addMember(f.owner,team.id,f.member)
    await pool.query("UPDATE department_edges SET clearance='confidential',origin='store' WHERE workspace_id=$1 AND user_id=$2",[f.workspaceId,f.member])
    const prepare=async(assistantId:string)=>{
      await pool.query("INSERT INTO department_edges(workspace_id,department_id,principal_kind,assistant_id,clearance,origin) VALUES($1,$2,'assistant',$3,'confidential','store')",[f.workspaceId,team.id,assistantId])
    }
    const w=await f.workflow(f.member,prepare),project=randomUUID()
    await pool.query("INSERT INTO workspace_projects(id,workspace_id,name,normalized_name,created_by) VALUES($1,$2,'Event project','event project',$3)",[project,f.workspaceId,f.owner])
    const source=sourceType==='task'
      ? await createTask(f.owner,{workspaceId:f.workspaceId,title:'Department task',sensitivity:'confidential',compartments:[team.compartmentKey!],projectIds:[project],visibility:{userId:null,assistantId:null}})
      : await createDbKnowledgeStore().create({workspaceId:f.workspaceId,path:'fixture/department',title:'Department knowledge',content:'Body',sensitivity:'confidential',compartments:[team.compartmentKey!],projectIds:[project],createdBy:f.owner})
    const event=sourceType==='task' ? {taskId:source.id,title:source.title} : {entryId:source.id,title:source.title,sourceVersion:'scopeVersion' in source ? source.scopeVersion : undefined}
    const params={workflowId:w.id,workspaceId:f.workspaceId,triggeredBy:f.member,triggerKind:'event' as const,input:{trigger:{sourceType},event}}
    expect(w.authoringAuthority.ceiling.departmentRead).toMatchObject({base:'public',departments:{[team.id]:'confidential'}})
    const run=await runs.createRun(params)
    let scope=await resolveWorkflowRunScope({workspaceId:f.workspaceId,userId:f.member,assistantId:w.assistantId,run})
    expect(scope.inputScopeEvidence).toMatchObject({sensitivity:'confidential',compartments:[team.compartmentKey],projectIds:[project]})
    expect((await pool.query('SELECT project_id FROM workspace_project_members WHERE project_id=$1 AND user_id=$2',[project,f.member])).rows).toHaveLength(0)
    const boundProject=randomUUID()
    await pool.query("INSERT INTO workspace_projects(id,workspace_id,name,normalized_name,created_by) VALUES($1,$2,'Bound project','bound project',$3)",[boundProject,f.workspaceId,f.owner])
    await pool.query('INSERT INTO workspace_project_members(project_id,user_id) VALUES($1,$2)',[boundProject,f.member])
    const bounded=await f.workflow(f.member,prepare,boundProject)
    expect(bounded.authoringAuthority.ceiling.projectIds).toEqual([boundProject])
    await expect(runs.createRun({...params,workflowId:bounded.id})).rejects.toThrow()
    expect((await pool.query('SELECT id FROM workflow_runs WHERE workflow_id=$1',[bounded.id])).rows).toHaveLength(0)
    await runs.updateRun(run.id,{vars:{__contextScopeEvidence:scope.inputScopeEvidence}})
    await pool.query("UPDATE workflow_runs SET status='completed',outcome='{\"summary\":\"Department outcome\"}' WHERE id=$1",[run.id])
    const target=await runs.createRun({workflowId:w.id,workspaceId:f.workspaceId,triggeredBy:f.member,triggerKind:'manual',input:{}})
    expect(await runWithAgentAccess(pinAccessCeiling(scope.turnScope.access),()=>readWorkflowOutcomeWithLineage(w.id,target.id))).toMatchObject({summary:'Department outcome'})
    expect((await readWorkflowInputEvidence(target.id,f.workspaceId)).sources).toContainEqual(expect.objectContaining({resourceId:source.id,sensitivity:'confidential',projectIds:[project]}))
    scope=await resolveWorkflowRunScope({workspaceId:f.workspaceId,userId:f.member,assistantId:w.assistantId,run:(await runs.getRunSystem(run.id))!})
    expect(await scope.executeWithAuthority(async()=> 'authorized')).toBe('authorized')
    if (principal==='user') {
      // Role promotion must not replace a missing department edge.
      await pool.query("UPDATE workspace_members SET role='owner' WHERE workspace_id=$1 AND user_id=$2",[f.workspaceId,f.member])
      await pool.query('DELETE FROM department_edges WHERE workspace_id=$1 AND user_id=$2',[f.workspaceId,f.member])
    } else {
      await pool.query('DELETE FROM department_edges WHERE workspace_id=$1 AND assistant_id=$2',[f.workspaceId,w.assistantId])
    }
    await expect(scope.executeWithAuthority(async()=> 'must not execute')).rejects.toThrow()
    await expect(runs.createRun(params)).rejects.toThrow()
    await expect(pauseWorkflowForPrimitiveEventSystem(params,'Fixture pause')).rejects.toThrow()
    expect(await runWithAgentAccess(pinAccessCeiling(scope.turnScope.access),()=>readWorkflowOutcomeWithLineage(w.id,target.id))).toBeNull()
    expect((await pool.query('SELECT id FROM workflow_runs WHERE workflow_id=$1',[w.id])).rows).toHaveLength(2)
  })
  it('checks source permission before comparing protected metadata',async()=>{
    const f=await fixture(),w=await f.workflow(f.member),errors:string[]=[]
    for (const title of [f.task.title,'Incorrect guessed title']) {
      const params={workflowId:w.id,workspaceId:f.workspaceId,triggeredBy:f.member,triggerKind:'event' as const,
        input:{trigger:{sourceType:'task'},event:{taskId:f.task.id,title}}}
      for (const operation of [()=>runs.createRun(params),()=>pauseWorkflowForPrimitiveEventSystem(params,'Fixture pause')]) {
        try {await operation();throw new Error('Unexpected admission')} catch(error) {errors.push((error as Error).message)}
      }
    }
    expect(errors[0]).not.toBe('Unexpected admission')
    expect(errors[0]).not.toBe('primitive_event_metadata_conflict')
    expect(new Set(errors).size).toBe(1)
  })
  it('admits real update metadata and treats object-key reordering as unchanged',async()=>{
    const f=await fixture(),w=await f.workflow(f.owner)
    let complete!:()=>void, failure:unknown, current=f.task
    setTaskEventDispatcher({dispatch:async event=>{
      try {await runs.createRun({workflowId:w.id,workspaceId:f.workspaceId,triggeredBy:f.owner,triggerKind:'event',
        input:{trigger:{sourceType:'task',provider:'task',channelId:event.channelId,actorId:event.actorId},event:event.payload}})}
      catch(error){failure=error} finally{complete()}
    }})
    try {
      for (const attributes of [{first:1,second:2},{second:2,first:1}]) {
        const done=new Promise<void>(resolve=>{complete=resolve})
        current=(await updateTask(f.owner,current.id,{title:'Updated canonical title',status:'done',tags:['checked'],attributes}))!
        await done
        expect(failure).toBeUndefined()
      }
      const rows=(await pool.query('SELECT input FROM workflow_runs WHERE workflow_id=$1 ORDER BY started_at,id',[w.id])).rows
      expect(rows).toHaveLength(2)
      const fields=rows.map(row=>row.input.event.changedFields)
      expect(fields).toContainEqual(['title','status','tags','attributes'])
      expect(fields).toContainEqual([])
    } finally {setTaskEventDispatcher(null)}
  })
  it('withholds unstamped historical event input and refuses retroactive certification',async()=>{
    const f=await fixture(),w=await f.workflow(f.owner)
    const run=(await pool.query(`INSERT INTO workflow_runs(workflow_id,workspace_id,triggered_by,trigger_kind,input,vars)
      VALUES($1,$2,$3,'event',$4,$5) RETURNING id`,[w.id,f.workspaceId,f.owner,
      JSON.stringify({trigger:{sourceType:'task'},event:{taskId:f.task.id,title:'Unverified historical title'}}),
      JSON.stringify({__contextScopeEvidence:{sensitivity:'public',compartments:[],projectIds:[],sources:[]}})])).rows[0]
    await expect(readWorkflowInputEvidence(run.id,f.workspaceId)).rejects.toThrow('primitive_event_metadata_missing')
    expect((await queryWithRLS(f.owner,'SELECT id FROM workflow_runs WHERE id=$1',[run.id])).rows).toHaveLength(0)
    await expect(pool.query('SELECT read_workflow_derivation_inputs($1,$2)',[f.workspaceId,run.id])).rejects.toThrow('primitive_event_metadata_missing')
    await expect(pool.query('UPDATE workflow_runs SET primitive_event_metadata_verified=true WHERE id=$1',[run.id])).rejects.toThrow('primitive_event_metadata_immutable')
  })
  it.each(['task','knowledge'] as const)('rejects substituted %s metadata before queue or pause effects',async sourceType=>{
    const f=await fixture(),w=await f.workflow(f.owner)
    const entry=sourceType==='knowledge' ? await createDbKnowledgeStore().create({workspaceId:f.workspaceId,path:'fixture/bound',title:'Canonical title',content:'Body',sensitivity:'confidential',createdBy:f.owner}) : null
    const original:Record<string,unknown> = entry ? {entryId:entry.id,sourceVersion:entry.scopeVersion,title:entry.title} : {taskId:f.task.id,title:f.task.title}
    const events:Record<string,unknown>[] = [
      {...original,title:'Substituted content'}, {...original,body:'Unbound body'}, {...original,tags:['Unbound tag']},
      {...original,action:'unbound action'}, {...original,actorId:randomUUID()},
      ...(sourceType==='task' ? [{...original,changedFields:['title']},{...original,action:'completed'}] : [{...original,path:'another/path'},{...original,action:'deleted'}]),
    ]
    for (const event of events) {
      const params={workflowId:w.id,workspaceId:f.workspaceId,triggeredBy:f.owner,triggerKind:'event' as const,input:{trigger:{sourceType},event}}
      await expect(runs.createRun(params)).rejects.toThrow('primitive_event_metadata_conflict')
      await expect(pauseWorkflowForPrimitiveEventSystem(params,'Fixture pause')).rejects.toThrow('primitive_event_metadata_conflict')
    }
    for (const input of [{trigger:{sourceType,extra:'Unbound trigger'},event:original},{trigger:{sourceType},event:original,extra:'Unbound root'}]) {
      await expect(runs.createRun({workflowId:w.id,workspaceId:f.workspaceId,triggeredBy:f.owner,triggerKind:'event',input})).rejects.toThrow('primitive_event_metadata_conflict')
    }
    expect((await pool.query('SELECT id FROM workflow_runs WHERE workspace_id=$1',[f.workspaceId])).rows).toHaveLength(0)
    expect((await pool.query('SELECT id FROM workflow_task_pause_admissions WHERE workflow_id=$1',[w.id])).rows).toHaveLength(0)
  })
  it('retains knowledge event-time restrictions after reclassification and deletion',async()=>{
    const f=await fixture(),allowed=await f.workflow(f.owner),denied=await f.workflow(f.member)
    const entry=await createDbKnowledgeStore().create({workspaceId:f.workspaceId,path:'fixture/private',title:'Protected title',content:'Fixture body',sensitivity:'confidential',createdBy:f.owner})
    expect(entry.scopeVersion).toBeTypeOf('string')
    const params=(workflow:typeof allowed)=>({workflowId:workflow.id,workspaceId:f.workspaceId,triggeredBy:workflow.userId,triggerKind:'event' as const,
      input:{trigger:{sourceType:'knowledge'},event:{entryId:entry.id,sourceVersion:entry.scopeVersion,title:entry.title,action:'created'}}})
    await pool.query("UPDATE knowledge_entries SET sensitivity='public' WHERE id=$1",[entry.id])
    await createDbKnowledgeStore().delete(entry.id)
    await expect(runs.createRun(params(denied))).rejects.toThrow()
    await expect(pauseWorkflowForPrimitiveEventSystem(params(denied),'Fixture pause')).rejects.toThrow()
    const run=await runs.createRun(params(allowed)),evidence=await readWorkflowInputEvidence(run.id,f.workspaceId)
    expect(evidence).toMatchObject({sensitivity:'confidential',sources:[expect.objectContaining({resourceKind:'knowledge_entry',resourceId:entry.id,version:entry.scopeVersion})]})
    const scope=await resolveWorkflowRunScope({run,workspaceId:f.workspaceId,userId:f.owner,assistantId:allowed.assistantId})
    expect(scope.inputScopeEvidence.sensitivity).toBe('confidential')
    await runs.updateRun(run.id,{vars:{__contextScopeEvidence:{sensitivity:'public',compartments:[],projectIds:[],sources:[]}}})
    expect((await queryWithRLS(f.member,'SELECT id FROM workflow_runs WHERE id=$1',[run.id])).rows).toHaveLength(0)
    expect((await pool.query('SELECT read_workflow_derivation_inputs($1,$2) AS inputs',[f.workspaceId,run.id])).rows[0].inputs[0].evidence.sensitivity).toBe('confidential')
    await expect(pool.query("UPDATE workflow_runs SET input=jsonb_set(input,'{event,sourceVersion}','\"999\"'::jsonb) WHERE id=$1",[run.id])).rejects.toThrow('knowledge_event_binding_immutable')
    await expect(runs.createRun({...params(allowed),input:{trigger:{sourceType:'knowledge'},event:{entryId:entry.id}}})).rejects.toThrow('knowledge_event_evidence_missing')
  })
  it('emits the canonical knowledge version from a real write and admits only its authorized subscriber',async()=>{
    const f=await fixture(),allowed=await f.workflow(f.owner),denied=await f.workflow(f.member)
    for (const workflow of [allowed,denied]) await pool.query('UPDATE workflows SET enabled=true,trigger=$2::jsonb WHERE id=$1',
      [workflow.id,JSON.stringify({kind:'event',event:{sources:[{source:{type:'knowledge'},match:{}}]}})])
    const errors:string[]=[]
    const dispatcher=createWorkflowEventDispatcher({findEventTriggeredWorkflows:({workspaceId})=>findEventTriggeredWorkflowsSystem(workspaceId),
      startWorkflowRun:async({workflowId,workspaceId,input})=>{await runs.createRun({workflowId,workspaceId,input,triggerKind:'event',triggeredBy:await getWorkflowCreatorSystem(workflowId)})},
      onError:(_error,context)=>{if(context.workflowId)errors.push(context.workflowId)}})
    let finish!:()=>void
    const dispatched=new Promise<void>(resolve=>{finish=resolve})
    setKnowledgeEventDispatcher({dispatch:async event=>{try{await dispatcher.dispatch(event)}finally{finish()}}})
    try {
      const entry=await createDbKnowledgeStore().create({workspaceId:f.workspaceId,path:'fixture/event',title:'Protected event title',content:'Fixture body',sensitivity:'confidential',createdBy:f.owner})
      await dispatched
      const queued=(await pool.query('SELECT workflow_id,input FROM workflow_runs WHERE workspace_id=$1',[f.workspaceId])).rows
      expect(queued).toEqual([expect.objectContaining({workflow_id:allowed.id,input:expect.objectContaining({event:expect.objectContaining({entryId:entry.id,sourceVersion:entry.scopeVersion})})})])
      expect(errors).toEqual([denied.id])
    } finally {setKnowledgeEventDispatcher(null)}
  })
  it('admits storm pauses only for authorized task sources without creating a run',async()=>{
    const f=await fixture(),allowed=await f.workflow(f.owner),denied=await f.workflow(f.member)
    await pool.query('UPDATE workflows SET enabled=true WHERE id=ANY($1::uuid[])',[[allowed.id,denied.id]])
    const pause=(workflow:typeof allowed)=>pauseWorkflowForPrimitiveEventSystem({workflowId:workflow.id,workspaceId:f.workspaceId,
      triggeredBy:workflow.userId,triggerKind:'event',input:{trigger:{sourceType:'task'},event:{taskId:f.task.id}}},'Fixture storm pause')
    await expect(pause(denied)).rejects.toThrow()
    expect((await pool.query('SELECT enabled,paused_reason FROM workflows WHERE id=$1',[denied.id])).rows[0]).toEqual({enabled:true,paused_reason:null})
    expect((await pool.query('SELECT id FROM workflow_task_pause_admissions WHERE workflow_id=$1',[denied.id])).rows).toHaveLength(0)
    await pause(allowed)
    expect((await pool.query('SELECT enabled,paused_reason FROM workflows WHERE id=$1',[allowed.id])).rows[0]).toEqual({enabled:false,paused_reason:'Fixture storm pause'})
    expect((await pool.query('SELECT id FROM workflow_runs WHERE workspace_id=$1',[f.workspaceId])).rows).toHaveLength(0)
  })
  it('rolls back a storm pause whose captured boundary expires at commit',async()=>{
    const f=await fixture(),w=await f.workflow(f.owner),client=await pool.connect()
    await pool.query('UPDATE workflows SET enabled=true WHERE id=$1',[w.id])
    try {
      await client.query('BEGIN')
      await client.query("INSERT INTO workflow_task_pause_admissions(workflow_id,valid_until) VALUES($1,clock_timestamp()+interval '100 milliseconds')",[w.id])
      await client.query("UPDATE workflows SET enabled=false,paused_reason='Fixture expired pause' WHERE id=$1",[w.id])
      await client.query('SELECT pg_sleep(0.15)')
      await expect(client.query('COMMIT')).rejects.toThrow('workflow_dispatch_expired')
    } finally {await client.query('ROLLBACK');client.release()}
    expect((await pool.query('SELECT enabled,paused_reason FROM workflows WHERE id=$1',[w.id])).rows[0]).toEqual({enabled:true,paused_reason:null})
    expect((await pool.query('SELECT id FROM workflow_task_pause_admissions WHERE workflow_id=$1',[w.id])).rows).toHaveLength(0)
  })
  it('fans an actual committed task write out only to an authorized matching workflow',async()=>{
    const f=await fixture(),allowed=await f.workflow(f.owner),denied=await f.workflow(f.member)
    for (const workflow of [allowed,denied]) await pool.query(`UPDATE workflows SET enabled=true,
      trigger=$2::jsonb WHERE id=$1`,[workflow.id,JSON.stringify({kind:'event',event:{sources:[{source:{type:'task'},match:{}}]}})])
    const errors: string[]=[]
    const dispatcher=createWorkflowEventDispatcher({
      findEventTriggeredWorkflows:({workspaceId})=>findEventTriggeredWorkflowsSystem(workspaceId),
      startWorkflowRun:async({workflowId,workspaceId,input})=>{
        await runs.createRun({workflowId,workspaceId,input,triggerKind:'event',triggeredBy:await getWorkflowCreatorSystem(workflowId)})
      },
      onError:(_error,context)=>{if(context.workflowId)errors.push(context.workflowId)},
    })
    let finish!:()=>void
    const dispatched=new Promise<void>(resolve=>{finish=resolve})
    setTaskEventDispatcher({dispatch:async event=>{try{await dispatcher.dispatch(event)}finally{finish()}}})
    try {
      const task=await createTask(f.owner,{workspaceId:f.workspaceId,title:'Committed private event',sensitivity:'confidential',visibility:{userId:f.owner,assistantId:null}})
      await dispatched
      const queued=(await pool.query('SELECT id,workflow_id,input FROM workflow_runs WHERE workspace_id=$1',[f.workspaceId])).rows
      expect(queued).toHaveLength(1)
      expect(queued[0]).toMatchObject({workflow_id:allowed.id,input:{event:{taskId:task.id,title:'Committed private event'}}})
      expect(errors).toEqual([denied.id])
      expect((await readWorkflowInputEvidence(queued[0].id,f.workspaceId)).sources).toEqual([expect.objectContaining({resourceId:task.id,userId:f.owner,sensitivity:'confidential'})])
    } finally {setTaskEventDispatcher(null)}
  })
  it('rejects private task metadata before creating a public workflow queue row',async()=>{
    const f=await fixture(),w=await f.workflow(f.member)
    expect((await queryWithRLS(f.member,'SELECT id FROM tasks WHERE id=$1',[f.task.id])).rows).toHaveLength(0)
    await expect(f.create(w)).rejects.toThrow()
    expect((await pool.query('SELECT id FROM workflow_runs WHERE workflow_id=$1',[w.id])).rows).toHaveLength(0)
  })
  it('executes an authorized event while retaining its original floor after source relabeling',async()=>{
    const f=await fixture(),w=await f.workflow(f.owner),run=await f.create(w)
    await pool.query("UPDATE tasks SET sensitivity='public',user_id=NULL WHERE id=$1",[f.task.id])
    const evidence=await readWorkflowInputEvidence(run.id,f.workspaceId)
    expect(evidence).toMatchObject({sensitivity:'confidential',sources:[expect.objectContaining({resourceKind:'task',resourceId:f.task.id,userId:f.owner,sensitivity:'confidential'})]})
    const scope=await resolveWorkflowRunScope({workspaceId:f.workspaceId,userId:f.owner,assistantId:w.assistantId,run})
    expect(scope.inputScopeEvidence.sensitivity).toBe('confidential')
    await runs.updateRun(run.id,{vars:{__contextScopeEvidence:{sensitivity:'public',compartments:[],projectIds:[],sources:[]}}})
    expect((await queryWithRLS(f.member,'SELECT id FROM workflow_runs WHERE id=$1',[run.id])).rows).toHaveLength(0)
    const derived=(await pool.query('SELECT read_workflow_derivation_inputs($1,$2) AS inputs',[f.workspaceId,run.id])).rows[0].inputs
    expect(derived[0].evidence).toMatchObject({sensitivity:'confidential',sources:[expect.objectContaining({resourceId:f.task.id,userId:f.owner})]})
    await expect(pool.query("UPDATE workflow_runs SET input=jsonb_set(input,'{event,taskId}',to_jsonb($2::text)) WHERE id=$1",[run.id,randomUUID()])).rejects.toThrow('task_event_binding_immutable')
    await expect(f.create(await f.workflow(f.member))).rejects.toThrow()
    await pool.query("UPDATE tasks SET scope_held=true WHERE id=$1",[f.task.id])
    await expect(f.create(w)).rejects.toThrow()
  })
  it('retains the previous task scope when an update exposes previous values',async()=>{
    const f=await fixture(),w=await f.workflow(f.owner)
    const next=await updateTask(f.owner,f.task.id,{title:'Updated fixture task'})
    if (!next) throw new Error('Missing updated fixture task')
    const run=await f.create(w,next.id),evidence=await readWorkflowInputEvidence(run.id,f.workspaceId)
    expect(evidence.sources?.map(source=>source.resourceId).sort()).toEqual([f.task.id,next.id].sort())
  })
  it('does not fabricate a source floor for a missing historical receipt or a foreign task',async()=>{
    const f=await fixture(),w=await f.workflow(f.owner),other=await fixture()
    await expect(f.create(w,other.task.id)).rejects.toThrow('task_event_evidence_missing')
    await pool.query('DELETE FROM workflow_task_event_receipts WHERE task_id=$1',[f.task.id])
    await expect(f.create(w)).rejects.toThrow('task_event_evidence_missing')
    expect((await pool.query('SELECT id FROM workflow_runs WHERE workflow_id=$1',[w.id])).rows).toHaveLength(0)
  })
  it('rolls back a queue insertion whose captured authority boundary expires before commit',async()=>{
    const f=await fixture(),w=await f.workflow(f.owner),client=await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(`INSERT INTO workflow_runs(workflow_id,workspace_id,triggered_by,trigger_kind,input,task_event_valid_until)
        VALUES($1,$2,$3,'event',$4,clock_timestamp()+interval '100 milliseconds')`,
      [w.id,f.workspaceId,f.owner,JSON.stringify({trigger:{sourceType:'task'},event:{taskId:f.task.id}})])
      await client.query('SELECT pg_sleep(0.15)')
      await expect(client.query('COMMIT')).rejects.toThrow('workflow_dispatch_expired')
    } finally { await client.query('ROLLBACK');client.release() }
    expect((await pool.query('SELECT id FROM workflow_runs WHERE workflow_id=$1',[w.id])).rows).toHaveLength(0)
  })
})

import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { advanceWorkflowRun, buildTool, browserInputScope, pinToolAuthoringAuthority, executionToolContext, ContextScopeAccumulator, type AuthoritySource, type ScopeSource, type SandboxTaskRecord } from '@use-brian/core'
import { z } from 'zod'
import { createSandboxTaskStore } from '../../db/sandbox-task-store.js'
import { createDbWorkspaceFilesStore } from '../../db/workspace-files-store.js'
import { createWorkspaceFile } from '../../db/workspace-files.js'
import { resolveWorkspaceViewpoint } from '../../db/workspace-viewpoint.js'
import { withFileTransactionAdmission } from '../../workspace-access/file-transaction-admission.js'
import { resolveBrowserTaskExecutionAuthority } from '../../sandbox/task-execution-authority.js'
import { getPool, getAppPool, applyRLSGucs, queryWithRLS, runWithAgentAccess, runWithAgentClearance } from '../../db/client.js'
import { createDeal, createContact } from '../../db/crm.js'
import { createMemory } from '../../db/memories.js'
import { createDbWorkspaceGroupStore } from '../../db/workspace-group-store.js'
import { createDbWorkflowStore, createDbWorkflowRunStore } from '../../db/workflow-store.js'
import { captureAuthoringAuthoritySystem, resolveWorkflowRunScope } from '../workflow-authority.js'
import { readWorkflowInputEvidence } from '../workflow-input-evidence.js'
import { validateCallerScopeEvidence } from '../caller-evidence.js'
import { readWorkflowOutcomeWithLineage } from '../../crm-operations/workflow-copy-store.js'
const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()
const pool=getPool(), runs=createDbWorkflowRunStore()
async function fixture() {
  const workspaceId=randomUUID(),owner=randomUUID(),member=randomUUID(),assistantId=randomUUID()
  for(const id of [owner,member])await pool.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)',[id])
  await pool.query("INSERT INTO workspaces(id,name,owner_user_id) VALUES($1,'Event audience fixture',$2)",[workspaceId,owner])
  await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role,clearance,team_scope_mode) VALUES($1,$2,'owner','confidential','assigned'),($1,$3,'member','internal','assigned')",[workspaceId,owner,member])
  await pool.query("INSERT INTO assistants(id,name,workspace_id,owner_user_id,kind,clearance,compartments) VALUES($1,'Fixture primary',$2,$3,'primary','confidential',NULL)",[assistantId,workspaceId,owner])
  const groups=createDbWorkspaceGroupStore(),team=await groups.createTeam(owner,workspaceId,{name:'Fixture department',key:'fixture-department'})
  if(!team.compartmentKey)throw new Error('Fixture team has no compartment key')
  const teamKey=team.compartmentKey
  await groups.addMember(owner,team.id,member)
  const deal=await createDeal(owner,{workspaceId})
  await pool.query('UPDATE entities SET compartments=$2 WHERE id=$1',[deal.id,[team.compartmentKey]])
  const eventId=randomUUID()
  await pool.query(`INSERT INTO crm_domain_event_outbox(id,workspace_id,event_type,event_key,subject_kind,subject_id,payload,actor_kind)
    VALUES($1::uuid,$2,'crm.deal.stage_changed',$1::text,'deal',$3,'{}','user')`,[eventId,workspaceId,deal.id])
  const workflow=await createDbWorkflowStore().create({
    userId:member,
    workspaceId,
    name:'Event audience fixture',
    definition:{startStepId:'consult',steps:[{id:'consult',type:'assistant_call',target:{assistantId:'primary'},prompt:'Fixture question'}]},
    authoringAuthority:{
      version:1,
      assistantId,
      ceiling:{
        workspaceId,
        userId:member,
        clearance:'internal',
        compartments:[teamKey],
        mutationCompartments:[teamKey],
        projectIds:null,
        visibilityAssistantIds:null,
      },
    },
  })
  const input={trigger:{sourceType:'crm'},event:{domainEventId:eventId,subjectId:deal.id}}
  const create=(actor=member)=>runs.createRun({workflowId:workflow.id,workspaceId,triggeredBy:actor,triggerKind:'event',input})
  const revoke=()=>pool.query('DELETE FROM workspace_group_members WHERE group_id=$1 AND user_id=$2',[team.id,member])
  return {workspaceId,owner,member,assistantId,groups,team,deal,eventId,workflow,input,create,revoke}
}


async function derive(f: Awaited<ReturnType<typeof fixture>>, sources: ScopeSource[]) {
  return createMemory({workspaceId:f.workspaceId,userId:f.member,assistantId:f.assistantId,
    createdByUserId:f.member,summary:'Derived event note',sensitivity:'internal',
    derivation:{producer:'fixture:event',sources}})
}
// Simulate the executor's persisted high-water evidence, using canonical reads.
async function persistRunEvidence(run: {id:string;workspaceId:string}) {
  const evidence=await readWorkflowInputEvidence(run.id,run.workspaceId)
  await runs.updateRun(run.id,{vars:{__contextScopeEvidence:evidence}})
  return evidence
}
describe('[COMP:api/workflow-input-evidence] canonical causal inputs',()=>{
  afterAll(async()=>{await getAppPool().end();await pool.end()})
  it('admits primitive source metadata at the department tier without an implicit Project membership gate',async()=>{
    const f=await fixture(),project=randomUUID()
    await pool.query("INSERT INTO workspace_projects(id,workspace_id,name,normalized_name,created_by) VALUES($1,$2,'Source project','source project',$3)",[project,f.workspaceId,f.owner])
    const memory=await createMemory({workspaceId:f.workspaceId,userId:null,assistantId:f.assistantId,createdByUserId:f.owner,
      summary:'Protected primitive source',sensitivity:'confidential',compartments:[f.team.compartmentKey!],projectIds:[project]})
    await pool.query("UPDATE workspace_members SET clearance='public' WHERE workspace_id=$1 AND user_id=$2",[f.workspaceId,f.member])
    await pool.query("UPDATE department_edges SET clearance='confidential' WHERE workspace_id=$1 AND user_id=$2",[f.workspaceId,f.member])
    const read=async()=>(await queryWithRLS(f.member,"SELECT read_entity_derivation_source($1,'memory',$2) AS source",[f.workspaceId,memory.id])).rows[0].source
    expect(await read()).toMatchObject({resourceId:memory.id,sensitivity:'confidential',projectIds:[project]})
    const access={workspaceId:f.workspaceId,userId:f.member,clearance:'confidential' as const,compartments:[f.team.compartmentKey!],projectIds:[]}
    expect(await runWithAgentAccess(access,read)).toBeNull()
    expect(await runWithAgentAccess({...access,projectIds:[project]},read)).toMatchObject({resourceId:memory.id})
    const source=await read(),files=createDbWorkspaceFilesStore()
    const saved=await files.createDerived(f.member,{workspaceId:f.workspaceId,userId:source.userId,assistantId:source.assistantId,
      createdByUserId:f.member,sensitivity:source.sensitivity,compartments:source.compartments,projectIds:source.projectIds,
      path:`/${randomUUID()}.txt`,parentPath:'/',name:'Primitive.txt',mime:'text/plain',sizeBytes:1,storageUri:'fixture://primitive'},
      {producer:'primitive-fixture',sources:[source]})
    const viewer=(await resolveWorkspaceViewpoint(f.member,f.workspaceId))!
    expect(viewer.clearance).toBe('public')
    expect(viewer.departmentRead?.departments[f.team.id]).toBe('confidential')
    expect((await files.getById(viewer,saved.id))?.id).toBe(saved.id)
    await pool.query('UPDATE memories SET user_id=$2 WHERE id=$1',[memory.id,f.owner])
    expect(await read()).toBeNull()
    expect(await files.getById(viewer,saved.id)).toBeNull()
    await pool.query('UPDATE memories SET user_id=NULL,scope_held=true WHERE id=$1',[memory.id])
    expect(await read()).toBeNull()
    await pool.query('UPDATE memories SET scope_held=false WHERE id=$1',[memory.id])
    await f.revoke()
    expect(await read()).toBeNull()
  })
  it.each([['before','user'],['after','user'],['after','author']] as const)('rolls back a file when retained workflow authority expires %s host renewal (%s)',async(timing,principal)=>{
    const f=await fixture(),run=await f.create(),store=createSandboxTaskStore(),id=randomUUID()
    if(principal==='user')await pool.query("UPDATE department_edges SET expires_at=clock_timestamp()+interval '2 seconds' WHERE workspace_id=$1 AND user_id=$2",[f.workspaceId,f.member])
    else{
      const author=randomUUID()
      await pool.query("INSERT INTO assistants(id,name,workspace_id,owner_user_id,kind,clearance,compartments) VALUES($1,'Fixture author',$2,$3,'standard','confidential',NULL)",[author,f.workspaceId,f.member])
      await pool.query("INSERT INTO department_edges(workspace_id,department_id,principal_kind,assistant_id,clearance,origin,expires_at) VALUES($1,$2,'assistant',$3,'internal','store',clock_timestamp()+interval '2 seconds')",[f.workspaceId,f.team.id,author])
      const saved=await captureAuthoringAuthoritySystem({userId:f.member,workspaceId:f.workspaceId,assistantId:author})
      await pool.query('UPDATE workflows SET authoring_authority=$2::jsonb WHERE id=$1',[f.workflow.id,JSON.stringify(saved)])
    }
    const scope=await resolveWorkflowRunScope({userId:f.member,assistantId:f.assistantId,workspaceId:f.workspaceId,run})
    await persistRunEvidence(run)
    const record:SandboxTaskRecord={taskId:randomUUID(),sandboxId:'fictional-expiring-browser',userId:f.member,
      workspaceId:f.workspaceId,sessionId:run.id,status:'running',profileId:null,injectedSite:null,
      browserStartedAt:Date.now(),authorizedBudgetUsd:1,createdAt:Date.now(),lastActivityAt:Date.now(),
      executionAuthority:pinToolAuthoringAuthority(executionToolContext(scope.executionContext,{appId:'fixture'})),
      sourceAuthority:scope.executionContext.security.authority.snapshotSource!(),inputScope:browserInputScope({},f.workspaceId)}
    await store.create(record)
    let inserted=false
    const delay:Parameters<typeof withFileTransactionAdmission>[0]=async client=>async()=>{
      expect((await client.query('SELECT id FROM workspace_files WHERE id=$1',[id])).rows).toEqual([{id}])
      inserted=true
      await client.query('SELECT pg_sleep(2.1)')
    }
    const write=()=>createWorkspaceFile(f.member,{id,workspaceId:f.workspaceId,
      path:`/${id}.txt`,parentPath:'/',name:'Fixture.txt',mime:'text/plain',sizeBytes:4,storageUri:`fixture://${id}`,
      createdByUserId:f.member,sensitivity:'public'})
    const result=timing==='before'?withFileTransactionAdmission(delay,()=>store.withPublication!(record,write))
      :store.withPublication!(record,()=>withFileTransactionAdmission(delay,write))
    await expect(result).rejects.toMatchObject({code:'42501',message:timing==='before'?'workflow_authority_unavailable':'workflow_publication_expired'})
    expect(inserted).toBe(true)
    expect((await pool.query('SELECT id FROM workspace_files WHERE id=$1',[id])).rows).toEqual([])
    expect((await store.getActiveBySession(run.id))?.taskId).toBe(record.taskId)
  })
  it('renews workflow authority on the caller transaction without owner-pool reads',async()=>{
    const f=await fixture(),run=await f.create(),params={userId:f.member,assistantId:f.assistantId,workspaceId:f.workspaceId,run}
    await pool.query("UPDATE department_edges SET expires_at=clock_timestamp()+interval '2 seconds' WHERE workspace_id=$1 AND user_id=$2",[f.workspaceId,f.member])
    await resolveWorkflowRunScope(params)
    const evidence=await persistRunEvidence(run)
    const client=await getAppPool().connect()
    try{
      await client.query('BEGIN');await applyRLSGucs(client,f.member)
      await client.query("SELECT set_config('app.fixture_transaction_marker','retained',true)")
      const ownerRead=vi.spyOn(pool,'query').mockRejectedValue(new Error('Owner-pool escape'))
      try{
        expect(await readWorkflowInputEvidence(run.id,f.workspaceId,client)).toEqual(evidence)
        await expect(readWorkflowInputEvidence(randomUUID(),f.workspaceId,client)).rejects.toThrow('scope_source_changed')
        const scope=await resolveWorkflowRunScope(params,client)
        expect(await scope.executeWithAuthority(async()=> 'same transaction')).toBe('same transaction')
        expect(ownerRead.mock.calls.filter(([sql])=>typeof sql!=='string'||!sql.includes('pg_notify'))).toEqual([])
        expect((await client.query("SELECT current_setting('app.fixture_transaction_marker',true) AS marker")).rows[0].marker).toBe('retained')
        const unknown=(await client.query("SELECT read_workflow_validation_source($1,$2,'memory',$3) AS source",[f.workspaceId,run.id,randomUUID()])).rows[0].source
        expect(unknown).toEqual({held:true})
        await client.query('SELECT pg_sleep(2.1)')
        await expect(scope.executeWithAuthority(async()=> 'withheld')).rejects.toMatchObject({reason:'authority_changed'})
      }finally{ownerRead.mockRestore()}
    }finally{await client.query('ROLLBACK');client.release()}
  })
  it('reads enrichment at its department tier while retaining explicit Project limits',async()=>{
    const f=await fixture(),run=await f.create(),record=randomUUID(),project=randomUUID()
    await pool.query("INSERT INTO workspace_projects(id,workspace_id,name,normalized_name,created_by) VALUES($1,$2,'Enrichment project','enrichment project',$3)",[project,f.workspaceId,f.owner])
    await pool.query("INSERT INTO workspace_project_members(project_id,user_id) VALUES($1,$2)",[project,f.member])
    await pool.query(`INSERT INTO blueprint_records(id,workspace_id,spec_snapshot,subject,anchor_key,fields,source_kind,source_id,created_by,sensitivity,compartments,project_ids)
      VALUES($1::uuid,$2,'{}','Fictional departmental enrichment',$1::text,'{}','workflow',$3,$4,'confidential',$5,$6)`,[record,f.workspaceId,run.id,f.member,[f.team.compartmentKey],[project]])
    await pool.query("UPDATE workspace_members SET clearance='public' WHERE workspace_id=$1 AND user_id=$2",[f.workspaceId,f.member])
    await pool.query("UPDATE department_edges SET clearance='confidential' WHERE workspace_id=$1 AND user_id=$2",[f.workspaceId,f.member])
    const read=async()=>({rows:(await queryWithRLS(f.member,'SELECT id FROM blueprint_records WHERE id=$1',[record])).rows,
      source:(await queryWithRLS(f.member,"SELECT read_entity_derivation_source($1,'blueprint_record',$2) AS source",[f.workspaceId,record])).rows[0].source})
    expect(await read()).toMatchObject({rows:[{id:record}],source:{sensitivity:'confidential',projectIds:[project]}})
    const ceiling={workspaceId:f.workspaceId,userId:f.member,clearance:'confidential' as const,compartments:[f.team.compartmentKey!],projectIds:[]}
    expect(await runWithAgentAccess(ceiling,read)).toEqual({rows:[],source:null})
    expect(await runWithAgentAccess({...ceiling,projectIds:[project]},read)).toMatchObject({rows:[{id:record}],source:{resourceId:record}})
    await f.revoke()
    expect(await read()).toEqual({rows:[],source:null})
  })
  it('renews workflow source permission at file commit after an edge expires',async()=>{
    const f=await fixture(),run=await f.create(),id=randomUUID()
    await persistRunEvidence(run)
    await pool.query("UPDATE department_edges SET expires_at=clock_timestamp()+interval '2 seconds' WHERE workspace_id=$1 AND user_id=$2",[f.workspaceId,f.member])
    const client=await getAppPool().connect()
    try{
      await client.query('BEGIN');await applyRLSGucs(client,f.member)
      const source=(await client.query("SELECT read_entity_derivation_source($1,'workflow_run',$2) AS source",[f.workspaceId,run.id])).rows[0].source
      expect(source).not.toBeNull()
      const input={id,workspaceId:f.workspaceId,userId:source.userId,assistantId:source.assistantId,createdByUserId:f.member,
        sensitivity:source.sensitivity,compartments:source.compartments,projectIds:source.projectIds,
        path:`/${id}.txt`,parentPath:'/',name:'expiry.txt',mime:'text/plain',sizeBytes:1,
        storageUri:'fixture://workflow-expiry',tags:[],relatedIds:[],metadata:{}}
      await client.query('SELECT * FROM create_source_derived_file($1::jsonb,$2::jsonb)',[JSON.stringify(input),JSON.stringify({producer:'workflow-fixture',sources:[source,...source.requiredSources]})])
      await client.query('SELECT pg_sleep(2.1)')
      await expect(client.query('COMMIT')).rejects.toMatchObject({code:'42501',message:'scope_source_changed'})
    }finally{await client.query('ROLLBACK');client.release()}
    expect((await pool.query('SELECT id FROM workspace_files WHERE id=$1',[id])).rows).toEqual([])
  })
  it.each(['entity','cancel','copied-source'])('admits complete workflow-derived files and holds them after %s changes',async change=>{
    const f=await fixture(),origin=await f.create()
    await persistRunEvidence(origin)
    let run=origin
    if(change==='copied-source'){
      await pool.query("UPDATE workflow_runs SET status='completed',outcome='{\"summary\":\"Fixture outcome\"}' WHERE id=$1",[origin.id])
      run=await runs.createRun({workflowId:f.workflow.id,workspaceId:f.workspaceId,triggeredBy:f.member,triggerKind:'manual'})
      await readWorkflowOutcomeWithLineage(f.workflow.id,run.id)
      await persistRunEvidence(run)
    }
    const read=async(actor=f.member)=>(await queryWithRLS<{source:ScopeSource&{requiredSources:ScopeSource[]}}>(actor,
      "SELECT read_entity_derivation_source($1,'workflow_run',$2) AS source",[f.workspaceId,run.id])).rows[0].source
    const source=await read()
    expect(source).toMatchObject({resourceKind:'workflow_run',resourceId:run.id,compartments:[f.team.compartmentKey]})
    expect(source.requiredSources).toEqual(expect.arrayContaining([expect.objectContaining({resourceKind:'crm_event',resourceId:f.eventId})]))
    const files=createDbWorkspaceFilesStore()
    const input=()=>({workspaceId:f.workspaceId,userId:source.userId,assistantId:source.assistantId,createdByUserId:f.member,
      sensitivity:source.sensitivity,compartments:source.compartments,projectIds:source.projectIds,
      path:`/${randomUUID()}.txt`,parentPath:'/',name:'workflow.txt',mime:'text/plain',sizeBytes:1,
      storageUri:'fixture://workflow-download',tags:[],relatedIds:[],metadata:{}})
    // The canonical writer expands a run's required upstream sources itself (expandDerivedFileEvidence),
    // so a caller naming only the run still records every parent receipt and its floor.
    const expanded=await files.createDerived(f.member,input(),{producer:'workflow-fixture',sources:[source]})
    expect(expanded.compartments).toEqual([f.team.compartmentKey])
    const expandedReceipts=(await pool.query('SELECT source_kind,source_id FROM scope_derivation_sources WHERE derivation_id IN(SELECT id FROM scope_derivations WHERE resource_id=$1)',[expanded.id])).rows
    expect(expandedReceipts).toEqual(expect.arrayContaining(source.requiredSources.map(required=>({source_kind:required.resourceKind,source_id:required.resourceId}))))
    for(const dependency of [source,...source.requiredSources]){
      const renewed=(await queryWithRLS(f.member,'SELECT read_entity_derivation_source($1,$2,$3) AS source',[f.workspaceId,dependency.resourceKind,dependency.resourceId])).rows[0].source
      expect(renewed,dependency.resourceKind).toMatchObject({version:dependency.version,userId:dependency.userId,assistantId:dependency.assistantId,sensitivity:dependency.sensitivity,compartments:dependency.compartments,projectIds:dependency.projectIds})
    }
    const saved=await files.createDerived(f.member,input(),{producer:'workflow-fixture',sources:[source,...source.requiredSources]})
    expect(saved.compartments).toEqual([f.team.compartmentKey])
    await expect(pool.query("DELETE FROM scope_derivation_sources WHERE derivation_id IN(SELECT id FROM scope_derivations WHERE resource_id=$1) AND source_kind='crm_event'",[saved.id])).rejects.toMatchObject({code:'42501'})
    const access={workspaceId:f.workspaceId,userId:f.member,assistantId:f.assistantId,assistantKind:'primary' as const,clearance:'internal' as const}
    expect((await files.getById(access,saved.id))?.id).toBe(saved.id)
    if(change==='entity')await pool.query("UPDATE entities SET attributes=attributes||'{\"changed\":true}'::jsonb WHERE id=$1",[f.deal.id])
    else await runs.updateRun(origin.id,{status:'failed',error:{reason:'workflow_cancelled'}})
    expect((await pool.query('SELECT scope_held FROM workspace_files WHERE id=$1',[saved.id])).rows[0].scope_held).toBe(true)
    expect(await files.getById(access,saved.id)).toBeNull()
    await expect(files.createDerived(f.member,input(),{producer:'workflow-fixture',sources:[source,...source.requiredSources]})).rejects.toThrow()
    if(change==='entity'){
      await pool.query('DELETE FROM scope_derivations WHERE workspace_id=$1 AND resource_id=$2',[f.workspaceId,saved.id])
      expect((await pool.query('SELECT id FROM scope_derivations WHERE resource_id=$1',[saved.id])).rows).toEqual([])
    }
  })
  it('locks derivation input ancestry and preserves independent saved evidence',async()=>{
    const f=await fixture(),source=await f.create()
    const captured=new ContextScopeAccumulator(await persistRunEvidence(source))
    const privateAssistant=randomUUID()
    await pool.query("INSERT INTO assistants(id,workspace_id,owner_user_id,name,kind,clearance) VALUES($1,$2,$3,'Private fixture assistant','standard','internal')",[privateAssistant,f.workspaceId,f.member])
    const memory=await createMemory({workspaceId:f.workspaceId,userId:f.member,assistantId:privateAssistant,createdByUserId:f.member,summary:'Private copied fixture',sensitivity:'internal'})
    captured.note({sources:[(await pool.query("SELECT read_scope_source($1,'memory',$2) AS source",[f.workspaceId,memory.id])).rows[0].source]})
    const evidence=captured.evidence
    await runs.updateRun(source.id,{vars:{__contextScopeEvidence:evidence}})
    await pool.query("UPDATE workflow_runs SET status='completed',outcome='{\"summary\":\"Fixture outcome\"}' WHERE id=$1",[source.id])
    const target=await runs.createRun({workflowId:f.workflow.id,workspaceId:f.workspaceId,triggeredBy:f.member,triggerKind:'manual'})
    await readWorkflowOutcomeWithLineage(f.workflow.id,target.id)
    await persistRunEvidence(target)
    const client=await pool.connect(),other=await pool.connect()
    try{
      await client.query('BEGIN')
      const inputs=(await client.query('SELECT read_workflow_derivation_inputs($1,$2) AS inputs',[f.workspaceId,target.id])).rows[0].inputs
      expect(inputs).toHaveLength(2)
      expect(inputs).toEqual(expect.arrayContaining([expect.objectContaining({runId:source.id,evidence})]))
      await other.query('BEGIN')
      await expect(other.query('SELECT id FROM workflow_runs WHERE id=$1 FOR UPDATE NOWAIT',[source.id])).rejects.toMatchObject({code:'55P03'})
      await other.query('ROLLBACK')
    }finally{await client.query('ROLLBACK');await other.query('ROLLBACK');client.release();other.release()}
    await expect(queryWithRLS(f.member,'SELECT read_workflow_derivation_inputs($1,$2)',[f.workspaceId,target.id])).rejects.toMatchObject({code:'42501'})
    const sourceSql="SELECT read_entity_derivation_source($1,'workflow_run',$2) AS source"
    expect((await queryWithRLS(f.member,sourceSql,[f.workspaceId,target.id])).rows[0].source).toMatchObject({userId:f.member,assistantId:privateAssistant})
    expect((await queryWithRLS(f.owner,sourceSql,[f.workspaceId,target.id])).rows[0].source).toBeNull()
    await runs.updateRun(source.id,{vars:{__contextScopeEvidence:{...evidence,sensitivity:'confidential'}}})
    await expect(pool.query('SELECT read_workflow_derivation_inputs($1,$2)',[f.workspaceId,target.id])).rejects.toThrow('scope_source_changed')
  })
  it('refuses missing derivation capture and unavailable runs without inventing an envelope',async()=>{
    const f=await fixture(),run=await f.create()
    const read=(workspace=f.workspaceId,id=run.id)=>pool.query('SELECT read_workflow_derivation_inputs($1,$2)',[workspace,id])
    await expect(read()).rejects.toThrow('scope_evidence_missing')
    await persistRunEvidence(run)
    await expect(read()).resolves.toBeDefined()
    await expect(read(randomUUID())).rejects.toThrow('scope_evidence_missing')
    await expect(read(f.workspaceId,randomUUID())).rejects.toThrow('scope_evidence_missing')
    await runs.updateRun(run.id,{status:'failed',error:{reason:'workflow_cancelled'}})
    await expect(read()).rejects.toThrow('scope_evidence_missing')
  })
  it.each(['member','missing','stripped','later-step'])('cold-renews a causal browser task and denies %s evidence loss',async change=>{
    const f=await fixture(),run=await f.create(),store=createSandboxTaskStore()
    const observed=await createMemory({workspaceId:f.workspaceId,userId:f.member,assistantId:f.assistantId,createdByUserId:f.member,summary:'Private later-step fixture',sensitivity:'internal'})
    const observedSource=(await pool.query("SELECT read_scope_source($1,'memory',$2) AS source",[f.workspaceId,observed.id])).rows[0].source
    let earlySource:AuthoritySource|undefined
    const readTool=buildTool({name:'readFixture',description:'Read a protected fixture',inputSchema:z.object({}),async execute(_input,ctx){
      earlySource=ctx.authority!.snapshotSource!()
      return{data:{ok:true},scopeEvidence:{sources:[observedSource]}}
    }})
    await pool.query('UPDATE workflows SET definition=$2::jsonb WHERE id=$1',[f.workflow.id,JSON.stringify({
      startStepId:change==='later-step'?'read':'browser',steps:[{id:'read',type:'tool_call',toolName:'readFixture',arguments:{},nextStepId:'browser'},{id:'browser',type:'tool_call',toolName:'browserFixture',arguments:{}}],
    })])
    const tool=buildTool({name:'browserFixture',description:'Persist a fixture browser task',inputSchema:z.object({}),
      async execute(_input,ctx){
        const record:SandboxTaskRecord={taskId:randomUUID(),sandboxId:'fictional-causal-browser',userId:f.member,
          workspaceId:f.workspaceId,sessionId:run.id,status:'running',profileId:null,injectedSite:null,
          browserStartedAt:Date.now(),authorizedBudgetUsd:1,createdAt:Date.now(),lastActivityAt:Date.now(),
          executionAuthority:pinToolAuthoringAuthority(ctx),sourceAuthority:ctx.authority!.snapshotSource!(),
          inputScope:browserInputScope({},f.workspaceId)}
        await store.create(record)
        return{data:{ok:true}}
      },
    })
    const result=await advanceWorkflowRun({workflowStore:createDbWorkflowStore(),runStore:runs,
      resolvePrimary:async()=>f.assistantId,resolveRunScope:resolveWorkflowRunScope,
      buildToolRegistry:async()=>new Map([[tool.name,tool],[readTool.name,readTool]]),
      consultTransport:{async send(){throw new Error('Unexpected consult')}},
    },run.id)
    expect(result,JSON.stringify(result)).toMatchObject({kind:'completed'})
    const loaded=await createSandboxTaskStore().getActiveBySession(run.id)
    expect(loaded?.sourceAuthority?.kind).toBe('workflow')
    if(change==='later-step'){
      expect(loaded?.sourceAuthority).not.toEqual(earlySource)
      expect((await runs.getRunSystem(run.id))?.vars.__contextScopeEvidence).toMatchObject({sources:expect.arrayContaining([expect.objectContaining({resourceKind:'memory',resourceId:observed.id,userId:f.member})])})
      const earlier=await resolveBrowserTaskExecutionAuthority({...loaded!,sourceAuthority:earlySource})
      await expect(earlier.assertCurrent()).rejects.toMatchObject({reason:'authority_changed'})
    }
    const cold=await resolveBrowserTaskExecutionAuthority(loaded!)
    expect(await cold.execute(async()=> 'current causal task')).toBe('current causal task')
    if(change==='member'||change==='later-step')await f.revoke()
    else if(change==='missing')await pool.query("UPDATE workflow_runs SET vars=vars-'__contextScopeEvidence' WHERE id=$1",[run.id])
    else await pool.query("UPDATE workflow_runs SET vars=jsonb_set(vars,'{__contextScopeEvidence,sources}','[]') WHERE id=$1",[run.id])
    await expect(cold.execute(async()=> 'withheld')).rejects.toMatchObject({reason:'authority_changed'})
  })
  it('preserves the saved audience after release and records event plus current-entity edges',async()=>{
    const f=await fixture(),run=await f.create()
    await pool.query("UPDATE entities SET compartments='{}' WHERE id=$1",[f.deal.id])
    const scope=await resolveWorkflowRunScope({userId:f.member,assistantId:f.assistantId,workspaceId:f.workspaceId,run})
    expect(scope.inputScopeEvidence.sources).toEqual(expect.arrayContaining([
      expect.objectContaining({resourceKind:'crm_event',resourceId:f.eventId,compartments:[f.team.compartmentKey]}),
      expect.objectContaining({resourceKind:'entity',resourceId:f.deal.id,compartments:[]}),
    ]))
    const memory=await derive(f,scope.inputScopeEvidence.sources!)
    expect(memory.compartments).toEqual([f.team.compartmentKey])
    expect((await pool.query('SELECT source_kind FROM scope_derivation_sources s JOIN scope_derivations d ON d.id=s.derivation_id WHERE d.resource_id=$1 ORDER BY source_kind',[memory.id])).rows).toEqual([{source_kind:'crm_event'},{source_kind:'entity'}])
  })
  it.each(['payload','actor','time','hold','delete','retire','entity'] as const)('withholds existing descendants and refuses stale %s inputs',async change=>{
    const f=await fixture(),run=await f.create(),evidence=await readWorkflowInputEvidence(run.id,f.workspaceId)
    const memory=await derive(f,evidence.sources!)
    if(change==='payload')await pool.query(`UPDATE crm_domain_event_outbox SET payload='{"changed":true}' WHERE id=$1`,[f.eventId])
    if(change==='actor')await pool.query("UPDATE crm_domain_event_outbox SET actor_kind='import' WHERE id=$1",[f.eventId])
    if(change==='time')await pool.query("UPDATE crm_domain_event_outbox SET occurred_at=occurred_at+interval '1 minute' WHERE id=$1",[f.eventId])
    if(change==='hold')await pool.query('UPDATE crm_domain_event_outbox SET scope_held=true WHERE id=$1',[f.eventId])
    if(change==='delete') {
      await pool.query('DELETE FROM workflow_runs WHERE id=$1',[run.id])
      await pool.query('DELETE FROM crm_domain_event_outbox WHERE id=$1',[f.eventId])
    }
    if(change==='retire')await pool.query("UPDATE crm_domain_event_outbox SET retired_from_status=status,retired_at=now(),status='retired',subject_id='00000000-0000-0000-0000-000000000000',payload=jsonb_build_object('erased',true,'eventType',event_type) WHERE id=$1",[f.eventId])
    if(change==='entity')await pool.query("UPDATE entities SET attributes=attributes||'{\"changed\":true}'::jsonb WHERE id=$1",[f.deal.id])
    expect((await pool.query('SELECT scope_held FROM memories WHERE id=$1',[memory.id])).rows[0].scope_held).toBe(true)
    await expect(derive(f,evidence.sources!)).rejects.toThrow('scope_source_changed')
  })
  it('requires the current entity edge at the canonical writer',async()=>{
    const f=await fixture(),run=await f.create(),evidence=await readWorkflowInputEvidence(run.id,f.workspaceId)
    await expect(derive(f,evidence.sources!.filter(s=>s.resourceKind==='crm_event'))).rejects.toThrow('scope_evidence_missing')
  })
  it('keeps delivery bookkeeping outside content versions',async()=>{
    const f=await fixture(),run=await f.create(),before=await readWorkflowInputEvidence(run.id,f.workspaceId)
    await pool.query("UPDATE crm_domain_event_outbox SET status='delivered',attempts=attempts+1 WHERE id=$1",[f.eventId])
    expect(await readWorkflowInputEvidence(run.id,f.workspaceId)).toEqual(before)
    expect((await derive(f,before.sources!)).id).toBeTruthy()
  })
  it('rejects changed event content during execution and stale persisted evidence on resume',async()=>{
    const f=await fixture(),run=await f.create(),params={userId:f.member,assistantId:f.assistantId,workspaceId:f.workspaceId,run}
    const scope=await resolveWorkflowRunScope(params)
    await runs.updateRun(run.id,{vars:{__contextScopeEvidence:scope.inputScopeEvidence}})
    await expect(scope.executeWithAuthority(async()=>{
      await pool.query(`UPDATE crm_domain_event_outbox SET payload='{"updated":true}' WHERE id=$1`,[f.eventId])
      return 'Stale answer'
    })).rejects.toMatchObject({reason:'authority_changed',operationMayHaveExecuted:true})
    await expect(resolveWorkflowRunScope(params)).rejects.toMatchObject({reason:'workflow_authority_unavailable'})
  })
  it('follows copied outcome receipts instead of forged source IDs in input JSON',async()=>{
    const f=await fixture(),source=await f.create()
    await persistRunEvidence(source)
    await pool.query("UPDATE workflow_runs SET status='completed',outcome='{\"summary\":\"Protected\"}' WHERE id=$1",[source.id])
    const target=await runs.createRun({workflowId:f.workflow.id,workspaceId:f.workspaceId,triggeredBy:f.member,triggerKind:'manual',input:{event:{domainEventId:randomUUID()}}})
    const version=async()=>Number((await pool.query('SELECT derivation_source_version FROM workflow_runs WHERE id=$1',[target.id])).rows[0].derivation_source_version)
    const before=await version()
    expect((await readWorkflowInputEvidence(target.id,f.workspaceId)).sources).toBeUndefined()
    await readWorkflowOutcomeWithLineage(f.workflow.id,target.id)
    expect(await version()).toBe(before+1)
    expect((await readWorkflowInputEvidence(target.id,f.workspaceId)).sources).toEqual(expect.arrayContaining([expect.objectContaining({resourceKind:'crm_event',resourceId:f.eventId})]))
    await readWorkflowOutcomeWithLineage(f.workflow.id,target.id)
    expect(await version()).toBe(before+1)
    await pool.query('DELETE FROM workflow_run_copy_sources WHERE run_id=$1',[target.id])
    expect(await version()).toBe(before+2)
    expect((await readWorkflowInputEvidence(target.id,f.workspaceId)).sources).toBeUndefined()
  })
  it('retains non-CRM copied evidence and enforces private, Project and assistant axes',async()=>{
    const f=await fixture(),projectId=randomUUID(),sourceAssistant=randomUUID()
    await pool.query("INSERT INTO workspace_projects(id,workspace_id,name,normalized_name,created_by) VALUES($1,$2,'Evidence project','evidence project',$3)",[projectId,f.workspaceId,f.member])
    await pool.query("INSERT INTO assistants(id,workspace_id,owner_user_id,name,kind,clearance) VALUES($1,$2,$3,'Evidence assistant','standard','internal')",[sourceAssistant,f.workspaceId,f.member])
    const memory=await createMemory({workspaceId:f.workspaceId,userId:f.member,assistantId:sourceAssistant,
      createdByUserId:f.member,summary:'Private fictional source',sensitivity:'internal',compartments:[f.team.compartmentKey!],projectIds:[projectId]})
    const snapshot=(await pool.query<{source:ScopeSource}>("SELECT read_scope_source($1,'memory',$2) AS source",[f.workspaceId,memory.id])).rows[0].source
    const evidence=new ContextScopeAccumulator({sources:[snapshot]}).evidence
    const source=await runs.createRun({workflowId:f.workflow.id,workspaceId:f.workspaceId,triggeredBy:f.member,triggerKind:'manual',input:{}})
    await runs.updateRun(source.id,{vars:{__contextScopeEvidence:evidence}})
    await pool.query("UPDATE workflow_runs SET status='completed',outcome='{\"summary\":\"Private context\"}' WHERE id=$1",[source.id])
    const target=await runs.createRun({workflowId:f.workflow.id,workspaceId:f.workspaceId,triggeredBy:f.member,triggerKind:'manual',input:{}})
    await pool.query(`INSERT INTO workflow_run_copy_sources(workspace_id,run_id,source_run_id,run_scope_evidence,run_source_version)
      VALUES($1,$2,$3,'{}',999)`,[f.workspaceId,target.id,source.id])
    const copied=await readWorkflowInputEvidence(target.id,f.workspaceId)
    expect(copied).toEqual(evidence)
    await persistRunEvidence(target)
    const step=randomUUID()
    await pool.query("INSERT INTO workflow_step_runs(id,run_id,step_id,step_type,status) VALUES($1,$2,'inspect','branch','completed')",[step,target.id])
    const history=async(userId:string)=>(await queryWithRLS(userId,'SELECT id FROM workflow_runs WHERE id=$1',[target.id])).rows
    expect(await history(f.member)).toEqual([{id:target.id}])
    expect(await history(f.owner)).toEqual([])
    const ceiling={workspaceId:f.workspaceId,userId:f.member,clearance:'internal' as const,
      compartments:[f.team.compartmentKey!],mutationCompartments:[f.team.compartmentKey!],projectIds:[projectId],visibilityAssistantIds:[sourceAssistant]}
    expect(await validateCallerScopeEvidence(copied,ceiling)).toEqual(evidence)
    expect(await runWithAgentAccess({...ceiling,sharedAudience:true},()=>history(f.member))).toEqual([])
    for(const narrowed of [{userId:f.owner},{projectIds:[]},{visibilityAssistantIds:[]}]) {
      await expect(validateCallerScopeEvidence(copied,{...ceiling,...narrowed})).rejects.toMatchObject({reason:'caller_evidence_unavailable'})
      await runWithAgentAccess({...ceiling,...narrowed},async()=>{
        const actor=narrowed.userId??f.member
        expect(await history(actor)).toEqual([])
        expect((await queryWithRLS(actor,'SELECT count(*)::int AS count FROM workflow_runs WHERE id=$1',[target.id])).rows).toEqual([{count:0}])
        expect((await queryWithRLS(actor,'SELECT id FROM workflow_step_runs WHERE id=$1',[step])).rows).toEqual([])
      })
      const deniedTarget=await runs.createRun({workflowId:f.workflow.id,workspaceId:f.workspaceId,triggeredBy:narrowed.userId??f.member,triggerKind:'manual',input:{}})
      expect(await runWithAgentAccess({...ceiling,...narrowed},()=>readWorkflowOutcomeWithLineage(f.workflow.id,deniedTarget.id))).toBeNull()
      expect((await pool.query('SELECT run_id FROM workflow_run_copy_sources WHERE run_id=$1',[deniedTarget.id])).rows).toEqual([])
    }
    expect(await runWithAgentAccess(ceiling,()=>readWorkflowOutcomeWithLineage(f.workflow.id,target.id))).toMatchObject({summary:'Private context'})
    await pool.query("UPDATE memories SET sensitivity='confidential' WHERE id=$1",[memory.id])
    expect(await runWithAgentAccess(ceiling,()=>history(f.member))).toEqual([])
    expect(await runWithAgentAccess(ceiling,()=>readWorkflowOutcomeWithLineage(f.workflow.id,target.id))).toBeNull()
    await pool.query("UPDATE memories SET sensitivity='internal',summary='Edited fictional context' WHERE id=$1",[memory.id])
    expect(await runWithAgentAccess(ceiling,()=>history(f.member))).toEqual([{id:target.id}])
    expect(await runWithAgentAccess(ceiling,()=>readWorkflowOutcomeWithLineage(f.workflow.id,target.id))).toMatchObject({summary:'Private context'})
    await expect(pool.query("UPDATE workflow_run_copy_sources SET run_scope_evidence='{}' WHERE run_id=$1",[target.id])).rejects.toThrow('workflow_copy_source_immutable')
    await runs.updateRun(source.id,{status:'running'})
    expect(await readWorkflowInputEvidence(target.id,f.workspaceId)).toEqual(evidence)
    await runs.updateRun(source.id,{vars:{__contextScopeEvidence:{sensitivity:'public',compartments:[],projectIds:[]}}})
    await expect(readWorkflowInputEvidence(target.id,f.workspaceId)).rejects.toThrow('scope_source_changed')
    await runs.updateRun(source.id,{vars:{__contextScopeEvidence:evidence}})
    await expect(readWorkflowInputEvidence(target.id,f.workspaceId)).rejects.toThrow('scope_source_changed')
  })
  it('admits Confidential department evidence for a Public-General member and preserves credential binding',async()=>{
    const f=await fixture()
    await pool.query('UPDATE workspaces SET department_read_v2=true WHERE id=$1',[f.workspaceId])
    await pool.query("UPDATE workspace_members SET clearance='public' WHERE workspace_id=$1 AND user_id=$2",[f.workspaceId,f.member])
    await pool.query("UPDATE department_edges SET clearance='confidential' WHERE workspace_id=$1 AND department_id=$2 AND user_id=$3",[f.workspaceId,f.team.id,f.member])
    const source=await runs.createRun({workflowId:f.workflow.id,workspaceId:f.workspaceId,triggeredBy:f.member,triggerKind:'manual',input:{}})
    await runs.updateRun(source.id,{vars:{__contextScopeEvidence:{sensitivity:'confidential',compartments:[f.team.compartmentKey],projectIds:[]}}})
    await pool.query("UPDATE workflow_runs SET status='completed',outcome='{\"summary\":\"Department context\"}' WHERE id=$1",[source.id])
    const target=await runs.createRun({workflowId:f.workflow.id,workspaceId:f.workspaceId,triggeredBy:f.member,triggerKind:'manual',input:{}})
    const grant={workspaceId:f.workspaceId,userId:f.member,assistantId:null,base:'public' as const,departments:{[f.team.id]:'confidential' as const},contextDepartment:null,binding:null,cap:null}
    const access={workspaceId:f.workspaceId,userId:f.member,clearance:'public' as const,compartments:null,projectIds:null,departmentRead:grant}
    const history=async()=>(await queryWithRLS(f.member,'SELECT id FROM workflow_runs WHERE id=$1',[source.id])).rows
    expect(await runWithAgentAccess(access,history)).toEqual([{id:source.id}])
    expect(await runWithAgentAccess({...access,departmentRead:{...grant,binding:[]}},history)).toEqual([])
    expect(await runWithAgentClearance('confidential',history)).toEqual([])
    const client=await getAppPool().connect()
    try {
      await client.query('BEGIN')
      await runWithAgentAccess(access,()=>applyRLSGucs(client,f.member))
      expect((await client.query('SELECT id FROM workflow_runs WHERE id=$1',[source.id])).rows).toEqual([{id:source.id}])
      await client.query('ROLLBACK')
      await client.query('BEGIN')
      await runWithAgentClearance('confidential',()=>applyRLSGucs(client,f.member))
      expect((await client.query("SELECT current_setting('app.v2_active',true) AS active")).rows[0].active).not.toBe('true')
      expect((await client.query('SELECT id FROM workflow_runs WHERE id=$1',[source.id])).rows).toEqual([])
    } finally {await client.query('ROLLBACK');client.release()}
    expect(await runWithAgentClearance('confidential',()=>readWorkflowOutcomeWithLineage(f.workflow.id,target.id))).toBeNull()
    expect(await runWithAgentAccess({...access,departmentRead:{...grant,binding:[]}},()=>readWorkflowOutcomeWithLineage(f.workflow.id,target.id))).toBeNull()
    expect((await pool.query('SELECT run_id FROM workflow_run_copy_sources WHERE run_id=$1',[target.id])).rows).toEqual([])
    expect(await runWithAgentAccess(access,()=>readWorkflowOutcomeWithLineage(f.workflow.id,target.id))).toMatchObject({summary:'Department context'})
  })
  it('holds source and authority rows until a copied outcome commits, then observes revocation',async()=>{
    const f=await fixture(),source=await f.create()
    await persistRunEvidence(source)
    await pool.query("UPDATE workflow_runs SET status='completed',outcome='{\"summary\":\"Concurrent context\"}' WHERE id=$1",[source.id])
    const target=await runs.createRun({workflowId:f.workflow.id,workspaceId:f.workspaceId,triggeredBy:f.member,triggerKind:'manual',input:{}})
    const name=`fixture_copy_gate_${randomUUID().replaceAll('-','')}`,key=Number.parseInt(randomUUID().slice(0,7),16)
    const gate=await pool.connect(),probe=await pool.connect()
    let copying: ReturnType<typeof readWorkflowOutcomeWithLineage> | undefined
    try {
      await gate.query('SELECT pg_advisory_lock($1)',[key])
      await pool.query(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.run_id='${target.id}'::uuid THEN PERFORM pg_advisory_xact_lock(${key}); END IF;
        RETURN NEW; END $$`)
      await pool.query(`CREATE TRIGGER ${name} AFTER INSERT ON workflow_run_copy_sources FOR EACH ROW EXECUTE FUNCTION ${name}()`)
      copying=readWorkflowOutcomeWithLineage(f.workflow.id,target.id)
      // Observe the actual pending advisory lock, not an assumed timer window.
      let waiting=false
      for(let attempt=0;attempt<100;attempt++) {
        waiting=(await probe.query('SELECT 1 FROM pg_locks WHERE locktype=\'advisory\' AND objid=$1 AND NOT granted',[key])).rowCount!>0
        if(waiting)break
        await new Promise(resolve=>setTimeout(resolve,10))
      }
      expect(waiting).toBe(true)
      for(const [sql,values] of [
        ['SELECT id FROM entities WHERE id=$1 FOR UPDATE NOWAIT',[f.deal.id]],
        ['SELECT user_id FROM workspace_members WHERE workspace_id=$1 AND user_id=$2 FOR UPDATE NOWAIT',[f.workspaceId,f.member]],
        ['SELECT id FROM department_edges WHERE workspace_id=$1 AND user_id=$2 FOR UPDATE NOWAIT',[f.workspaceId,f.member]],
      ] as const) {
        await probe.query('BEGIN')
        try { await expect(probe.query(sql,[...values])).rejects.toMatchObject({code:'55P03'}) }
        finally { await probe.query('ROLLBACK') }
      }
      await gate.query('SELECT pg_advisory_unlock($1)',[key])
      expect(await copying).toMatchObject({summary:'Concurrent context'})
      await f.revoke()
      expect(await readWorkflowOutcomeWithLineage(f.workflow.id,target.id)).toBeNull()
      expect((await pool.query('SELECT run_id FROM workflow_run_copy_sources WHERE run_id=$1',[target.id])).rows).toHaveLength(1)
    } finally {
      await gate.query('SELECT pg_advisory_unlock($1)',[key])
      await copying?.catch(()=>{})
      await pool.query(`DROP TRIGGER IF EXISTS ${name} ON workflow_run_copy_sources`)
      await pool.query(`DROP FUNCTION IF EXISTS ${name}()`)
      probe.release();gate.release()
    }
  })
  it.each([undefined,null,{},'unknown',{sensitivity:'public',compartments:'unknown',projectIds:[]}])('refuses missing or malformed copied evidence %j',async evidence=>{
    const f=await fixture(),source=await runs.createRun({workflowId:f.workflow.id,workspaceId:f.workspaceId,triggeredBy:f.member,triggerKind:'manual',input:{}})
    await runs.updateRun(source.id,{vars:evidence===undefined?{}:{__contextScopeEvidence:evidence}})
    const target=await runs.createRun({workflowId:f.workflow.id,workspaceId:f.workspaceId,triggeredBy:f.member,triggerKind:'manual',input:{}})
    await pool.query('INSERT INTO workflow_run_copy_sources(workspace_id,run_id,source_run_id) VALUES($1,$2,$3)',[f.workspaceId,target.id,source.id])
    await expect(readWorkflowInputEvidence(target.id,f.workspaceId)).rejects.toThrow('scope_source_changed')
    expect((await queryWithRLS(f.member,'SELECT id FROM workflow_runs WHERE id=$1',[target.id])).rows).toEqual([])
    await expect(resolveWorkflowRunScope({userId:f.member,assistantId:f.assistantId,workspaceId:f.workspaceId,run:target})).rejects.toMatchObject({reason:'workflow_authority_unavailable'})
  })
  it('starts fresh without copying an unverifiable historical outcome',async()=>{
    const f=await fixture(),source=await f.create()
    await pool.query("UPDATE workflow_runs SET status='completed',outcome='{\"summary\":\"Historical context\"}' WHERE id=$1",[source.id])
    expect((await queryWithRLS(f.member,'SELECT id FROM workflow_runs WHERE id=$1',[source.id])).rows).toEqual([])
    expect((await queryWithRLS(f.member,'SELECT count(*)::int AS count FROM workflow_runs WHERE id=$1',[source.id])).rows).toEqual([{count:0}])
    const target=await runs.createRun({workflowId:f.workflow.id,workspaceId:f.workspaceId,triggeredBy:f.member,triggerKind:'manual',input:{}})
    expect(await readWorkflowOutcomeWithLineage(f.workflow.id,target.id)).toBeNull()
    expect((await pool.query('SELECT run_id FROM workflow_run_copy_sources WHERE run_id=$1',[target.id])).rows).toEqual([])
    const scope=await resolveWorkflowRunScope({userId:f.member,assistantId:f.assistantId,workspaceId:f.workspaceId,run:target})
    expect(await scope.executeWithAuthority(async()=>'Fresh execution')).toBe('Fresh execution')
    await persistRunEvidence(target)
    expect((await queryWithRLS(f.member,'SELECT id FROM workflow_runs WHERE id=$1',[target.id])).rows).toEqual([{id:target.id}])
    expect((await pool.query('SELECT vars,outcome FROM workflow_runs WHERE id=$1',[source.id])).rows[0]).toEqual({vars:{},outcome:{summary:'Historical context'}})
  })
  it('withholds a previously copied outcome after its retained source evidence changes',async()=>{
    const f=await fixture(),source=await f.create()
    const evidence=await persistRunEvidence(source)
    await pool.query("UPDATE workflow_runs SET status='completed',outcome='{\"summary\":\"Current context\"}' WHERE id=$1",[source.id])
    const target=await runs.createRun({workflowId:f.workflow.id,workspaceId:f.workspaceId,triggeredBy:f.member,triggerKind:'manual',input:{}})
    expect(await readWorkflowOutcomeWithLineage(f.workflow.id,target.id)).toMatchObject({summary:'Current context'})
    await runs.updateRun(source.id,{vars:{__contextScopeEvidence:{...evidence,sensitivity:'confidential'}}})
    expect(await readWorkflowOutcomeWithLineage(f.workflow.id,target.id)).toBeNull()
    expect((await pool.query('SELECT run_id FROM workflow_run_copy_sources WHERE run_id=$1',[target.id])).rows).toHaveLength(1)
    await expect(readWorkflowInputEvidence(target.id,f.workspaceId)).rejects.toThrow('scope_source_changed')
  })
  it.each(['reassign','delete'] as const)('holds association event descendants on subject %s',async change=>{
    const f=await fixture(),contact=await createContact(f.owner,{workspaceId:f.workspaceId,name:'Fixture contact'}),subject=randomUUID(),eventId=randomUUID()
    await pool.query(`INSERT INTO association_enquiries(id,workspace_id,contact_id,source,source_submission_id,request_fingerprint,subject,message)
      VALUES($1::uuid,$2,$3,'fixture',$1::text,repeat('a',64),'Fixture','Fixture')`,[subject,f.workspaceId,contact.id])
    await pool.query(`INSERT INTO crm_domain_event_outbox(id,workspace_id,event_type,event_key,subject_kind,subject_id,actor_kind)
      VALUES($1::uuid,$2,'crm.submission.received',$1::text,'submission',$3,'user')`,[eventId,f.workspaceId,subject])
    f.input.event.domainEventId=eventId
    const run=await f.create(),evidence=await readWorkflowInputEvidence(run.id,f.workspaceId),memory=await derive(f,evidence.sources!)
    if(change==='reassign') {
      const other=await createContact(f.owner,{workspaceId:f.workspaceId,name:'Other fixture'})
      await pool.query('UPDATE association_enquiries SET contact_id=$2 WHERE id=$1',[subject,other.id])
    } else await pool.query('DELETE FROM association_enquiries WHERE id=$1',[subject])
    expect((await pool.query('SELECT scope_held FROM memories WHERE id=$1',[memory.id])).rows[0].scope_held).toBe(true)
    await expect(derive(f,evidence.sources!)).rejects.toThrow('scope_source_changed')
    if(change==='reassign') {
      await pool.query('UPDATE association_enquiries SET contact_id=$2 WHERE id=$1',[subject,contact.id])
      await expect(derive(f,evidence.sources!)).rejects.toThrow('scope_source_changed')
    }
  })
  it.each(['edit','release','delete'] as const)('retains exact blueprint evidence and invalidates descendants after %s',async change=>{
    const f=await fixture(),source=await runs.createRun({workflowId:f.workflow.id,workspaceId:f.workspaceId,triggeredBy:f.member,triggerKind:'manual',input:{}}),record=randomUUID()
    await persistRunEvidence(source)
    await pool.query("UPDATE workflow_runs SET status='completed',outcome='{\"summary\":\"Prior\"}' WHERE id=$1",[source.id])
    await pool.query(`INSERT INTO blueprint_records(id,workspace_id,spec_snapshot,subject,anchor_key,fields,source_kind,source_id,created_by,sensitivity,compartments)
      VALUES($1::uuid,$2,'{}','Fictional enrichment',$1::text,'{"note":"Protected"}','workflow',$3,$4,'internal',$5)`,[record,f.workspaceId,source.id,f.member,[f.team.compartmentKey]])
    const target=await runs.createRun({workflowId:f.workflow.id,workspaceId:f.workspaceId,triggeredBy:f.member,triggerKind:'manual',input:{}})
    expect(await readWorkflowOutcomeWithLineage(f.workflow.id,target.id)).toMatchObject({output:{note:'Protected'}})
    const evidence=await readWorkflowInputEvidence(target.id,f.workspaceId)
    expect(evidence.sources).toEqual(expect.arrayContaining([expect.objectContaining({resourceKind:'blueprint_record',resourceId:record,compartments:[f.team.compartmentKey]})]))
    const resolved=await resolveWorkflowRunScope({userId:f.member,assistantId:f.assistantId,workspaceId:f.workspaceId,run:target})
    expect(resolved.inputScopeEvidence.sources).toEqual(evidence.sources)
    expect(evidence.sources).toHaveLength(1)
    await persistRunEvidence(target)
    const child=await runs.createRun({workflowId:f.workflow.id,workspaceId:f.workspaceId,triggeredBy:f.member,triggerKind:'manual',input:{}})
    await pool.query('INSERT INTO workflow_run_copy_sources(workspace_id,run_id,source_run_id) VALUES($1,$2,$3)',[f.workspaceId,child.id,target.id])
    expect((await readWorkflowInputEvidence(child.id,f.workspaceId)).sources).toEqual(evidence.sources)
    const memory=await derive(f,evidence.sources!)
    expect(memory.compartments).toContain(f.team.compartmentKey)
    const workflowSource=(await queryWithRLS(f.member,"SELECT read_entity_derivation_source($1,'workflow_run',$2) AS source",[f.workspaceId,target.id])).rows[0].source
    const files=createDbWorkspaceFilesStore()
    const saved=await files.createDerived(f.member,{workspaceId:f.workspaceId,userId:workflowSource.userId,assistantId:workflowSource.assistantId,createdByUserId:f.member,
      sensitivity:workflowSource.sensitivity,compartments:workflowSource.compartments,projectIds:workflowSource.projectIds,
      path:`/${randomUUID()}.txt`,parentPath:'/',name:'enrichment.txt',mime:'text/plain',sizeBytes:1,
      storageUri:'fixture://workflow-enrichment',tags:[],relatedIds:[],metadata:{}},{producer:'workflow-fixture',sources:[workflowSource,...workflowSource.requiredSources]})
    const access={workspaceId:f.workspaceId,userId:f.member,assistantId:f.assistantId,assistantKind:'primary' as const,clearance:'internal' as const}
    expect((await files.getById(access,saved.id))?.id).toBe(saved.id)

    expect((await pool.query("SELECT source_id FROM scope_derivation_sources s JOIN scope_derivations d ON d.id=s.derivation_id WHERE d.resource_id=$1 AND s.source_kind='blueprint_record'",[memory.id])).rows).toEqual([{source_id:record}])
    await expect(pool.query("UPDATE workflow_run_copy_sources SET blueprint_source='null' WHERE run_id=$1",[target.id])).rejects.toThrow('workflow_copy_source_immutable')
    if(change==='edit')await pool.query(`UPDATE blueprint_records SET fields='{"note":"Changed"}' WHERE id=$1`,[record])
    if(change==='release')await pool.query("UPDATE blueprint_records SET compartments='{}' WHERE id=$1",[record])
    if(change==='delete')await pool.query('DELETE FROM blueprint_records WHERE id=$1',[record])
    expect((await pool.query('SELECT scope_held FROM workspace_files WHERE id=$1',[saved.id])).rows[0].scope_held).toBe(true)
    expect(await files.getById(access,saved.id)).toBeNull()
    expect((await pool.query('SELECT scope_held FROM memories WHERE id=$1',[memory.id])).rows[0].scope_held).toBe(true)
    await expect(derive(f,evidence.sources!)).rejects.toThrow('scope_source_changed')
    await expect(readWorkflowInputEvidence(target.id,f.workspaceId)).rejects.toThrow('scope_source_changed')
    await expect(readWorkflowInputEvidence(child.id,f.workspaceId)).rejects.toThrow('scope_source_changed')
    await expect(resolveWorkflowRunScope({userId:f.member,assistantId:f.assistantId,workspaceId:f.workspaceId,run:target})).rejects.toMatchObject({reason:'workflow_authority_unavailable'})
    expect(await readWorkflowOutcomeWithLineage(f.workflow.id,target.id)).toBeNull()
  })
  it('captures absence canonically and refuses silently substituting a new enrichment on replay',async()=>{
    const f=await fixture(),source=await f.create()
    await persistRunEvidence(source)
    await pool.query("UPDATE workflow_runs SET status='completed',outcome='{\"summary\":\"Prior\"}' WHERE id=$1",[source.id])
    const target=await runs.createRun({workflowId:f.workflow.id,workspaceId:f.workspaceId,triggeredBy:f.member,triggerKind:'manual',input:{}})
    await pool.query(`INSERT INTO workflow_run_copy_sources(workspace_id,run_id,source_run_id,blueprint_source) VALUES($1,$2,$3,'{"forged":true}')`,[f.workspaceId,target.id,source.id])
    expect((await pool.query("SELECT blueprint_source='null'::jsonb AS absent FROM workflow_run_copy_sources WHERE run_id=$1",[target.id])).rows[0].absent).toBe(true)
    expect(await readWorkflowOutcomeWithLineage(f.workflow.id,target.id)).toMatchObject({summary:'Prior'})
    const record=randomUUID()
    await pool.query(`INSERT INTO blueprint_records(id,workspace_id,spec_snapshot,subject,anchor_key,fields,source_kind,source_id,created_by)
      VALUES($1::uuid,$2,'{}','New fictional enrichment',$1::text,'{}','workflow',$3,$4)`,[record,f.workspaceId,source.id,f.member])
    expect(await readWorkflowOutcomeWithLineage(f.workflow.id,target.id)).toBeNull()
  })
  it('upgrades saved audiences without rewriting them or exposing the metadata reader',async()=>{
    const f=await fixture(),client=await pool.connect()
    const migration=(await readFile(new URL('../../../migrations/586_crm_event_derivation.sql',import.meta.url),'utf8')).replace(/^BEGIN;\s*/,'').replace(/COMMIT;\s*$/,'')
    try {
      await client.query('BEGIN')
      const saved=(await client.query('SELECT scope_source FROM crm_domain_event_outbox WHERE id=$1',[f.eventId])).rows[0].scope_source
      await client.query('DROP TRIGGER zz_crm_event_scope_version ON crm_domain_event_outbox')
      for(const table of ['association_enquiries','association_memberships','association_registrations'])await client.query(`DROP TRIGGER crm_event_source_rebound ON ${table}`)
      await client.query('DROP FUNCTION advance_crm_event_scope_version(); DROP FUNCTION hold_rebound_crm_event_derivations()')
      await client.query('ALTER TABLE crm_domain_event_outbox DROP COLUMN scope_version')
      // Later suites can have created receipt kinds that did not exist at 585.
      // Remove only those edges inside this rolled-back historical fixture.
      await client.query('DROP TRIGGER workflow_derivation_receipts ON scope_derivation_sources')
      await client.query('DROP TRIGGER page_derivation_receipts ON scope_derivation_sources')
      await client.query("DELETE FROM scope_derivation_sources WHERE source_kind NOT IN('memory','entity','entity_link','task','workspace_file','episode','knowledge_entry','kb_chunk','crm_event')")
      // Later source wrappers use different parameter names. Keep them outside
      // this historical replay; transaction rollback restores the live chain.
      await client.query('ALTER FUNCTION read_scope_source(uuid,text,uuid) RENAME TO fixture_later_scope_reader')
      await client.query('ALTER FUNCTION scope_source_ancestors(uuid,text,uuid) RENAME TO fixture_later_scope_ancestors')
      await client.query(migration)
      expect((await client.query('SELECT scope_source FROM crm_domain_event_outbox WHERE id=$1',[f.eventId])).rows[0].scope_source).toEqual(saved)
      expect((await client.query("SELECT read_scope_source($1,'crm_event',$2) AS source",[f.workspaceId,f.eventId])).rows[0].source).toMatchObject({resourceKind:'crm_event',compartments:[f.team.compartmentKey]})
      expect((await client.query("SELECT has_function_privilege('assurance_app','read_scope_source(uuid,text,uuid)','EXECUTE') AS allowed")).rows[0].allowed).toBe(false)
      expect((await client.query("SELECT scope_source_table('crm_event') AS editable")).rows[0].editable).toBeNull()
    } finally {await client.query('ROLLBACK');client.release()}
  })
  it('refuses unresolved aggregate inputs even while legacy admission remains enabled',async()=>{
    const f=await fixture(),eventId=randomUUID()
    await pool.query(`INSERT INTO crm_domain_event_outbox(id,workspace_id,event_type,event_key,subject_kind,subject_id,actor_kind,payload)
      VALUES($1::uuid,$2,'crm.deal.stage_changed',$1::text,'deal',$3,'import','{"batchCount":2}')`,[eventId,f.workspaceId,f.deal.id])
    f.input.event.domainEventId=eventId
    const run=await f.create()
    await expect(resolveWorkflowRunScope({userId:f.member,assistantId:f.assistantId,workspaceId:f.workspaceId,run})).rejects.toMatchObject({reason:'workflow_authority_unavailable'})
  })
})

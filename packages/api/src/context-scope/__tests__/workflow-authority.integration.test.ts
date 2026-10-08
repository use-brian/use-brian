import { ContextScopeAccumulator, advanceWorkflowRun, buildTool, browserInputScope, createCrmCredentialTools, executionToolContext, pinToolAuthoringAuthority, type SandboxTaskRecord } from '@use-brian/core'
import { z } from 'zod'
import { createDbWorkspaceGroupStore } from '../../db/workspace-group-store.js'
import { createSandboxTaskStore } from '../../db/sandbox-task-store.js'
import { createWorkspaceFile } from '../../db/workspace-files.js'
import { resolveBrowserTaskExecutionAuthority } from '../../sandbox/task-execution-authority.js'
import { resolveExecutionContextSystem } from '../execution-context.js'
import { findAssistantById } from '../../db/users.js'
import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { applyRLSGucs, getPool, getAppPool, queryWithRLS, runWithAgentAccess } from '../../db/client.js'
import { createDbWorkflowStore, createDbWorkflowRunStore } from '../../db/workflow-store.js'
import { createGoal } from '../../db/goals.js'
import { currentAgentAccess } from '../../db/agent-access-context.js'
import { captureAuthoringAuthoritySystem, resolveGoalAuthoritySystem, resolveWorkflowRunScope, resolveRetainedWorkflowSource } from '../workflow-authority.js'
import { createCrmIntegrationStore, readCrmIntegrationCredential } from '../../db/crm-integration-store.js'
import { assertCrmCredentialParent } from '../../crm-operations/integration-department-authority.js'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()
const pool = getPool()
async function fixture(triggered = true) {
  const workspaceId=randomUUID(), owner=randomUUID(), userId=randomUUID(), assistantId=randomUUID()
  for (const id of [owner,userId]) await pool.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)',[id])
  await pool.query("INSERT INTO workspaces(id,name,owner_user_id) VALUES($1,'Workflow authority fixture',$2)",[workspaceId,owner])
  await pool.query("INSERT INTO workspace_compartments(workspace_id,key,label) VALUES($1,'product','Product')",[workspaceId])
  await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role,clearance,compartments) VALUES($1,$2,'owner','confidential',NULL),($1,$3,'member','internal',ARRAY['product'])",[workspaceId,owner,userId])
  await pool.query("INSERT INTO assistants(id,name,owner_user_id,workspace_id,kind,clearance,compartments) VALUES($1,'Fixture primary',$2,$3,'primary','confidential',NULL)",[assistantId,owner,workspaceId])
  const authoringAuthority={version:1 as const,assistantId,ceiling:{workspaceId,userId,clearance:'internal' as const,compartments:['product'],mutationCompartments:['product'],projectIds:null,visibilityAssistantIds:null}}
  const workflow = await createDbWorkflowStore().create({ userId,workspaceId,name:'Authority fixture',
    definition:{startStepId:'consult',steps:[{id:'consult',type:'assistant_call',target:{assistantId:'primary'},prompt:'Fixture question'}]},authoringAuthority })
  const runStore=createDbWorkflowRunStore()
  const run=await runStore.createRun({workflowId:workflow.id,workspaceId,triggeredBy:triggered?userId:null,triggerKind:triggered?'manual':'schedule'})
  const params={userId,assistantId,workspaceId,run}
  const snapshot=async()=>(await pool.query('SELECT execution_authority FROM workflow_runs WHERE id=$1',[run.id])).rows[0].execution_authority
  return{...params,owner,workflow,authoringAuthority,runStore,params,snapshot}
}

async function persistInitialEvidence(f: Awaited<ReturnType<typeof fixture>>, scope: Awaited<ReturnType<typeof resolveWorkflowRunScope>>) {
  const evidence=new ContextScopeAccumulator({compartments:scope.turnScope.writeCompartments,projectIds:scope.turnScope.writeProjectIds})
  evidence.note(scope.inputScopeEvidence)
  await f.runStore.updateRun(f.run.id,{vars:{__contextScopeEvidence:evidence.evidence}})
}

describe('[COMP:api/workflow-authority] persisted member-run authority',()=>{
  afterAll(async()=>{await getAppPool().end();await pool.end()})
  it('retains workflow authority in a child credential across issuance and standalone renewal', async () => {
    const f = await fixture()
    await pool.query("UPDATE workspace_members SET role='admin' WHERE workspace_id=$1 AND user_id=$2", [f.workspaceId,f.userId])
    for (const capability of ['configure','crm','home_app:crm:write']) await pool.query(
      'INSERT INTO assistant_capabilities(assistant_id,capability,granted_by_user_id) VALUES($1,$2,$3)', [f.assistantId,capability,f.userId])
    const scope = await resolveWorkflowRunScope(f.params)
    await persistInitialEvidence(f,scope)
    const source = scope.executionContext.security.authority.snapshotSource!()
    if (source.kind !== 'workflow') throw new Error('Expected workflow source')
    const parent = { version:1 as const,kind:'workflow' as const,credentialId:f.run.id,workspaceId:f.workspaceId,userId:f.userId,source }
    const authoring = pinToolAuthoringAuthority(executionToolContext(scope.executionContext,{appId:'fixture'}))
    const keys = createCrmIntegrationStore(pool,getAppPool())
    const native = createCrmCredentialTools({
      preview:(input,authority,parent)=>keys.bindingOptions(f.workspaceId,f.userId,input,authority,parent),
      list:(input,authority,parent)=>keys.listForMember(f.workspaceId,f.userId,input,authority,parent),
      create:(input,authority,parent)=>keys.create(f.workspaceId,f.userId,input,authority,parent),
      revoke:async(input,authority,parent)=>({revoked:await keys.revoke(f.workspaceId,f.userId,input.credentialId,authority,parent)}),
    })
    const context = {...executionToolContext(scope.executionContext,{appId:'fixture'}),
      activeCapabilities:new Set(['configure','crm','home_app:crm:write'])}
    const result = await native.createCrmCredential.execute({requestId:randomUUID(),label:'Fictional workflow child',
      expiresAt:'2099-01-01T00:00:00Z',grants:[{operation:'crm.records.read',selectors:{}}],
      departmentBinding:{departmentIds:[],cap:'internal'}},context)
    expect(result.isError).not.toBe(true)
    const issued = result.data as Awaited<ReturnType<typeof keys.create>>
    expect(issued.departmentBinding?.parent).toEqual(parent)
    expect((await native.previewCrmCredentialBindings.execute({},context)).isError).not.toBe(true)
    expect((await native.listCrmCredentials.execute({},context)).isError).not.toBe(true)
    expect(await keys.authenticate(issued.oneTimeSecret)).not.toBeNull()
    expect((await Promise.all([keys.authenticate(issued.oneTimeSecret),keys.authenticate(issued.oneTimeSecret)])).every(value=>value!==null)).toBe(true)
    expect(await readCrmIntegrationCredential(pool,f.workspaceId,issued.id)).toMatchObject({credentialId:issued.id})
    const client = await getAppPool().connect()
    try {
      await client.query('BEGIN')
      await applyRLSGucs(client,f.owner)
      await assertCrmCredentialParent(client,parent,f.workspaceId,f.userId)
      expect((await client.query("SELECT current_setting('app.current_user_id') AS actor")).rows[0].actor).toBe(f.owner)
      const missingRun = randomUUID()
      await expect(assertCrmCredentialParent(client,{...parent,credentialId:missingRun,source:{...source,runId:missingRun}},f.workspaceId,f.userId))
        .rejects.toMatchObject({code:'not_authorized'})
      expect((await client.query("SELECT current_setting('app.current_user_id') AS actor")).rows[0].actor).toBe(f.owner)
      await expect(assertCrmCredentialParent(client,parent,f.workspaceId,f.userId,
        {...authoring,ceiling:{...authoring.ceiling,clearance:'confidential'}})).rejects.toMatchObject({code:'not_authorized'})
      for (const field of ['authorityFingerprint','inputFingerprint','persistedFingerprint'] as const) {
        await expect(assertCrmCredentialParent(client,{...parent,source:{...source,[field]:'0'.repeat(64)}},f.workspaceId,f.userId))
          .rejects.toMatchObject({code:'not_authorized'})
      }
      await client.query('ROLLBACK')
    } finally { client.release() }
    await pool.query(`UPDATE workflow_runs SET status='failed',error='{"reason":"workflow_cancelled"}' WHERE id=$1`,[f.run.id])
    expect(await keys.authenticate(issued.oneTimeSecret)).toBeNull()
    expect(await native.listCrmCredentials.execute({},context)).toMatchObject({isError:true})
    await expect(readCrmIntegrationCredential(pool,f.workspaceId,issued.id)).rejects.toMatchObject({code:'not_authorized'})
    const attended = await captureAuthoringAuthoritySystem({workspaceId:f.workspaceId,userId:f.userId,assistantId:f.assistantId})
    expect((await keys.listForMember(f.workspaceId,f.userId,{},attended)).credentials.map(row=>row.id)).toContain(issued.id)
    const replacement = await keys.create(f.workspaceId,f.userId,{requestId:randomUUID(),label:'Fictional reviewed replacement',
      expiresAt:'2099-01-01T00:00:00Z',grants:[{operation:'crm.records.read',selectors:{}}],
      departmentBinding:{departmentIds:[],cap:'internal'},revokeCredentialId:issued.id},attended)
    expect(replacement.departmentBinding?.parent).toBeUndefined()
    expect(await keys.authenticate(replacement.oneTimeSecret)).not.toBeNull()
    expect(await keys.authenticate(issued.oneTimeSecret)).toBeNull()
  })
  it.each([false,true])('reconstructs only the exact retained source inside a locked app transaction (goal=%s)',async withGoal=>{
    const f=await fixture()
    const goal=withGoal?await createGoal({workspaceId:f.workspaceId,outcome:'Complete transaction fixture',doneWhen:{kind:'subtasks'},
      means:{workflowId:f.workflow.id},createdByUserId:f.userId,authoringAuthority:f.authoringAuthority}):null
    if(goal){
      f.run=await f.runStore.createRun({workflowId:f.workflow.id,workspaceId:f.workspaceId,triggeredBy:f.userId,triggerKind:'manual',input:{goalId:goal.id}})
      f.params.run=f.run
    }
    const scope=await resolveWorkflowRunScope(f.params)
    await persistInitialEvidence(f,scope)
    const source=scope.executionContext.security.authority.snapshotSource!()
    if(source.kind!=='workflow')throw new Error('Expected workflow source')
    const replacement=await f.runStore.createRun({workflowId:f.workflow.id,workspaceId:f.workspaceId,triggeredBy:f.userId,triggerKind:'manual'})
    const client=await getAppPool().connect(),probe=await pool.connect()
    try{
      await client.query('BEGIN');await applyRLSGucs(client,f.userId)
      await client.query("SET LOCAL statement_timeout='2s'")
      await client.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE',[f.workspaceId])
      const ownerRead=vi.spyOn(pool,'query').mockRejectedValue(new Error('Owner-pool escape'))
      try{
        const retained=await resolveRetainedWorkflowSource(source,client)
        expect(await retained.executeWithAuthority(async()=> 'locked source')).toBe('locked source')
        for(const changed of [{runId:replacement.id},{authorityUserId:f.owner},{contextGroupId:randomUUID()},
          {authorityFingerprint:'0'.repeat(64)},{inputFingerprint:'0'.repeat(64)},{persistedFingerprint:'0'.repeat(64)}]){
          await client.query('SAVEPOINT invalid_source')
          await expect(resolveRetainedWorkflowSource({...source,...changed},client)).rejects.toMatchObject({reason:'workflow_authority_unavailable'})
          await client.query('ROLLBACK TO SAVEPOINT invalid_source')
        }
        expect(await retained.executeWithAuthority(async()=> 'still valid')).toBe('still valid')
        expect(ownerRead.mock.calls.filter(([sql])=>typeof sql!=='string'||!sql.includes('pg_notify'))).toEqual([])
      }finally{ownerRead.mockRestore()}
      await probe.query('BEGIN')
      await expect(probe.query('SELECT id FROM workflow_runs WHERE id=$1 FOR UPDATE NOWAIT',[f.run.id])).rejects.toMatchObject({code:'55P03'})
      await probe.query('ROLLBACK');await probe.query('BEGIN')
      await expect(probe.query('SELECT id FROM assistants WHERE id=$1 FOR UPDATE NOWAIT',[f.assistantId])).rejects.toMatchObject({code:'55P03'})
      await probe.query('ROLLBACK');await probe.query('BEGIN')
      await expect(probe.query('SELECT user_id FROM workspace_members WHERE workspace_id=$1 AND user_id=$2 FOR UPDATE NOWAIT',[f.workspaceId,f.userId])).rejects.toMatchObject({code:'55P03'})
      if(goal){
        await probe.query('ROLLBACK');await probe.query('BEGIN')
        await expect(probe.query('SELECT id FROM goals WHERE id=$1 FOR UPDATE NOWAIT',[goal.id])).rejects.toMatchObject({code:'55P03'})
      }
    }finally{await probe.query('ROLLBACK');await client.query('ROLLBACK');probe.release();client.release()}
    expect((await pool.query('SELECT execution_authority FROM workflow_runs WHERE id=$1',[replacement.id])).rows[0].execution_authority).toBeNull()
  })
  it('persists canonical history evidence before an actual executor tool dispatch',async()=>{
    const f=await fixture()
    await pool.query('UPDATE workflows SET definition=$2::jsonb WHERE id=$1',[f.workflow.id,JSON.stringify({
      startStepId:'inspect',steps:[{id:'inspect',type:'tool_call',toolName:'inspectFixture',arguments:{}}],
    })])
    expect(await f.runStore.getRunById(f.userId,f.run.id)).toBeNull()
    let dispatched=0
    const tool=buildTool({name:'inspectFixture',description:'Inspect fixture history',inputSchema:z.object({}),
      async execute(){
        dispatched++
        const visible=await f.runStore.getRunById(f.userId,f.run.id)
        expect(visible?.vars.__contextScopeEvidence).toMatchObject({sensitivity:'public',compartments:[],projectIds:[]})
        expect(await f.runStore.listStepRuns(f.userId,f.run.id)).toHaveLength(1)
        return{data:{ok:true}}
      },
    })
    const result=await advanceWorkflowRun({workflowStore:createDbWorkflowStore(),runStore:f.runStore,
      resolvePrimary:async()=>f.assistantId,resolveRunScope:resolveWorkflowRunScope,
      buildToolRegistry:async()=>new Map([[tool.name,tool]]),
      consultTransport:{async send(){throw new Error('Unexpected consult')}},
    },f.run.id)
    expect(result,JSON.stringify(result)).toMatchObject({kind:'completed'})
    expect(dispatched).toBe(1)
    expect((await f.runStore.getRunById(f.userId,f.run.id))?.status).toBe('completed')
  })
  it.each([true,false])('captures the recorded actor once for manual/scheduled execution (%s)',async triggered=>{
    const f=await fixture(triggered)
    const resolved=await resolveWorkflowRunScope(f.params)
    expect(resolved.turnScope.access).toMatchObject({userId:f.userId,clearance:'internal',compartments:['product']})
    expect(await resolved.executeWithAuthority(async()=>currentAgentAccess())).toMatchObject({
      userId:f.userId,workspaceId:f.workspaceId,clearance:'internal',compartments:['product'],
    })
    expect(currentAgentAccess()).toBeUndefined()
    expect(await f.snapshot()).toMatchObject({version:1,assistantId:f.assistantId,ceiling:{userId:f.userId,workspaceId:f.workspaceId,clearance:'internal'}})
    await f.runStore.updateRun(f.run.id,{status:'running'})
    await pool.query("UPDATE workspace_members SET clearance='confidential',compartments=NULL WHERE workspace_id=$1 AND user_id=$2",[f.workspaceId,f.userId])
    const resumed=await resolveWorkflowRunScope(f.params)
    expect(resumed.turnScope.access).toMatchObject({clearance:'internal',compartments:['product']})
  })
  it('refuses a resumed legacy run instead of inventing new authority',async()=>{
    const f=await fixture();await f.runStore.updateRun(f.run.id,{status:'running'})
    await expect(resolveWorkflowRunScope(f.params)).rejects.toMatchObject({reason:'workflow_authority_unavailable'})
    expect(await f.snapshot()).toBeNull()
  })
  it('refuses a legacy workflow whose authoring principal was never captured',async()=>{
    const f=await fixture()
    await pool.query('UPDATE workflows SET authoring_authority=NULL WHERE id=$1',[f.workflow.id])
    await expect(resolveWorkflowRunScope(f.params)).rejects.toMatchObject({reason:'workflow_authority_unavailable'})
    expect(await f.snapshot()).toBeNull()
  })
  it('never widens a first run when the author gains broader access after saving the workflow',async()=>{
    const f=await fixture()
    await pool.query("UPDATE workspace_members SET clearance='confidential',compartments=NULL WHERE workspace_id=$1 AND user_id=$2",[f.workspaceId,f.userId])
    const resolved=await resolveWorkflowRunScope(f.params)
    expect(resolved.turnScope.access).toMatchObject({clearance:'internal',compartments:['product']})
  })
  it('refuses a first run when the saved authoring principal has contracted',async()=>{
    const f=await fixture()
    await pool.query("UPDATE workspace_members SET clearance='public',compartments=ARRAY[]::text[] WHERE workspace_id=$1 AND user_id=$2",[f.workspaceId,f.userId])
    await expect(resolveWorkflowRunScope(f.params)).rejects.toMatchObject({reason:'workflow_authority_unavailable'})
    expect(await f.snapshot()).toBeNull()
  })
  it('refuses an older persisted ceiling without mutation authority instead of reconstructing it',async()=>{
    const f=await fixture();
    const old={version:1,assistantId:f.assistantId,ceiling:{workspaceId:f.workspaceId,userId:f.userId,clearance:'internal',compartments:['product'],projectIds:null,visibilityAssistantIds:null}};
    await pool.query('UPDATE workflow_runs SET execution_authority=$2::jsonb WHERE id=$1',[f.run.id,JSON.stringify(old)]);
    await expect(resolveWorkflowRunScope(f.params)).rejects.toMatchObject({reason:'workflow_authority_unavailable'});
    expect(await f.snapshot()).toEqual(old);
  })
  it('refuses contraction and actor substitution',async()=>{
    const f=await fixture();await resolveWorkflowRunScope(f.params)
    await pool.query("UPDATE workspace_members SET clearance='public' WHERE workspace_id=$1 AND user_id=$2",[f.workspaceId,f.userId])
    await expect(resolveWorkflowRunScope(f.params)).rejects.toMatchObject({reason:'workflow_authority_unavailable'})
    await expect(resolveWorkflowRunScope({...f.params,userId:f.owner})).rejects.toMatchObject({reason:'workflow_authority_unavailable'})
  })
  it('rehydrates a workflow browser source without the original invocation and denies cancellation',async()=>{
    const f=await fixture(), scope=await resolveWorkflowRunScope(f.params)
    await persistInitialEvidence(f,scope)
    const task=JSON.parse(JSON.stringify({userId:f.userId,workspaceId:f.workspaceId,
      executionAuthority:pinToolAuthoringAuthority(executionToolContext(scope.executionContext,{appId:'fixture'})),
      sourceAuthority:scope.executionContext.security.authority.snapshotSource!()}))
    expect(task.sourceAuthority.kind).toBe('workflow')
    const unstarted=await f.runStore.createRun({workflowId:f.workflow.id,workspaceId:f.workspaceId,triggeredBy:f.userId,triggerKind:'manual'})
    const replacement=await resolveBrowserTaskExecutionAuthority({...task,sourceAuthority:{...task.sourceAuthority,runId:unstarted.id}})
    await expect(replacement.assertCurrent()).rejects.toMatchObject({reason:'authority_changed'})
    expect((await pool.query('SELECT execution_authority FROM workflow_runs WHERE id=$1',[unstarted.id])).rows[0].execution_authority).toBeNull()
    const cold=await resolveBrowserTaskExecutionAuthority(task)
    expect(await cold.execute(async()=> 'cold result')).toBe('cold result')
    const changed=await resolveBrowserTaskExecutionAuthority({...task,sourceAuthority:{...task.sourceAuthority,inputFingerprint:'0'.repeat(64)}})
    await expect(changed.assertCurrent()).rejects.toMatchObject({reason:'authority_changed'})
    await expect(resolveBrowserTaskExecutionAuthority({...task,userId:f.owner})).rejects.toMatchObject({code:'profile_authority_denied'})
    await f.runStore.updateRun(f.run.id,{status:'failed',error:{reason:'workflow_cancelled',message:'Fictional cancellation'}})
    await expect(cold.execute(async()=> 'withheld')).rejects.toMatchObject({reason:'authority_changed'})
    await expect((await resolveBrowserTaskExecutionAuthority(task)).assertCurrent()).rejects.toMatchObject({reason:'authority_changed'})
  })
  it.each(['member','assistant','run'])('renews a database-persisted workflow browser task after %s source loss',async loss=>{
    const f=await fixture(), scope=await resolveWorkflowRunScope(f.params), store=createSandboxTaskStore()
    await persistInitialEvidence(f,scope)
    const record:SandboxTaskRecord={taskId:randomUUID(),sandboxId:'fictional-workflow-browser',userId:f.userId,
      workspaceId:f.workspaceId,sessionId:f.run.id,status:'running',profileId:null,injectedSite:null,
      browserStartedAt:Date.now(),authorizedBudgetUsd:1,createdAt:Date.now(),lastActivityAt:Date.now(),
      executionAuthority:pinToolAuthoringAuthority(executionToolContext(scope.executionContext,{appId:'fixture'})),
      sourceAuthority:scope.executionContext.security.authority.snapshotSource!(),inputScope:browserInputScope({},f.workspaceId)}
    await store.create(record)
    const loaded=await createSandboxTaskStore().getActiveBySession(f.run.id)
    expect(loaded?.sourceAuthority).toEqual(record.sourceAuthority)
    const cold=await resolveBrowserTaskExecutionAuthority(loaded!)
    expect(await cold.execute(async()=> 'current')).toBe('current')
    if(loss==='member') await pool.query('DELETE FROM workspace_members WHERE workspace_id=$1 AND user_id=$2',[f.workspaceId,f.userId])
    else if(loss==='assistant') await pool.query("UPDATE assistants SET clearance='public' WHERE id=$1",[f.assistantId])
    else await pool.query('DELETE FROM workflow_runs WHERE id=$1',[f.run.id])
    let invoked=false
    await expect(cold.execute(async()=>{invoked=true})).rejects.toMatchObject({reason:'authority_changed'})
    expect(invoked).toBe(false)
    const retained=await createSandboxTaskStore().getActiveBySession(f.run.id)
    expect(retained?.taskId).toBe(record.taskId)
    await expect((await resolveBrowserTaskExecutionAuthority(retained!)).assertCurrent()).rejects.toMatchObject({reason:'authority_changed'})
  })
  it.each(['none','cancelled','session','ceiling'])('guards actual file transactions for retained workflow tasks (%s)',async change=>{
    const f=await fixture(),scope=await resolveWorkflowRunScope(f.params),store=createSandboxTaskStore()
    await persistInitialEvidence(f,scope)
    const executionAuthority=pinToolAuthoringAuthority(executionToolContext(scope.executionContext,{appId:'fixture'}))
    if(change==='ceiling')executionAuthority.ceiling.clearance='confidential'
    const record:SandboxTaskRecord={taskId:randomUUID(),sandboxId:'fictional-publication-browser',userId:f.userId,
      workspaceId:f.workspaceId,sessionId:change==='session'?randomUUID():f.run.id,status:'running',profileId:null,injectedSite:null,
      browserStartedAt:Date.now(),authorizedBudgetUsd:1,createdAt:Date.now(),lastActivityAt:Date.now(),executionAuthority,
      sourceAuthority:scope.executionContext.security.authority.snapshotSource!(),inputScope:browserInputScope({},f.workspaceId)}
    await store.create(record)
    if(change==='cancelled')await f.runStore.updateRun(f.run.id,{status:'failed',error:{reason:'workflow_cancelled',message:'Fixture cancelled'}})
    const id=randomUUID(),saved=store.withPublication!(record,()=>createWorkspaceFile(f.userId,{id,workspaceId:f.workspaceId,
      path:`/${id}.txt`,parentPath:'/',name:'Fixture.txt',mime:'text/plain',sizeBytes:4,storageUri:`fixture://${id}`,
      createdByUserId:f.userId,sensitivity:'public'}))
    if(change==='none')expect(await saved).toMatchObject({id})
    else await expect(saved).rejects.toThrow()
    expect((await pool.query('SELECT id FROM workspace_files WHERE workspace_id=$1',[f.workspaceId])).rows).toEqual(change==='none'?[{id}]:[])
  })
  it('renews current source workflow department visibility as well as the original run ceiling',async()=>{
    const f=await fixture(), scope=await resolveWorkflowRunScope(f.params)
    const department=await createDbWorkspaceGroupStore().createTeam(f.owner,f.workspaceId,{name:'Fictional restricted source',key:'restricted-source'})
    await pool.query('UPDATE workflows SET context_group_id=$2 WHERE id=$1',[f.workflow.id,department.id])
    let invoked=false
    await expect(scope.executeWithAuthority(async()=>{invoked=true})).rejects.toMatchObject({reason:'authority_changed'})
    expect(invoked).toBe(false)
    await expect(resolveWorkflowRunScope(f.params)).rejects.toMatchObject({reason:'workflow_authority_unavailable'})
    await pool.query('UPDATE workflows SET context_group_id=NULL WHERE id=$1',[f.workflow.id])
    await expect(scope.executeWithAuthority(async()=> 'stale')).rejects.toMatchObject({reason:'authority_changed'})
    const fresh=await resolveWorkflowRunScope(f.params)
    expect(await fresh.executeWithAuthority(async()=> 'current')).toBe('current')
  })
  it('versions protection changes while preserving ordinary workflow progress',async()=>{
    const f=await fixture()
    const version=async()=>Number((await pool.query('SELECT derivation_source_version FROM workflow_runs WHERE id=$1',[f.run.id])).rows[0].derivation_source_version)
    const initial=await version()
    await resolveWorkflowRunScope(f.params)
    expect(await version()).toBe(initial+1)
    const admitted=await version()
    await f.runStore.updateRun(f.run.id,{status:'running'})
    await pool.query("UPDATE workflow_runs SET last_active_at=clock_timestamp(),current_step_id='consult' WHERE id=$1",[f.run.id])
    expect(await version()).toBe(admitted)
    await f.runStore.updateRun(f.run.id,{status:'failed',error:{reason:'step_failed',message:'Fictional failure'}})
    expect(await version()).toBe(admitted)
    await f.runStore.updateRun(f.run.id,{status:'failed',error:{reason:'workflow_cancelled',message:'Fictional cancellation'}})
    expect(await version()).toBe(admitted+1)
    await pool.query('UPDATE workflow_runs SET derivation_source_version=999 WHERE id=$1',[f.run.id])
    expect(await version()).toBe(admitted+1)
  })
  it('versions current workflow protection changes without treating cosmetic renames as new authority',async()=>{
    const f=await fixture()
    await resolveWorkflowRunScope(f.params)
    const version=async()=>Number((await pool.query('SELECT derivation_source_version FROM workflow_runs WHERE id=$1',[f.run.id])).rows[0].derivation_source_version)
    const initial=await version()
    await pool.query("UPDATE workflows SET name='Fictional renamed workflow' WHERE id=$1",[f.workflow.id])
    expect(await version()).toBe(initial)
    const department=await createDbWorkspaceGroupStore().createTeam(f.owner,f.workspaceId,{name:'Fictional parent department',key:'parent-department'})
    await pool.query('UPDATE workflows SET context_group_id=$2 WHERE id=$1',[f.workflow.id,department.id])
    expect(await version()).toBe(initial+1)
    await pool.query('UPDATE workflows SET context_group_id=NULL WHERE id=$1',[f.workflow.id])
    expect(await version()).toBe(initial+2)
  })
  it('terminates retained and fresh source authority after persisted cancellation',async()=>{
    const f=await fixture(), scope=await resolveWorkflowRunScope(f.params)
    await f.runStore.updateRun(f.run.id,{status:'failed',error:{reason:'workflow_cancelled',message:'Fictional cancellation'}})
    let invoked=false
    await expect(scope.executeWithAuthority(async()=>{invoked=true})).rejects.toMatchObject({reason:'authority_changed',operationMayHaveExecuted:false})
    expect(invoked).toBe(false)
    await expect(resolveWorkflowRunScope(f.params)).rejects.toMatchObject({reason:'workflow_authority_unavailable'})
  })
  it('withholds a result when cancellation commits during an operation',async()=>{
    const f=await fixture(), scope=await resolveWorkflowRunScope(f.params)
    await expect(scope.executeWithAuthority(async()=>{
      await f.runStore.updateRun(f.run.id,{status:'failed',error:{reason:'workflow_cancelled',message:'Fictional cancellation'}})
      return 'withheld result'
    })).rejects.toMatchObject({reason:'authority_changed',operationMayHaveExecuted:true})
  })
  it('does not revive cancellation when content RLS hides the run history',async()=>{
    const f=await fixture(),scope=await resolveWorkflowRunScope(f.params)
    await f.runStore.updateRun(f.run.id,{status:'failed',error:{reason:'workflow_cancelled',message:'Fictional cancellation'},
      vars:{__contextScopeEvidence:null}})
    expect((await queryWithRLS(f.userId,'SELECT id FROM workflow_runs WHERE id=$1',[f.run.id])).rows).toEqual([])
    let invoked=false
    await expect(scope.executeWithAuthority(async()=>{invoked=true})).rejects.toMatchObject({reason:'authority_changed',operationMayHaveExecuted:false})
    expect(invoked).toBe(false)
    await expect(resolveWorkflowRunScope(f.params)).rejects.toMatchObject({reason:'workflow_authority_unavailable'})
  })
  it('retains authority for ordinary failure reporting',async()=>{
    const f=await fixture(), scope=await resolveWorkflowRunScope(f.params)
    await f.runStore.updateRun(f.run.id,{status:'failed',error:{reason:'step_failed',message:'Fictional step failure'}})
    expect(await scope.executeWithAuthority(async()=> 'failure report')).toBe('failure report')
  })
  it('checks live authority before a deterministic operation starts',async()=>{
    const f=await fixture(), scope=await resolveWorkflowRunScope(f.params)
    await pool.query('DELETE FROM workspace_members WHERE workspace_id=$1 AND user_id=$2',[f.workspaceId,f.userId])
    let invoked=false
    await expect(scope.executeWithAuthority(async()=>{invoked=true})).rejects.toMatchObject({reason:'authority_changed',operationMayHaveExecuted:false})
    expect(invoked).toBe(false)
  })
  it('withholds in-flight results and cannot revive the same advance after permissions return',async()=>{
    const f=await fixture(), scope=await resolveWorkflowRunScope(f.params)
    let calls=0
    await expect(scope.executeWithAuthority(async()=>{
      calls++
      await pool.query("UPDATE workspace_members SET clearance='public' WHERE workspace_id=$1 AND user_id=$2",[f.workspaceId,f.userId])
      return 'private result'
    })).rejects.toMatchObject({reason:'authority_changed',operationMayHaveExecuted:true})
    await pool.query("UPDATE workspace_members SET clearance='internal' WHERE workspace_id=$1 AND user_id=$2",[f.workspaceId,f.userId])
    await expect(scope.executeWithAuthority(async()=>{calls++;return 'retry'})).rejects.toMatchObject({reason:'authority_changed',operationMayHaveExecuted:true})
    expect(calls).toBe(1)
  })
  it('does not mistake nested tool narrowing for lost live authority',async()=>{
    const f=await fixture(), scope=await resolveWorkflowRunScope(f.params)
    await expect(runWithAgentAccess({workspaceId:f.workspaceId,userId:f.userId,
      clearance:'public',compartments:[],projectIds:[],visibilityAssistantIds:[]},
    ()=>scope.executeWithAuthority(async()=> 'bounded result'))).resolves.toBe('bounded result')
  })
  it('does not mistake a pending legacy retry with prior step history for a new run',async()=>{
    const f=await fixture()
    await f.runStore.createStepRun({runId:f.run.id,stepId:'prior',stepType:'assistant_call',input:{}})
    await expect(resolveWorkflowRunScope(f.params)).rejects.toMatchObject({reason:'workflow_authority_unavailable'})
    expect(await f.snapshot()).toBeNull()
  })
  it('retains the winning snapshot across simultaneous initializers and forbids replacing or clearing it',async()=>{
    const f=await fixture()
    await Promise.all([resolveWorkflowRunScope(f.params),resolveWorkflowRunScope(f.params)])
    const stored=await f.snapshot()
    await expect(pool.query("UPDATE workflow_runs SET execution_authority=jsonb_set(execution_authority,'{ceiling,clearance}','\"confidential\"') WHERE id=$1",[f.run.id])).rejects.toThrow('workflow_execution_authority_immutable')
    await expect(pool.query('UPDATE workflow_runs SET execution_authority=NULL WHERE id=$1',[f.run.id])).rejects.toThrow('workflow_execution_authority_immutable')
    expect(await f.snapshot()).toEqual(stored)
  })
  it('pins a goal to its saved authoring principal even after later permission expansion',async()=>{
    const f=await fixture()
    const goal=await createGoal({workspaceId:f.workspaceId,outcome:'Complete fixture work',doneWhen:{kind:'subtasks'},
      means:{workflowId:f.workflow.id},createdByUserId:f.userId,authoringAuthority:f.authoringAuthority})
    await pool.query("UPDATE workspace_members SET clearance='confidential',compartments=NULL WHERE workspace_id=$1 AND user_id=$2",[f.workspaceId,f.userId])
    const scope=await resolveGoalAuthoritySystem(goal)
    expect(scope.ceiling).toMatchObject({clearance:'internal',compartments:['product']})
    expect(await scope.executeWithAuthority(async()=>currentAgentAccess())).toMatchObject({clearance:'internal',compartments:['product']})
  })
  it('retains tool-authored department consent through PostgreSQL goal reload and permission expansion',async()=>{
    const f=await fixture(),research=randomUUID(),operations=randomUUID()
    await pool.query('UPDATE workspace_members SET compartments=NULL WHERE workspace_id=$1 AND user_id=$2',[f.workspaceId,f.userId])
    await pool.query('UPDATE workspaces SET department_read_v2=true WHERE id=$1',[f.workspaceId])
    for(const department of [research,operations]) {
      await pool.query("INSERT INTO workspace_groups(id,workspace_id,name,created_by,kind,key,compartment_key) VALUES($1::uuid,$2,'Fictional authoring department',$3,'team',$1::text,$4)",[department,f.workspaceId,f.owner,`team:${department}`])
      await pool.query("INSERT INTO workspace_compartments(workspace_id,key,label,created_by,managed_by,managed_ref_id) VALUES($1,$2,'Fictional department',$3,'team',$4)",[f.workspaceId,`team:${department}`,f.owner,department])
    }
    const grant=async(department:string)=>{
      await pool.query("INSERT INTO department_edges(workspace_id,department_id,principal_kind,user_id,clearance,origin) VALUES($1,$2,'user',$3,'internal','store') ON CONFLICT DO NOTHING",[f.workspaceId,department,f.userId])
      await pool.query("INSERT INTO department_edges(workspace_id,department_id,principal_kind,assistant_id,clearance,origin) VALUES($1,$2,'assistant',$3,'internal','store') ON CONFLICT DO NOTHING",[f.workspaceId,department,f.assistantId])
    }
    await grant(research)
    const resolved=await resolveExecutionContextSystem({ userId:f.userId,workspaceId:f.workspaceId,
      assistant:(await findAssistantById(f.assistantId))!,key:{contextGroupId:research,contextProjectId:null},
      identity:{kind:'attended',principal:{kind:'workspace_member',userId:f.userId}},
      ownership:{kind:'workspace',workspaceId:f.workspaceId},
      lifecycle:{sessionId:randomUUID(),channelType:'web',channelId:'fixture',abortSignal:new AbortController().signal},
    })
    const saved=pinToolAuthoringAuthority(executionToolContext(resolved.executionContext,{appId:'fixture'}))
    expect(saved.ceiling.departmentRead?.departments[research]).toBe('internal')
    expect(saved.ceiling.departmentRead?.contextDepartment).toBe(research)
    expect(saved.ceiling.departmentRead?.departments[operations]).toBeUndefined()
    const goal=await createGoal({workspaceId:f.workspaceId,outcome:'Department-bound fixture work',doneWhen:{kind:'subtasks'},
      contextGroupId:research,createdByUserId:f.userId,authoringAuthority:saved})
    const persisted=(await pool.query('SELECT authoring_authority FROM goals WHERE id=$1',[goal.id])).rows[0].authoring_authority
    expect(persisted).toEqual(saved)
    await grant(operations)
    const scope=await resolveGoalAuthoritySystem({...goal,authoringAuthority:persisted})
    expect(scope.ceiling.departmentRead?.departments[research]).toBe('internal')
    expect(scope.ceiling.departmentRead?.departments[operations]).toBeUndefined()
    await pool.query("UPDATE department_edges SET expires_at=clock_timestamp()-interval '1 second' WHERE workspace_id=$1 AND department_id=$2 AND user_id=$3",[f.workspaceId,research,f.userId])
    await expect(scope.executeWithAuthority(async()=> 'must not run')).rejects.toMatchObject({reason:'authority_changed'})
    await expect(resolveGoalAuthoritySystem({...goal,authoringAuthority:persisted})).rejects.toMatchObject({reason:'goal_authority_unavailable'})
  })
  it('keeps legacy and contracted goals inert before any tick claim',async()=>{
    const legacyFixture=await fixture()
    const legacy=await createGoal({workspaceId:legacyFixture.workspaceId,outcome:'Legacy draft',doneWhen:{kind:'subtasks'},
      createdByUserId:legacyFixture.userId,confirmed:false})
    await expect(resolveGoalAuthoritySystem(legacy)).rejects.toMatchObject({reason:'goal_authority_unavailable'})

    const f=await fixture()
    const goal=await createGoal({workspaceId:f.workspaceId,outcome:'Contracted fixture work',doneWhen:{kind:'subtasks'},
      means:{workflowId:f.workflow.id},createdByUserId:f.userId,authoringAuthority:f.authoringAuthority})
    await pool.query("UPDATE workspace_members SET clearance='public',compartments=ARRAY[]::text[] WHERE workspace_id=$1 AND user_id=$2",[f.workspaceId,f.userId])
    await expect(resolveGoalAuthoritySystem(goal)).rejects.toMatchObject({reason:'goal_authority_unavailable'})
  })
})

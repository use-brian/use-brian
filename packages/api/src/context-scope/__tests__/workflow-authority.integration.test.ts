import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { getPool, getAppPool, runWithAgentAccess } from '../../db/client.js'
import { createDbWorkflowStore, createDbWorkflowRunStore } from '../../db/workflow-store.js'
import { createGoal } from '../../db/goals.js'
import { currentAgentAccess } from '../../db/agent-access-context.js'
import { resolveGoalAuthoritySystem, resolveWorkflowRunScope } from '../workflow-authority.js'

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

describe('[COMP:api/workflow-authority] persisted member-run authority',()=>{
  afterAll(async()=>{await getAppPool().end();await pool.end()})
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

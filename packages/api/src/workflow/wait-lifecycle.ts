import type {RetainedGoalWorkflowClaim} from '../db/goals.js'
import { resolveRetainedGoalWorkflowRuntime } from '../workspace-access/goal-source-admission.js'
/** Existing persisted wait scheduling and scheduler dispatch. [COMP:workflow/wait-lifecycle] */
import {WorkflowDefinitionSchema,advanceWorkflowRun,stepSuccessors,type ExecutorDeps,type JobStore,type ScheduledJob,type WorkflowStore,type WorkflowRunStore} from '@use-brian/core'
import {getRunIdForStepRun} from '../db/workflow-store.js'
export async function pauseWorkflowRunForWait(params:Parameters<NonNullable<ExecutorDeps['pauseRunForWait']>>[0],deps:{jobStore:JobStore;runStore:WorkflowRunStore;resolvePrimary:ExecutorDeps['resolvePrimary']}){
 const {runId,stepRunId,workspaceId,triggeredBy,dueAt}=params,retained=await resolveRetainedGoalWorkflowRuntime(runId),primary=retained?.saved.assistantId??await deps.resolvePrimary(workspaceId)
 if(!primary)throw new Error('pauseRunForWait: no primary assistant for workspace '+workspaceId)
 await deps.jobStore.create({assistantId:primary,userId:triggeredBy??primary,schedule:{type:'once',datetime:new Date(dueAt.getTime()-dueAt.getTimezoneOffset()*60_000).toISOString().slice(0,19)},timezone:'UTC',mode:'local',instructions:JSON.stringify({kind:'workflow_wait_resume',runId,stepRunId}),channelType:'workflow',channelId:runId,nextRunAt:dueAt,workflowId:(await deps.runStore.getRunSystem(runId))?.workflowId??'',workflowStepRunId:stepRunId})
}
/** Maintained scheduler dispatch consumes the persisted workflowStepRunId. */
export async function resumeWorkflowWaitJob(job:ScheduledJob,deps:{jobStore:JobStore;runStore:WorkflowRunStore;workflowStore:WorkflowStore;executorDeps:ExecutorDeps}){
 if(!job.workflowStepRunId)throw new Error('workflow wait job has no step')
 const runId=await getRunIdForStepRun(job.workflowStepRunId)
 if(!runId)return 'step run '+job.workflowStepRunId+' not found (workflow may have been deleted)'
 const retained=await resolveRetainedGoalWorkflowRuntime(runId)
 if(retained){
  const claim=await retained.frame(true,async client=>{
   const saved=(await client.query<{enabled:boolean;stepId:string;channelId:string;userId:string;assistantId:string;nextRunAt:Date;workflowId:string;currentStepId:string;stepKey:string;stepStatus:string;runStatus:string;claimed:boolean;definition:unknown;vars:Record<string,unknown>;schedule:ScheduledJob['schedule']}>(`SELECT job.enabled,job.workflow_step_run_id AS "stepId",job.channel_id AS "channelId",job.user_id AS "userId",job.assistant_id AS "assistantId",job.next_run_at AS "nextRunAt",job.workflow_id AS "workflowId",r.current_step_id AS "currentStepId",step.step_id AS "stepKey",step.status AS "stepStatus",r.status AS "runStatus",(r.status='running' AND r.claimed_at>clock_timestamp()-interval '10 minutes') AS claimed,w.definition,r.vars,job.schedule
    FROM scheduled_jobs job JOIN workflow_step_runs step ON step.id=job.workflow_step_run_id JOIN workflow_runs r ON r.id=step.run_id JOIN workflows w ON w.id=r.workflow_id
    WHERE job.id=$1 AND r.id=$2 AND step.step_type='wait' FOR UPDATE OF job,step,r`,[job.id,runId])).rows[0]
   if(!saved||saved.stepId!==job.workflowStepRunId||saved.channelId!==runId||saved.workflowId!==job.workflowId
    ||saved.userId!==retained.saved.actor||saved.assistantId!==retained.saved.assistantId
    ||saved.nextRunAt.getTime()!==job.nextRunAt.getTime())throw new Error('goal_source_scope_unavailable')
   const definition=WorkflowDefinitionSchema.parse(saved.definition),step=definition.steps.find(item=>item.id===saved.stepKey)
   if(step?.type!=='wait'||!step.at||step.until||(step.at.timezone??'UTC')!=='UTC'
    ||new Date(step.at.datetime+'Z').getTime()>Date.now()||saved.schedule.type!=='once'
    ||saved.schedule.datetime!==new Date(new Date(step.at.datetime+'Z').getTime()-new Date(step.at.datetime+'Z').getTimezoneOffset()*60_000).toISOString().slice(0,19))throw new Error('goal_source_scope_unavailable')
   if(!saved.enabled)return{kind:'disabled' as const}
   if(['completed','failed','timeout'].includes(saved.runStatus))return{kind:'terminal' as const}
   if(saved.claimed)return{kind:'claimed' as const}
   const startAt=stepSuccessors(step,definition.steps.map(item=>item.id))
   if(saved.stepStatus==='running'){
    if(saved.runStatus!=='awaiting_wait'||saved.currentStepId!==saved.stepKey)throw new Error('goal_source_scope_unavailable')
    await client.query("UPDATE workflow_step_runs SET status='completed',output='{"+'"resumed":true'+"}'::jsonb,finished_at=clock_timestamp() WHERE id=$1",[job.workflowStepRunId])
    await client.query(`UPDATE workflow_runs SET status='running',current_step_id=$2,vars=jsonb_set(vars,'{__frontier}',$3::jsonb),claimed_at=clock_timestamp(),claim_attempts=claim_attempts+1 WHERE id=$1`,[runId,startAt[0]??null,JSON.stringify(startAt)])
   }else if(saved.stepStatus==='completed'&&saved.runStatus==='running'){
    // Crash recovery consumes the already persisted successor frontier. No
    // second wait completion and no new run/authority/allowance is created.
    if(!Array.isArray(saved.vars.__frontier)||saved.vars.__frontier.some(id=>typeof id!=='string'||!definition.steps.some(step=>step.id===id)))throw new Error('goal_source_scope_unavailable')
    await client.query('UPDATE workflow_runs SET claimed_at=clock_timestamp(),claim_attempts=claim_attempts+1 WHERE id=$1',[runId])
    return{kind:'advance' as const,startAt:saved.vars.__frontier as string[]}
   }else throw new Error('goal_source_scope_unavailable')
   return{kind:'advance' as const,startAt}
  })
  if(claim.kind!=='advance')return 'workflow wait wake-up: '+claim.kind
  const advance=(await resolveRetainedGoalWorkflowRuntime(runId))!
  const outcome=await advance.executeWithAuthority(async()=>{
   const result=await advanceWorkflowRun(deps.executorDeps,runId,{startAt:claim.startAt})
   await advance.frame(true,async client=>{await client.query('UPDATE scheduled_jobs SET enabled=false WHERE id=$1 AND workflow_step_run_id=$2',[job.id,job.workflowStepRunId])})
   return result
  })
  if(outcome.kind==='failed')throw new Error('workflow wait wake-up failed under retained source authority')
  return 'workflow wait wake-up: '+outcome.kind
 }
 await deps.runStore.updateStepRun(job.workflowStepRunId,{status:'completed',output:{resumed:true},finishedAt:new Date()})
 const run=await deps.runStore.getRunSystem(runId),workflow=run?await deps.workflowStore.findByIdSystem(run.workflowId):null
 let startAt:string[]|undefined
 if(run&&workflow){const step=workflow.definition.steps.find(s=>s.id===run.currentStepId);startAt=step?stepSuccessors(step,workflow.definition.steps.map(s=>s.id)):undefined;await deps.runStore.updateRun(runId,{status:'running'})}
 const outcome=await advanceWorkflowRun(deps.executorDeps,runId,startAt?{startAt}:undefined)
 await deps.jobStore.update(job.id,{enabled:false})
 if(outcome.kind==='failed')throw new Error('workflow wait wake-up '+runId+' failed: '+(outcome.error?.reason??'unknown')+(outcome.error?.message?': '+outcome.error.message:''))
 return 'workflow wait wake-up: '+outcome.kind
}

/** Canonical initial dispatch uses the same immutable generation lease as wake-up. */
export async function advanceRetainedGoalWorkflow(runId:string,deps:ExecutorDeps,expectedClaim:RetainedGoalWorkflowClaim){
 const runtime=await resolveRetainedGoalWorkflowRuntime(runId)
 if(!runtime||!expectedClaim||runtime.saved.claimedAt!==expectedClaim.claimedAt||runtime.saved.claimAttempts!==expectedClaim.claimAttempts)throw new Error('goal_source_scope_unavailable')
 return runtime.executeWithAuthority(async()=>{
  // Reclaim persisted an explicit frontier, including [] after the last branch.
  // Passing it explicitly prevents core's legacy currentStepId fallback.
  const checkpoint=await runtime.frame(false,async client=>(await client.query<{status:string;vars:Record<string,unknown>;definition:unknown}>('SELECT r.status,r.vars,w.definition FROM workflow_runs r JOIN workflows w ON w.id=r.workflow_id WHERE r.id=$1',[runId])).rows[0])
  const definition=WorkflowDefinitionSchema.parse(checkpoint?.definition),known=new Set(definition.steps.map(step=>step.id))
  const frontier=checkpoint?.status==='running'?checkpoint.vars.__frontier:undefined
  if(frontier!==undefined&&(!Array.isArray(frontier)||frontier.some(id=>typeof id!=='string'||!known.has(id))||new Set(frontier).size!==frontier.length))throw new Error('goal_source_scope_unavailable')
  return advanceWorkflowRun(deps,runId,frontier===undefined?undefined:{startAt:frontier as string[]})
 })
}

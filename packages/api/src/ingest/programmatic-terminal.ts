/** Source-authorized scheduled capture terminal. No human execution identity is
 * reconstructed from attribution, and no store opens a nested transaction.
 * Canonical memory, new entity, and admitted task candidates use a per-call
 * source capability. Unsupported candidates roll the whole batch back. */
import type { PoolClient } from 'pg'
import { createMemory } from '../db/memories.js'
import { createEntity } from '../db/entities-store.js'
import { createTask } from '../db/tasks.js'
import { createTaskAdmissionPort } from '../db/task-admission-store.js'
import { recordDerivedResource } from '../db/derived-scope-store.js'
import { candidateEvidence, withProgrammaticCandidate } from './programmatic-candidate-authority.js'
import { randomUUID } from 'node:crypto'
import { processEpisode, freezeExtractionPlan, admitTask, type ScopeSource, type PipelineBApplicationCommand, type PipelineBDeps, type PipelineBEpisode, type PipelineBApplicationPort, type ExtractionApplicationRun } from '@use-brian/core'
import type { BrainEpisodeIngestor } from '../ingest-port.js'
import { programmaticIntakeClient, programmaticIntakeClaims } from '../db/programmatic-intake-context.js'
import { renderBatchWindow } from './programmatic-capture.js'
import type { QueuedProgrammaticCaptureEvent } from '../db/pending-ingest-batches-store.js'

type Source = {
 id:string; workspace_id:string; assistant_id:string; rule_id:string; events:QueuedProgrammaticCaptureEvent[]
 compartments:string[]; project_ids:string[]; episode_sensitivity:'public'|'internal'|'confidential'
 profile_id:string; intake_binding:{actor:string}; partition_key:string
}
export function createProgrammaticEpisodeTerminal(options: Pick<PipelineBDeps,'provider'|'model'>): BrainEpisodeIngestor {
 return async input => {
  const client=programmaticIntakeClient.getStore() as PoolClient | undefined
  const batchId=input.sourceRef?.batch_id
  if(!client || typeof batchId!=='string' || !programmaticIntakeClaims.getStore()?.has(batchId))throw new Error('capture_claim_required')
  // The production poll worker intentionally catches per-batch exceptions.
  // Roll back here, before that catch can turn a JS failure into a commit.
  await client.query('SAVEPOINT programmatic_terminal')
  try {
  const load=async()=>{
   const row=(await client.query<Source>(`SELECT b.*,p.id AS profile_id,p.intake_binding
    FROM pending_ingest_batches b JOIN ingest_rules r ON r.id=b.rule_id
    JOIN programmatic_capture_profiles p ON p.id=r.capture_profile_id
    WHERE b.id=$1 AND b.workspace_id=$2 AND b.source='programmatic' AND b.processed_at IS NULL
    AND NOT b.scope_held AND p.intake_binding IS NOT NULL
    AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(b.events) ev
      WHERE programmatic_intake_current(b.workspace_id,b.assistant_id,b.rule_id,ev) IS NOT TRUE)
    FOR UPDATE OF b`,[batchId,input.workspaceId])).rows[0]
   if(!row)throw new Error('capture_binding_unavailable')
   return row
  }
  const source=await load(), id=randomUUID()
  const content=renderBatchWindow(source.events)
  const episode:PipelineBEpisode={id,workspaceId:source.workspace_id,assistantId:source.assistant_id,userId:null,
   createdByUserId:source.intake_binding.actor,createdByAssistantId:source.assistant_id,
   sourceKind:'manual_paste',occurredAt:new Date(source.events[0].occurredAt),sensitivity:source.episode_sensitivity,
   compartments:source.compartments,projectIds:source.project_ids}
  // Attribution is NOT a principal: app.current_user_id remains the worker
  // sentinel. The INSERT guard validates the canonical batch instead.
  await client.query("SELECT set_config('app.programmatic_publication_batch',$1,true)",[batchId])
  await client.query(`INSERT INTO episodes(id,workspace_id,user_id,assistant_id,created_by_user_id,created_by_assistant_id,
   source_kind,source_ref,occurred_at,status,sensitivity,compartments,project_ids,content_ref,programmatic_batch_id)
   VALUES($1,$2,NULL,$3,$4,$3,'manual_paste',$5::jsonb,$6,'open',$7,$8,$9,$10::jsonb,$11)`,
   [id,source.workspace_id,source.assistant_id,source.intake_binding.actor,
    JSON.stringify({connector:'programmatic',capture_mode:'routed_batch',batch_id:batchId,rule_id:source.rule_id,profile_id:source.profile_id}),
    episode.occurredAt,source.episode_sensitivity,source.compartments,source.project_ids,JSON.stringify({kind:'manual_paste',text:content}),batchId])
  const taskPort=createTaskAdmissionPort(client)
  // The core policy kernel loads independent inputs in parallel. Serialize its
  // DB reads on this single transaction connection (no nested pool requests).
  let policyReads:Promise<unknown>=Promise.resolve()
  const serialize=<A extends unknown[],R>(read:(...args:A)=>Promise<R>)=>(...args:A):Promise<R>=>{
   const next=policyReads.then(()=>read(...args));policyReads=next.catch(()=>{});return next
  }
  taskPort.listActiveRules=serialize(taskPort.listActiveRules)
  taskPort.findSimilarTombstones=serialize(taskPort.findSimilarTombstones)
  // Workspace policy is evaluated, but no unrelated task text enters prompts.
  // Duplicate matching is restricted to this source's exact visibility/labels.
  taskPort.loadPolicyForPrompt=undefined
  taskPort.findSimilarTasks=serialize(async(w:string,title:string,threshold:number)=>{
   if(w!==source.workspace_id)throw new Error('capture_source_changed')
   const rows=(await client.query<{id:string;title:string;similarity:number}>(`SELECT id,title,similarity(lower(title),$2) AS similarity FROM tasks
    WHERE workspace_id=$1 AND user_id IS NULL AND assistant_id=$3 AND compartments=$4 AND project_ids=$5
    AND sensitivity=$6 AND NOT scope_held AND valid_to IS NULL AND retracted_at IS NULL AND status NOT IN ('done','archived')
    AND similarity(lower(title),$2)>=$7 ORDER BY similarity DESC LIMIT 5`,[w,title,source.assistant_id,source.compartments,source.project_ids,source.episode_sensitivity,threshold])).rows
   return rows
  })
  const application:PipelineBApplicationPort={apply:async ({plan:rawPlan,attemptKey})=>{
   await load()
   const current=(await client.query<{snapshot:ScopeSource}>("SELECT read_scope_source($1,'episode',$2) AS snapshot",[source.workspace_id,id])).rows[0].snapshot
   const snapshot:ScopeSource={resourceKind:'episode',resourceId:id,version:current.version,workspaceId:source.workspace_id,
    userId:current.userId,assistantId:current.assistantId,sensitivity:current.sensitivity,compartments:current.compartments,projectIds:current.projectIds}
   if(snapshot.version!==rawPlan.sourceScopeVersion)throw new Error('capture_source_changed')
   // Core's human-window memory check rejects null userId; configured shared
   // intake is admitted by its own exact source capability instead. Re-freeze
   // the explicit source-derived plan, never mutate hashes after persistence.
   const plan=freezeExtractionPlan({...rawPlan,candidates:rawPlan.candidates.map(c=>({key:c.candidateId,primitiveKind:c.primitiveKind,
    dependencyKeys:c.dependencyIds,payload:{...c.payload,derivation:candidateEvidence(snapshot)},
    ...(c.primitiveKind==='memory' && c.terminalReason==='visibility_missing' ? {} :
      {terminalDisposition:c.terminalDisposition,terminalReason:c.terminalReason})}))})
   const runId=randomUUID()
   await client.query(`INSERT INTO episode_extraction_runs(id,workspace_id,episode_id,attempt_key,source_content_hash,
    extractor_contract_version,plan_hash,frozen_plan,extraction_state,application_state,source_scope_version,
    user_id,assistant_id,created_by_user_id,created_by_assistant_id,sensitivity,compartments,project_ids)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,'succeeded','not_started',$9,NULL,$10,$11,$10,$12,$13,$14)`,
    [runId,source.workspace_id,id,attemptKey,plan.sourceContentHash,plan.extractorContractVersion,plan.planHash,JSON.stringify(plan),
     plan.sourceScopeVersion,source.assistant_id,source.intake_binding.actor,source.episode_sensitivity,source.compartments,source.project_ids])
   const items=[]
   for(const c of plan.candidates){
    const payload=c.payload as PipelineBApplicationCommand
    if(c.terminalDisposition || !['memory','entity','task','episode_finalization'].includes(c.primitiveKind))throw new Error('capture_candidate_writer_required')
    let targetId:string=id
    const common={workspaceId:source.workspace_id,userId:null,assistantId:source.assistant_id,createdByUserId:source.intake_binding.actor,
     createdByAssistantId:source.assistant_id,sourceEpisodeId:id,sensitivity:source.episode_sensitivity,compartments:source.compartments,projectIds:source.project_ids,
     derivation:candidateEvidence(snapshot),source:'extracted' as const}
    if(payload.command==='memory')targetId=await withProgrammaticCandidate(client,batchId,snapshot,'memory',source.intake_binding.actor,async()=>{
     const row=await createMemory({...common,scope:payload.scope,tags:payload.tags,summary:payload.summary,detail:payload.detail??undefined},undefined,client)
     return row.id
    })
    else if(payload.command==='entity')targetId=await withProgrammaticCandidate(client,batchId,snapshot,'entity',source.intake_binding.actor,async()=>{
     if(payload.action!=='create_entity')throw new Error('capture_candidate_writer_required')
     const row=await createEntity({...common,kind:payload.entityKind,displayName:payload.displayName,canonicalId:payload.canonicalId,attributes:payload.attributes},client)
     return row.id
    })
    else if(payload.command==='task')targetId=await withProgrammaticCandidate(client,batchId,snapshot,'task',source.intake_binding.actor,async()=>{
     const verdict=await admitTask(taskPort,{workspaceId:source.workspace_id,title:payload.title,due:payload.dueIso?new Date(payload.dueIso):null,
      lane:'extracted',sourceKind:payload.sourceKind,sourceEpisodeId:id,createdByAssistantId:source.assistant_id,quality:payload.quality})
     if(verdict.outcome!=='allow')throw new Error('capture_task_not_admitted')
     const row=await createTask(source.intake_binding.actor,{...common,title:payload.title,due:payload.dueIso?new Date(payload.dueIso):null,
      visibility:{userId:null,assistantId:source.assistant_id}},undefined,client)
     const version=(await client.query<{version:string}>('SELECT scope_version::text AS version FROM tasks WHERE id=$1',[row.id])).rows[0].version
     await recordDerivedResource(client,candidateEvidence(snapshot),{...snapshot,resourceKind:'task',resourceId:row.id,version},source.intake_binding.actor)
     return row.id
    })
    else if(payload.command!=='episode_finalization')throw new Error('capture_candidate_writer_required')
    const receiptId=randomUUID()
    await client.query(`INSERT INTO episode_extraction_items(run_id,candidate_id,primitive_kind,payload_hash,dependency_ids,
     disposition,target_record_id,receipt_id,attempt_count,applied_at) VALUES($1,$2,$3,$4,$5,'committed',$6,$7,1,now())`,
     [runId,c.candidateId,c.primitiveKind,c.payloadHash,c.dependencyIds,targetId,receiptId])
    items.push({candidateId:c.candidateId,primitiveKind:c.primitiveKind,payloadHash:c.payloadHash,dependencyIds:c.dependencyIds,
     disposition:'committed' as const,targetRecordId:targetId,receiptId,attemptCount:1,failureCode:null,retryable:false})
   }
   await client.query("UPDATE episode_extraction_runs SET application_state='complete' WHERE id=$1",[runId])
   return {id:runId,workspaceId:source.workspace_id,episodeId:id,attemptKey,planHash:plan.planHash,
    extractionState:'succeeded',applicationState:'complete',errorCode:null,items,
    counts:{pending:0,committed:items.length,already_applied:0,held:0,rejected:0,failed:0}} satisfies ExtractionApplicationRun
  }}
  const unavailable=new Proxy({}, {get(){return ()=>{throw new Error('capture_candidate_writer_required')}}})
  // No workspace-owner lookup: new source-derived entities are never reused
  // or superseded using unbounded human read authority.
  const entities={...unavailable,findByCanonicalIdSystem:async()=>[],findByNameSystem:async()=>null} as unknown as PipelineBDeps['entities']
  const deps:PipelineBDeps={...options,classifierModel:null,application,
   crm:unavailable as PipelineBDeps['crm'],entities,tasks:unavailable as PipelineBDeps['tasks'],taskAdmission:taskPort,
   entityLinks:unavailable as PipelineBDeps['entityLinks'],memories:unavailable as PipelineBDeps['memories'],
   episodes:{
    async getEpisodeByIdSystem(_actor,episodeId){if(episodeId!==id)throw new Error('capture_source_changed');return (await client.query(`SELECT scope_version::text AS "scopeVersion",status,scope_held AS "scopeHeld",extraction_locked AS "extractionLocked" FROM episodes WHERE id=$1`,[id])).rows[0]},
    async updateCheckpoint(_actor,episodeId,patch){if(episodeId!==id)throw new Error('capture_source_changed');await client.query('UPDATE episodes SET summary_text=$2 WHERE id=$1',[id,patch.summaryText??null])},
    async updateStatus(_actor,episodeId,status){if(episodeId!==id)throw new Error('capture_source_changed');await client.query('UPDATE episodes SET status=$2 WHERE id=$1',[id,status])},
   }}
  const result=await processEpisode(episode,content,deps)
  if(!result.extracted || result.applicationState!=='complete')throw new Error('capture_extraction_incomplete')
  await load() // expiry/hold recheck after extraction, before claimant commit
  await client.query('RELEASE SAVEPOINT programmatic_terminal')
  return result
  } catch(error) {
   await client.query('ROLLBACK TO SAVEPOINT programmatic_terminal')
   await client.query('RELEASE SAVEPOINT programmatic_terminal')
   throw error
  }
 }
}

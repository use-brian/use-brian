/** Existing deterministic workflow caller under the real bound app service. [COMP:api/source-service-binding] */
import { z } from 'zod'
import { ContextScopeAccumulator, buildTool, type ExecutionContext, type ScopeSource, type TurnScope, type Tool,
  type WorkflowRunRecord, type ScopeEvidence } from '@use-brian/core'
import { SourceProtocolError } from '@use-brian/brian-app/connector'
import { ApplicationPlatformError } from '@use-brian/shared'
import { getPool,getAppPool,applyRLSGucs,runWithAgentAccess } from '../db/client.js'
import { applyApplicationRLSContext,releaseApplicationTransactionBinding } from '../application-platform/execution-context.js'
import { resolveSourceServiceExecution,getSourceServiceExecutionBinding } from '../application-platform/source-service-binding.js'
import { getSharedRetainedSourceAuthority } from '../application-platform/source-runtime.js'
import { pinPreparedExternalSourceAuthority,assertPreparedExternalSourceAuthorityCurrent } from '../application-platform/retained-source-authority.js'
import { validateDerivedWriteInputs } from '../db/derived-scope-store.js'
import { buildConnectorAuthHeaders } from '../mcp/auth-headers.js'
import { mcpToolDisplayResult } from '../mcp/client.js'

type Runtime={execution:ExecutionContext;runId:string;workflowId:string;initial:ScopeEvidence;assertCurrent:()=>Promise<void>}
const scopes=new WeakMap<TurnScope,Runtime>()
const outputs=new WeakMap<object,{runtime:Runtime;evidence:ScopeEvidence}>()
function denied():never{throw Object.assign(new SourceProtocolError('source_access_denied'),{reason:'workflow_authority_unavailable'})}
/** The immutable server row, not workflow input or a JSON principal, selects this lane. */
export async function resolveSourceServiceWorkflowScope(params:{workspaceId:string;assistantId:string;run:WorkflowRunRecord}){
 const saved=(await getPool().query<{bindingId:string;revision:string;fingerprint:string}>('SELECT binding_id AS "bindingId",binding_revision::text AS revision,authority_fingerprint AS fingerprint FROM source_service_workflow_runs WHERE run_id=$1',[params.run.id])).rows[0]
 const selected=saved?.bindingId??(await getPool().query<{id:string}>('SELECT id FROM source_service_bindings WHERE workflow_id=$1 AND workspace_id=$2 AND status<>\'revoked\' ORDER BY created_at DESC LIMIT 1',[params.run.workflowId,params.workspaceId])).rows[0]?.id
 if(!selected)return undefined
 const execution=await resolveSourceServiceExecution(selected,{runId:params.run.id}),binding=getSourceServiceExecutionBinding(execution)!
 if(binding.row.workflowId!==params.run.workflowId||binding.row.workspaceId!==params.workspaceId||binding.row.assistantId!==params.assistantId)denied()
 const workflow=(await getPool().query<{definition:{steps:Array<{type:string}>};status:string;vars:Record<string,unknown>}>(`SELECT w.definition,r.status,r.vars FROM workflows w JOIN workflow_runs r ON r.workflow_id=w.id
 WHERE r.id=$1 AND r.workspace_id=$2`,[params.run.id,params.workspaceId])).rows[0]
 if(!workflow||workflow.definition.steps.some(step=>!['tool_call','wait','branch'].includes(step.type)))denied()
 if(!saved){
  if(workflow.status!=='pending'||Object.keys(workflow.vars).length||(await getPool().query('SELECT 1 FROM workflow_step_runs WHERE run_id=$1 LIMIT 1',[params.run.id])).rowCount)denied()
  await getPool().query(`INSERT INTO source_service_workflow_runs(run_id,binding_id,binding_revision,authority_fingerprint)
  SELECT r.id,$2,$3,$4 FROM workflow_runs r WHERE r.id=$1 AND r.status='pending' AND r.vars='{}'::jsonb
  AND NOT EXISTS(SELECT 1 FROM workflow_step_runs s WHERE s.run_id=r.id) ON CONFLICT DO NOTHING`,[params.run.id,binding.row.id,binding.row.revision,binding.row.authorityFingerprint])
 }
 const frozen=(await getPool().query<{bindingId:string;revision:string;fingerprint:string}>('SELECT binding_id AS "bindingId",binding_revision::text AS revision,authority_fingerprint AS fingerprint FROM source_service_workflow_runs WHERE run_id=$1',[params.run.id])).rows[0]
 if(!frozen||frozen.bindingId!==binding.row.id||frozen.revision!==binding.row.revision||frozen.fingerprint!==binding.row.authorityFingerprint)denied()
 const initial=new ContextScopeAccumulator(params.run.vars.__contextScopeEvidence as ScopeEvidence|undefined).evidence
 if(initial.sources?.some(s=>s.resourceKind!=='external_source'||s.workspaceId!==params.workspaceId))denied()
 const assertCurrent=async()=>{
  await execution.security.authority.assertCurrent();await binding.assertCurrent()
  const row=(await getPool().query<{status:string;bindingId:string;revision:string;fingerprint:string}>(`SELECT r.status,f.binding_id AS "bindingId",f.binding_revision::text AS revision,f.authority_fingerprint AS fingerprint
  FROM workflow_runs r JOIN source_service_workflow_runs f ON f.run_id=r.id WHERE r.id=$1 AND r.workspace_id=$2`,[params.run.id,params.workspaceId])).rows[0]
  if(!row||row.status==='failed'||row.bindingId!==frozen.bindingId||row.revision!==frozen.revision||row.fingerprint!==frozen.fingerprint)denied()
 }
 const ceiling=execution.security.ceiling
 const turnScope:TurnScope={access:execution.security.access,effectiveCompartments:ceiling.compartments,effectiveProjectIds:ceiling.projectIds,
  writeCompartments:[],writeProjectIds:[],activeGroupId:null,activeProjectId:null}
 const runtime:Runtime={execution,runId:params.run.id,workflowId:params.run.workflowId,initial,assertCurrent};scopes.set(turnScope,runtime)
 const executeWithAuthority=async<T>(operation:()=>Promise<T>)=>runWithAgentAccess(execution.security.access,async()=>{
  await assertCurrent()
  if(initial.sources?.length)await validateCurrentSources(runtime,initial.sources,'context')
  const value=await operation()
  await assertCurrent()
  return value
 })
 await executeWithAuthority(async()=>undefined)
 return {turnScope,executionContext:execution,assistantClearance:ceiling.clearance,inputScopeEvidence:initial,executeWithAuthority}
}
async function validateCurrentSources(runtime:Runtime,sources:readonly ScopeSource[],action:'context'|'retain',operation?:(client:import('pg').PoolClient)=>Promise<void>){
 const wiring=getSharedRetainedSourceAuthority();if(!wiring)denied()
 const prepared=await wiring.coordinator.prepare(runtime.execution,sources,action),client=await getAppPool().connect();let commitStarted=false
 try{
  await client.query('BEGIN');await applyRLSGucs(client,runtime.execution.security.access.userId);await applyApplicationRLSContext(client,runtime.execution)
  await pinPreparedExternalSourceAuthority(client,runtime.execution,prepared)
  if(action==='retain')await validateDerivedWriteInputs(client,{producer:'source-service-workflow',sources:[...sources]})
  await operation?.(client);await runtime.assertCurrent();commitStarted=true;await client.query('COMMIT')
  await assertPreparedExternalSourceAuthorityCurrent(runtime.execution,prepared)
 }catch(error){await client.query('ROLLBACK').catch(()=>{});if(commitStarted&&operation)throw new ApplicationPlatformError('outcome_uncertain','Reconcile the workflow result before retrying.','uncertain');throw error}
 finally{releaseApplicationTransactionBinding(client);client.release()}
}

/** Only exact bound source tools are present; human first-party tools never enter this map. */
export async function buildSourceServiceWorkflowTools(turnScope:TurnScope):Promise<Map<string,Tool>|undefined>{
 const runtime=scopes.get(turnScope);if(!runtime)return undefined
 const binding=getSourceServiceExecutionBinding(runtime.execution)!,wiring=getSharedRetainedSourceAuthority();if(!wiring)denied()
 await runtime.assertCurrent()
 const instance=(await getPool().query<{instanceId:string}>('SELECT connector_instance_id AS "instanceId" FROM connector_source_profiles WHERE id=$1',[binding.row.profileId])).rows[0]?.instanceId
 const shared=await import('../application-platform/source-runtime.js')
 const instances=shared.getSharedSourceInstances();if(!instance||!instances)denied()
 const auth=await instances.getAuthCredentialsSystem(instance);if(!auth)denied()
 const accumulator=new ContextScopeAccumulator(runtime.initial)
 const source=await wiring.factory({workspaceId:binding.row.workspaceId,instanceId:instance,execution:runtime.execution,accumulator,headers:buildConnectorAuthHeaders(auth)??{}})
 if(!source?.read)denied()
 const catalog=await source.discover('Bound workflow source'),tools=new Map<string,Tool>()
 for(const tool of catalog.tools){
  tools.set(tool.name,buildTool({name:tool.name,description:tool.description??'Read the bound protected source.',inputSchema:z.record(z.unknown()),execute:async(input,context)=>{
   const projected=context.executionContext
    if(!projected||projected.security!==runtime.execution.security||projected.identity!==runtime.execution.identity||projected.assistant!==runtime.execution.assistant
      ||projected.lifecycle.abortSignal.aborted||runtime.execution.lifecycle.abortSignal.aborted)denied();await runtime.assertCurrent()
   const read=await source.read!(tool.name,input)
   const data={value:mcpToolDisplayResult(read.result)}
   const combined=new ContextScopeAccumulator(runtime.initial);combined.note({sources:read.sources});const evidence=combined.evidence
   outputs.set(data,{runtime,evidence});return {data,scopeEvidence:evidence}
  }}))
 }
 await runtime.assertCurrent();return tools
}
/** The existing canonical run store calls this before any protected bytes are persisted. */
export async function persistSourceServiceWorkflowOutput(stepId:string,output:Record<string,unknown>):Promise<boolean>{
 const binding=outputs.get(output);if(!binding){
  // A copied/unbound protected result must never fall through to the system writer.
  if((await getPool().query(`SELECT 1 FROM workflow_step_runs s JOIN source_service_workflow_runs r ON r.run_id=s.run_id WHERE s.id=$1 AND s.step_type='tool_call'`,[stepId])).rowCount)denied()
  return false
 }
 const runtime=binding.runtime,service=getSourceServiceExecutionBinding(runtime.execution);if(!service)denied()
 await runtime.assertCurrent()
 const step=(await getPool().query<{runId:string}>('SELECT run_id AS "runId" FROM workflow_step_runs WHERE id=$1',[stepId])).rows[0]
 if(step?.runId!==runtime.runId)denied()
 await runWithAgentAccess(runtime.execution.security.access,()=>validateCurrentSources(runtime,binding.evidence.sources??[],'retain',async client=>{
  await client.query('SELECT persist_source_service_workflow_output($1,$2,$3,$4)',[service.row.id,stepId,output,binding.evidence])
 }))
 return true
}

/** Native configuration rights admit starting a scoped service; they never become its actor. */
export async function admitScopedSourceWorkflowStart(userId:string,workspaceId:string,workflowId:string){
 const rows=(await getPool().query<{id:string;status:string}>("SELECT b.id,b.status FROM source_service_bindings b JOIN connector_source_profiles p ON p.id=b.profile_id WHERE b.workflow_id=$1 AND b.workspace_id=$2 AND p.scoped_app_id=b.app_id ORDER BY b.created_at DESC",[workflowId,workspaceId])).rows
 if(!rows.length)return undefined
 const active=rows.filter(row=>row.status==='active');if(active.length!==1)denied()
 const execution=await resolveSourceServiceExecution(active[0].id),binding=getSourceServiceExecutionBinding(execution)!
 if((await getPool().query("SELECT 1 FROM workspace_members WHERE workspace_id=$1 AND user_id=$2 AND role IN('owner','admin')",[workspaceId,userId])).rowCount!==1)denied()
 if(binding.row.workflowId!==workflowId||binding.row.workspaceId!==workspaceId)denied()
 await execution.security.authority.assertCurrent();await binding.assertCurrent();return true

}

import {withCurrentReadAuthority} from './authority-lease.js'
import {assertOutputOperationAuthority} from '@use-brian/agent-runtime/engine/query-loop.js'
import {executionToolContext} from '@use-brian/agent-runtime/security/execution-context.js'
import {tryNativeInvocationEvidence} from './native-invocation-evidence.js'
import { nativeSessionQueryContextSources } from '../application-platform/session-query-context.js'
/** Native attended recipient admission. [COMP:api/application-persistence] [COMP:api/delivery-authority] */
import {intersectAccessCeilings, type AccessCeiling} from '@use-brian/agent-runtime/security/access-ceiling.js'
import {ContextScopeAccumulator, type ScopeEvidence} from '@use-brian/agent-runtime/security/context-scope.js'
import type {ScopeSource} from '@use-brian/agent-runtime/security/derived-scope.js'
import type {ExecutionContext} from '@use-brian/agent-runtime/security/execution-context.js'
import type {ChannelIntegrationStore} from '../db/channel-integrations.js'
import {getAppPool,getPool,applyRLSGucs,rollbackAndRelease,runWithAgentAccess} from '../db/client.js'
import {applyApplicationRLSContext,releaseApplicationTransactionBinding,getApplicationExecutionBinding} from '../application-platform/execution-context.js'
import {getSharedRetainedSourceAuthority} from '../application-platform/source-runtime.js'
import {isConversationEvidenceRoot} from '../application-platform/conversation-evidence.js'
import {readApplicationFieldAncestors} from '../application-platform/field-evidence.js'
import {readExternalSourceAncestors} from '../application-platform/external-source-ancestry.js'
import {readPersistentSessionContextAncestors} from '../db/session-context-ancestry.js'
import {pinPreparedExternalSourceAuthority,assertPreparedExternalSourceAuthorityCurrent,type PreparedExternalSourceAuthority} from '../application-platform/retained-source-authority.js'
import {assertScopeEvidenceFitsCeiling,validateAudienceScopeEvidence,validateCallerScopeEvidence,tryValidateNativeScopeEvidence,scopeEvidenceFailureOf} from './caller-evidence.js'
import {createDeliveryAudienceAuthorizer,createDeliveryAudienceEnvelopeResolver,DeliveryAudienceUnverifiedError,type AuthorizeDeliveryAudience,type DeliveryAudienceInput,type DeliveryAudienceDecision} from './delivery-authority.js'
import {classifySession,isWebTransport,policyFor} from '../session-kind.js'
import {readSessionById} from '../db/sessions.js'
import {hasWorkspaceMcpRetainedAuthority} from '../db/session-context-revisions.js'
import {findAssistantById} from '../db/users.js'
import {deliveryFailureMetadata,type DeliveryVerificationPhase} from './delivery-failure.js'
import {yieldOptionalEvidence} from './optional-evidence.js'
import {beginClosureAdmission} from './admission-closure.js'
import {admitTurnConversationRecords,assertConversationFloor,recordEvidenceParts} from './conversation-record-admission.js'

type Prepare=(execution:ExecutionContext,sources:readonly ScopeSource[],action:'context'|'deliver')=>Promise<PreparedExternalSourceAuthority>
type Options={integrationStore?:ChannelIntegrationStore;prepareSource?:Prepare}
function denied(phase?:DeliveryVerificationPhase):never{throw new DeliveryAudienceUnverifiedError(undefined,'source_unverifiable',deliveryFailureMetadata(undefined,phase))}
/** A destination narrows data access, never the original invocation identity. */
export async function admitAttendedAudienceEvidence(execution:ExecutionContext,rawEvidence:ScopeEvidence,rawRecipient:AccessCeiling,
 options:{prepareSource?:Prepare;directHumanSource?:boolean;pageThreadSessionId?:string;turnDestinationSessionId?:string}={}):Promise<ScopeEvidence>{
 try{
  const evidence=new ContextScopeAccumulator(execution.security.provenance);evidence.note(structuredClone(rawEvidence))
  const recipient=structuredClone(rawRecipient),workspaceId=execution.security.access.workspaceId,actor=execution.security.access.userId
  const pageAudience=options.pageThreadSessionId===execution.lifecycle.sessionId&&execution.security.access.sharedAudience
   ?{sessionId:options.pageThreadSessionId,actorUserId:actor}:undefined
  // This admission's view of its turn's admission closure (one witness read).
  const closure=beginClosureAdmission(execution)
  const validateAudience=(value:ScopeEvidence,ceiling:AccessCeiling,client?:import('pg').PoolClient)=>
   validateAudienceScopeEvidence(value,ceiling,client,pageAudience,client?closure:undefined)
  const machine=hasWorkspaceMcpRetainedAuthority(execution)
  if(execution.ownership.kind!=='workspace'||!machine&&(execution.identity.kind!=='attended'||execution.identity.principal.kind!=='workspace_member'
   ||execution.identity.principal.userId!==actor)||recipient.workspaceId!==workspaceId||recipient.userId!==''&&recipient.userId!==actor)denied()
  let sources=evidence.evidence.sources??[]
  if(sources.some(source=>source.workspaceId!==workspaceId))denied()
  const recordParts=recordEvidenceParts(evidence.evidence)
  if(recordParts){
   // Only the receiving web turn's own sink may use its record as a leaf.
   // Its freshly checked destination and the high-water labels govern this
   // frame. Tool reads and publication keep their independent source checks.
   if(!options.turnDestinationSessionId||options.turnDestinationSessionId!==execution.lifecycle.sessionId
    ||execution.lifecycle.channelType!=='web'||execution.lifecycle.abortSignal.aborted)denied()
   assertScopeEvidenceFitsCeiling(evidence.evidence,recipient,'audience')
   const current=await admitTurnConversationRecords(execution,recordParts.records,'frame')
   assertConversationFloor(evidence.evidence,current.destination)
   if(execution.lifecycle.abortSignal.aborted)denied()
   return evidence.evidence
  }
  if(!sources.length){
   const current=await withCurrentReadAuthority(execution.security.authority,()=>validateAudience(evidence.evidence,recipient))
   return current
  }
  const native=await tryNativeInvocationEvidence(execution,evidence.evidence,recipient,'audience')
  if(native){return native}
  return await withCurrentReadAuthority(execution.security.authority,async()=>{
  // Optional decoration defers before its ancestry discovery (no SQL otherwise).
  await yieldOptionalEvidence()
  // Ancestry discovery is metadata; the turn's closure may hold this exact
  // input's result while every source it relies on is unchanged.
  const roots=sources,discoverAncestry=async()=>{
   const persistent=await readPersistentSessionContextAncestors(workspaceId,roots)
   const expanded=new ContextScopeAccumulator(evidence.evidence);expanded.note({sources:persistent})
   const reached=expanded.evidence.sources??[]
   return {persistent,fields:await readApplicationFieldAncestors(workspaceId,reached),external:await readExternalSourceAncestors(workspaceId,reached)}
  }
  const ancestry=closure?await closure.discover('attended-audience',[...roots],discoverAncestry,
   value=>value.external.length?null:[...roots,...value.persistent,...value.fields]):await discoverAncestry()
  evidence.note({sources:ancestry.persistent})
  sources=evidence.evidence.sources??[]
  const fields=ancestry.fields,external=ancestry.external
  evidence.note({sources:[...fields,...external]});sources=evidence.evidence.sources??[]
  const anonymous=recipient.userId==='',hasExternal=sources.some(source=>source.resourceKind==='external_source')
  // The existing native validator already checks current ordinary source
  // envelopes. Field, context and independent-source evidence requires the
  // bound non-owner transaction below; no admission result is cached.
  if(!fields.length&&!hasExternal&&!sources.some(isConversationEvidenceRoot)){
   const current=await validateAudience(evidence.evidence,recipient)
   return current
  }
  let nativeFieldProof:ScopeSource[]=[]
  if(anonymous){
   if(hasExternal)denied()
   const ids=[...new Set(sources.filter(source=>source.resourceKind==='application_field').map(source=>source.resourceId))]
   if(ids.length){
    // Metadata is not admission. Fields outside the original session allowlist
    // must independently complete the existing closed native reader below.
    const rows=(await getPool().query<{id:string;closed:boolean}>(`SELECT id,origin='{"kind":"native","moduleKey":"native"}'::jsonb
     AND type_key IN('session_message','session_message_annotation') AS closed FROM application_field_resources WHERE workspace_id=$1 AND id=ANY($2::uuid[])`,[workspaceId,ids])).rows
    if(rows.length!==ids.length)denied()
    const unproved=new Set(rows.filter(row=>!row.closed).map(row=>row.id))
    nativeFieldProof=sources.filter(source=>source.resourceKind==='application_field'&&unproved.has(source.resourceId))
   }
  }
  if(hasExternal&&!options.directHumanSource)denied()
  const wiring=getSharedRetainedSourceAuthority(),prepare=options.prepareSource??(wiring?((e:ExecutionContext,s:readonly ScopeSource[],a:'context'|'deliver')=>wiring.coordinator.prepare(e,s,a)):undefined)
  const cohortRoots=sources,discoverCohort=()=>nativeSessionQueryContextSources(execution,cohortRoots,prepare)
  const cohort=!fields.length?{sources,independent:false}:closure?await closure.discover('attended-cohort',[...cohortRoots],discoverCohort,
   value=>value.independent?null:[...cohortRoots,...value.sources]):await discoverCohort()
  if((hasExternal||cohort.independent)&&!prepare)denied()
  const contextProof=cohort.independent?await prepare!(execution,cohort.sources,'context'):undefined
  const prepared=hasExternal?await prepare!(execution,sources,'deliver'):undefined
  const assertWiring=()=>{if(!options.prepareSource&&wiring!==getSharedRetainedSourceAuthority())denied()}
  assertWiring()
  // A shared destination contributes visibility and label restrictions to the
  // original actor. No recipient identity or synthetic member is used in SQL.
  const maximum:AccessCeiling={workspaceId,userId:actor,clearance:recipient.clearance,compartments:recipient.compartments,
   mutationCompartments:[],projectIds:recipient.projectIds,visibilityAssistantIds:execution.security.ceiling.visibilityAssistantIds,
   ...(!anonymous&&recipient.departmentRead?{departmentRead:recipient.departmentRead}:{})}
  const bounded=intersectAccessCeilings(execution.security.ceiling,maximum)
  const client=await getAppPool().connect()
  let result:ScopeEvidence
  try{result=await runWithAgentAccess(execution.security.access,async()=>{
   await client.query('BEGIN')
   const role=(await client.query<{bypass:boolean}>(`SELECT r.rolsuper OR r.rolbypassrls OR pg_has_role(r.oid,c.relowner,'USAGE') AS bypass
    FROM pg_roles r JOIN pg_class c ON c.oid='session_messages'::regclass WHERE r.rolname=current_user`)).rows[0]
   if(role?.bypass!==false)denied()
   await runWithAgentAccess({...execution.security.access,...bounded,sharedAudience:anonymous||execution.security.access.sharedAudience},()=>applyRLSGucs(client,actor))
   if(machine)await client.query("SELECT set_config('app.v2_assistant_id',$1,true)",[execution.assistant.id])
   await client.query('SELECT id FROM workspaces WHERE id=$1 FOR SHARE',[workspaceId])
   if(nativeFieldProof.length){
    // This is the same source/recipient proof used for a standalone native
    // closure, on the original actor's non-owner transaction. Null refuses;
    // machine identity never exempts a field from proof. Keep all original
    // roots and validate the complete mixed ancestry below under these locks.
    const current=await tryValidateNativeScopeEvidence({sources:nativeFieldProof},recipient,client,'audience')
    if(!current)denied('anonymous_field_proof')
    evidence.note(current)
   }
   await applyApplicationRLSContext(client,execution)
   if(contextProof){
    await pinPreparedExternalSourceAuthority(client,execution,contextProof)
    await validateCallerScopeEvidence(evidence.evidence,recipient,client)
   }
   if(prepared)await pinPreparedExternalSourceAuthority(client,execution,prepared)
   const admitted=await validateAudience(evidence.evidence,recipient,client)
   // This transaction is read-only. The current lease is checked again on
   // return, after COMMIT and current source-proof checks.
   assertWiring();await client.query('COMMIT');return admitted
  })}finally{releaseApplicationTransactionBinding(client);await rollbackAndRelease(client)}
  if(contextProof)await assertPreparedExternalSourceAuthorityCurrent(execution,contextProof)
  if(prepared)await assertPreparedExternalSourceAuthorityCurrent(execution,prepared)
  assertWiring();return result
  })
 }catch(error){
  if(error instanceof DeliveryAudienceUnverifiedError)throw error
  throw Object.assign(new DeliveryAudienceUnverifiedError(undefined,scopeEvidenceFailureOf(error)??'verification_error',error),{cause:error})
 }
}
/** One complete destination admission for kernel and standalone effects. */
export function createAttendedDeliveryAudienceAuthorizer(execution:ExecutionContext,options:Options={}):AuthorizeDeliveryAudience{
 const dependencies={...options}
 const envelope=createDeliveryAudienceEnvelopeResolver({integrationStore:dependencies.integrationStore})
 return async input=>{
  const pinned=structuredClone(input),actor=execution.security.access.userId

  const capture=admitAttendedAudienceEvidence
  const resolve=async():Promise<DeliveryAudienceDecision>=>{
   const fallback=()=>createDeliveryAudienceAuthorizer({integrationStore:dependencies.integrationStore,
    validateEvidence:(evidence,recipient)=>capture(execution,evidence,recipient,{
     ...(dependencies.prepareSource?{prepareSource:dependencies.prepareSource}:{}),
     directHumanSource:isWebTransport(pinned.channelType)||pinned.recipientType==='individual',
     pageThreadSessionId:pinned.sessionId,
     ...(pinned.channelType==='web'&&pinned.channelId===execution.lifecycle.channelId&&pinned.userId===actor
      &&pinned.assistantId===execution.assistant.id?{turnDestinationSessionId:pinned.sessionId}:{}),
    })})(pinned)
   if(!isWebTransport(pinned.channelType)||pinned.sessionId!==execution.lifecycle.sessionId
    ||execution.lifecycle.sessionPersisted===false||execution.security.access.sharedAudience
    ||execution.identity.kind!=='attended'||execution.identity.principal.kind!=='workspace_member'
    ||execution.identity.principal.userId!==actor||pinned.userId!==actor||pinned.workspaceId!==execution.security.access.workspaceId
    ||pinned.assistantId!==execution.assistant.id||getApplicationExecutionBinding(execution)
    ||pinned.recipientType==='group'||pinned.recipientMode&&pinned.recipientMode!=='member')return fallback()
   const session=await readSessionById(pinned.sessionId!)
   if(!session)return{allowed:false,reason:'delivery_audience_unverified',diagnostic:'session_missing'}
   if(session.channelType!==pinned.channelType||session.channelId!==pinned.channelId)
    return{allowed:false,reason:'delivery_audience_unverified',diagnostic:'binding_recipient_conflict'}
   if(policyFor(session).deliveryCeiling.ceiling!=='owner'||session.userId!==actor||classifySession(session).surface!=='chat')return fallback()
   const owner=await findAssistantById(session.assistantId)
   if(!owner||owner.workspaceId!==pinned.workspaceId)return{allowed:false,reason:'delivery_audience_unverified',diagnostic:'session_assistant_missing'}
   // The stored owner and explicit recipient are the same original actor, in
   // the same bound web destination and answering assistant. Resolve that one
   // constraint once; distinct channel/room constraints use the owner above.
   const recipient=await envelope(pinned)
   if(!recipient.allowed)return recipient
   if(recipient.ceiling.userId!==actor)return{allowed:false,reason:'delivery_audience_unverified',diagnostic:'binding_recipient_conflict'}
   return{allowed:true,evidence:await capture(execution,pinned.scopeEvidence??{},recipient.ceiling,{
    ...(dependencies.prepareSource?{prepareSource:dependencies.prepareSource}:{}),directHumanSource:true,turnDestinationSessionId:session.id,
   })}
  }
  let decision:DeliveryAudienceDecision|undefined
  const accumulator=new ContextScopeAccumulator(pinned.scopeEvidence)
  try{
   await assertOutputOperationAuthority({...executionToolContext(execution,{appId:'attended-delivery'}),scopeAccumulator:accumulator,
    admitModelOutput:async()=>{decision=await resolve();if(decision.allowed)accumulator.note(decision.evidence)}})
   return decision!
  }catch(error){return{allowed:false,reason:'delivery_audience_unverified',diagnostic:scopeEvidenceFailureOf(error)??'verification_error',...deliveryFailureMetadata(error)}}
 }
}

/** Standalone recipient consumers enter the core effect owner too. */
export async function validateAttendedAudienceEvidence(execution:ExecutionContext,rawEvidence:ScopeEvidence,rawRecipient:AccessCeiling,
 options:Parameters<typeof admitAttendedAudienceEvidence>[3]={}):Promise<ScopeEvidence>{
 let result:ScopeEvidence|undefined
 try {
  await assertOutputOperationAuthority({...executionToolContext(execution,{appId:'attended-delivery'}),
   scopeAccumulator:new ContextScopeAccumulator(rawEvidence),
   admitModelOutput:async()=>{result=await admitAttendedAudienceEvidence(execution,rawEvidence,rawRecipient,options)}})
  return result!
 }catch(error){
  if(error instanceof DeliveryAudienceUnverifiedError)throw error
  throw Object.assign(new DeliveryAudienceUnverifiedError(undefined,scopeEvidenceFailureOf(error)??'verification_error',error),{cause:error})
 }
}

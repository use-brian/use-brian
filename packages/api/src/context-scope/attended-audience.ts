import {tryNativeInvocationEvidence} from './native-invocation-evidence.js'
import { nativeSessionQueryContextSources } from '../application-platform/session-query-context.js'
/** Native attended recipient admission. [COMP:api/application-persistence] [COMP:api/delivery-authority] */
import {ContextScopeAccumulator,intersectAccessCeilings,type AccessCeiling,type ExecutionContext,type ScopeEvidence,type ScopeSource} from '@use-brian/core'
import type {ChannelIntegrationStore} from '../db/channel-integrations.js'
import {getAppPool,getPool,applyRLSGucs,rollbackAndRelease,runWithAgentAccess} from '../db/client.js'
import {applyApplicationRLSContext,releaseApplicationTransactionBinding} from '../application-platform/execution-context.js'
import {getSharedRetainedSourceAuthority} from '../application-platform/source-runtime.js'
import {readApplicationFieldAncestors} from '../application-platform/field-evidence.js'
import {readExternalSourceAncestors} from '../application-platform/external-source-ancestry.js'
import {readPersistentSessionContextAncestors} from '../db/session-context-ancestry.js'
import {pinPreparedExternalSourceAuthority,assertPreparedExternalSourceAuthorityCurrent,type PreparedExternalSourceAuthority} from '../application-platform/retained-source-authority.js'
import {validateAudienceScopeEvidence,validateCallerScopeEvidence,scopeEvidenceFailureOf} from './caller-evidence.js'
import {createDeliveryAudienceAuthorizer,DeliveryAudienceUnverifiedError,type AuthorizeDeliveryAudience} from './delivery-authority.js'
import {isWebTransport} from '../session-kind.js'

type Prepare=(execution:ExecutionContext,sources:readonly ScopeSource[],action:'context'|'deliver')=>Promise<PreparedExternalSourceAuthority>
type Options={integrationStore?:ChannelIntegrationStore;prepareSource?:Prepare}
function denied():never{throw new DeliveryAudienceUnverifiedError(undefined,'source_unverifiable')}
/** A destination narrows data access, never the original invocation identity. */
export async function validateAttendedAudienceEvidence(execution:ExecutionContext,rawEvidence:ScopeEvidence,rawRecipient:AccessCeiling,
 options:{prepareSource?:Prepare;directHumanSource?:boolean}={}):Promise<ScopeEvidence>{
 try{
  const evidence=new ContextScopeAccumulator(execution.security.provenance);evidence.note(structuredClone(rawEvidence))
  const recipient=structuredClone(rawRecipient),workspaceId=execution.security.access.workspaceId,actor=execution.security.access.userId
  if(execution.ownership.kind!=='workspace'||execution.identity.kind!=='attended'||execution.identity.principal.kind!=='workspace_member'
   ||execution.identity.principal.userId!==actor||recipient.workspaceId!==workspaceId||recipient.userId!==''&&recipient.userId!==actor)denied()
  await execution.security.authority.assertCurrent()
  let sources=evidence.evidence.sources??[]
  if(sources.some(source=>source.workspaceId!==workspaceId))denied()
  if(!sources.length){
   const current=await validateAudienceScopeEvidence(evidence.evidence,recipient)
   await execution.security.authority.assertCurrent();return current
  }
  const native=await tryNativeInvocationEvidence(execution,evidence.evidence,recipient,'audience')
  if(native){await execution.security.authority.assertCurrent();return native}
  evidence.note({sources:await readPersistentSessionContextAncestors(workspaceId,sources)})
  sources=evidence.evidence.sources??[]
  const fields=await readApplicationFieldAncestors(workspaceId,sources),external=await readExternalSourceAncestors(workspaceId,sources)
  evidence.note({sources:[...fields,...external]});sources=evidence.evidence.sources??[]
  const anonymous=recipient.userId==='',hasExternal=sources.some(source=>source.resourceKind==='external_source')
  // The existing native validator already checks current ordinary source
  // envelopes. Field, context and independent-source evidence requires the
  // bound non-owner transaction below; no admission result is cached.
  if(!fields.length&&!external.length&&!sources.some(source=>['application_field','external_source','session_context_revision'].includes(source.resourceKind))){
   const current=await validateAudienceScopeEvidence(evidence.evidence,recipient)
   await execution.security.authority.assertCurrent();return current
  }
  if(anonymous){
   if(hasExternal)denied()
   const ids=[...new Set(sources.filter(source=>source.resourceKind==='application_field').map(source=>source.resourceId))]
   if(ids.length){
    // Private metadata only. This rejects member-specific field families for
    // an anonymous destination; actual native admission still follows in SQL.
    const rows=(await getPool().query<{id:string;closed:boolean}>(`SELECT id,origin='{"kind":"native","moduleKey":"native"}'::jsonb
     AND type_key IN('session_message','session_message_annotation') AS closed FROM application_field_resources WHERE workspace_id=$1 AND id=ANY($2::uuid[])`,[workspaceId,ids])).rows
    if(rows.length!==ids.length||rows.some(row=>!row.closed))denied()
   }
  }
  if(hasExternal&&!options.directHumanSource)denied()
  const wiring=getSharedRetainedSourceAuthority(),prepare=options.prepareSource??(wiring?((e:ExecutionContext,s:readonly ScopeSource[],a:'context'|'deliver')=>wiring.coordinator.prepare(e,s,a)):undefined)
  const cohort=fields.length?await nativeSessionQueryContextSources(execution,sources,prepare):{sources,independent:false}
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
   await client.query('SELECT id FROM workspaces WHERE id=$1 FOR SHARE',[workspaceId])
   await applyApplicationRLSContext(client,execution)
   if(contextProof){
    await pinPreparedExternalSourceAuthority(client,execution,contextProof)
    await validateCallerScopeEvidence(evidence.evidence,recipient,client)
   }
   if(prepared)await pinPreparedExternalSourceAuthority(client,execution,prepared)
   const admitted=await validateAudienceScopeEvidence(evidence.evidence,recipient,client)
   // This transaction is read-only. The current lease is checked again on
   // return, after COMMIT and current source-proof checks.
   assertWiring();await client.query('COMMIT');return admitted
  })}finally{releaseApplicationTransactionBinding(client);await rollbackAndRelease(client)}
  if(contextProof)await assertPreparedExternalSourceAuthorityCurrent(execution,contextProof)
  if(prepared)await assertPreparedExternalSourceAuthorityCurrent(execution,prepared)
  await execution.security.authority.assertCurrent();assertWiring();return result
 }catch(error){
  if(error instanceof DeliveryAudienceUnverifiedError)throw error
  throw Object.assign(new DeliveryAudienceUnverifiedError(undefined,scopeEvidenceFailureOf(error)??'verification_error'),{cause:error})
 }
}
/** Existing destination resolution, with a current original-actor SQL validator. */
export function createAttendedDeliveryAudienceAuthorizer(execution:ExecutionContext,options:Options={}):AuthorizeDeliveryAudience{
 const dependencies={...options}
 return input=>createDeliveryAudienceAuthorizer({integrationStore:dependencies.integrationStore,
  validateEvidence:(evidence,recipient)=>validateAttendedAudienceEvidence(execution,evidence,recipient,{
   ...(dependencies.prepareSource?{prepareSource:dependencies.prepareSource}:{}),
   directHumanSource:isWebTransport(input.channelType)||input.recipientType==='individual',
  })})(input)
}

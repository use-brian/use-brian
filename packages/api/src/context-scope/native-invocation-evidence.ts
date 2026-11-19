import {captureSessionAuthority,withCurrentReadAuthority} from './authority-lease.js'
/** Current native proof before optional ancestry discovery. [COMP:api/application-persistence] */
import {intersectAccessCeilings, type AccessCeiling} from '@use-brian/agent-runtime/security/access-ceiling.js'
import type {ScopeEvidence} from '@use-brian/agent-runtime/security/context-scope.js'
import type {ExecutionContext} from '@use-brian/agent-runtime/security/execution-context.js'
import type {CurrentAuthorityBoundary} from '@use-brian/agent-runtime/tools/types.js'
import {getAppPool,applyRLSGucs,rlsGucSettings,rollbackAndRelease,runWithAgentAccess} from '../db/client.js'
import {getApplicationExecutionBinding} from '../application-platform/execution-context.js'
import {hasWorkspaceMcpRetainedAuthority} from '../db/session-context-revisions.js'
import {tryValidateNativeScopeEvidence} from './caller-evidence.js'

const verifiedProviderEvidence = new WeakMap<ExecutionContext, CurrentAuthorityBoundary>()

/** The channel entry point enrolls the original, linked group invocation.
 * Its credential and destination callbacks remain part of its live lease. */
export function bindVerifiedTelegramEvidence(execution: ExecutionContext): void {
 if (execution.lifecycle.channelType === 'telegram') bindVerifiedProviderEvidence(execution)
}

/** Native threaded provider rooms have an exact record and credential lease. */
export function bindVerifiedThreadRoomEvidence(execution: ExecutionContext): void {
 if (execution.lifecycle.channelType === 'slack' || execution.lifecycle.channelType === 'feishu') bindVerifiedProviderEvidence(execution)
}

function bindVerifiedProviderEvidence(execution: ExecutionContext): void {
 if (execution.lifecycle.sessionPersisted === false
  || execution.identity.kind !== 'attended' || execution.identity.principal.kind !== 'workspace_member'
  || execution.identity.principal.authenticationKind !== 'verified_channel') return
 verifiedProviderEvidence.set(execution, execution.security.authority)
}

/** Null requires the full original validator; it never means admitted. Callers bracket this read with their original live lease.
 * An optional server-owned metadata guard only narrows a completed proof under its native locks. */
export async function tryNativeInvocationEvidence(execution:ExecutionContext,evidence:ScopeEvidence,recipient:AccessCeiling,kind:'caller'|'audience',narrowingGuard?:()=>Promise<void>):Promise<ScopeEvidence|null>{
 const roots=evidence.sources??[],actor=execution.security.access.userId,workspaceId=execution.security.access.workspaceId
 const nativeAttended=execution.identity.kind==='attended'&&execution.identity.principal.kind==='workspace_member'
  &&execution.identity.principal.userId===actor
 const nativeVerifiedAttended=nativeAttended&&execution.identity.kind==='attended'&&execution.identity.principal.kind==='workspace_member'
  &&(execution.identity.principal.authenticationKind==='native_session'||execution.identity.principal.authenticationKind==='verified_channel')&&execution.security.access.assistantId===execution.assistant.id
  &&execution.ownership.kind==='workspace'&&execution.ownership.workspaceId===workspaceId
  &&!execution.surface.systemRead&&!execution.surface.clientSelfMemory&&!execution.security.access.systemRead
 const nativeDelegated=execution.identity.kind==='delegated'&&execution.identity.actorUserId===actor
  &&execution.identity.parentCeiling.userId===actor&&execution.identity.parentCeiling.workspaceId===workspaceId
  &&execution.security.access.assistantId===execution.assistant.id
  &&!execution.surface.readOnly&&!execution.surface.systemRead&&!execution.surface.clientSelfMemory&&!execution.security.access.systemRead
 const nativeProgrammatic=hasWorkspaceMcpRetainedAuthority(execution)
 if(execution.ownership.kind!=='workspace'||execution.ownership.workspaceId!==workspaceId||!nativeAttended&&!nativeDelegated&&!nativeProgrammatic||getApplicationExecutionBinding(execution)
  ||recipient.workspaceId!==workspaceId||recipient.userId!==''&&recipient.userId!==actor
  ||!roots.length||roots.length>4096
  ||roots.some(root=>!['application_field','session_message','session_context_revision','memory','workspace_file','private_transcript'].includes(root.resourceKind)))return null
 const anonymous=recipient.userId===''
 const ceiling=intersectAccessCeilings(execution.security.ceiling,{...recipient,userId:actor,mutationCompartments:[],visibilityAssistantIds:execution.security.ceiling.visibilityAssistantIds})
 const access={...execution.security.access,...ceiling,sharedAudience:anonymous||execution.security.access.sharedAudience}
 const assistantId=nativeDelegated||nativeVerifiedAttended||nativeProgrammatic?execution.assistant.id:undefined
 // A source-only operation has no host work between capture and release.
 // Its RLS initialization and capture share one implicit transaction.
 if(!narrowingGuard)return runWithAgentAccess(access,async()=>{
  const settings=rlsGucSettings(actor,assistantId)
  const lease=execution.security.authority
  // The native capture proves this cohort's entire current ancestry. An
  // unsupported cohort keeps the original independent source checks.
  if(nativeVerifiedAttended&&verifiedProviderEvidence.get(execution)===lease){
   return withCurrentReadAuthority(lease,()=>tryValidateNativeScopeEvidence(evidence,recipient,getAppPool(),kind,settings))
  }
  const captured=await captureSessionAuthority(execution.security.authority,async input=>{
   let authority:unknown
   const value=await tryValidateNativeScopeEvidence(evidence,recipient,getAppPool(),kind,settings,
    {input,capture:facts=>{authority=facts}})
   return value?{authority,value}:null
  })
  return captured?.value??null
 })
 const client=await getAppPool().connect()
 let committed=false
 try{return await withCurrentReadAuthority(execution.security.authority,()=>runWithAgentAccess(access,async()=>{
  await client.query('BEGIN')
  // The canonical SQL owner rejects owner/bypass roles itself before reads.
  await applyRLSGucs(client,actor,assistantId)
  // The SQL facade acquires its native lock only after proving eligibility.
  // Unknown/generic/independent-source closures therefore fall back unlocked.
  const admitted=await tryValidateNativeScopeEvidence(evidence,recipient,client,kind)
  if(admitted)await narrowingGuard?.()
  await client.query('COMMIT');committed=true;return admitted
 }))}finally{if(committed)client.release();else await rollbackAndRelease(client)}
}

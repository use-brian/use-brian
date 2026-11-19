import {captureSessionAuthority,withCurrentReadAuthority} from './authority-lease.js'
/** Current native proof before optional ancestry discovery. [COMP:api/application-persistence] */
import {intersectAccessCeilings, type AccessCeiling} from '@use-brian/agent-runtime/security/access-ceiling.js'
import {ContextScopeAccumulator, type ScopeEvidence} from '@use-brian/agent-runtime/security/context-scope.js'
import type {ExecutionContext} from '@use-brian/agent-runtime/security/execution-context.js'
import type {CurrentAuthorityBoundary} from '@use-brian/agent-runtime/tools/types.js'
import {getAppPool,applyRLSGucs,rlsGucSettings,rollbackAndRelease,runWithAgentAccess,withRLSTransaction} from '../db/client.js'
import {getApplicationExecutionBinding} from '../application-platform/execution-context.js'
import {hasWorkspaceMcpRetainedAuthority} from '../db/session-context-revisions.js'
import {assertScopeEvidenceFitsCeiling,tryValidateNativeScopeEvidence,validateAudienceScopeEvidence} from './caller-evidence.js'

import { z } from 'zod'
import type { PoolClient } from 'pg'
import { resourceScopeKey } from '@use-brian/agent-runtime/security/derived-scope.js'
import { isConversationEvidenceRoot, nativeSessionCurrentScopeSchema } from '../application-platform/conversation-evidence.js'

const verifiedProviderEvidence = new WeakMap<ExecutionContext, CurrentAuthorityBoundary>()
const verifiedResumeEvidence = new WeakMap<ExecutionContext, {
 authority: CurrentAuthorityBoundary
 token: string
 assertOwnerCurrent: () => Promise<void>
}>()

/** Only the original turn owner binds its leased approval execution. */
export function bindVerifiedResumeEvidence(
 execution: ExecutionContext, token: string, assertOwnerCurrent: () => Promise<void>,
): void {
 verifiedResumeEvidence.set(execution, { authority: execution.security.authority, token, assertOwnerCurrent })
}

function resumeReadOwner(execution: ExecutionContext) {
 const owner = verifiedResumeEvidence.get(execution)
 const { identity, security, lifecycle, surface } = execution
 return identity.kind === 'system' && identity.purpose === 'session_resume'
  && execution.ownership.kind === 'workspace' && execution.ownership.workspaceId === security.access.workspaceId
  && lifecycle.sessionPersisted !== false && !lifecycle.abortSignal.aborted
  && security.access.assistantId === execution.assistant.id
  && !surface.systemRead && !surface.clientSelfMemory && !security.access.systemRead
  && !getApplicationExecutionBinding(execution) && owner?.authority === security.authority ? owner : undefined
}

/** Native source proof for a personal web approval returning to its own member. */
export async function admitVerifiedPersonalResumeAudience(
 execution:ExecutionContext,evidence:ScopeEvidence,recipient:AccessCeiling,
):Promise<ScopeEvidence>{
 const owner=resumeReadOwner(execution),{security,lifecycle}=execution
 const {userId,workspaceId}=security.access
 if(!owner||security.access.sharedAudience||lifecycle.channelType!=='web'
  ||recipient.userId!==userId||recipient.workspaceId!==workspaceId)throw new Error('Personal resume recipient unavailable')
 if(!evidence.sources?.some(isConversationEvidenceRoot))return validateAudienceScopeEvidence(evidence,recipient)
 const ceiling=intersectAccessCeilings(security.ceiling,recipient)
 return withCurrentReadAuthority(owner.authority,async()=>{
  await owner.assertOwnerCurrent()
  const checked=await runWithAgentAccess({...security.access,...ceiling},()=>withRLSTransaction(userId,
   client=>validateAudienceScopeEvidence(evidence,recipient,client),execution.assistant.id))
  await owner.assertOwnerCurrent()
  return checked
 })
}

const roomResumeProof = z.object({
 immutable: z.array(nativeSessionCurrentScopeSchema),
 current: z.array(nativeSessionCurrentScopeSchema),
}).strict()

/** Same-room retained dialogue under this exact approval's running owner. */
export async function admitVerifiedSharedRoomResumeEvidence(
 execution: ExecutionContext, evidence: ScopeEvidence, recipient: AccessCeiling, kind: 'caller' | 'audience',
 publication?: { client: Pick<PoolClient, 'query'>; sessionId: string; token: string },
): Promise<ScopeEvidence> {
 const refused = (cause?: unknown) => Object.assign(new Error('Room resume source authority changed', { cause }),
  { reason: 'authority_changed' as const, retrySafe: false })
 const owner = resumeReadOwner(execution)
 const { identity, security, lifecycle } = execution
 const { userId: actor, workspaceId } = security.access
 if (!owner || identity.kind !== 'system' || identity.purpose !== 'session_resume' || !security.access.sharedAudience
  || lifecycle.channelType !== 'web' || recipient.workspaceId !== workspaceId
  || (recipient.userId !== actor && (kind !== 'audience' || recipient.userId !== ''))
  || (publication && (kind !== 'audience' || recipient.userId !== '' || publication.sessionId !== lifecycle.sessionId
    || publication.token !== owner.token))) throw refused()
 const snapshot = structuredClone(evidence)
 const roots = snapshot.sources ?? []
 if (!roots.length || roots.length > 4096 || roots.some(root => root.workspaceId !== workspaceId
  || (root.resourceKind !== 'session_message' && root.resourceKind !== 'session_context_revision'))) throw refused()

 try {
  assertScopeEvidenceFitsCeiling(snapshot, recipient, kind)
  const access = { ...security.access, ...intersectAccessCeilings(security.ceiling, { ...recipient, userId: actor }) }
  const capture = () => runWithAgentAccess(access, async () => {
   lifecycle.abortSignal.throwIfAborted()
   const settings = rlsGucSettings(actor, execution.assistant.id)
   const identities = roots.map(source => ({ kind: source.resourceKind, id: source.resourceId, version: source.version }))
   const receiver = publication?.client ?? getAppPool()
   const captureEvidence = publication
    ? 'public.lock_shared_room_resume_evidence($1,$2,$3,$4,$5,$6,$7,$8,true)'
    : 'public.capture_shared_room_resume_evidence($1,$2,$3,$4,$5,$6,$7,$8)'
   const result = await receiver.query<{ value: unknown }>(`WITH context AS MATERIALIZED (
    SELECT count(set_config(setting.name,setting.value,true)) FROM unnest($9::text[],$10::text[]) AS setting(name,value)
   ) SELECT ${captureEvidence} AS value FROM context`,
   [workspaceId, actor, execution.assistant.id, lifecycle.sessionId, lifecycle.channelId, identity.jobId, owner.token, JSON.stringify(identities),
    settings.map(([name]) => name), settings.map(([, value]) => value)])
   const proof = roomResumeProof.parse(result.rows[0]?.value)
   if (proof.immutable.some(source => source.resourceKind !== 'session_context_revision')
    || roots.some(root => !proof.current.some(source => source.resourceKind === root.resourceKind
      && source.resourceId === root.resourceId && source.version === root.version && resourceScopeKey(source) === resourceScopeKey(root)))) throw refused()
   const expanded = new ContextScopeAccumulator(snapshot)
   expanded.note({ sources: proof.immutable })
   for (const source of proof.current) {
    assertScopeEvidenceFitsCeiling({ sources: [source] }, recipient, kind)
    expanded.note({ sensitivity: source.sensitivity, compartments: source.compartments, projectIds: source.projectIds })
   }
   assertScopeEvidenceFitsCeiling(expanded.evidence, recipient, kind)
   lifecycle.abortSignal.throwIfAborted()
   return expanded.evidence
  })
  if (publication) return await capture()
  return await withCurrentReadAuthority(owner.authority, async () => {
   await owner.assertOwnerCurrent()
   const result = await capture()
   await owner.assertOwnerCurrent()
   return result
  })
 } catch (error) {
  throw refused(error)
 }
}


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
 const nativeResume = !narrowingGuard && kind === 'caller' && recipient.userId === actor ? resumeReadOwner(execution) : undefined

 if(execution.ownership.kind!=='workspace'||execution.ownership.workspaceId!==workspaceId||!nativeAttended&&!nativeDelegated&&!nativeProgrammatic&&!nativeResume||getApplicationExecutionBinding(execution)
  ||recipient.workspaceId!==workspaceId||recipient.userId!==''&&recipient.userId!==actor
  ||!roots.length||roots.length>4096
  ||roots.some(root=>!['application_field','session_message','session_context_revision','memory','workspace_file','private_transcript'].includes(root.resourceKind)))return null
 const anonymous=recipient.userId===''
 const ceiling=intersectAccessCeilings(execution.security.ceiling,{...recipient,userId:actor,mutationCompartments:[],visibilityAssistantIds:execution.security.ceiling.visibilityAssistantIds})
 const access={...execution.security.access,...ceiling,sharedAudience:anonymous||execution.security.access.sharedAudience}
 const assistantId=nativeDelegated||nativeVerifiedAttended||nativeProgrammatic||nativeResume?execution.assistant.id:undefined
 // A source-only operation has no host work between capture and release.
 // Its RLS initialization and capture share one implicit transaction.
 if(!narrowingGuard)return runWithAgentAccess(access,async()=>{
  const settings=rlsGucSettings(actor,assistantId)
  const lease=execution.security.authority
  if (nativeResume) {
   return withCurrentReadAuthority(lease, async () => {
    await nativeResume.assertOwnerCurrent()
    const captured = await tryValidateNativeScopeEvidence(evidence, recipient, getAppPool(), kind, settings)
    await nativeResume.assertOwnerCurrent()
    if (captured || !execution.security.access.sharedAudience || execution.lifecycle.channelType !== 'web') return captured
    return admitVerifiedSharedRoomResumeEvidence(execution, evidence, recipient, kind)
   })
  }
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

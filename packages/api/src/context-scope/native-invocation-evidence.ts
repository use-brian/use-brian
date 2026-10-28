/** Current native proof before optional ancestry discovery. [COMP:api/application-persistence] */
import {intersectAccessCeilings,type AccessCeiling,type ExecutionContext,type ScopeEvidence} from '@use-brian/core'
import {getAppPool,applyRLSGucs,rollbackAndRelease,runWithAgentAccess} from '../db/client.js'
import {getApplicationExecutionBinding} from '../application-platform/execution-context.js'
import {tryValidateNativeScopeEvidence} from './caller-evidence.js'

/** Null requires the full original validator; it never means admitted. Callers bracket this read with their original live lease.
 * An optional server-owned metadata guard only narrows a completed proof under its native locks. */
export async function tryNativeInvocationEvidence(execution:ExecutionContext,evidence:ScopeEvidence,recipient:AccessCeiling,kind:'caller'|'audience',narrowingGuard?:()=>Promise<void>):Promise<ScopeEvidence|null>{
 const roots=evidence.sources??[],actor=execution.security.access.userId,workspaceId=execution.security.access.workspaceId
 const nativeAttended=execution.identity.kind==='attended'&&execution.identity.principal.kind==='workspace_member'
  &&execution.identity.principal.userId===actor
 const nativeSessionAttended=nativeAttended&&execution.identity.kind==='attended'&&execution.identity.principal.kind==='workspace_member'
  &&execution.identity.principal.authenticationKind==='native_session'&&execution.security.access.assistantId===execution.assistant.id
  &&execution.ownership.kind==='workspace'&&execution.ownership.workspaceId===workspaceId
  &&!execution.surface.systemRead&&!execution.surface.clientSelfMemory&&!execution.security.access.systemRead
 const nativeDelegated=execution.identity.kind==='delegated'&&execution.identity.actorUserId===actor
  &&execution.identity.parentCeiling.userId===actor&&execution.identity.parentCeiling.workspaceId===workspaceId
  &&execution.security.access.assistantId===execution.assistant.id
  &&!execution.surface.readOnly&&!execution.surface.systemRead&&!execution.surface.clientSelfMemory&&!execution.security.access.systemRead
 if(execution.ownership.kind!=='workspace'||execution.ownership.workspaceId!==workspaceId||!nativeAttended&&!nativeDelegated||getApplicationExecutionBinding(execution)
  ||recipient.workspaceId!==workspaceId||recipient.userId!==''&&recipient.userId!==actor
  ||!roots.length||roots.length>100||!roots.some(root=>root.resourceKind==='application_field'||root.resourceKind==='session_context_revision')
  ||roots.some(root=>!['application_field','session_message','session_context_revision','memory'].includes(root.resourceKind)))return null
 const anonymous=recipient.userId===''
 const ceiling=intersectAccessCeilings(execution.security.ceiling,{...recipient,userId:actor,mutationCompartments:[],visibilityAssistantIds:execution.security.ceiling.visibilityAssistantIds})
 const client=await getAppPool().connect()
 try{return await runWithAgentAccess(execution.security.access,async()=>{
  await client.query('BEGIN')
  const role=(await client.query<{bypass:boolean}>(`SELECT r.rolsuper OR r.rolbypassrls OR pg_has_role(r.oid,c.relowner,'USAGE') AS bypass
   FROM pg_roles r JOIN pg_class c ON c.oid='session_messages'::regclass WHERE r.rolname=current_user`)).rows[0]
  if(role?.bypass!==false)throw new Error('Native proof requires an application role')
  await runWithAgentAccess({...execution.security.access,...ceiling,sharedAudience:anonymous||execution.security.access.sharedAudience},()=>applyRLSGucs(client,actor))
  // Preserve the original verified native assistant under legacy and v2 policies.
  if(nativeDelegated||nativeSessionAttended)await client.query("SELECT set_config('app.v2_assistant_id',$1,true)",[execution.assistant.id])
  // The SQL facade acquires its native lock only after proving eligibility.
  // Unknown/generic/independent-source closures therefore fall back unlocked.
  const admitted=await tryValidateNativeScopeEvidence(evidence,recipient,client,kind)
  if(admitted)await narrowingGuard?.()
  await client.query('COMMIT');return admitted
 })}finally{await rollbackAndRelease(client)}
}

/** Native HTTP workspace reads through the original R1 factory. [COMP:api/application-persistence] */
import {randomUUID} from 'node:crypto'
import type {SessionContextAuthority} from '@use-brian/core/memory/session-state-types.js'
import {pinAccessCeiling, intersectAccessCeilings} from '@use-brian/agent-runtime/security/access-ceiling.js'
import {ContextScopeAccumulator} from '@use-brian/agent-runtime/security/context-scope.js'
import {DerivedScopeError} from '@use-brian/agent-runtime/security/derived-scope.js'
import type {ExecutionIdentity} from '@use-brian/agent-runtime/security/execution-context.js'
import {query} from '../db/client.js'
import {authSessionStore,type AuthTokenClaims} from '../db/auth-session-store.js'
import {getUserAssistant} from '../db/users.js'
import {resolveWorkspaceViewpoint} from '../db/workspace-viewpoint.js'
import {resolveExecutionContextSystem} from '../context-scope/execution-context.js'
import {resolveLiveAccessCeilingSystem} from '../context-scope/resolve-turn-scope.js'
function denied():never{throw new DerivedScopeError('scope_evidence_missing')}
/** Middleware claims are supplied by the caller; no body/header claim reconstruction. */
export async function resolveNativeWorkspaceReadAuthority(input:{claims:Readonly<AuthTokenClaims>|null;workspaceId:string;selectedAssistantId?:string|null;abortSignal:AbortSignal}):Promise<SessionContextAuthority>{
 const claims=structuredClone(input.claims)
 if(!claims)denied()
 return resolveWorkspaceReadAuthority({
  workspaceId:input.workspaceId,selectedAssistantId:input.selectedAssistantId,abortSignal:input.abortSignal,userId:claims.userId,
  credentialCurrent:()=>authSessionStore.validateAccess(claims),
  identity:()=>({kind:'attended',principal:{kind:'workspace_member',userId:claims.userId,authenticationKind:'native_session'}}),
  channelType:'web',channelId:'native-workspace-read',
 })
}

/** A trusted host supplies an authenticated, revocable delegation bound to this member and workspace. */
export async function resolveDelegatedWorkspaceReadAuthority(input:{
 userId:string;workspaceId:string;delegationId:string;credentialCurrent:()=>Promise<boolean>;abortSignal:AbortSignal
}):Promise<SessionContextAuthority>{
 const {userId,workspaceId,delegationId,credentialCurrent,abortSignal}=input
 return resolveWorkspaceReadAuthority({workspaceId,userId,credentialCurrent,abortSignal,
  identity:parentCeiling=>({kind:'delegated',actorUserId:userId,delegationId,parentCeiling}),
  channelType:'programmatic',channelId:'delegated-workspace-read',
 })
}

async function resolveWorkspaceReadAuthority(input:{
 userId:string;workspaceId:string;selectedAssistantId?:string|null;abortSignal:AbortSignal;credentialCurrent:()=>Promise<boolean>;
 identity:(ceiling:ReturnType<typeof pinAccessCeiling>)=>ExecutionIdentity;channelType:string;channelId:string
}):Promise<SessionContextAuthority>{
 const {userId,workspaceId,selectedAssistantId,abortSignal,credentialCurrent,identity,channelType,channelId}=input
 if(!await credentialCurrent()||abortSignal.aborted)denied()
 const primary=async()=>{
  const rows=(await query<{id:string}>("SELECT id FROM assistants WHERE workspace_id=$1 AND kind='primary' ORDER BY id LIMIT 2",[workspaceId])).rows
  if(rows.length!==1)denied();return rows[0].id
 }
 const primaryId=await primary(),assistant=await getUserAssistant(userId,primaryId)
 if(!assistant||assistant.workspaceId!==workspaceId||assistant.kind!=='primary')denied()
 const maximum=async()=>{
  if(await primary()!==primaryId)return null
  const viewpoint=await resolveWorkspaceViewpoint(userId,workspaceId,selectedAssistantId)
  if(!viewpoint||viewpoint.clearance===undefined||viewpoint.compartments===undefined)return null
  // The legacy viewpoint does not carry every authority axis. Keep the
  // complete current R1 ceiling, applying only its explicitly resolved caps.
  const native=await resolveLiveAccessCeilingSystem({userId,workspaceId,assistant,memberMode:'member'})
  const cap=pinAccessCeiling({...native,assistantId:assistant.id,assistantKind:assistant.kind,clearance:viewpoint.clearance,
   compartments:viewpoint.compartments,...(viewpoint.departmentRead?{departmentRead:viewpoint.departmentRead}:{})})
  return intersectAccessCeilings(native,cap)
 }
 const ceiling=await maximum();if(!ceiling)denied()
 const execution=(await resolveExecutionContextSystem({userId,workspaceId,assistant,memberMode:'member',sharedAudience:false,
  identity:identity(ceiling),ownership:{kind:'workspace',workspaceId},surface:{readOnly:true},maximumAccess:ceiling,maximumAccessCurrent:maximum,
  // This is an invocation nonce, not a persisted session or fabricated actor.
  lifecycle:{sessionId:randomUUID(),sessionPersisted:false,channelType,channelId,abortSignal},
  credentialCurrent})).executionContext
 await execution.security.authority.assertCurrent()
 return{execution,accumulator:new ContextScopeAccumulator(execution.security.provenance)}
}

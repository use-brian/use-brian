/** Native HTTP workspace reads through the original R1 factory. [COMP:api/application-persistence] */
import {randomUUID} from 'node:crypto'
import {ContextScopeAccumulator,DerivedScopeError,pinAccessCeiling,intersectAccessCeilings,type SessionContextAuthority} from '@use-brian/core'
import {query} from '../db/client.js'
import {authSessionStore,type AuthTokenClaims} from '../db/auth-session-store.js'
import {getUserAssistant} from '../db/users.js'
import {resolveWorkspaceViewpoint} from '../db/workspace-viewpoint.js'
import {resolveExecutionContextSystem} from '../context-scope/execution-context.js'
import {resolveLiveAccessCeilingSystem} from '../context-scope/resolve-turn-scope.js'
function denied():never{throw new DerivedScopeError('scope_evidence_missing')}
/** Middleware claims are supplied by the caller; no body/header claim reconstruction. */
export async function resolveNativeWorkspaceReadAuthority(input:{claims:Readonly<AuthTokenClaims>|null;workspaceId:string;selectedAssistantId?:string|null;abortSignal:AbortSignal}):Promise<SessionContextAuthority>{
 const command=structuredClone({claims:input.claims,workspaceId:input.workspaceId,selectedAssistantId:input.selectedAssistantId}),claims=command.claims,abortSignal=input.abortSignal
 if(!claims||!await authSessionStore.validateAccess(claims)||abortSignal.aborted)denied()
 const primary=async()=>{
  const rows=(await query<{id:string}>("SELECT id FROM assistants WHERE workspace_id=$1 AND kind='primary' ORDER BY id LIMIT 2",[command.workspaceId])).rows
  if(rows.length!==1)denied();return rows[0].id
 }
 const primaryId=await primary(),assistant=await getUserAssistant(claims.userId,primaryId)
 if(!assistant||assistant.workspaceId!==command.workspaceId||assistant.kind!=='primary')denied()
 const maximum=async()=>{
  if(await primary()!==primaryId)return null
  const viewpoint=await resolveWorkspaceViewpoint(claims.userId,command.workspaceId,command.selectedAssistantId)
  if(!viewpoint||viewpoint.clearance===undefined||viewpoint.compartments===undefined)return null
  // The legacy viewpoint does not carry every authority axis. Keep the
  // complete current R1 ceiling, applying only its explicitly resolved caps.
  const native=await resolveLiveAccessCeilingSystem({userId:claims.userId,workspaceId:command.workspaceId,assistant,memberMode:'member'})
  const cap=pinAccessCeiling({...native,assistantId:assistant.id,assistantKind:assistant.kind,clearance:viewpoint.clearance,
   compartments:viewpoint.compartments,...(viewpoint.departmentRead?{departmentRead:viewpoint.departmentRead}:{})})
  return intersectAccessCeilings(native,cap)
 }
 const ceiling=await maximum();if(!ceiling)denied()
 const execution=(await resolveExecutionContextSystem({userId:claims.userId,workspaceId:command.workspaceId,assistant,memberMode:'member',sharedAudience:false,
  identity:{kind:'attended',principal:{kind:'workspace_member',userId:claims.userId,authenticationKind:'native_session'}},
  ownership:{kind:'workspace',workspaceId:command.workspaceId},surface:{readOnly:true},maximumAccess:ceiling,maximumAccessCurrent:maximum,
  // This is an invocation nonce, not a persisted session or fabricated actor.
  lifecycle:{sessionId:randomUUID(),sessionPersisted:false,channelType:'web',channelId:'native-workspace-read',abortSignal},
  credentialCurrent:()=>authSessionStore.validateAccess(claims)})).executionContext
 await execution.security.authority.assertCurrent()
 return{execution,accumulator:new ContextScopeAccumulator(execution.security.provenance)}
}

/** Native browser title readers and authored commands. [COMP:api/application-persistence] */
import {ContextScopeAccumulator,DerivedScopeError,bindScopeSources,boundScopeSources,executionToolContext,type SessionContextAuthority} from '@use-brian/core'
import {isAuthorityChangedError} from '../context-scope/authority-lease.js'
import {authSessionStore,type AuthTokenClaims} from '../db/auth-session-store.js'
import {findSessionById} from '../db/sessions.js'
import {getUserAssistant} from '../db/users.js'
import {readAdmittedSessionQuery} from '../db/session-query-reader.js'
import {publishSessionTitle,readSessionTitle,sessionTitleHead} from '../db/session-title-store.js'
import {resolveExecutionContextSystem} from '../context-scope/execution-context.js'
import {gateSessionRead} from '../session-read-authority.js'
import {policyFor,classifySession} from '../session-kind.js'
import {assertSourceModelOutputAuthority} from '../application-platform/model-source-authority.js'

type NativeClaims=Readonly<AuthTokenClaims>
/** Only verified middleware properties are accepted; never request JSON. */
export function pinSessionTitleClaims(request:{userId?:string;authSessionId?:string;authVersion?:number}):NativeClaims|null{
 return request.userId?Object.freeze({userId:request.userId,sessionId:request.authSessionId,authVersion:request.authVersion}):null
}
function denied():never{throw new DerivedScopeError('scope_evidence_missing')}
export async function resolveSessionTitleAuthority(input:{claims:NativeClaims|null;sessionId:string;readOnly:boolean}):Promise<SessionContextAuthority>{
 const command=structuredClone(input),claims=command.claims
 if(!claims||!await authSessionStore.validateAccess(claims))denied()
 const session=await findSessionById(command.sessionId)
 if(!session||await gateSessionRead(claims.userId,session))denied()
 if(!command.readOnly&&policyFor(session).lifecycle.rename!=='participants'&&session.userId!==claims.userId)denied()
 const assistant=await getUserAssistant(claims.userId,session.assistantId)
 if(!assistant?.workspaceId)denied()
 const execution=(await resolveExecutionContextSystem({userId:claims.userId,workspaceId:assistant.workspaceId,assistant,memberMode:'member',
  sharedAudience:!policyFor(session).context.personalMemory,session,sessionAuthority:session,
  identity:{kind:'attended',principal:{kind:'workspace_member',userId:claims.userId,authenticationKind:'native_session'}},
  ownership:{kind:'workspace',workspaceId:assistant.workspaceId},...(command.readOnly?{surface:{readOnly:true as const}}:{}),
  lifecycle:{sessionId:session.id,sessionPersisted:true,channelType:session.channelType,channelId:session.channelId,
   transport:classifySession(session).transport,abortSignal:new AbortController().signal},
  credentialCurrent:()=>authSessionStore.validateAccess(claims)})).executionContext
 await execution.security.authority.assertCurrent()
 return{execution,accumulator:new ContextScopeAccumulator(execution.security.provenance)}
}
async function prepareCurrentSessionTitle(input:{claims:NativeClaims|null;sessionId:string}){
 const command=structuredClone(input),authority=await resolveSessionTitleAuthority({...command,readOnly:true})
 const title=await readSessionTitle(command.sessionId,authority)
 await assertSourceModelOutputAuthority({...executionToolContext(authority.execution,{appId:'native-session-title-read'}),scopeAccumulator:authority.accumulator})
 return{authority,title}
}
export async function readCurrentSessionTitle(input:{claims:NativeClaims|null;sessionId:string}){
 return(await prepareCurrentSessionTitle(input)).title
}
/** A fresh human-authored title does not adopt any held legacy title bytes. */
export async function renameCurrentSessionTitle(input:{claims:NativeClaims|null;sessionId:string;title:string}){
 const command=structuredClone(input),authority=await resolveSessionTitleAuthority({...command,readOnly:false})
 const expectedRevision=await sessionTitleHead(command.sessionId,authority)
 await readAdmittedSessionQuery({sessionId:command.sessionId,throughSequence:0,topicThroughSequence:0,authority})
 const title=await publishSessionTitle({sessionId:command.sessionId,title:command.title,manual:true,expectedRevision,authority,
  derivation:{producer:'human:session-title',sources:authority.accumulator.evidence.sources??[]}})
 if(title){
  authority.accumulator.note({sources:boundScopeSources(title)})
  await assertSourceModelOutputAuthority({...executionToolContext(authority.execution,{appId:'native-session-title-rename'}),scopeAccumulator:authority.accumulator})
 }
 return title
}

type TitleProjection=Readonly<{title:string|null;titleRevisionId:string|null}>
const projectionAuthorities=new WeakMap<TitleProjection,SessionContextAuthority|null>()
function heldTitleProjection():TitleProjection{
 const projection=Object.freeze({title:null,titleRevisionId:null})
 projectionAuthorities.set(projection,null);return projection
}
/** Immutable value identity is private and grants no reusable admission. */
export async function sessionTitleProjection(input:{claims:NativeClaims|null;sessionId:string}):Promise<TitleProjection>{
 try{
  const{authority,title}=await prepareCurrentSessionTitle(input)
  if(!title)return heldTitleProjection()
  const projection=bindScopeSources(Object.freeze({title:title.title,titleRevisionId:title.revisionId}),boundScopeSources(title))
  projectionAuthorities.set(projection,authority);return projection
 }catch(error){
  if(error instanceof DerivedScopeError||isAuthorityChangedError(error))return heldTitleProjection()
  throw error
 }
}
/** Original per-row authority and sources are checked again at the actual collection boundary. */
export async function sessionTitleProjections(input:{claims:NativeClaims|null;sessionIds:readonly string[]}):Promise<Map<string,TitleProjection>>{
 const command=structuredClone(input),prepared:Array<{id:string;projection:TitleProjection}>=[]
 // Finish each row's frame before opening another. An unrelated blocked row
 // must not consume every connection needed for current source admission.
 for(const id of command.sessionIds)prepared.push({id,projection:await sessionTitleProjection({claims:command.claims,sessionId:id})})
 const result=new Map<string,TitleProjection>()
 for(const{id,projection}of prepared){
  if(!projectionAuthorities.has(projection))denied()
  const authority=projectionAuthorities.get(projection)
  if(!authority){result.set(id,projection);continue}
  try{
   const current=await readSessionTitle(id,authority)
   if(!current||current.revisionId!==projection.titleRevisionId){result.set(id,heldTitleProjection());continue}
   await assertSourceModelOutputAuthority({...executionToolContext(authority.execution,{appId:'native-session-title-list-output'}),scopeAccumulator:authority.accumulator})
   result.set(id,projection)
  }catch(error){
   if(error instanceof DerivedScopeError||isAuthorityChangedError(error)){result.set(id,heldTitleProjection());continue}
   throw error
  }
 }
 return result
}

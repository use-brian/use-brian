/** Native browser title readers and authored commands. [COMP:api/application-persistence] */
import {ContextScopeAccumulator,DerivedScopeError,bindScopeSources,boundScopeSources,executionToolContext,sanitizeTitle,type SessionContextAuthority} from '@use-brian/core'
import {getPool} from '../db/client.js'
import {isAuthorityChangedError} from '../context-scope/authority-lease.js'
import {authSessionStore,type AuthTokenClaims} from '../db/auth-session-store.js'
import {readSessionById} from '../db/sessions.js'
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
 // Admission is a read: a recency UPDATE can block behind a turn's row lock.
 const session=await readSessionById(command.sessionId)
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
type ProjectionAuthority={authority:SessionContextAuthority;previewThrough?:number}
const projectionAuthorities=new WeakMap<TitleProjection,ProjectionAuthority|null>()

/** Presence metadata only: an unreadable saved title must never become a preview. */
async function hasSavedTitle(sessionId:string,authority:SessionContextAuthority):Promise<boolean>{
 return (await getPool().query('SELECT 1 FROM session_title_heads WHERE workspace_id=$1 AND session_id=$2',
  [authority.execution.security.access.workspaceId,sessionId])).rowCount!==0
}
async function assertPreviewOutput(sessionId:string,authority:SessionContextAuthority){
 await assertSourceModelOutputAuthority({...executionToolContext(authority.execution,{appId:'native-session-title-preview'}),scopeAccumulator:authority.accumulator},
  async()=>{if(await hasSavedTitle(sessionId,authority))denied()})
}
/** Compatibility labels use admitted current history, never the held legacy scalar. */
async function prepareTitlePreview(sessionId:string,authority:SessionContextAuthority,originalThrough?:number){
 if(await hasSavedTitle(sessionId,authority))return null
 const through=originalThrough??(await getPool().query<{sequence:number}>(`SELECT coalesce(max(sequence_num),0)::int AS sequence FROM
  (SELECT sequence_num FROM session_messages WHERE workspace_id=$1 AND session_id=$2 ORDER BY sequence_num LIMIT 10) original`,
  [authority.execution.security.access.workspaceId,sessionId])).rows[0].sequence
 if(through===0)return null
 const query=await readAdmittedSessionQuery({sessionId,throughSequence:through,topicThroughSequence:0,authority})
 let title=''
 for(const row of query.history){
  if(row.role!=='user')continue
  const text=typeof row.content==='string'?row.content:Array.isArray(row.content)?row.content.flatMap(block=>
   typeof block==='object'&&block!==null&&block.type==='text'&&typeof block.text==='string'?[block.text]:[]).join('\n'):''
  title=sanitizeTitle(text.trim())
  if(title)break
 }
 if(!title||await hasSavedTitle(sessionId,authority))return null
 await assertPreviewOutput(sessionId,authority)
 return{projection:bindScopeSources(Object.freeze({title,titleRevisionId:null}),boundScopeSources(query)),through}
}
function heldTitleProjection():TitleProjection{
 const projection=Object.freeze({title:null,titleRevisionId:null})
 projectionAuthorities.set(projection,null);return projection
}
/** Immutable value identity is private and grants no reusable admission. */
export async function sessionTitleProjection(input:{claims:NativeClaims|null;sessionId:string}):Promise<TitleProjection>{
 const command=structuredClone(input)
 try{
  const{authority,title}=await prepareCurrentSessionTitle(command)
  if(!title){
   const preview=await prepareTitlePreview(command.sessionId,authority)
   if(!preview)return heldTitleProjection()
   projectionAuthorities.set(preview.projection,{authority,previewThrough:preview.through});return preview.projection
  }
  const projection=bindScopeSources(Object.freeze({title:title.title,titleRevisionId:title.revisionId}),boundScopeSources(title))
  projectionAuthorities.set(projection,{authority});return projection
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
  const binding=projectionAuthorities.get(projection)
  if(!binding){result.set(id,projection);continue}
  const{authority,previewThrough}=binding
  try{
   if(previewThrough!==undefined){
    const current=await prepareTitlePreview(id,authority,previewThrough)
    if(!current||current.projection.title!==projection.title){result.set(id,heldTitleProjection());continue}
   }else{
    const current=await readSessionTitle(id,authority)
    if(!current||current.revisionId!==projection.titleRevisionId){result.set(id,heldTitleProjection());continue}
   }
   if(previewThrough!==undefined)await assertPreviewOutput(id,authority)
   else await assertSourceModelOutputAuthority({...executionToolContext(authority.execution,{appId:'native-session-title-list-output'}),scopeAccumulator:authority.accumulator})
   result.set(id,projection)
  }catch(error){
   if(error instanceof DerivedScopeError||isAuthorityChangedError(error)){result.set(id,heldTitleProjection());continue}
   throw error
  }
 }
 return result
}

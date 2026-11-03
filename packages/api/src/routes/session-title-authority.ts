/** Native browser title readers and authored commands. [COMP:api/application-persistence] */
import {ContextScopeAccumulator,DerivedScopeError,bindScopeSources,boundScopeSources,executionToolContext,sanitizeTitle,type SessionContextAuthority} from '@use-brian/core'
import {getPool} from '../db/client.js'
import {isAuthorityChangedError} from '../context-scope/authority-lease.js'
import {authSessionStore,type AuthTokenClaims} from '../db/auth-session-store.js'
import {readSessionById} from '../db/sessions.js'
import {getUserAssistant} from '../db/users.js'
import {readAdmittedSessionQuery} from '../db/session-query-reader.js'
import {publishSessionTitle,readSessionTitle,readSessionTitlesGrouped,sessionTitleHead} from '../db/session-title-store.js'
import {resolveExecutionContextSystem} from '../context-scope/execution-context.js'
import {gateSessionRead} from '../session-read-authority.js'
import {policyFor,classifySession} from '../session-kind.js'
import {getApplicationExecutionBinding} from '../application-platform/execution-context.js'
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
type ProjectionAuthority={authority:SessionContextAuthority;previewThrough?:number;previewPending?:boolean;headOnly?:boolean}
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
 // Sequence/role metadata narrows the query; it never admits message bytes.
 // Stop at the first usable user text instead of capturing later model/tool
 // ancestry that cannot contribute to its label. Output reuses this exact prefix.
 const candidates=originalThrough!==undefined?[originalThrough]:(await getPool().query<{sequence:number}>(`SELECT sequence_num AS sequence FROM
  (SELECT sequence_num,role FROM session_messages WHERE workspace_id=$1 AND session_id=$2 ORDER BY sequence_num LIMIT 10) original
  WHERE role='user' ORDER BY sequence_num`,[authority.execution.security.access.workspaceId,sessionId])).rows.map(row=>row.sequence)
 for(const through of candidates){
  const query=await readAdmittedSessionQuery({sessionId,throughSequence:through,topicThroughSequence:0,authority})
  let title=''
  for(const row of query.history){
   if(row.role!=='user')continue
   const text=typeof row.content==='string'?row.content:Array.isArray(row.content)?row.content.flatMap(block=>
    typeof block==='object'&&block!==null&&block.type==='text'&&typeof block.text==='string'?[block.text]:[]).join('\n'):''
   title=sanitizeTitle(text.trim())
   if(title)break
  }
  if(!title)continue
  if(await hasSavedTitle(sessionId,authority))return null
  await assertPreviewOutput(sessionId,authority)
  return{projection:bindScopeSources(Object.freeze({title,titleRevisionId:null}),boundScopeSources(query)),through}
 }
 return null
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
type PreparedTitle={id:string;projection:TitleProjection}
/** Equal data here means equal SQL/GUC context, never interchangeable leases. */
function titleGroupContext(authority:SessionContextAuthority):string|null{
 const execution=authority.execution,{identity,ownership,security,surface,lifecycle}=execution
 if(identity.kind!=='attended'||identity.principal.kind!=='workspace_member'||identity.principal.authenticationKind!=='native_session'
  ||identity.principal.userId!==security.access.userId||ownership.kind!=='workspace'||ownership.workspaceId!==security.access.workspaceId
  ||security.access.assistantId!==execution.assistant.id||security.access.sharedAudience||security.access.systemRead||security.access.applicationBound
  ||surface.readOnly!==true||surface.systemRead||surface.clientSelfMemory||getApplicationExecutionBinding(execution)
  ||lifecycle.sessionPersisted===false||lifecycle.channelType!=='web'||lifecycle.abortSignal.aborted)return null
 return JSON.stringify({identity,ownership,access:security.access,ceiling:security.ceiling,provenance:security.provenance,surface,
  assistantId:execution.assistant.id,channelType:lifecycle.channelType,transport:lifecycle.transport})
}
async function tryTitleGroup(claims:NativeClaims,entries:PreparedTitle[],context:string):Promise<Map<string,TitleProjection>|null>{
 const bindings=entries.map(entry=>projectionAuthorities.get(entry.projection))
 if(bindings.some(binding=>!binding?.headOnly)||entries.some(entry=>!entry.projection.titleRevisionId))return null
 try{
  for(const binding of bindings){
   await binding!.authority.execution.security.authority.assertCurrent()
   if(titleGroupContext(binding!.authority)!==context)return null
  }
  // A rejected group must not invalidate an unaffected row's original lease.
  // Resolve a genuine separate operation instead of cloning an execution.
  const authority=await resolveSessionTitleAuthority({claims,sessionId:entries[0].id,readOnly:true})
  if(titleGroupContext(authority)!==context)return null
  const heads=entries.map(entry=>({sessionId:entry.id,revisionId:entry.projection.titleRevisionId!}))
  const titles=await readSessionTitlesGrouped(heads,authority)
  if(!titles)return null
  const result=new Map<string,TitleProjection>()
  for(const [index,entry] of entries.entries()){
   const binding=bindings[index]!,title=titles.get(entry.id)
   await binding.authority.execution.security.authority.assertCurrent()
   if(titleGroupContext(binding.authority)!==context||!title||title.revisionId!==entry.projection.titleRevisionId)return null
   const projection=bindScopeSources(Object.freeze({title:title.title,titleRevisionId:title.revisionId}),boundScopeSources(title))
   projectionAuthorities.set(projection,{authority:binding.authority});result.set(entry.id,projection)
  }
  // This is the final awaited boundary: all original leases and provisional
  // projections are checked before the fresh union source/head proof.
  await assertSourceModelOutputAuthority({...executionToolContext(authority.execution,{appId:'native-session-title-list-output'}),scopeAccumulator:authority.accumulator},async()=>{
   const current=(await getPool().query<{sessionId:string;revisionId:string}>(`SELECT session_id AS "sessionId",scope_revision_id AS "revisionId"
    FROM session_title_heads WHERE workspace_id=$1 AND session_id=ANY($2::uuid[]) AND session_recording_read_allowed(session_id)`,
   [authority.execution.security.access.workspaceId,heads.map(head=>head.sessionId)])).rows
   if(current.length!==heads.length||heads.some(head=>!current.some(row=>row.sessionId===head.sessionId&&row.revisionId===head.revisionId)))denied()
  })
  return result
 }catch(error){
  if(error instanceof DerivedScopeError||isAuthorityChangedError(error))return null
  // A union may exceed a canonical walk bound although each original row
  // remains supported. Only that known optional-cohort failure delegates.
  if(typeof error==='object'&&error!==null&&'code'in error&&error.code==='22023'
   &&'message'in error&&error.message==='scope_ancestry_unavailable')return null
  throw error
 }
}
/** Original per-row authority and sources are checked again at the actual collection boundary. */
export async function sessionTitleProjections(input:{claims:NativeClaims|null;sessionIds:readonly string[]}):Promise<Map<string,TitleProjection>>{
 const command=structuredClone(input),prepared:Array<{id:string;projection:TitleProjection}>=[]
 if(!command.sessionIds.length)return new Map()
 if(!command.claims)return new Map(command.sessionIds.map(id=>[id,heldTitleProjection()]))
 // Presence metadata can only withhold a label. Missing canonical parents,
 // heads and bounded preview candidates need no execution/source frame. This
 // is not an admission cache: every remaining row takes the complete path
 // below, and a head/message created after this read waits for the next list.
 const titleCandidates=new Set((await getPool().query<{id:string}>(`SELECT s.id FROM sessions s
  WHERE s.id=ANY($1::uuid[]) AND s.workspace_id IS NOT NULL
   AND (EXISTS(SELECT 1 FROM session_title_heads title_candidates
     WHERE title_candidates.workspace_id=s.workspace_id AND title_candidates.session_id=s.id)
    OR EXISTS(SELECT 1 FROM (
      SELECT role FROM session_messages WHERE workspace_id=s.workspace_id AND session_id=s.id
       ORDER BY sequence_num LIMIT 10
     ) preview_candidates WHERE role='user'))`,[command.sessionIds])).rows.map(row=>row.id))
 // Finish each row's frame before opening another. An unrelated blocked row
 // must not consume every connection needed for current source admission.
 for(const id of command.sessionIds){
  let projection:TitleProjection=heldTitleProjection()
  if(titleCandidates.has(id))try{
   const authority=await resolveSessionTitleAuthority({claims:command.claims,sessionId:id,readOnly:true})
   const head=await sessionTitleHead(id,authority)
   if(head){
    // Pin identity only. Payload and source admission happen at the final
    // boundary below, after every row's execution has been prepared.
    projection=Object.freeze({title:null,titleRevisionId:head})
    projectionAuthorities.set(projection,{authority,headOnly:true})
   }else{
    // Preparation retains identity only. The actual preview is selected and
    // source-validated once at this row's final collection boundary.
    projection=Object.freeze({title:null,titleRevisionId:null})
    projectionAuthorities.set(projection,{authority,previewPending:true})
   }
  }catch(error){
   if(!(error instanceof DerivedScopeError||isAuthorityChangedError(error)))throw error
  }
  prepared.push({id,projection})
 }
 // Schedule individual rows first, then collect equal-context saved heads
 // together. Each group still completes and consumes its proof contiguously;
 // original display positions do not require another proof of the same graph.
 type Group={entries:PreparedTitle[];context:string;attempted:boolean;value:Map<string,TitleProjection>|null;budget:{failed:number}}
 const groupForId=new Map<string,Group>(),seenIds=new Set<string>(),repeatedIds=new Set<string>()
 for(const entry of prepared){if(seenIds.has(entry.id))repeatedIds.add(entry.id);seenIds.add(entry.id)}
 const individual:PreparedTitle[]=[],contexts=new Map<string,PreparedTitle[]>()
 for(const entry of prepared){
  const binding=projectionAuthorities.get(entry.projection)
  const context=binding?.headOnly&&!repeatedIds.has(entry.id)?titleGroupContext(binding.authority):null
  if(context===null){individual.push(entry);continue}
  const entries=contexts.get(context)??[]
  entries.push(entry);contexts.set(context,entries)
 }
 // This is eligibility metadata only. A held/missing head keeps its original
 // individual reader; it cannot poison an otherwise supported optional group.
 // The group reader reacquires these exact identities and all source authority.
 for(const [context,entries]of contexts){
  if(entries.length<2)continue
  const workspaceId=projectionAuthorities.get(entries[0].projection)!.authority.execution.security.access.workspaceId
  const metadata=(await getPool().query<{sessionId:string;revisionId:string;source:{held?:boolean;resourceKind?:string;resourceId?:string;version?:string}|null}>(`SELECT h.session_id AS "sessionId",h.scope_revision_id AS "revisionId",
   read_scope_source(h.workspace_id,'session_context_revision',h.scope_revision_id) AS source
   FROM session_title_heads h JOIN unnest($2::uuid[],$3::uuid[]) group_candidates(session_id,revision_id)
    ON group_candidates.session_id=h.session_id AND group_candidates.revision_id=h.scope_revision_id WHERE h.workspace_id=$1`,
  [workspaceId,entries.map(entry=>entry.id),entries.map(entry=>entry.projection.titleRevisionId)])).rows
  const eligible=new Set(metadata.filter(row=>row.source?.held===false&&row.source.resourceKind==='session_context_revision'
   &&row.source.resourceId===row.revisionId&&row.source.version==='1').map(row=>row.sessionId))
  contexts.set(context,entries.filter(entry=>eligible.has(entry.id)))
  individual.push(...entries.filter(entry=>!eligible.has(entry.id)))
 }
 const collectionOrder=[...individual]
 for(const [context,entries]of contexts){
  for(let offset=0;offset<entries.length;offset+=50){
   const part=entries.slice(offset,offset+50)
   collectionOrder.push(...part)
   if(part.length<2)continue
   const group:Group={entries:part,context,attempted:false,value:null,budget:{failed:0}}
   for(const entry of part)groupForId.set(entry.id,group)
  }
 }
 const result=new Map<string,TitleProjection>()
 for(const{id,projection}of collectionOrder){
  let group=groupForId.get(id),groupedValue:TitleProjection|undefined
  while(group){
   if(!group.attempted){
    group.attempted=true
    if(group.budget.failed<3){
     group.value=await tryTitleGroup(command.claims,group.entries,group.context)
     if(!group.value)group.budget.failed++
    }
   }
   groupedValue=group.value?.get(id)
   if(groupedValue)break
   for(const entry of group.entries)groupForId.delete(entry.id)
   // A held/unsupported member cannot poison other original row readers.
   // At most three failed optional probes precede their canonical fallback.
   if(group.budget.failed<3&&group.entries.length>2){
    const middle=Math.ceil(group.entries.length/2)
    for(const part of [group.entries.slice(0,middle),group.entries.slice(middle)])if(part.length>1){
     const half:Group={entries:part,context:group.context,attempted:false,value:null,budget:group.budget}
     for(const entry of part)groupForId.set(entry.id,half)
    }
   }
   group=groupForId.get(id)
  }
  if(groupedValue){result.set(id,groupedValue);continue}
  if(!projectionAuthorities.has(projection))denied()
  const binding=projectionAuthorities.get(projection)
  if(!binding){result.set(id,projection);continue}
  const{authority,previewThrough,previewPending,headOnly}=binding
  try{
   let finalProjection=projection
   if(previewPending){
    const current=await prepareTitlePreview(id,authority)
    if(!current){result.set(id,heldTitleProjection());continue}
    projectionAuthorities.set(current.projection,{authority,previewThrough:current.through})
    result.set(id,current.projection);continue
   }
   if(previewThrough!==undefined){
    const current=await prepareTitlePreview(id,authority,previewThrough)
    if(!current||current.projection.title!==projection.title){result.set(id,heldTitleProjection());continue}
   }else{
    const current=await readSessionTitle(id,authority)
    if(!current||current.revisionId!==projection.titleRevisionId){result.set(id,heldTitleProjection());continue}
    if(headOnly)finalProjection=bindScopeSources(Object.freeze({title:current.title,titleRevisionId:current.revisionId}),boundScopeSources(current))
   }
   if(previewThrough!==undefined)await assertPreviewOutput(id,authority)
   else await assertSourceModelOutputAuthority({...executionToolContext(authority.execution,{appId:'native-session-title-list-output'}),scopeAccumulator:authority.accumulator})
   result.set(id,finalProjection)
  }catch(error){
   if(error instanceof DerivedScopeError||isAuthorityChangedError(error)){result.set(id,heldTitleProjection());continue}
   throw error
  }
 }
 // All admitted values have completed their actual collection boundary.
 // Restore caller order without awaiting or reusing a proof for another row.
 return new Map(prepared.map(({id})=>[id,result.get(id)!]))
}

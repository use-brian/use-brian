import {notifyWorkspaceChange} from '../brain-stream/notify.js'
/** One admitted history service for HTTP, MCP and UI. [COMP:api/engineering-history] */
import {createHash,createHmac,randomUUID,timingSafeEqual} from 'node:crypto'
import type {AccessContext,FilesApi,FilesContext,WorkspaceFile} from '@use-brian/core'
import {EngineeringHistoryCommandSchema,EngineeringHistoryQuerySchema,type EngineeringHistoryCommand,type EngineeringHistoryQuery} from '@use-brian/shared'
import {buildAccessPredicate,buildCurrentMemberSourcePredicate} from '../db/access-predicate.js'
import {applyRLSGucs,getAppPool,queryWithRLS,rollbackAndRelease} from '../db/client.js'
import {withFileErasureAdmission} from '../workspace-access/file-transaction-admission.js'
import {EngineeringHistoryError} from './contracts.js'
import type {PoolClient} from 'pg'
export type HistoryActor=FilesContext & {principalRef?:string;readOnly?:boolean;origin?:'human'|'programmatic'}
type HistoryEvent={id:string;fileId:string;fileVersion:string;revision:number;sequence:string;provider:string;sessionId:string|null;
 contentDigest:string;sourceEventId:string;turnId:string|null;profileId:string|null;principalKind:string;principalId:string;actorId:string|null;claimedSubject:string|null;attributionQuality:string;role:'user'|'assistant';
 occurredAt:Date;receivedAt:Date;deliveryStatus:'archived';annotations:unknown[];excerpt:string}
const columns=`e.id,e.file_id AS "fileId",f.scope_version::text AS "fileVersion",e.revision::int AS revision,e.sequence::text AS sequence,
 e.source_provider AS provider,e.source_session AS "sessionId",e.profile_id AS "profileId",e.principal_kind AS "principalKind",
 e.principal_id AS "principalId",e.actor_id AS "actorId",e.claimed_subject AS "claimedSubject",e.attribution_quality AS "attributionQuality",
 e.content_digest AS "contentDigest",e.event_id AS "sourceEventId",e.source_turn AS "turnId",e.event_kind AS role,e.occurred_at AS "occurredAt",e.received_at AS "receivedAt",e.delivery_status AS "deliveryStatus",e.annotations,left(e.index_text,240) AS excerpt`
const access=(ctx:HistoryActor):AccessContext=>({...ctx,assistantId:ctx.assistantId??'',assistantKind:ctx.assistantId?ctx.assistantKind??'standard':'primary'})
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex')
const missing=()=>new EngineeringHistoryError('history_not_available',404)
function queryGuard(ctx:HistoryActor,mutation=false){
 const a=buildAccessPredicate(access(ctx),{alias:'f',operation:mutation?'mutation':'read'})
 const member=buildCurrentMemberSourcePredicate(ctx.userId,{alias:'f',operation:mutation?'mutation':'read',startIdx:a.nextIdx})
 return {sql:`(${a.sql}) AND (${member.sql}) AND f.purpose='engineering_archive' AND f.valid_to IS NULL AND f.retracted_at IS NULL AND NOT f.scope_held AND e.delivery_status='archived'`,params:[...a.params,...member.params],nextIdx:member.nextIdx}
}
export function createEngineeringHistoryService(options:{files:FilesApi;cursorSecret:string}){
 function cursor(ctx:HistoryActor,q:EngineeringHistoryQuery,sequence:string){
  const body=Buffer.from(JSON.stringify({w:ctx.workspaceId,u:ctx.userId,q:digest({...q,cursor:undefined,limit:undefined}),s:sequence})).toString('base64url')
  return `${body}.${createHmac('sha256',options.cursorSecret).update(body).digest('base64url')}`
 }
 function cursorSequence(ctx:HistoryActor,q:EngineeringHistoryQuery):string {
  if(!q.cursor)return '0'
  try{
   const [body,sig,...rest]=q.cursor.split('.'),expected=createHmac('sha256',options.cursorSecret).update(body!).digest()
   const actual=Buffer.from(sig!,'base64url');if(rest.length||actual.length!==expected.length||!timingSafeEqual(actual,expected))throw new Error()
   const c=JSON.parse(Buffer.from(body!,'base64url').toString())
   if(c.w!==ctx.workspaceId||c.u!==ctx.userId||c.q!==digest({...q,cursor:undefined,limit:undefined})||!/^\d+$/.test(c.s))throw new Error()
   return c.s
  }catch{throw new EngineeringHistoryError('history_cursor_invalid',400)}
 }
 async function list(ctx:HistoryActor,input:Partial<EngineeringHistoryQuery>={}){
  const q=EngineeringHistoryQuerySchema.parse(input),guard=queryGuard(ctx),values:unknown[]=[...guard.params]
  const p=(v:unknown)=>{values.push(v);return `$${values.length}`}
  const clauses=[guard.sql,`e.sequence>${p(cursorSequence(ctx,q))}::bigint`]
  if(q.query?.trim()){
   const term=p(q.query),like=p(`%${q.query.replace(/[\\%_]/g,'\\$&')}%`)
   clauses.push(`(e.search_vector @@ plainto_tsquery('simple',${term}) OR e.index_text ILIKE ${like})`)
  }
  for(const [key,col] of [['provider','source_provider'],['sessionId','source_session'],['profileId','profile_id'],['keyId','principal_id']] as const)if(q[key])clauses.push(`e.${col}=${p(q[key])}`)
  if(q.since)clauses.push(`e.occurred_at>=${p(q.since)}::timestamptz`)
  if(q.until)clauses.push(`e.occurred_at<${p(q.until)}::timestamptz`)
  const cap=p(q.limit+1)
  const rows=(await queryWithRLS<HistoryEvent>(ctx.userId,`SELECT ${columns} FROM programmatic_archive_events e JOIN workspace_files f ON f.id=e.file_id
   WHERE ${clauses.join(' AND ')} ORDER BY e.sequence ASC LIMIT ${cap}`,values)).rows
  const events=rows.slice(0,q.limit),nextCursor=rows.length>q.limit?cursor(ctx,q,events.at(-1)!.sequence):null
  return {events,nextCursor,serverHealth:{index:'available',localEmitterObserved:false}}
 }
 async function row(ctx:HistoryActor,id:string,client?:PoolClient,mutation=false){
  const g=queryGuard(ctx,mutation),sql=`SELECT ${columns} FROM programmatic_archive_events e JOIN workspace_files f ON f.id=e.file_id
   WHERE ${g.sql} AND e.id=$${g.nextIdx}${mutation?' FOR UPDATE OF e,f':''}`
  return (await(client?client.query<HistoryEvent>(sql,[...g.params,id]):queryWithRLS<HistoryEvent>(ctx.userId,sql,[...g.params,id]))).rows[0]??null
 }
 async function read(ctx:HistoryActor,id:string){
  const event=await row(ctx,id);if(!event)throw missing()
  const bytes=await options.files.readBytes(ctx,event.fileId);if(!bytes.ok)throw new EngineeringHistoryError(bytes.error.kind==='not_found'?'history_not_available':'history_storage_unavailable',bytes.error.kind==='not_found'?404:503)
  if(bytes.value.file.scopeVersion!==event.fileVersion)throw missing()
  let envelope:unknown
  try{envelope=JSON.parse(Buffer.from(bytes.value.bytes).toString('utf8'))}catch{throw new EngineeringHistoryError('history_storage_unavailable',503)}
  if(!envelope||typeof envelope!=='object'||(envelope as {version?:unknown}).version!==1||typeof(envelope as {content?:unknown}).content!=='string')throw new EngineeringHistoryError('history_storage_unavailable',503)
  if(createHash('sha256').update((envelope as {content:string}).content).digest('hex')!==event.contentDigest)throw new EngineeringHistoryError('history_storage_unavailable',503)
  // Revalidate before projecting metadata, annotations or original text after I/O.
  const current=await row(ctx,id);if(!current||current.fileVersion!==event.fileVersion)throw missing()
  return {...current,content:(envelope as {content:string}).content}
 }
 async function exportPage(ctx:HistoryActor,input:Partial<EngineeringHistoryQuery>={}){
  const q=EngineeringHistoryQuerySchema.parse(input),page=await list(ctx,q),events:Awaited<ReturnType<typeof read>>[]=[]
  let failureCode:string|undefined
  for(const event of page.events){try{events.push(await read(ctx,event.id))}catch(error){failureCode=error instanceof EngineeringHistoryError?error.code:'history_storage_unavailable';break}}
  return {format:'jsonl',jsonl:events.map(e=>JSON.stringify(e)).join('\n')+(events.length?'\n':''),count:events.length,
   status:failureCode?'partial':page.nextCursor?'partial':'complete',failureCode,
   nextCursor:failureCode?(events.length?cursor(ctx,q,events.at(-1)!.sequence):q.cursor??null):page.nextCursor}
 }
 function commandKey(ctx:HistoryActor,c:EngineeringHistoryCommand){
  if(ctx.readOnly)throw new EngineeringHistoryError('history_write_denied',403)
  if(!c.eventId||!c.idempotencyKey||!c.expectedFileVersion||!c.expectedRevision)throw new EngineeringHistoryError('history_version_required',400)
  return {ref:ctx.principalRef??`user:${ctx.userId}`,hash:digest({...c,query:undefined})}
 }
 async function priorCommand(client:PoolClient,ctx:HistoryActor,c:EngineeringHistoryCommand,key:ReturnType<typeof commandKey>){
  const r=(await client.query(`SELECT request_digest,result FROM engineering_history_commands WHERE workspace_id=$1 AND principal_ref=$2 AND idempotency_key=$3`,[ctx.workspaceId,key.ref,c.idempotencyKey])).rows[0]
  if(r&&r.request_digest!==key.hash)throw new EngineeringHistoryError('history_command_conflict')
  return r?.result??null
 }
 async function finishCommand(client:PoolClient,ctx:HistoryActor,c:EngineeringHistoryCommand,key:ReturnType<typeof commandKey>,result:unknown){
  await client.query(`INSERT INTO engineering_history_commands(workspace_id,actor_id,principal_ref,idempotency_key,event_id,request_digest,result)
   VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)`,[ctx.workspaceId,ctx.userId,key.ref,c.idempotencyKey,c.eventId,key.hash,JSON.stringify(result)])
 }
 const checkVersion=(e:HistoryEvent,c:EngineeringHistoryCommand)=>{if(e.revision!==c.expectedRevision||e.fileVersion!==c.expectedFileVersion)throw new EngineeringHistoryError('history_version_conflict')}
 async function mutate(ctx:HistoryActor,c:EngineeringHistoryCommand){
  const key=commandKey(ctx,c)
  if(c.action==='delete'){
   // Repeat erasure receipts are content-free, actor-owned and membership-gated.
   const client=await getAppPool().connect()
   let prior
   try{await client.query('BEGIN');await applyRLSGucs(client,ctx.userId)
    if(!(await client.query('SELECT 1 FROM workspace_members WHERE workspace_id=$1 AND user_id=$2',[ctx.workspaceId,ctx.userId])).rows[0])throw missing()
    prior=await priorCommand(client,ctx,c,key)
   }finally{await rollbackAndRelease(client)}
   if(prior)return prior
   const event=await row(ctx,c.eventId!);if(!event)throw missing();checkVersion(event,c)
   const result={eventId:c.eventId,status:'deleted',revision:event.revision+1}
   const deleted=await withFileErasureAdmission(async(client,actor,file:WorkspaceFile)=>{
    if(actor!==ctx.userId||file.id!==event.fileId||file.scopeVersion!==c.expectedFileVersion)throw new EngineeringHistoryError('history_version_conflict')
    const current=await row(ctx,c.eventId!,client,true);if(!current)throw missing();checkVersion(current,c)
    if(await priorCommand(client,ctx,c,key))throw new EngineeringHistoryError('history_command_conflict')
    return async()=>{await finishCommand(client,ctx,c,key,result)}
   },()=>options.files.delete(ctx,event.fileId))
   if(!deleted.ok)throw missing()
   notifyWorkspaceChange(ctx.workspaceId,'file','delete',event.fileId)
   return result
  }
  const client=await getAppPool().connect()
  try{
   await client.query('BEGIN');await applyRLSGucs(client,ctx.userId)
   await client.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE',[ctx.workspaceId])
   if(!(await client.query('SELECT 1 FROM workspace_members WHERE workspace_id=$1 AND user_id=$2',[ctx.workspaceId,ctx.userId])).rowCount)throw missing()
   const prior=await priorCommand(client,ctx,c,key);if(prior)return prior
   const current=await row(ctx,c.eventId!,client,true);if(!current)throw missing()
   checkVersion(current,c)
   if(c.action==='annotate'){
    if(!c.text?.trim())throw new EngineeringHistoryError('history_annotation_required',400)
    const annotation={id:randomUUID(),text:c.text,actorId:ctx.userId,principalRef:key.ref,origin:ctx.origin??'human',createdAt:new Date().toISOString()}
    await client.query('UPDATE programmatic_archive_events SET annotations=annotations||$2::jsonb,revision=revision+1 WHERE id=$1',[c.eventId,JSON.stringify([annotation])])
   }else if(c.action==='exclude'){
    // File retraction runs the native archive projection/receipt lifecycle trigger.
    await client.query("UPDATE workspace_files SET retracted_at=now(),retracted_by=$2,retracted_reason='engineering_history_exclusion' WHERE id=$1 AND scope_version=$3",[current.fileId,ctx.userId,c.expectedFileVersion])
   }else throw new EngineeringHistoryError('history_action_invalid',400)
   const result={eventId:c.eventId,status:c.action==='annotate'?'annotated':'excluded',revision:current.revision+1}
   await finishCommand(client,ctx,c,key,result);await client.query('COMMIT');notifyWorkspaceChange(ctx.workspaceId,'file','update',current.fileId);return result
  }finally{await rollbackAndRelease(client)}
 }
 async function execute(ctx:HistoryActor,input:EngineeringHistoryCommand){
  const c=EngineeringHistoryCommandSchema.parse(input)
  if(c.action==='list'||c.action==='search')return list(ctx,c.query)
  if(c.action==='export')return exportPage(ctx,c.query)
  if(c.action==='read'){if(!c.eventId)throw new EngineeringHistoryError('history_event_required',400);return read(ctx,c.eventId)}
  return mutate(ctx,c)
 }
 return {list,read,exportPage,execute}
}
export type EngineeringHistoryService=ReturnType<typeof createEngineeringHistoryService>

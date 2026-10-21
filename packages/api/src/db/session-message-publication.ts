/** Actual native transcript publication. [COMP:api/application-persistence] */
import {z} from 'zod'
import type pg from 'pg'
import {bindScopeSource,deriveResourceScope,deriveWriteScope,DerivedScopeError,type DerivedWriteEvidence,type ResourceScope,type SessionContextAuthority} from '@use-brian/core'
import {applicationJsonSchema} from '@use-brian/shared'
import {assertSessionMessagePublicationFrame,withSessionMessagePublication} from './session-context-revisions.js'
import type {SessionMessage,SessionMessageAttachment} from './sessions.js'

const attachment=z.object({fileId:z.string().uuid(),workspaceId:z.string().uuid(),path:z.string(),name:z.string(),mime:z.string(),sizeBytes:z.number().int().nonnegative(),caption:z.string().optional()}).strict()
const payload=z.object({role:z.enum(['user','assistant']),content:applicationJsonSchema,channelMessageId:z.string().nullable(),senderUserId:z.string().uuid().nullable(),senderAssistantId:z.string().uuid().nullable(),attachments:z.array(attachment).max(100)}).strict()
const scope=z.object({workspaceId:z.string().uuid(),userId:z.string().uuid().nullable(),assistantId:z.null(),sensitivity:z.enum(['public','internal','confidential']),compartments:z.array(z.string()),projectIds:z.array(z.string().uuid()),resourceKind:z.literal('session_message'),resourceId:z.string().uuid(),version:z.literal('1')}).strict()
const message=payload.extend({id:z.string().uuid(),sessionId:z.string().uuid(),sequenceNum:z.number().int().positive(),createdAt:z.string().datetime({offset:true}),replyToText:z.null(),topicLabel:z.null(),topicConfidence:z.null()}).strict()
export type NativeSessionMessageInput={sessionId:string;role:string;content:unknown;channelMessageId?:string|null;senderUserId?:string|null;senderAssistantId?:string|null;attachments?:SessionMessageAttachment[];
 replyToText?:string|null;topicLabel?:string|null;topicConfidence?:number|null;derivation:DerivedWriteEvidence;derivationTarget?:ResourceScope;authority:SessionContextAuthority}
/** Match JSON's absent optional object keys; retain every other value for strict validation. */
function transcriptJson(value:unknown):unknown {
 if(Array.isArray(value))return value.map(transcriptJson)
 if(value&&typeof value==='object'&&(Object.getPrototypeOf(value)===Object.prototype||Object.getPrototypeOf(value)===null)) {
  return Object.fromEntries(Object.entries(value).filter(([,item])=>item!==undefined).map(([key,item])=>[key,transcriptJson(item)]))
 }
 return value
}
export async function publishNativeSessionMessage(input:NativeSessionMessageInput,client?:Pick<pg.ClientBase,'query'>):Promise<SessionMessage>{
 const {authority,sessionId}=input,{execution}=authority
 if(execution.lifecycle.sessionId!==sessionId||execution.lifecycle.sessionPersisted===false
  ||input.senderAssistantId!=null&&input.senderAssistantId!==execution.assistant.id
  ||[input.replyToText,input.topicLabel,input.topicConfidence].some(value=>value!==undefined&&value!==null))throw new DerivedScopeError('scope_evidence_missing')
 const evidence=structuredClone(input.derivation),target=input.derivationTarget?deriveWriteScope(evidence,input.derivationTarget,execution.security.access.userId):deriveResourceScope(evidence)
 const value=payload.parse({role:input.role,content:transcriptJson(input.content),channelMessageId:input.channelMessageId??null,senderUserId:input.senderUserId??null,senderAssistantId:input.senderAssistantId??null,attachments:input.attachments??[]})
 const write=async(db:Pick<pg.ClientBase,'query'>)=>{
  assertSessionMessagePublicationFrame(db,authority);await execution.security.authority.assertCurrent()
  let result:unknown
  try{result=(await db.query<{value:unknown}>('SELECT publish_native_session_message($1,$2,$3,$4,$5,$6) AS value',
   [execution.security.access.workspaceId,sessionId,value,evidence.producer,JSON.stringify(evidence.sources),target])).rows[0]?.value}
  catch(error){
   const sql=error as {code?:unknown;message?:unknown}
   if(sql.code==='P0001'&&sql.message==='scope_source_changed'||sql.code==='42501'&&['scope_source_changed','scope_ancestry_unavailable','scope_operation_denied'].includes(String(sql.message))||sql.code==='22023'&&sql.message==='scope_ancestry_unavailable')throw Object.assign(new DerivedScopeError('scope_source_changed'),{cause:error})
   if(sql.code==='22023'&&sql.message==='scope_evidence_missing')throw Object.assign(new DerivedScopeError('scope_evidence_missing'),{cause:error})
   if(sql.code==='22023'&&sql.message==='scope_visibility_incompatible')throw Object.assign(new DerivedScopeError('scope_visibility_incompatible'),{cause:error})
   throw error
  }
  const stored=z.object({message,source:scope}).strict().parse(result)
  if(stored.message.sessionId!==sessionId||stored.source.workspaceId!==execution.security.access.workspaceId||stored.source.resourceId!==stored.message.id)throw new DerivedScopeError('scope_source_changed')
  await execution.security.authority.assertCurrent()
  return bindScopeSource({...stored.message,createdAt:new Date(stored.message.createdAt)},stored.source)
 }
 return client?write(client):withSessionMessagePublication(authority,evidence.sources,write)
}

/** One logical native transcript effect, using the original live publication frame. */
export async function publishNativeSessionMessageBatch(input: {
 sessionId:string;messages:readonly Pick<NativeSessionMessageInput,'role'|'content'|'channelMessageId'|'senderUserId'|'senderAssistantId'|'attachments'>[];
 derivation:DerivedWriteEvidence;derivationTarget?:ResourceScope;authority:SessionContextAuthority;
},client?:Pick<pg.ClientBase,'query'>):Promise<SessionMessage[]>{
 const {authority,sessionId}=input,{execution}=authority
 if(execution.lifecycle.sessionId!==sessionId||execution.lifecycle.sessionPersisted===false||input.messages.length<1||input.messages.length>512
  ||input.messages.some(row=>row.senderAssistantId!=null&&row.senderAssistantId!==execution.assistant.id
   ||Object.keys(row).some(key=>!['role','content','channelMessageId','senderUserId','senderAssistantId','attachments'].includes(key))))throw new DerivedScopeError('scope_evidence_missing')
 const evidence=structuredClone(input.derivation),target=input.derivationTarget?deriveWriteScope(evidence,input.derivationTarget,execution.security.access.userId):deriveResourceScope(evidence)
 const values=input.messages.map(row=>payload.parse({role:row.role,content:transcriptJson(row.content),channelMessageId:row.channelMessageId??null,
  senderUserId:row.senderUserId??null,senderAssistantId:row.senderAssistantId??null,attachments:row.attachments??[]}))
 const write=async(db:Pick<pg.ClientBase,'query'>)=>{
  assertSessionMessagePublicationFrame(db,authority);await execution.security.authority.assertCurrent()
  let result:unknown
  try{result=(await db.query<{value:unknown}>('SELECT publish_native_session_message_batch($1,$2,$3,$4,$5,$6) AS value',
   [execution.security.access.workspaceId,sessionId,JSON.stringify(values),evidence.producer,JSON.stringify(evidence.sources),target])).rows[0]?.value}
  catch(error){
   const sql=error as {code?:unknown;message?:unknown}
   if(sql.code==='P0001'&&sql.message==='scope_source_changed'||sql.code==='42501'&&['scope_source_changed','scope_ancestry_unavailable','scope_operation_denied'].includes(String(sql.message))||sql.code==='22023'&&sql.message==='scope_ancestry_unavailable')throw Object.assign(new DerivedScopeError('scope_source_changed'),{cause:error})
   if(sql.code==='22023'&&sql.message==='scope_evidence_missing')throw Object.assign(new DerivedScopeError('scope_evidence_missing'),{cause:error})
   if(sql.code==='22023'&&sql.message==='scope_visibility_incompatible')throw Object.assign(new DerivedScopeError('scope_visibility_incompatible'),{cause:error})
   throw error
  }
  const stored=z.array(z.object({message,source:scope}).strict()).length(values.length).parse(result)
  const rows=stored.map((row,index)=>{
   if(row.message.sessionId!==sessionId||row.source.workspaceId!==execution.security.access.workspaceId||row.source.resourceId!==row.message.id
    ||row.message.role!==values[index].role||index>0&&row.message.sequenceNum!==stored[index-1].message.sequenceNum+1)throw new DerivedScopeError('scope_source_changed')
   return bindScopeSource({...row.message,createdAt:new Date(row.message.createdAt)},row.source)
  })
  await execution.security.authority.assertCurrent()
  return rows
 }
 return client?write(client):withSessionMessagePublication(authority,evidence.sources,write)
}

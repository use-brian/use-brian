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
export async function publishNativeSessionMessage(input:NativeSessionMessageInput,client?:Pick<pg.ClientBase,'query'>):Promise<SessionMessage>{
 const {authority}=input,{execution}=authority
 if(execution.lifecycle.sessionId!==input.sessionId||execution.lifecycle.sessionPersisted===false
  ||[input.replyToText,input.topicLabel,input.topicConfidence].some(value=>value!==undefined&&value!==null))throw new DerivedScopeError('scope_evidence_missing')
 const evidence=structuredClone(input.derivation),target=input.derivationTarget?deriveWriteScope(evidence,input.derivationTarget,execution.security.access.userId):deriveResourceScope(evidence)
 const value=payload.parse({role:input.role,content:input.content,channelMessageId:input.channelMessageId??null,senderUserId:input.senderUserId??null,senderAssistantId:input.senderAssistantId??null,attachments:input.attachments??[]})
 const write=async(db:Pick<pg.ClientBase,'query'>)=>{
  assertSessionMessagePublicationFrame(db,authority);await execution.security.authority.assertCurrent()
  let result:unknown
  try{result=(await db.query<{value:unknown}>('SELECT publish_native_session_message($1,$2,$3,$4,$5,$6) AS value',
   [execution.security.access.workspaceId,input.sessionId,value,evidence.producer,JSON.stringify(evidence.sources),target])).rows[0]?.value}
  catch(error){
   const sql=error as {code?:unknown;message?:unknown}
   if(sql.code==='42501'&&['scope_source_changed','scope_ancestry_unavailable','scope_operation_denied'].includes(String(sql.message))||sql.code==='22023'&&sql.message==='scope_ancestry_unavailable')throw Object.assign(new DerivedScopeError('scope_source_changed'),{cause:error})
   if(sql.code==='22023'&&sql.message==='scope_evidence_missing')throw Object.assign(new DerivedScopeError('scope_evidence_missing'),{cause:error})
   if(sql.code==='22023'&&sql.message==='scope_visibility_incompatible')throw Object.assign(new DerivedScopeError('scope_visibility_incompatible'),{cause:error})
   throw error
  }
  const stored=z.object({message,source:scope}).strict().parse(result)
  if(stored.message.sessionId!==input.sessionId||stored.source.workspaceId!==execution.security.access.workspaceId||stored.source.resourceId!==stored.message.id)throw new DerivedScopeError('scope_source_changed')
  await execution.security.authority.assertCurrent()
  return bindScopeSource({...stored.message,createdAt:new Date(stored.message.createdAt)},stored.source)
 }
 return client?write(client):withSessionMessagePublication(authority,evidence.sources,write)
}

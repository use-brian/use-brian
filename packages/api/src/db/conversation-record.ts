/** Immutable M7 dialogue acquisition. Unmounted until the authenticated
 * successor and admission/derivation/withdrawal owners are installed together.
 * A capture is data with provenance; it never caches reader permission.
 * [COMP:api/conversation-visibility] */
import {z} from 'zod'
import {DerivedScopeError,type ScopeSource} from '@use-brian/agent-runtime/security/derived-scope.js'
import {bindScopeSources} from '@use-brian/agent-runtime/security/source-evidence.js'
import {applyRLSGucs,commitTransaction,getAppPool,rollbackAndRelease} from './client.js'
import {privateTranscriptText} from './private-transcript.js'
import {sessionMessageAnnotationPayloadSchema} from './session-message-annotations.js'
import type {SessionMessage} from './sessions.js'
import {ConversationVisibilityError,type ConversationVisibilityActor} from './conversation-visibility.js'

const uuid=z.string().uuid(),sequence=z.number().int().nonnegative(),digest=z.string().regex(/^[0-9a-f]{64}$/)
export const conversationRecordSourceSchema=z.object({workspaceId:uuid,userId:z.null(),assistantId:z.null(),resourceKind:z.literal('conversation_record'),
 resourceId:uuid,version:z.literal('1'),sensitivity:z.enum(['public','internal','confidential']),
 compartments:z.array(z.string()),projectIds:z.array(uuid)}).strict()
const attachment=z.object({fileId:uuid,workspaceId:uuid,path:z.string(),name:z.string(),mime:z.string(),
 sizeBytes:z.number().int().nonnegative(),caption:z.string().optional()}).strict()
const rowSchema=z.object({id:uuid,sessionId:uuid,role:z.enum(['user','assistant']),content:z.unknown(),
 sequenceNum:sequence.positive(),createdAt:z.string().datetime({offset:true}),senderUserId:uuid.nullable(),
 senderAssistantId:uuid.nullable(),channelMessageId:z.string().nullable(),attachments:z.array(attachment)}).strict()
const annotationSchema=z.object({id:uuid,sequenceNum:sequence.positive(),revisionId:uuid,
 version:z.string().regex(/^[1-9][0-9]*$/),content:sessionMessageAnnotationPayloadSchema}).strict()
const manifestSchema=z.object({afterSequence:sequence,throughSequence:sequence,topicThroughSequence:sequence,
 modelRecipe:z.literal('dialogue_text_v1'),rowCount:sequence,annotationCount:sequence,
 payloadDigest:digest,rowIdentityDigest:digest,annotationIdentityDigest:digest}).strict()
const captureSchema=z.object({source:conversationRecordSourceSchema,rows:z.array(rowSchema),annotations:z.array(annotationSchema),
 generation:z.string().regex(/^[1-9][0-9]*$/),dataRevision:z.string().regex(/^[1-9][0-9]*$/),manifest:manifestSchema}).strict()
const actorSchema=z.object({userId:uuid,authSessionId:uuid,authVersion:z.number().int().nonnegative()}).strict()
export const conversationRecordSelectionSchema=z.object({workspaceId:uuid,sessionId:uuid,afterSequence:sequence,
 throughSequence:sequence,topicThroughSequence:sequence}).strict()
 .refine(value=>value.throughSequence>=value.afterSequence,'Invalid conversation selection')
export type ConversationRecordSelection=z.infer<typeof conversationRecordSelectionSchema>
export type ConversationRecord=Readonly<{source:ScopeSource;rows:SessionMessage[];generation:string;dataRevision:string;
 manifest:z.infer<typeof manifestSchema>}>
const recordSelection=new WeakMap<ConversationRecord,ReadonlyMap<string,{sequence:number;role:string}>>()
export function conversationRecordSelectedRow(record:ConversationRecord,id:string,sequence:number,role:string):boolean{
 const selected=recordSelection.get(record)?.get(id)
 return selected?.sequence===sequence&&selected.role===role
}
function changed():never{throw new DerivedScopeError('scope_source_changed')}

/** The transaction-owned reader may resolve its upper bound from the indexed
 * current high sequence. Keep the requested slice coupled to that result. */
export function parseTurnConversationRecord(raw:unknown,workspaceId:string,sessionId:string,after:number,through?:number,topicThrough?:number):ConversationRecord{
 const manifest=manifestSchema.parse((raw as {manifest?:unknown}|null)?.manifest)
 if(manifest.afterSequence!==Math.min(after,manifest.throughSequence)||manifest.topicThroughSequence!==(topicThrough??manifest.throughSequence)
  ||through!==undefined&&manifest.throughSequence!==through)changed()
 return parseConversationRecord(raw,{workspaceId,sessionId,afterSequence:manifest.afterSequence,
  throughSequence:manifest.throughSequence,topicThroughSequence:manifest.topicThroughSequence})
}

/** Parse inside the acquisition transaction: malformed observations roll back.
 * Keep the one fixed model recipe here; generic raw history must not be passed
 * off as the source-certified dialogue. */
export function parseConversationRecord(raw:unknown,selection:ConversationRecordSelection):ConversationRecord{
 const value=captureSchema.parse(raw),{manifest}=value
 if(value.source.workspaceId!==selection.workspaceId||manifest.afterSequence!==selection.afterSequence
  ||manifest.throughSequence!==selection.throughSequence||manifest.topicThroughSequence!==selection.topicThroughSequence
  ||manifest.rowCount!==value.rows.length||manifest.annotationCount!==value.annotations.length)changed()
 const ids=new Map<string,number>();let previous=selection.afterSequence
 for(const row of value.rows){
  if(row.sessionId!==selection.sessionId||row.sequenceNum<=previous||row.sequenceNum>selection.throughSequence||ids.has(row.id))changed()
  ids.set(row.id,row.sequenceNum);previous=row.sequenceNum
 }
 const annotations=new Map<string,z.infer<typeof annotationSchema>>();previous=0
 for(const annotation of value.annotations){
  if(ids.get(annotation.id)!==annotation.sequenceNum||annotation.sequenceNum<=previous
   ||annotation.sequenceNum>selection.topicThroughSequence||annotations.has(annotation.id))changed()
  annotations.set(annotation.id,annotation);previous=annotation.sequenceNum
 }
 const source:ScopeSource=value.source
 const rows=value.rows.flatMap(row=>{
  const text=privateTranscriptText(row.content,row.role)
  if(!text)return []
  const annotation=annotations.get(row.id)?.content
  return [bindScopeSources<SessionMessage>({...row,createdAt:new Date(row.createdAt),content:[{type:'text',text}],
   replyToText:annotation?.replyToText??null,topicLabel:annotation?.topicLabel??null,
   topicConfidence:annotation?.topicConfidence??null},[source])]
 })
 const record=Object.freeze({source,rows:bindScopeSources(rows,[source]),generation:value.generation,dataRevision:value.dataRevision,manifest})
 recordSelection.set(record,new Map(value.rows.map(row=>[row.id,{sequence:row.sequenceNum,role:row.role}])))
 return record
}

/** Native workspace purpose only. Channel/visitor and nonworkspace personal
 * purposes retain their existing owner until separately bound successor ports
 * are proved; callers cannot select one with an allowNonmember boolean. */
export async function captureNativeConversationRecord(actor:ConversationVisibilityActor,
 request:ConversationRecordSelection):Promise<ConversationRecord>{
 const claims=actorSchema.parse(actor),selection=conversationRecordSelectionSchema.parse(request)
 const client=await getAppPool().connect()
 try{
   await client.query('BEGIN');await applyRLSGucs(client,claims.userId)
   const result=await client.query<{value:unknown}>(
    'SELECT capture_native_conversation_record($1,$2,$3,$4,$5,$6,$7) AS value',
    [selection.workspaceId,selection.sessionId,claims.authSessionId,claims.authVersion,
     selection.afterSequence,selection.throughSequence,selection.topicThroughSequence])
   if(result.rows.length!==1||result.rows[0].value==null)throw new Error('conversation_record_unavailable')
   const captured=parseConversationRecord(result.rows[0].value,selection)
   await commitTransaction(client)
   return captured
 }catch(error){
  const failure=error as {code?:string;message?:string}
  if(failure.code==='42501'&&failure.message==='conversation_access_denied')
   throw new ConversationVisibilityError('conversation_access_denied',403)
  throw error
 }finally{await rollbackAndRelease(client)}
}

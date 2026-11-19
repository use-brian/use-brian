import { hasWorkspaceConversationAudience } from '../session-kind.js'
import {readPrivateTranscript,usesPrivateResponderTranscript} from './private-transcript.js'
/** Current native session query captures. [COMP:api/application-persistence] */
import {z} from 'zod'
import type {PoolClient,ClientBase} from 'pg'
import {assertHostObservationPublication} from '@use-brian/core/engine/routine-read.js'
import type {SessionContextAuthority} from '@use-brian/core/memory/session-state-types.js'
import {ContextScopeAccumulator,type ScopeEvidence} from '@use-brian/agent-runtime/security/context-scope.js'
import {deriveResourceScope, deriveWriteScope, DerivedScopeError, type DerivedWriteEvidence, type ResourceScope, type ScopeSource} from '@use-brian/agent-runtime/security/derived-scope.js'
import {executionToolContext,type ExecutionContext} from '@use-brian/agent-runtime/security/execution-context.js'
import {bindScopeSource, bindScopeSources, boundScopeSources} from '@use-brian/agent-runtime/security/source-evidence.js'
import {applicationJsonSchema} from '@use-brian/shared'
import {commitTransaction,getPool,rollbackAndRelease} from './client.js'
import {bufferedWebPublicationDescriptor,recordTurnCompletion,bindTurnCompletion,verifyTurnCompletionReceipt,type BufferedWebPublication,type TurnCompletionBinding} from './conversation-publication-recovery.js'
import {bufferedTerminalCandidate,acceptCommittedTerminalPublication,type BoundBufferedTerminalCommand} from '../turn/terminal-publication.js'
import {admitModelInput} from '../context-scope/admission.js'
import {admitVerifiedSharedRoomResumeEvidence} from '../context-scope/native-invocation-evidence.js'
import type {AccessCeiling} from '@use-brian/agent-runtime/security/access-ceiling.js'
import {boundScopeSource} from '@use-brian/agent-runtime/security/source-evidence.js'
import {addSessionMessage,readSessionMessageScopeSource,type SessionMessage,type SessionMessageAttachment} from './sessions.js'
import {publicConversationScope,readPublicConversationFloor,type PublicTurnConversationBinding} from './public-conversation.js'
import {channelEvidenceFitsEnvelope,pinVerifiedChannelPublication,selectVerifiedChannelHistory,type ChannelRecordPublication} from './verified-channel-record.js'
import {assertSessionMessagePublicationFrame,acceptSessionMessagePublicationAnnotation,withSessionMessagePublication,readJointSessionQueryFrame,readRetainedContextFrame} from './session-context-revisions.js'

export type ConversationSelection=Readonly<{sessionId:string;throughSequence:number;topicThroughSequence:number}>
const source=z.object({workspaceId:z.string().uuid(),userId:z.string().uuid().nullable(),assistantId:z.string().uuid().nullable(),
 sensitivity:z.enum(['public','internal','confidential']),compartments:z.array(z.string()),projectIds:z.array(z.string().uuid()),
 resourceKind:z.enum(['application_field','session_context_revision','session_message','memory','workspace_file']),resourceId:z.string().uuid(),version:z.string().min(1)}).strict()
const captureSource=source.extend({resourceKind:z.enum(['application_field','external_source'])})
const capture=z.object({row:z.record(applicationJsonSchema).nullable(),sources:z.array(captureSource).min(1)}).strict()
const attachment=z.object({fileId:z.string().uuid(),workspaceId:z.string().uuid(),path:z.string(),name:z.string(),mime:z.string(),
 sizeBytes:z.number().int().nonnegative(),caption:z.string().optional()}).strict()
const body=z.object({id:z.string().uuid(),role:z.string(),content:applicationJsonSchema,sequenceNum:z.number().int().positive(),
 createdAt:z.string().datetime({offset:true}),senderUserId:z.string().uuid().nullable(),senderAssistantId:z.string().uuid().nullable(),
 channelMessageId:z.string().nullable(),attachments:z.array(attachment)}).strict()
export const conversationAnnotationSchema=z.object({id:z.string().uuid(),sequenceNum:z.number().int().positive(),topicLabel:z.string().min(1).max(200),
 topicConfidence:z.number().finite().min(0).max(1),replyToText:z.string().max(8000).nullable()}).strict()
// Strict DTO parsing stays inside the acquisition transaction so malformed
// payloads cannot commit observations.
const captures=z.object({history:z.array(capture.extend({row:body.nullable()})).min(1),
 annotations:z.array(capture.extend({row:conversationAnnotationSchema.nullable()})).min(1)}).strict()
export type ConversationCaptures=z.infer<typeof captures>

export function conversationCaptureSources(value:ConversationCaptures,workspaceId:string):ScopeSource[]{
 for(const rows of [value.history,value.annotations]){
  if(rows[0].row!==null||rows.slice(1).some(row=>row.row===null)
   ||rows.some(row=>row.sources[0].resourceKind!=='application_field'||row.sources.some(source=>source.workspaceId!==workspaceId)))throw new DerivedScopeError('scope_source_changed')
 }
 return new ContextScopeAccumulator({sources:[...value.history,...value.annotations].flatMap(row=>row.sources)}).evidence.sources??[]
}


/** Only selector identities cross the SQL boundary; no caller supplies a proof. */
export async function captureConversationQuery(client:Pick<PoolClient,'query'>,workspaceId:string,
 selection:ConversationSelection):Promise<ConversationCaptures>{
 const value=captures.parse((await client.query<{value:unknown}>('SELECT capture_conversation_query($1,$2,$3,$4) AS value',
  [workspaceId,selection.sessionId,selection.throughSequence,selection.topicThroughSequence])).rows[0]?.value)
 conversationCaptureSources(value,workspaceId)
 return value
}
export type SessionQueryAnnotation=z.infer<typeof conversationAnnotationSchema>
function changed():never{throw new DerivedScopeError('scope_source_changed')}
/** Annotation-only capture uses the same operation and retains its query obligation. */
export async function captureSessionTopics(client:Pick<PoolClient,'query'>,workspaceId:string,sessionId:string,through:number):Promise<SessionQueryAnnotation[]>{
 const raw=(await client.query<{value:unknown}>('SELECT capture_conversation_query($1,$2,NULL,$3) AS value',[workspaceId,sessionId,through])).rows[0]?.value
 const value=captures.extend({history:z.array(capture).length(0)}).parse(raw)
 const rows=value.annotations
 if(rows[0].row!==null||rows.slice(1).some(row=>row.row===null)
  ||rows.some(row=>row.sources[0].resourceKind!=='application_field'||row.sources.some(source=>source.workspaceId!==workspaceId)))changed()
 return bindScopeSources(rows.slice(1).map(row=>bindScopeSources(conversationAnnotationSchema.parse(row.row),row.sources)),rows.flatMap(row=>row.sources))
}
/** Immutable root metadata for fresh independent-source preparation, never payload admission. */
export async function sessionQueryRootMetadata(workspaceId:string,sessionId:string,throughSequence:number,topicThrough:number):Promise<ScopeSource[]>{
 return (await getPool().query<{source:ScopeSource|null}>(`SELECT jsonb_build_object(
  'workspaceId',m.workspace_id,'userId',m.user_id,'assistantId',m.assistant_id,'sensitivity',m.sensitivity,
  'compartments',m.compartments,'projectIds',m.project_ids,'resourceKind','session_message','resourceId',m.id,'version',m.scope_version::text) AS source
  FROM session_messages m WHERE m.workspace_id=$1 AND m.session_id=$2 AND m.sequence_num<=$3
  UNION ALL SELECT read_scope_source(h.workspace_id,'session_context_revision',h.scope_revision_id) AS source
  FROM session_message_annotation_heads h JOIN session_messages m ON m.workspace_id=h.workspace_id AND m.id=h.message_id AND m.session_id=h.session_id
  WHERE h.workspace_id=$1 AND h.session_id=$2 AND m.sequence_num<=$4`,[workspaceId,sessionId,throughSequence,topicThrough])).rows
  .flatMap(row=>row.source?[row.source]:[])
}
/** One invocation's detached data. Every consumer still admits its complete
 * original sources at dispatch; none of these methods returns an allow receipt. */
export type ConversationFrame={
 history:SessionMessage[];annotations:SessionQueryAnnotation[]
 assemble:(authority:SessionContextAuthority,fromSequence?:number|null)=>SessionMessage[]
 privateTranscript:(authority:SessionContextAuthority)=>SessionMessage[]|null
 current:(authority:SessionContextAuthority,topicThroughSequence?:number,currentInput?:{id:string;sequence:number})=>Promise<ConversationFrame>
}
function copyConversationRows<T extends object>(rows:readonly T[]):T[]{
 return rows.map(row=>bindScopeSources(structuredClone(row),structuredClone(boundScopeSources(row))))
}
function ownConversationFrame(authority:SessionContextAuthority,selection:ConversationSelection,
 data:{history:SessionMessage[];annotations:SessionQueryAnnotation[]},privateDialogue:boolean,originalRoots:readonly ScopeSource[]=[]):ConversationFrame{
 const execution=authority.execution,sources=structuredClone(boundScopeSources(data))
 const rootKey=(roots:readonly ScopeSource[])=>JSON.stringify(roots.map(source=>JSON.stringify(source)).sort())
 const originalRootKey=rootKey(originalRoots)
 const history=copyConversationRows(data.history),annotations=copyConversationRows(data.annotations)
 const use=(current:SessionContextAuthority)=>{
  if(current.execution!==execution||execution.lifecycle.sessionId!==selection.sessionId
   ||!(current.accumulator instanceof ContextScopeAccumulator))changed()
  current.accumulator.note({sources:structuredClone(sources)})
 }
 const assemble=(current:SessionContextAuthority,from?:number|null)=>{
  use(current)
  const labels=new Map(annotations.map(row=>[row.id,row]))
  const rows=copyConversationRows(history).filter(row=>from==null||row.sequenceNum>=from).map(row=>{
   const annotation=labels.get(row.id)
   return bindScopeSources({...row,topicLabel:annotation?.topicLabel??null,topicConfidence:annotation?.topicConfidence??null,
    replyToText:annotation?.replyToText??null},[...boundScopeSources(row),...(annotation?boundScopeSources(annotation):[])])
  })
  return bindScopeSources(rows,structuredClone(sources))
 }
 const frame:ConversationFrame={history:bindScopeSources(copyConversationRows(history),boundScopeSources(data.history)),
  annotations:bindScopeSources(copyConversationRows(annotations),boundScopeSources(data.annotations)),assemble,
  privateTranscript(current){use(current);return privateDialogue?assemble(current):null},
  async current(current,topicThroughSequence,currentInput){
   const high=(await getPool().query<{sequence:number}>(
    'SELECT coalesce(max(sequence_num),0)::int AS sequence FROM session_messages WHERE (workspace_id=$1 OR workspace_id IS NULL) AND session_id=$2',
    [current.execution.security.access.workspaceId,selection.sessionId])).rows[0].sequence
   const topicThrough=topicThroughSequence??high
   let unchanged=current.execution===execution&&high===selection.throughSequence&&topicThrough===selection.topicThroughSequence
   if(unchanged&&!privateDialogue)unchanged=rootKey(await sessionQueryRootMetadata(execution.security.access.workspaceId,selection.sessionId,high,topicThrough))===originalRootKey
   if(unchanged){
    // Metadata is never permission. This is a new complete source operation;
    // dispatch and completion still perform their own independent checks.
    await admitModelInput({...executionToolContext(execution,{appId:'native-conversation-assembly'}),
     scopeAccumulator:new ContextScopeAccumulator({sources:structuredClone(sources)})})
    use(current);return frame
   }
   return readAdmittedSessionQuery({authority:current,sessionId:selection.sessionId,throughSequence:high,topicThroughSequence:topicThrough,
    ...(currentInput&&current.execution===execution?{currentMessageId:currentInput.id,currentMessageSequence:currentInput.sequence}:{})})
  },
 }
 return bindScopeSources(Object.freeze(frame),structuredClone(sources))
}

/** The selector is server query metadata, never source authority or a client allow token. */
export async function readAdmittedSessionQuery(input:{sessionId:string;throughSequence:number;topicThroughSequence?:number;currentMessageId?:string;currentMessageSequence?:number;authority:SessionContextAuthority}):Promise<ConversationFrame> {
 const {authority,sessionId,throughSequence}=input,{execution}=authority
 const topicThrough=input.topicThroughSequence??throughSequence,workspaceId=execution.security.access.workspaceId
 if(!(authority.accumulator instanceof ContextScopeAccumulator)||execution.lifecycle.sessionId!==sessionId||execution.lifecycle.sessionPersisted===false
  ||![throughSequence,topicThrough].every(value=>Number.isSafeInteger(value)&&value>=0&&value<=2147483647))changed()
 await execution.security.authority.assertCurrent()
 // Private dialogue is its own source. Do not traverse old facts just to
 // discover that they are obsolete before remembering what was said.
 const transcript=await readPrivateTranscript(authority,sessionId,throughSequence)
 if(transcript){
  const history=[...transcript],sources=[...boundScopeSources(transcript)]
  // Only the actual current authored input needs raw attachment/model context.
  // Its ordinary source is freshly admitted, independently of earlier replies.
  if(input.currentMessageId){
   const currentSequence=input.currentMessageSequence??throughSequence
   if(!Number.isSafeInteger(currentSequence)||currentSequence<1||currentSequence>throughSequence)changed()
   const currentSource=await readSessionMessageScopeSource(workspaceId,input.currentMessageId)
   if(!currentSource)changed()
   const current=await readRetainedContextFrame(authority,[currentSource],async client=>{
    const row=(await client.query<SessionMessage>(`SELECT id,session_id AS "sessionId",role,content,
     sequence_num AS "sequenceNum",created_at AS "createdAt",NULL::text AS "replyToText",
     NULL::text AS "topicLabel",NULL::float AS "topicConfidence",channel_message_id AS "channelMessageId",
     sender_user_id AS "senderUserId",sender_assistant_id AS "senderAssistantId",attachments
     FROM session_messages WHERE workspace_id=$1 AND session_id=$2 AND id=$3 AND sequence_num=$4
      AND role='user' AND session_recording_read_allowed(session_id)`,
     [workspaceId,sessionId,input.currentMessageId,currentSequence])).rows[0]
    if(row)return bindScopeSources(row,[currentSource])
    if(!usesPrivateResponderTranscript(execution))changed()
    // The direct presentation fence can decline a private responder. Use the
    // original native selector in this same source frame for this exact input.
    const captured=await captureConversationQuery(client,workspaceId,{sessionId,throughSequence:currentSequence,topicThroughSequence:0})
    const authored=captured.history.find(({row:message})=>message&&message.id===input.currentMessageId
      &&message.sequenceNum===currentSequence&&message.role==='user')
    if(!authored?.row)changed()
    const value=authored.row
    return bindScopeSources({...value,sessionId,createdAt:new Date(value.createdAt),
      replyToText:null,topicLabel:null,topicConfidence:null},[currentSource,...authored.sources])
   })
   const index=history.findIndex(row=>row.id===current.id)
   if(index<0)history.push(current);else history[index]=current
   sources.push(...boundScopeSources(current))
  }
  history.sort((a,b)=>a.sequenceNum-b.sequenceNum)
  bindScopeSources(history,sources)
  const result=bindScopeSources({history,annotations:[] as SessionQueryAnnotation[]},sources)
  authority.accumulator.note({sources})
  return ownConversationFrame(authority,{sessionId,throughSequence,topicThroughSequence:topicThrough},result,true)
 }
 // Discover immutable identities only. Neither owner discovery nor metadata is
 // an authorization decision; the non-owner projection admits every candidate.
 const roots=await sessionQueryRootMetadata(workspaceId,sessionId,throughSequence,topicThrough)
 const captured=await readJointSessionQueryFrame(authority,roots,{sessionId,throughSequence,topicThroughSequence:topicThrough})
 const candidates=captured.history.slice(1)
 const selected=await selectVerifiedChannelHistory(execution,candidates.map(item=>item.row!.id))
 if(selected&&input.currentMessageId&&!selected.has(input.currentMessageId))changed()
 const history=candidates.filter(item=>!selected||selected.has(item.row!.id)).map(row=>{
  const value=row.row!
  return bindScopeSources<SessionMessage>({...value,sessionId,createdAt:new Date(value.createdAt),replyToText:null,topicLabel:null,topicConfidence:null},row.sources)
 })
 bindScopeSources(history,captured.history.flatMap(row=>row.sources))
 const annotations=bindScopeSources(captured.annotations.slice(1).filter(item=>!selected||selected.has(item.row!.id))
  .map(row=>bindScopeSources(row.row!,row.sources)),captured.annotations.flatMap(row=>row.sources))
 const result=bindScopeSources({history,annotations},[...boundScopeSources(history),...boundScopeSources(annotations)])
 authority.accumulator.note({sources:boundScopeSources(result)})
 return ownConversationFrame(authority,{sessionId,throughSequence,topicThroughSequence:topicThrough},result,false,roots)
}

/** Canonical publication shares the same native conversation owner. */
const publicationPayload=z.object({role:z.enum(['user','assistant']),content:applicationJsonSchema,channelMessageId:z.string().nullable(),senderUserId:z.string().uuid().nullable(),senderAssistantId:z.string().uuid().nullable(),attachments:z.array(attachment).max(100)}).strict()
const publicationScope=z.object({workspaceId:z.string().uuid(),userId:z.string().uuid().nullable(),assistantId:z.null(),sensitivity:z.enum(['public','internal','confidential']),compartments:z.array(z.string()),projectIds:z.array(z.string().uuid()),resourceKind:z.literal('session_message'),resourceId:z.string().uuid(),version:z.literal('1')}).strict()
const publicationMessage=publicationPayload.extend({id:z.string().uuid(),sessionId:z.string().uuid(),sequenceNum:z.number().int().positive(),createdAt:z.string().datetime({offset:true}),replyToText:z.null(),topicLabel:z.null(),topicConfidence:z.null()}).strict()
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
export async function publishNativeSessionMessage(input:NativeSessionMessageInput,client?:Pick<ClientBase,'query'>):Promise<SessionMessage>{
 if([input.replyToText,input.topicLabel,input.topicConfidence].some(value=>value!==undefined&&value!==null))throw new DerivedScopeError('scope_evidence_missing')
 const {role,content,channelMessageId,senderUserId,senderAssistantId,attachments}=input
 const [message]=await publishNativeSessionMessageBatch({sessionId:input.sessionId,authority:input.authority,
  derivation:input.derivation,derivationTarget:input.derivationTarget,
  messages:[{role,content,channelMessageId,senderUserId,senderAssistantId,attachments}]},client)
 return message
}

/** One logical native transcript effect, using the original live publication frame. */
type NativeSessionMessageBatchInput={
 sessionId:string;messages:readonly Pick<NativeSessionMessageInput,'role'|'content'|'channelMessageId'|'senderUserId'|'senderAssistantId'|'attachments'>[];
 derivation:DerivedWriteEvidence;derivationTarget?:ResourceScope;authority:SessionContextAuthority;
 /** `completion`: the owner's reply binding (8277). Recorded in this same
  * transaction after the rows, under the pinned lease token; closings omit it. */
 publication?:{turnToken?:string;stoppedTurnToken?:string;pendingAnnotation?:object;completion?:TurnCompletionBinding;
  publicConversation?:PublicTurnConversationBinding;channelRecord?:ChannelRecordPublication};
 measure?:<T>(counter:string,run:()=>Promise<T>)=>Promise<T>;
}
export async function publishNativeSessionMessageBatch(input:NativeSessionMessageBatchInput,client?:Pick<ClientBase,'query'>):Promise<SessionMessage[]>{
 return publishNativeMessageBatch(input,client)
}
/** Explicit migrated shared-web effect; generic writers retain their existing owner. */
export async function publishBufferedWebConversation(input:NativeSessionMessageBatchInput&{operation:BufferedWebPublication;
 terminalBinding?:(rows:readonly {role:string;content:unknown;senderAssistantId?:string|null}[])=>BoundBufferedTerminalCommand}):Promise<SessionMessage[]>{
 const {operation,terminalBinding,...command}=input
 return publishNativeMessageBatch(command,undefined,operation,terminalBinding)
}
async function publishNativeMessageBatch(input:NativeSessionMessageBatchInput,client?:Pick<ClientBase,'query'>,
 operation?:BufferedWebPublication,terminalBinding?:(rows:readonly {role:string;content:unknown;senderAssistantId?:string|null}[])=>BoundBufferedTerminalCommand):Promise<SessionMessage[]>{
 const {authority,sessionId}=input,{execution,accumulator}=authority
 const {completion:requestedCompletion,...publicationOptions}=input.publication??{}
 const publication=input.publication?publicationOptions:undefined
 const completion=requestedCompletion?bindTurnCompletion(requestedCompletion):undefined
 const completionToken=publication?.turnToken??publication?.stoppedTurnToken
 const channelRecord=publication?.channelRecord
 if(channelRecord&&(!publication?.turnToken||publication.publicConversation||operation||!channelRecord.address.member
  ||execution.identity.kind!=='attended'||execution.identity.principal.kind!=='workspace_member'
  ||execution.identity.principal.authenticationKind!=='verified_channel'||execution.lifecycle.channelType!==channelRecord.address.session.channelType
  ||sessionId!==channelRecord.address.session.id||execution.security.access.workspaceId!==channelRecord.address.workspaceId
  ||execution.security.access.userId!==channelRecord.address.userId||execution.assistant.id!==channelRecord.address.assistantId))throw new DerivedScopeError('scope_source_changed')
 if(completion&&(!completionToken||completion.assistantId!==execution.assistant.id))throw new DerivedScopeError('scope_evidence_missing')
 const originalOperation=operation?bufferedWebPublicationDescriptor(operation,authority,publication):undefined
 if(client&&publication)throw new DerivedScopeError('scope_evidence_missing')
 for(const row of input.messages){
  assertHostObservationPublication(row.content,execution)
  if(row.role!=='assistant' && Array.isArray(row.content)&&row.content.some(block=>block?.type==='host_observation'))throw new Error('Host observations require assistant-owned publication')
 }
 const time=input.measure??(<T>(_counter:string,run:()=>Promise<T>)=>run())
 if(execution.lifecycle.sessionId!==sessionId||execution.lifecycle.sessionPersisted===false||input.messages.length<1&&!publication||input.messages.length>512
  ||input.messages.some(row=>row.senderAssistantId!=null&&row.senderAssistantId!==execution.assistant.id
   ||Object.keys(row).some(key=>!['role','content','channelMessageId','senderUserId','senderAssistantId','attachments'].includes(key))))throw new DerivedScopeError('scope_evidence_missing')
 const evidence=structuredClone(input.derivation),target=input.derivationTarget?deriveWriteScope(evidence,input.derivationTarget,execution.security.access.userId):deriveResourceScope(evidence)
 const values=structuredClone(input.messages.map(row=>publicationPayload.parse({role:row.role,content:transcriptJson(row.content),channelMessageId:row.channelMessageId??null,
  senderUserId:row.senderUserId??null,senderAssistantId:row.senderAssistantId??null,attachments:row.attachments??[]})))
 const bufferedCommand=terminalBinding?.(values)
 const operationDescriptor=bufferedCommand&&operation&&originalOperation?{...originalOperation,version:2,
  terminalCandidate:bufferedTerminalCandidate(bufferedCommand,operation,execution,values)}:originalOperation
 let terminalResult:unknown
 const write=async(db:Pick<ClientBase,'query'>)=>{
  if(authority.execution!==execution||authority.accumulator!==accumulator)throw new DerivedScopeError('scope_source_changed')
  const annotation=assertSessionMessagePublicationFrame(db,authority)
  if(values.length===0&&!annotation)return []
  const channelFloor=channelRecord&&await pinVerifiedChannelPublication(db,channelRecord,publication!.turnToken!)
  let result:unknown,completionResult:unknown
  const publicationCall=operationDescriptor?'publish_native_session_message_batch($1,$2,$3,$4,$5,$6,$7)'
    :'publish_native_session_message_batch($1,$2,$3,$4,$5,$6)'
  const parameters=[execution.security.access.workspaceId,sessionId,JSON.stringify(annotation?{messages:values,annotation}:values),evidence.producer,
    JSON.stringify(evidence.sources),target,...(operationDescriptor?[operationDescriptor]:[])]
  try{
   if(completion&&values.length){
    const tokenIndex=parameters.length+1,bindingIndex=tokenIndex+1
    const publication=bufferedCommand?"authored.value->'value'":'authored.value'
    const messages=annotation?`${publication}->'messages'`:publication
    const written=(await time('publication_batch_sql',()=>db.query<{value:unknown;completion:unknown}>(`WITH authored AS MATERIALIZED (
      SELECT ${publicationCall} AS value
     ) SELECT value,record_native_turn_completion($1,$2,$${tokenIndex}::uuid,$${bindingIndex}::jsonb||jsonb_build_object('messages',(
      SELECT jsonb_agg(row->'message'->'id' ORDER BY ordinal)
      FROM jsonb_array_elements(${messages}) WITH ORDINALITY outputs(row,ordinal)
     ))) AS completion FROM authored`,[...parameters,completionToken,JSON.stringify({...completion,stopped:!!input.publication?.stoppedTurnToken})]))).rows[0]
    result=written?.value;completionResult=written?.completion
   }else{
    result=(await time('publication_batch_sql',()=>db.query<{value:unknown}>(`SELECT ${publicationCall} AS value`,parameters))).rows[0]?.value
   }
  }
  catch(error){
   const sql=error as {code?:unknown;message?:unknown}
   if(sql.code==='P0001'&&sql.message==='scope_source_changed'||sql.code==='42501'&&['scope_source_changed','scope_ancestry_unavailable','scope_operation_denied'].includes(String(sql.message))||sql.code==='22023'&&sql.message==='scope_ancestry_unavailable')throw Object.assign(new DerivedScopeError('scope_source_changed'),{cause:error})
   if(sql.code==='22023'&&sql.message==='scope_evidence_missing')throw Object.assign(new DerivedScopeError('scope_evidence_missing'),{cause:error})
   if(sql.code==='22023'&&sql.message==='scope_visibility_incompatible')throw Object.assign(new DerivedScopeError('scope_visibility_incompatible'),{cause:error})
   throw error
  }
  if(bufferedCommand){
   const packet=z.object({value:z.unknown(),publication:z.unknown()}).strict().parse(result)
   terminalResult=packet.publication;result=packet.value
  }
  if(annotation){
   const compound=z.object({messages:z.unknown(),annotation:z.unknown()}).strict().parse(result)
   acceptSessionMessagePublicationAnnotation(db,authority,compound.annotation)
   result=compound.messages
  }
  const stored=z.array(z.object({message:publicationMessage,source:publicationScope}).strict()).length(values.length).parse(result)
  const rows=stored.map((row,index)=>{
   if(row.message.sessionId!==sessionId||row.source.workspaceId!==execution.security.access.workspaceId||row.source.resourceId!==row.message.id
    ||row.message.role!==values[index].role||index>0&&row.message.sequenceNum!==stored[index-1].message.sequenceNum+1)throw new DerivedScopeError('scope_source_changed')
   if(channelFloor&&(!channelEvidenceFitsEnvelope(channelFloor,row.source)
    ||hasWorkspaceConversationAudience(channelFloor.visibility)&&row.source.userId!==null))throw new DerivedScopeError('scope_source_changed')
   return bindScopeSource({...row.message,createdAt:new Date(row.message.createdAt)},row.source)
  })
  if(completion&&rows.length)verifyTurnCompletionReceipt(completionResult,completion,rows)
  return rows
 }
 const rows=await(client?write(client):withSessionMessagePublication(authority,evidence.sources,write,{...publication,measure:time,bufferedCommand}))
 if(bufferedCommand&&operation)acceptCommittedTerminalPublication(bufferedCommand,operation,execution,rows,terminalResult,!!originalOperation?.stopped)
 return rows
}

/** One stored-writer row (no native transcript authority). */
export type StoredTurnPublicationRow={role:'assistant'|'user';content:unknown;senderAssistantId?:string|null;senderUserId?:string|null;
 channelMessageId?:string|null;attachments?:SessionMessageAttachment[]}

/** The exact public credential and live lease are held by the same transaction
 * that appends the authored row or applies the explicit destructive retry. */
export async function withPublicConversationWrite<T>(binding:PublicTurnConversationBinding,token:string,
 operation:(client:PoolClient,scope:ResourceScope|undefined)=>Promise<T>):Promise<T>{
 const client=await getPool().connect()
 try{
  await client.query('BEGIN')
  const floor=await readPublicConversationFloor(binding,{version:binding.version,write:{client,token}})
  const result=await operation(client,publicConversationScope(floor))
  await commitTransaction(client)
  return result
 }finally{await rollbackAndRelease(client)}
}

/** The stored room continuation retains its own checked audience and outcome. */
export type SharedRoomResumePublication = {
  execution: ExecutionContext
  evidence: ScopeEvidence
  recipient: AccessCeiling
  outcomeNote?: string
}

/** The stored writer of the reply publication, for lanes without native
 * transcript authority (durable resume, external callee). Without a completion it
 * keeps the displaced shape exactly: one autocommit row, or one transaction for
 * several. With the owner's completion it is always one transaction: the rows,
 * then the 8277 completion header, then COMMIT. Run inside the adapter's
 * authority bracket; it adds no authorization of its own. */
export async function publishStoredTurnPublication(input:{sessionId:string;rows:readonly StoredTurnPublicationRow[];
 write:{scope:ResourceScope}|{derivation:DerivedWriteEvidence;derivationTarget?:ResourceScope};
 token:string;stopped:boolean;completion?:TurnCompletionBinding;publicConversation?:PublicTurnConversationBinding;channelRecord?:ChannelRecordPublication;sharedRoomResume?:SharedRoomResumePublication}):Promise<SessionMessage[]>{
 const {sessionId,rows,write}=input
 if(rows.length<1||rows.length>512)throw new DerivedScopeError('scope_evidence_missing')
 const completion=input.completion?bindTurnCompletion(input.completion):undefined
 if(!completion&&!input.publicConversation&&!input.channelRecord&&!input.sharedRoomResume&&rows.length===1)return [await addSessionMessage({sessionId,...rows[0]!,...write})]
 const workspaceId='scope' in write?write.scope.workspaceId:(write.derivationTarget?.workspaceId??deriveResourceScope(structuredClone(write.derivation)).workspaceId)
 const tx=await getPool().connect()
 try{
  await tx.query('BEGIN')
  if(input.publicConversation){
   if(input.publicConversation.sessionId!==sessionId||input.stopped)throw new DerivedScopeError('scope_source_changed')
   await readPublicConversationFloor(input.publicConversation,{version:input.publicConversation.version,write:{client:tx,token:input.token}})
  }
  if(input.channelRecord){
   if(input.publicConversation||input.stopped||input.channelRecord.address.session.id!==sessionId
    ||input.channelRecord.address.workspaceId!==workspaceId)throw new DerivedScopeError('scope_source_changed')
   await pinVerifiedChannelPublication(tx,input.channelRecord,input.token)
  }
  const resume=input.sharedRoomResume
  let replyWrite=write
  if(resume){
   if(input.publicConversation||input.channelRecord||input.stopped||workspaceId!==resume.recipient.workspaceId
    ||completion&&(completion.lane!=='resume'||completion.assistantId!==resume.execution.assistant.id
      ||completion.input?.kind!=='approval'||resume.execution.identity.kind!=='system'
      ||completion.input.ref!==resume.execution.identity.jobId))throw new DerivedScopeError('scope_source_changed')
   await admitVerifiedSharedRoomResumeEvidence(resume.execution,resume.evidence,resume.recipient,'audience',
    {client:tx,sessionId,token:input.token})
   if(resume.outcomeNote!==undefined){
    if(!completion||!('derivation' in write))throw new DerivedScopeError('scope_evidence_missing')
    const outcome=await addSessionMessage({sessionId,role:'system',content:[{type:'text',text:resume.outcomeNote}],...write,
     derivation:{...write.derivation,producer:'turn:resume-outcome'}},tx)
    const source=boundScopeSource(outcome)
    if(!source)throw new DerivedScopeError('scope_evidence_missing')
    replyWrite={...write,derivation:{...write.derivation,sources:[...write.derivation.sources,source]}}
   }
  }
  const stored:SessionMessage[]=[]
  for(const row of rows)stored.push(await addSessionMessage({sessionId,...row,...replyWrite},tx))
  if(input.publicConversation||input.channelRecord||resume){
   const result=await tx.query<{valid:boolean}>(`SELECT NOT EXISTS(SELECT 1 FROM public.conversation_message_quarantine
    WHERE session_id=$1 AND message_id=ANY($2::uuid[])) AS valid`,[sessionId,stored.map(row=>row.id)])
   if(result.rows[0]?.valid!==true)throw new DerivedScopeError('scope_source_changed')
  }
  if(completion)await recordTurnCompletion(tx,{workspaceId,sessionId,token:input.token,stopped:input.stopped,binding:completion,rows:stored})
  resume?.execution.lifecycle.abortSignal.throwIfAborted()
  await commitTransaction(tx)
  return stored
 }finally{await rollbackAndRelease(tx)}
}

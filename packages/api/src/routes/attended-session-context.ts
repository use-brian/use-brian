/** Current native attended history and annotations. [COMP:api/application-persistence] */
import {ContextScopeAccumulator,bindScopeSources,boundScopeSources,classifyTopic,classifyResearchIntent,classifySplit,isTrivialChatMessage,DerivedScopeError,executionToolContext,
 type ResearchClassifyOptions,type ResearchClassifyResult,type SplitOptions,type SplitResult,type TopicClassifierOptions,type SessionContextAuthority,type ScopeSource,type TopicClassification} from '@use-brian/core'
import {getPool} from '../db/client.js'
import {readAdmittedSessionQuery,captureSessionTopics,sessionQueryRootMetadata} from '../db/session-query-reader.js'
import {readSessionQueryFrame} from '../db/session-context-revisions.js'
import {writeSessionMessageAnnotation,prepareSessionMessageAnnotation} from '../db/session-message-annotations.js'
import type {Session,SessionMessage} from '../db/sessions.js'
import {assertSourceModelInputAuthority,ownsNativeAttendedAssembly,type NativeAttendedOutputBoundary} from '../application-platform/model-source-authority.js'
import {resolveReplyText,type ResolveReplyParams} from '../routes/_reply-context.js'
import {isAuthorityChangedError} from '../context-scope/authority-lease.js'

type ClassificationInput={authority:SessionContextAuthority;session:Session;message:SessionMessage;capture?:object}
type ClassificationMeasure=<T>(counter:string,run:()=>Promise<T>)=>Promise<T>
const classificationCaptures=new WeakMap<object,{authority:SessionContextAuthority;execution:SessionContextAuthority['execution'];accumulator:ContextScopeAccumulator;
 rootAuthority:SessionContextAuthority;rootExecution:SessionContextAuthority['execution'];rootAccumulator:ContextScopeAccumulator;
 sessionId:string;messageId:string;sequence:number;query:Awaited<ReturnType<typeof readAdmittedSessionQuery>>}>()
/** Data snapshot only; every classifier still checks current bound input authority. */
export async function captureAttendedSessionClassification(input:ClassificationInput):Promise<object>{
 const {authority,session,message}=input
 const execution=authority.execution,accumulator=authority.accumulator
 if(message.sessionId!==session.id||message.role!=='user')throw new DerivedScopeError('scope_evidence_missing')
 const query=await readAdmittedSessionQuery({sessionId:session.id,throughSequence:message.sequenceNum,topicThroughSequence:message.sequenceNum-1,currentMessageId:message.id,authority})
 if(authority.execution!==execution||authority.accumulator!==accumulator)throw new DerivedScopeError('scope_source_changed')
 const capture=Object.freeze({})
 classificationCaptures.set(capture,{authority,execution,accumulator,rootAuthority:authority,rootExecution:execution,rootAccumulator:accumulator,
  sessionId:session.id,messageId:message.id,sequence:message.sequenceNum,query})
 return capture
}
/** Fork data evidence for concurrent assessments, never an authority or allow receipt. */
export function forkAttendedSessionClassification(input:ClassificationInput){
 const captured=input.capture?classificationCaptures.get(input.capture):undefined
 if(!captured||captured.authority!==input.authority||captured.sessionId!==input.session.id
  ||captured.messageId!==input.message.id||captured.sequence!==input.message.sequenceNum
  ||input.authority.execution!==captured.execution||input.authority.accumulator!==captured.accumulator
  ||captured.rootAuthority.execution!==captured.rootExecution||captured.rootAuthority.accumulator!==captured.rootAccumulator)throw new DerivedScopeError('scope_evidence_missing')
 const authority:SessionContextAuthority={execution:input.authority.execution,
  accumulator:new ContextScopeAccumulator(structuredClone(input.authority.accumulator.evidence))}
 const capture=Object.freeze({})
 classificationCaptures.set(capture,{...captured,authority,execution:authority.execution,accumulator:authority.accumulator})
 return{authority,capture,mergeEvidence:()=>input.authority.accumulator.note(structuredClone(authority.accumulator.evidence))}
}
async function classificationQuery(input:ClassificationInput,topicThroughSequence:number){
 if(!input.capture)return readAdmittedSessionQuery({sessionId:input.session.id,throughSequence:input.message.sequenceNum,topicThroughSequence,currentMessageId:input.message.id,authority:input.authority})
 const captured=classificationCaptures.get(input.capture)
 if(!captured||captured.authority!==input.authority||captured.sessionId!==input.session.id||captured.messageId!==input.message.id||captured.sequence!==input.message.sequenceNum)
  throw new DerivedScopeError('scope_evidence_missing')
 if(input.authority.execution!==captured.execution||input.authority.accumulator!==captured.accumulator)throw new DerivedScopeError('scope_source_changed')
 await input.authority.execution.security.authority.assertCurrent()
 if(input.authority.execution!==captured.execution||input.authority.accumulator!==captured.accumulator)throw new DerivedScopeError('scope_source_changed')
 return captured.query
}

type ClassifiedTranscript = {
 execution:SessionContextAuthority['execution'];sessionId:string;through:number;messageId:string;annotationId?:string;
 history:SessionMessage[];sources:ScopeSource[];
}
const classifiedTranscripts=new WeakMap<readonly SessionMessage[],ClassifiedTranscript>()
function copyBoundHistory(history:readonly SessionMessage[]):SessionMessage[]{
 return history.map(row=>bindScopeSources(structuredClone(row),structuredClone(boundScopeSources(row))))
}
type ClassifiedInput={classification:TopicClassification;reply:Awaited<ReturnType<typeof resolveReplyText>>;history:SessionMessage[];pendingAnnotation?:object}
type TopicAssessment={publish:()=>Promise<ClassifiedInput>;defer:()=>Promise<ClassifiedInput>}
const nativeAssessments=new WeakMap<TopicAssessment,{rootAuthority:SessionContextAuthority;rootExecution:SessionContextAuthority['execution'];rootAccumulator:ContextScopeAccumulator;defer:()=>Promise<ClassifiedInput>;
 publicDefer:TopicAssessment['defer'];publicPublish:TopicAssessment['publish'];check:()=>Promise<void>;assertBinding:()=>void}>()

/** A private data handoff to the actual native sink owner, never an allow receipt.
 * Public/custom assessment and history entry points retain full fresh admission. */
export function captureNativeClassifiedAssembly(assessment:TopicAssessment,authority:SessionContextAuthority,boundary:NativeAttendedOutputBoundary){
 const entry=nativeAssessments.get(assessment),{execution,accumulator}=authority
 if(!entry||entry.rootAuthority!==authority||entry.rootExecution!==execution||entry.rootAccumulator!==accumulator
  ||assessment.defer!==entry.publicDefer||assessment.publish!==entry.publicPublish
  ||!ownsNativeAttendedAssembly(boundary,execution,accumulator))return undefined
 const lease=execution.security.authority,assertCurrent=lease.assertCurrent
 let staged:ClassifiedInput|undefined,refusal:unknown
 const assertBinding=()=>{
  if(refusal)throw refusal
  if(authority.execution!==execution||authority.accumulator!==accumulator||execution.security.authority!==lease
   ||lease.assertCurrent!==assertCurrent||assessment.defer!==entry.publicDefer||assessment.publish!==entry.publicPublish
   ||!ownsNativeAttendedAssembly(boundary,execution,accumulator))throw new DerivedScopeError('scope_source_changed')
  entry.assertBinding()
 }
 const checked=async<T>(operation:()=>Promise<T>):Promise<T>=>{
  try{assertBinding();await assertCurrent.call(lease);assertBinding();const result=await operation();assertBinding();return result}
  catch(error){
   if(!(error instanceof DerivedScopeError)&&!isAuthorityChangedError(error))throw error
   refusal=Object.assign(error,{reason:'authority_changed',retrySafe:false});throw refusal
  }
 }
 return Object.freeze({
  defer:()=>checked(async()=>{
   if(staged)throw new DerivedScopeError('scope_source_changed')
   const result=await entry.defer()
   const classification=structuredClone(result.classification)
   if(classification.related_topics)Object.freeze(classification.related_topics)
   if(classification.usage)Object.freeze(classification.usage)
   Object.freeze(classification)
   staged=Object.freeze({...result,classification:bindScopeSources(classification,boundScopeSources(result.classification)),
    reply:result.reply?bindScopeSources(Object.freeze({...result.reply}),boundScopeSources(result.reply)):null})
   return staged
  }),
  readHistory:(fromSequence?:number|null)=>checked(async()=>{
   if(!staged)throw new DerivedScopeError('scope_evidence_missing')
   const receipt=classifiedTranscripts.get(staged.history)
   if(!receipt||receipt.execution!==execution||receipt.annotationId)throw new DerivedScopeError('scope_evidence_missing')
   if(!await classifiedTranscriptCurrent(execution,receipt))return readClassifiedSessionHistory(authority,receipt.sessionId,staged.history,fromSequence)
   await assertCurrent.call(lease);assertBinding()
   accumulator.note({sources:receipt.sources})
   return attendedHistoryResult(authority,receipt.sessionId,copyBoundHistory(receipt.history),receipt.sources,fromSequence)
  }),
  runEffect:<T>(effect:()=>Promise<T>)=>checked(async()=>{
   if(!staged)throw new DerivedScopeError('scope_evidence_missing')
   await entry.check();assertBinding()
   return effect()
  }),
 })
}

async function classifiedTranscriptCurrent(execution:SessionContextAuthority['execution'],receipt:ClassifiedTranscript){
 return(await getPool().query<{current:boolean}>(`SELECT
  (SELECT coalesce(max(sequence_num),0) FROM session_messages WHERE (workspace_id=$1 OR workspace_id IS NULL) AND session_id=$2)=$3
  AND ($5::uuid IS NULL OR EXISTS(SELECT 1 FROM session_message_annotation_heads h JOIN session_messages m
   ON m.workspace_id=h.workspace_id AND m.session_id=h.session_id AND m.id=h.message_id
   WHERE h.workspace_id=$1 AND h.session_id=$2 AND h.message_id=$4 AND h.scope_revision_id=$5 AND m.sequence_num=$3)) AS current`,
  [execution.security.access.workspaceId,receipt.sessionId,receipt.through,receipt.messageId,receipt.annotationId??null])).rows[0]?.current===true
}

/** Group only already-admitted history; keys are exact storage identities, not names.
 * Assistant context follows the preceding annotated user, never a global bucket.
 */
export function topicEvidenceFromHistory(history: ReadonlyArray<{role:string;content:unknown;topicLabel?:string|null}>) {
 const groups=new Map<string,{topicLabel:string;messages:Array<{role:'user'|'assistant'|'system';text:string}>}>()
 const recent:string[]=[]
 let preceding:string|null=null
 for(const row of history){
  const toolContext=row.role==='user'&&Array.isArray(row.content)&&row.content.length>0&&row.content.every(block=>
   typeof block==='object'&&block!==null&&'type' in block&&block.type==='tool_result')
  if(row.role==='user'&&!toolContext)preceding=row.topicLabel?.trim()&&row.topicLabel!=='(uncategorized)'?row.topicLabel:null
  const key=row.role==='assistant'||toolContext?preceding:row.topicLabel
  if(!key?.trim()||key==='(uncategorized)'||!['user','assistant','system'].includes(row.role))continue
  const text=typeof row.content==='string'?row.content:Array.isArray(row.content)?row.content.flatMap(block=>{
   if(typeof block!=='object'||block===null||!('type' in block))return []
   if(block.type==='text'&&'text' in block&&typeof block.text==='string')return [block.text]
   if(block.type==='tool_result'&&'content' in block&&typeof block.content==='string')return [`Tool result: ${block.content}`]
   if(block.type==='tool_use'&&'name' in block&&'input' in block)return [`Tool call ${String(block.name)}: ${JSON.stringify(block.input)}`]
   return []
  }).join(' '):''
  let group=groups.get(key)
  if(!group){group={topicLabel:key,messages:[]};groups.set(key,group)}
  if(text)group.messages.push({role:row.role as 'user'|'assistant'|'system',text})
  recent.push(key)
 }
 return {topicAnchors:[...groups.values()],knownTopicsThisSession:[...new Set(recent.reverse())].slice(0,20).reverse()}
}

/** The actual current authored row is selected and scoped before text is formatted. */
export async function assessAttendedSessionMessage(input:{
 authority:SessionContextAuthority;session:Session;message:SessionMessage;
 provider:TopicClassifierOptions['provider'];model:string;decisionRuntime?:TopicClassifierOptions['decisionRuntime'];
 reply?:Pick<ResolveReplyParams,'channelType'|'replyToMessageId'|'clientSnippet'>;
 capture?:object;
 measure?:ClassificationMeasure;
}):Promise<TopicAssessment>{
 const {authority,session,message}=input
 const capture=input.capture,captured=capture?classificationCaptures.get(capture):undefined
 const sessionId=session.id,messageId=message.id,sequence=message.sequenceNum
 const execution=authority.execution,accumulator=authority.accumulator,lease=execution.security.authority,assertCurrent=lease.assertCurrent
 const measure=input.measure
 const assertBinding=()=>{
  if(input.authority!==authority||input.capture!==capture||input.session!==session||input.message!==message
   ||session.id!==sessionId||message.id!==messageId||message.sequenceNum!==sequence
   ||authority.execution!==execution||authority.accumulator!==accumulator
   ||captured&&(captured.rootAuthority.execution!==captured.rootExecution||captured.rootAuthority.accumulator!==captured.rootAccumulator
    ||execution!==captured.rootExecution)
   ||execution.security.authority!==lease||lease.assertCurrent!==assertCurrent)throw new DerivedScopeError('scope_source_changed')
 }
 if(message.sessionId!==session.id||message.role!=='user')throw new DerivedScopeError('scope_evidence_missing')
 const query=await classificationQuery(input,message.sequenceNum-1)
 const current=query.history.find(row=>row.id===message.id)
 if(!current||current.role!=='user')throw new DerivedScopeError('scope_source_changed')
 const text=(row:SessionMessage)=>typeof row.content==='string'?row.content:Array.isArray(row.content)?row.content.flatMap(block=>
  typeof block==='object'&&block!==null&&'type' in block&&block.type==='text'&&'text' in block&&typeof block.text==='string'?[block.text]:[]).join(' ').trim():''
 const annotations=new Map(query.annotations.map(row=>[row.id,row]))
 const history=query.history.map(row=>{
  const annotation=annotations.get(row.id)
  return bindScopeSources({...row,topicLabel:annotation?.topicLabel??null,topicConfidence:annotation?.topicConfidence??null,replyToText:annotation?.replyToText??null},
   [...boundScopeSources(row),...(annotation?boundScopeSources(annotation):[])])
 })
 bindScopeSources(history,boundScopeSources(query))
 const reply=input.reply?await resolveReplyText({...input.reply,session,readableHistory:history}):null
 // Exact acknowledgments need no durable generated annotation. The result
 // still retains the complete admitted query and current authority checks.
 const plain=typeof current.content==='string'||Array.isArray(current.content)&&current.content.every(block=>
  typeof block==='object'&&block!==null&&'type' in block&&block.type==='text'&&'text' in block&&typeof block.text==='string')
 const allowTrivialShortcut=!input.reply?.replyToMessageId&&!input.reply?.clientSnippet&&plain&&!current.attachments?.length
 const ephemeral=!reply&&allowTrivialShortcut&&isTrivialChatMessage(text(current))
 // Only metadata is read for CAS. The old generated value is not an input to
 // this new classification; its immutable revision remains in native history.
 const expected=ephemeral?undefined:(await getPool().query<{id:string}>('SELECT scope_revision_id AS id FROM session_message_annotation_heads WHERE workspace_id=$1 AND session_id=$2 AND message_id=$3',
  [authority.execution.security.access.workspaceId,session.id,message.id])).rows[0]?.id
 const context={...executionToolContext(authority.execution,{appId:'native-session-topic'}),scopeAccumulator:authority.accumulator}
 const check=async()=>{assertBinding();await(measure?measure('topic_authority',()=>assertSourceModelInputAuthority(context)):assertSourceModelInputAuthority(context));assertBinding()}
 const options=bindScopeSources<TopicClassifierOptions>({provider:input.provider,model:input.model,decisionRuntime:input.decisionRuntime,
  allowTrivialShortcut,currentMessage:text(current),recentUserTurns:history.filter(row=>row.sequenceNum<message.sequenceNum&&row.role==='user'&&(!ephemeral||row.topicLabel)).slice(-8)
   .map(row=>({text:text(row),topicLabel:row.topicLabel})).filter(turn=>turn.text.length>0),
  ...topicEvidenceFromHistory(history.filter(row=>row.sequenceNum<message.sequenceNum)),replyToText:reply?.text??null,
  authority,assertInputAuthority:check,workspaceId:authority.execution.security.access.workspaceId,
  runId:'memory-topic-'+message.id},boundScopeSources(query))
 const classification=await classifyTopic(options)
 const privateClassification=bindScopeSources(structuredClone(classification),structuredClone(boundScopeSources(classification)))
 const privateHistory=copyBoundHistory(history),privateReply=reply?structuredClone(reply):null
 const defer=async(full:boolean)=>{
  // A sibling assessment/quota wait may have changed the original inputs.
  // Public callers re-admit here; private assembly checks real effects later.
  if(full)await check()
  else{assertBinding();await assertCurrent.call(lease);assertBinding()}
  const selectedClassification=full?classification:bindScopeSources(structuredClone(privateClassification),boundScopeSources(privateClassification))
  const selectedHistory=full?history:bindScopeSources(copyBoundHistory(privateHistory),boundScopeSources(query))
  const selectedReply=full?reply:privateReply?bindScopeSources(structuredClone(privateReply),reply?boundScopeSources(reply):[]):null
  const pendingAnnotation=ephemeral?undefined:await prepareSessionMessageAnnotation({sessionId:session.id,messageId:message.id,
   classification:selectedClassification,replyToText:selectedReply?.text??null,authority,expectedRevision:expected})
  assertBinding()
  classifiedTranscripts.set(selectedHistory,{execution:authority.execution,sessionId:session.id,through:message.sequenceNum,
   messageId:message.id,history:copyBoundHistory(selectedHistory),sources:structuredClone(boundScopeSources(query))})
  return{classification:selectedClassification,reply:selectedReply,history:selectedHistory,pendingAnnotation}
 }
 const assessment:TopicAssessment={defer:()=>defer(true),publish:async()=>{
 if(ephemeral)await check()
 const annotation=ephemeral?null:await writeSessionMessageAnnotation({sessionId:session.id,messageId:message.id,classification,replyToText:reply?.text??null,authority,expectedRevision:expected})
 if(!ephemeral&&!annotation)throw new DerivedScopeError('scope_source_changed')
 await authority.execution.security.authority.assertCurrent()
 if(annotation)classifiedTranscripts.set(history,{execution:authority.execution,sessionId:session.id,through:message.sequenceNum,
  messageId:message.id,annotationId:annotation.revisionId,history:copyBoundHistory(query.history),
  sources:structuredClone(boundScopeSources(query.history))})
 return{classification,reply,history}
 }}
 if(captured?.authority===authority)nativeAssessments.set(assessment,{rootAuthority:captured.rootAuthority,rootExecution:captured.rootExecution,
  rootAccumulator:captured.rootAccumulator,defer:()=>defer(false),
  publicDefer:assessment.defer,publicPublish:assessment.publish,check,assertBinding})
 return assessment
}

/** Sequential callers retain the original classify-and-publish contract. */
export async function classifyAttendedSessionMessage(input:Parameters<typeof assessAttendedSessionMessage>[0]){
 const assessment=await assessAttendedSessionMessage(input)
 return assessment.publish()
}

const historyTurnCounts=new WeakMap<readonly SessionMessage[],{workspaceId:string;sessionId:string;count:number;sources:readonly ScopeSource[]}>()
function attendedHistoryResult(authority:SessionContextAuthority,sessionId:string,rows:SessionMessage[],sources:readonly ScopeSource[],fromSequence?:number|null){
 const count=rows.filter(row=>row.role==='user'&&!(Array.isArray(row.content)&&row.content.some(block=>
  typeof block==='object'&&block!==null&&'type' in block&&block.type==='tool_result'))).length
 const history=rows.filter(row=>fromSequence==null||row.sequenceNum>=fromSequence)
 historyTurnCounts.set(history,{workspaceId:authority.execution.security.access.workspaceId,sessionId,count,sources:structuredClone(sources)})
 return bindScopeSources(history,sources)
}

/** Reuse bytes only after a fresh canonical query frame admits their complete original evidence. */
export async function readClassifiedSessionHistory(authority:SessionContextAuthority,sessionId:string,classifiedHistory:readonly SessionMessage[],fromSequence?:number|null):Promise<SessionMessage[]>{
 const receipt=classifiedTranscripts.get(classifiedHistory),{execution}=authority
 const currentInput=receipt?.execution===execution&&receipt.sessionId===sessionId
  ?{id:receipt.messageId,sequence:receipt.through}:undefined
 const fresh=()=>readAttendedSessionHistory(authority,sessionId,fromSequence,undefined,currentInput)
 if(!receipt||receipt.execution!==execution||receipt.sessionId!==sessionId||execution.lifecycle.sessionId!==sessionId)return fresh()
 const current=()=>classifiedTranscriptCurrent(execution,receipt)
 await execution.security.authority.assertCurrent()
 if(!await current())return fresh()
 try{
  const topicRoots=receipt.annotationId?await sessionQueryRootMetadata(execution.security.access.workspaceId,sessionId,0,receipt.through):[]
  const rows=await readSessionQueryFrame(authority,[...receipt.sources,...topicRoots],async client=>{
   if(!await current())return{value:null,sources:[]}
   // A pending annotation has not been read or persisted. Re-admit the complete
   // original body/topic query before reusing its bytes, without fabricating a
   // current-annotation observation. The frame validates these sources freshly.
   if(!receipt.annotationId)return{value:bindScopeSources(copyBoundHistory(receipt.history),receipt.sources),sources:receipt.sources}
   // The newly written annotation has not had a query-field observation yet.
   // Capture current topics through the unchanged canonical query, including
   // its field policy and row bounds; only the immutable body query is reused.
   const annotations=await captureSessionTopics(client,execution.security.access.workspaceId,sessionId,receipt.through)
   const topics=new Map(annotations.map(row=>[row.id,row]))
   const history=copyBoundHistory(receipt.history).map(row=>{
    const topic=topics.get(row.id)
    return bindScopeSources({...row,topicLabel:topic?.topicLabel??null,topicConfidence:topic?.topicConfidence??null,replyToText:topic?.replyToText??null},
     [...boundScopeSources(row),...(topic?boundScopeSources(topic):[])])
   })
   const sources=[...receipt.sources,...boundScopeSources(annotations)]
   return{value:bindScopeSources(history,sources),sources}
  })
  if(!rows||!await current())return fresh()
  await execution.security.authority.assertCurrent()
  const sources=boundScopeSources(rows)
  authority.accumulator.note({sources})
  return attendedHistoryResult(authority,sessionId,rows,sources,fromSequence)
 }catch(error){
  const failure=error as {reason?:string;diagnostic?:string;cause?:{message?:string}}
  // A changed observation needs a new capture. Transport/SQL failures and
  // authority revocation must keep their authentic failure, never a retry.
  if(error instanceof DerivedScopeError&&error.code==='scope_source_changed'
   ||failure.reason==='caller_evidence_unavailable'&&(
    ['source_held','source_reclassified','source_changed'].includes(failure.diagnostic??'')
    ||failure.diagnostic==='source_unverifiable'&&failure.cause?.message==='Native session evidence unavailable'))return fresh()
  throw error
 }
}
/** Data snapshot only. Every use still requires the original current field/query/source admission. */
export async function attendedSessionTurnCount(authority:SessionContextAuthority,history:readonly SessionMessage[]):Promise<number>{
 const snapshot=historyTurnCounts.get(history),{execution}=authority
 if(!snapshot||snapshot.workspaceId!==execution.security.access.workspaceId||snapshot.sessionId!==execution.lifecycle.sessionId)throw new DerivedScopeError('scope_evidence_missing')
 const accumulator=new ContextScopeAccumulator(execution.security.provenance)
 accumulator.note({sources:[...snapshot.sources]})
 await assertSourceModelInputAuthority({...executionToolContext(execution,{appId:'native-session-title-count'}),scopeAccumulator:accumulator})
 return snapshot.count
}

/** Capture before filtering/formatting, retaining complete query obligations even for an empty window. */
export async function readAttendedSessionHistory(authority:SessionContextAuthority,sessionId:string,fromSequence?:number|null,throughSequence?:number,currentInput?:{id:string;sequence:number}):Promise<SessionMessage[]> {
 const high=throughSequence??(await getPool().query<{sequence:number}>(
  'SELECT coalesce(max(sequence_num),0)::int AS sequence FROM session_messages WHERE (workspace_id=$1 OR workspace_id IS NULL) AND session_id=$2',
  [authority.execution.security.access.workspaceId,sessionId])).rows[0].sequence
 const query=await readAdmittedSessionQuery({sessionId,throughSequence:high,authority,
  ...(currentInput?{currentMessageId:currentInput.id,currentMessageSequence:currentInput.sequence}:{})})
 const annotations=new Map(query.annotations.map(row=>[row.id,row]))
 const history=query.history.map(row=>{
  const annotation=annotations.get(row.id)
  return bindScopeSources({...row,topicLabel:annotation?.topicLabel??null,topicConfidence:annotation?.topicConfidence??null,replyToText:annotation?.replyToText??null},
   [...boundScopeSources(row),...(annotation?boundScopeSources(annotation):[])])
 })
 return attendedHistoryResult(authority,sessionId,history,boundScopeSources(query),fromSequence)
}

/** Assess only an authored current row and the complete admitted original body cohort. */
export async function classifyAttendedResearchMessage(input:{
 authority:SessionContextAuthority;session:Session;message:SessionMessage;
 provider:ResearchClassifyOptions['provider'];model:string;decisionRuntime?:ResearchClassifyOptions['decisionRuntime'];
 toolCandidates?:ResearchClassifyOptions['toolCandidates'];
 capture?:object;
 measure?:ClassificationMeasure;
}):Promise<ResearchClassifyResult>{
 const {authority,session,message}=input
 if(message.sessionId!==session.id||message.role!=='user')throw new DerivedScopeError('scope_evidence_missing')
 const query=await classificationQuery(input,0)
 const current=query.history.find(row=>row.id===message.id)
 if(!current)throw new DerivedScopeError('scope_source_changed')
 const text=(row:SessionMessage)=>typeof row.content==='string'?row.content:Array.isArray(row.content)?row.content.flatMap(block=>
  typeof block==='object'&&block!==null&&'type' in block&&block.type==='text'&&'text' in block&&typeof block.text==='string'?[block.text]:[]).join(' ').trim():''
 const recent=query.history.filter(row=>row.sequenceNum<message.sequenceNum&&(row.role==='user'||row.role==='assistant'))
  .filter(row=>!(row.role==='assistant'&&Array.isArray(row.content)&&row.content.some(block=>
   typeof block==='object'&&block!==null&&'type' in block&&block.type==='tool_use')))
  .map(row=>({role:row.role as 'user'|'assistant',text:text(row)})).filter(row=>row.text.trim().length>0).slice(-6)
 const context={...executionToolContext(authority.execution,{appId:'native-session-research'}),scopeAccumulator:authority.accumulator}
 const options=bindScopeSources<ResearchClassifyOptions>({provider:input.provider,model:input.model,decisionRuntime:input.decisionRuntime,
  message:text(current),recentConversation:recent,toolCandidates:input.toolCandidates,authority,signal:authority.execution.lifecycle.abortSignal,
  assertInputAuthority:()=>input.measure?input.measure('research_authority',()=>assertSourceModelInputAuthority(context)):assertSourceModelInputAuthority(context),workspaceId:authority.execution.security.access.workspaceId,
  runId:'research-intent-'+message.id},boundScopeSources(query))
 return classifyResearchIntent(options)
}

/** Data-only preparation for the invariant Standard splitter route. Classification
 * may overlap sibling assessments; task generation is consumed only at the old
 * preflight boundary after a NEW input proof. This object is never an allow receipt.
 */
export async function prepareAttendedSplitMessage(input:ClassificationInput&{
 provider:ResearchClassifyOptions['provider'];rawMessage:string;signal:AbortSignal;measure?:ClassificationMeasure;decisionRuntime?:SplitOptions['decisionRuntime'];
}):Promise<{usage:SplitResult['usage'];model:SplitResult['model'];matches:(message:string,provider:ResearchClassifyOptions['provider'],decisionRuntime?:SplitOptions['decisionRuntime'])=>boolean;read:()=>Promise<SplitResult>}|undefined>{
 const {authority,session,message,provider,rawMessage,signal,measure,decisionRuntime}=input
 const {execution,accumulator}=authority
 const sessionId=session.id,messageId=message.id,sequence=message.sequenceNum,capture=input.capture
 const captured=capture?classificationCaptures.get(capture):undefined
 const assertBinding=()=>{
  if(input.authority!==authority||input.session!==session||input.message!==message||input.capture!==capture
   ||input.provider!==provider||input.rawMessage!==rawMessage||input.decisionRuntime!==decisionRuntime
   ||session.id!==sessionId||message.id!==messageId||message.sequenceNum!==sequence||message.sessionId!==sessionId||message.role!=='user'
   ||authority.execution!==execution||authority.accumulator!==accumulator
   ||captured&&(captured.rootAuthority.execution!==captured.rootExecution||captured.rootAuthority.accumulator!==captured.rootAccumulator))throw new DerivedScopeError('scope_source_changed')
 }
 assertBinding()
 if(message.sessionId!==sessionId||message.role!=='user')throw new DerivedScopeError('scope_evidence_missing')
 const query=await classificationQuery(input,0)
 assertBinding()
 const current=query.history.find(row=>row.id===messageId)
 if(!current)throw new DerivedScopeError('scope_source_changed')
 const content=current.content
 // Never substitute a truncated/formatted/history-derived body for the exact
 // late splitter input. Mixed blocks and transformed attachments stay late.
 const body=typeof content==='string'?content:Array.isArray(content)&&content.every(block=>
  typeof block==='object'&&block!==null&&block.type==='text'&&typeof block.text==='string')
   ?content.map(block=>(block as {text:string}).text).join(' '):undefined
 if(body!==rawMessage)return undefined
 const context={...executionToolContext(execution,{appId:'native-session-split'}),scopeAccumulator:accumulator}
 const check=async()=>{
  try{
   assertBinding()
   await (measure?measure('split_authority',()=>assertSourceModelInputAuthority(context)):assertSourceModelInputAuthority(context))
   assertBinding()
  }catch(error){throw Object.assign(error instanceof Error?error:new Error('The assessment context is unavailable.'),{reason:'authority_changed',retrySafe:false})}
 }
 const options=bindScopeSources({provider,message:rawMessage,authority,signal,deadlineAt:Date.now()+8_000,
  decisionRuntime,workspaceId:execution.security.access.workspaceId,runId:'research-split-'+messageId,
  assertInputAuthority:check},structuredClone(boundScopeSources(query)))
 // Keep the historical standalone LLM model; the selected runtime may resolve
 // a native no-split decision, but task generation still uses that LLM route.
 const result=await classifySplit(options)
 const snapshot=structuredClone(result)
 if(snapshot.tasks)Object.freeze(snapshot.tasks)
 if(snapshot.usage)Object.freeze(snapshot.usage)
 Object.freeze(snapshot)
 let consumed=false
 return Object.freeze({usage:snapshot.usage,model:snapshot.model,matches:(message:string,candidate:ResearchClassifyOptions['provider'],runtime?:SplitOptions['decisionRuntime'])=>message===rawMessage&&candidate===provider&&runtime===decisionRuntime,read:async()=>{
  if(consumed)throw Object.assign(new DerivedScopeError('scope_source_changed'),{reason:'authority_changed',retrySafe:false})
  // Claim before awaiting: concurrent reads and retries after a refusal must not
  // turn this data-only preparation into a reusable permission receipt.
  consumed=true
  signal.throwIfAborted()
  await check()
  signal.throwIfAborted()
  return bindScopeSources(structuredClone(snapshot),structuredClone(boundScopeSources(query)))
 }})
}

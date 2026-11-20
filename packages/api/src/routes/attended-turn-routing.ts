/**
 * Turn-routing adapter switch (M3, deletion rows D11-12 / D11-13 / D5-S4).
 *
 * Web chat and the channel pipeline route every turn through this one adapter
 * after capability preparation: it builds the captured routing input, the
 * research / topic / split classifier ports, one input-authority check per lane
 * and the usage recorder, then calls the kernel preparation port
 * `routePreparedTurn` (core `routeTurn`). It replaces the inline assessment
 * orchestration in `routes/chat.ts` (capture, three forks, settled assessments,
 * the speculative split handoff, the Pro/Max `classifySplit` call) and the
 * channel pipeline's sequential research and topic calls plus its preflight
 * splitter. Preflight and the coordinator consume `route.split` through
 * `consumeSplit`, which re-proves the split lane at that later boundary.
 *
 * Native transcript turns capture the admitted session query once and give
 * each lane its own fork of it (data, never a permission receipt); legacy
 * transcripts route over their pre-turn history; a page-bound turn reads
 * nothing. Every classifier call keeps its historical call shape.
 *
 * Spec: docs/architecture/features/research.md "Adapter switch".
 * [COMP:api/turn-kernel]
 */
import { isTrivialChatMessage } from '@use-brian/core/classification/trivial-chat.js'
import type { DecisionExecutionPort } from '@use-brian/core/decisions/hydra.js'
import type { SessionContextAuthority } from '@use-brian/core/memory/session-state-types.js'
import { bindRecordTopicAdmission, classifyTopic, type TopicClassification, type TopicClassifierOptions } from '@use-brian/core/memory/topic-classifier.js'
import {
  classifyResearchIntent,
  type ResearchClassifyOptions,
  type ResearchClassifyResult,
} from '@use-brian/core/workers/research-classifier.js'
import { classifySplit, type SplitOptions, type SplitResult } from '@use-brian/core/workers/splitter.js'
import type {
  TurnRoute,
  TurnRoutingAttribution,
  TurnRoutingCapture,
  TurnRoutingFacts,
  TurnRoutingLane,
  TurnRoutingUsageRecord,
} from '@use-brian/core/workers/turn-routing.js'
import { isInputAuthorityError } from '@use-brian/agent-runtime/providers/input-authority.js'
import type { LLMProvider } from '@use-brian/agent-runtime/providers/types.js'
import { ContextScopeAccumulator } from '@use-brian/agent-runtime/security/context-scope.js'
import { DerivedScopeError } from '@use-brian/agent-runtime/security/derived-scope.js'
import { executionToolContext } from '@use-brian/agent-runtime/security/execution-context.js'
import { bindScopeSources, boundScopeSources } from '@use-brian/agent-runtime/security/source-evidence.js'
import type { Tool } from '@use-brian/agent-runtime/tools/types.js'
import { admitModelInput } from '../context-scope/admission.js'
import { isAuthorityChangedError } from '../context-scope/authority-lease.js'
import { tryReadTurnConversationRecord } from '../context-scope/conversation-record-admission.js'
import { getPool } from '../db/client.js'
import { conversationRecordSelectedRow, type ConversationRecord } from '../db/conversation-record.js'
import { readAdmittedSessionQuery, type ConversationFrame } from '../db/conversation-store.js'
import { prepareSessionMessageAnnotation, writeSessionMessageAnnotation } from '../db/session-message-annotations.js'
import type { Session, SessionMessage } from '../db/sessions.js'
import { routePreparedTurn } from '../turn/capabilities.js'
import { resolveReplyText, type ResolveReplyParams } from './_reply-context.js'
import { prepareAdmittedSessionHistory, type PreparedAttendedSessionHistory } from './attended-session-context.js'

// The Telegram recording proof locks the route against changes. Concurrent
// classifier transactions for the same turn must take turns acquiring it.
const telegramAdmission = new WeakMap<Session, Promise<void>>()

async function admitClassifierInput(session: Session, context: Parameters<typeof admitModelInput>[0]) {
  if (session.channelType !== 'telegram') return admitModelInput(context)
  const pending = telegramAdmission.get(session) ?? Promise.resolve()
  const check = pending.then(() => admitModelInput(context))
  const settled = check.catch(() => {})
  telegramAdmission.set(session, settled)
  try { await check } finally {
    if (telegramAdmission.get(session) === settled) telegramAdmission.delete(session)
  }
}

type Measure = <T>(counter: string, run: () => Promise<T>) => Promise<T>
type Classified = Awaited<ReturnType<Awaited<ReturnType<typeof assessAttendedSessionMessage>>['defer']>>

/** A native (admitted) transcript turn: the authored row exists and is admitted. */
export type AttendedRoutingNative = {
  authority: SessionContextAuthority
  session: Session
  message: SessionMessage
  reply: Pick<ResolveReplyParams, 'channelType' | 'replyToMessageId' | 'clientSnippet'>
}

/** A legacy transcript turn: routing reads its pre-turn history and resolved reply. */
export type AttendedRoutingLegacy = {
  history: ReadonlyArray<Pick<SessionMessage, 'role' | 'content' | 'topicLabel'>>
  replyToText: string | null
  /** Text the legacy topic classifier always assessed (web: the stored user text). */
  topicText: string
  /** Web refuses a legacy research call (research requires native admission); channel classifies. */
  research: 'refuse' | 'classify'
}

export type AttendedTurnRoutingInput = {
  facts: TurnRoutingFacts
  /** The route's authored text: the string every route gate used before routing. */
  message: string
  native?: AttendedRoutingNative
  legacy?: AttendedRoutingLegacy
  /** Prepared roster (capability-filtered). Passed only with a decision runtime. */
  roster?: ReadonlyMap<string, Tool>
  provider: LLMProvider
  model: string
  decisionRuntime?: DecisionExecutionPort
  workspaceId?: string
  /** Stable id for decision run ids (the authored row id when it exists). */
  runId: string
  /**
   * Historical split call shapes. `concurrent`: the web invariant Standard split is
   * prepared on its admitted fork; the channel preflight split stays unbound.
   * `late`: the Pro/Max coordinator split passes the background model and decision
   * runtime; the Standard / channel preflight split passes provider, message and signal.
   */
  split: { concurrent: 'admitted' | 'preflight'; late: 'coordinator' | 'preflight' }
  recordUsage: (record: TurnRoutingUsageRecord) => Promise<void>
  attribution: TurnRoutingAttribution
  signal: AbortSignal
  measure?: Measure
}

export type AttendedTurnRoute = {
  route: TurnRoute
  /** Native topic result (model or trivial shortcut); absent when the topic lane skipped or the turn is legacy. */
  topic?: {
    classification: TopicClassification
    /** Fresh topic-lane proof for later topic-driven effects (plan lifecycle, episodic retrieval). */
    assertCurrent: () => Promise<void>
    /** Web: prepare the annotation for publication with the reply. */
    defer: () => Promise<Classified>
    /** Channel: write the annotation now. */
    publish: () => Promise<Classified>
  }
  /** Legacy topic classification (null when the classifier failed or did not run). */
  legacyClassification: TopicClassification | null
  /** Single use: re-prove the split lane and hand the routed tasks to preflight or the coordinator. */
  consumeSplit: () => Promise<string[] | null>
}

const NO_SPLIT: SplitResult = Object.freeze({ tasks: null, usage: null, model: null }) as SplitResult
const FALLBACK_TOPIC: TopicClassification = { topic_label: '(uncategorized)', state: 'continue', confidence: 0, usage: null }
const unavailable = () => Object.assign(new Error('The assessment context is unavailable.'), { reason: 'authority_changed' as const, retrySafe: false })

function authorityFailure(error: unknown): boolean {
  return isInputAuthorityError(error) || isAuthorityChangedError(error) || error instanceof DerivedScopeError
}

/** Projects a legacy pre-turn history into the routing capture (the old classifier inputs). */
function legacyCapture(message: string, legacy: AttendedRoutingLegacy): TurnRoutingCapture {
  const text = (content: unknown) => typeof content === 'string' ? content : Array.isArray(content)
    ? (content as Array<{ type?: string; text?: string }>).filter(block => block?.type === 'text' && typeof block.text === 'string')
      .map(block => block.text as string).join(' ') : ''
  return {
    message,
    recentConversation: legacy.history.filter(row => row.role === 'user' || row.role === 'assistant')
      .filter(row => !(row.role === 'assistant' && Array.isArray(row.content)
        && (row.content as Array<{ type?: string }>).some(block => block.type === 'tool_use')))
      .map(row => ({ role: row.role as 'user' | 'assistant', text: text(row.content).trim() }))
      .filter(turn => turn.text.length > 0).slice(-6),
    topic: {
      recentUserTurns: legacy.history.filter(row => row.role === 'user' && Array.isArray(row.content)).slice(-8)
        .map(row => ({ text: text(row.content).trim(), topicLabel: row.topicLabel ?? null })).filter(turn => turn.text.length > 0),
      ...topicEvidenceFromHistory(legacy.history),
      replyToText: legacy.replyToText,
      // The legacy classifier ran its own trivial shortcut on every input.
      allowTrivialShortcut: true,
    },
  }
}

type ClassificationInput={authority:SessionContextAuthority;session:Session;message:SessionMessage;capture?:object}
const classificationCaptures=new WeakMap<object,{authority:SessionContextAuthority;execution:SessionContextAuthority['execution'];accumulator:ContextScopeAccumulator;
 rootAuthority:SessionContextAuthority;rootExecution:SessionContextAuthority['execution'];rootAccumulator:ContextScopeAccumulator;
 sessionId:string;messageId:string;sequence:number;query:Awaited<ReturnType<typeof readAdmittedSessionQuery>>}>()

function recordClassificationFrame(authority:SessionContextAuthority,record:ConversationRecord,message:SessionMessage):ConversationFrame{
 const execution=authority.execution
 if(!conversationRecordSelectedRow(record,message.id,message.sequenceNum,'user'))throw new DerivedScopeError('scope_source_changed')
 const sources=[record.source]
 const history=copyBoundHistory(record.rows)
 if(!history.some(row=>row.id===message.id)){
  // The capture attests the input's exact identity even when its complete
  // stored body was an image or another carrier outside the dialogue recipe.
  history.push(bindScopeSources({...message,content:[]},sources))
  history.sort((left,right)=>left.sequenceNum-right.sequenceNum)
 }
 const annotations=history.flatMap(row=>row.topicLabel&&row.topicConfidence!==null
  ?[bindScopeSources({id:row.id,sequenceNum:row.sequenceNum,topicLabel:row.topicLabel,
   topicConfidence:row.topicConfidence,replyToText:row.replyToText},sources)]:[])
 const frame:ConversationFrame={
  history:bindScopeSources(copyBoundHistory(history),sources),annotations:bindScopeSources(annotations,sources),
  assemble(current,from){
   if(current.execution!==execution)throw new DerivedScopeError('scope_evidence_missing')
   current.accumulator.noteSource(record.source)
   return bindScopeSources(copyBoundHistory(history).filter(row=>from==null||row.sequenceNum>=from),sources)
  },
  privateTranscript(){return null},
  async current(current,topicThroughSequence,nextInput){
   if(!nextInput||nextInput.id!==message.id||nextInput.sequence!==message.sequenceNum)
    throw new DerivedScopeError('scope_evidence_missing')
   const latest=await tryReadTurnConversationRecord(current.execution,null,undefined,topicThroughSequence)
   if(!latest)throw new DerivedScopeError('scope_source_changed')
   return recordClassificationFrame(current,latest,message)
  },
 }
 authority.accumulator.noteSource(record.source)
 return bindScopeSources(Object.freeze(frame),sources)
}

async function acquireClassificationQuery(input:ClassificationInput,topicThroughSequence:number):Promise<ConversationFrame>{
 const {authority,session,message}=input
 const record=await tryReadTurnConversationRecord(authority.execution,null,message.sequenceNum,topicThroughSequence)
 if(record)return recordClassificationFrame(authority,record,message)
 return readAdmittedSessionQuery({sessionId:session.id,throughSequence:message.sequenceNum,topicThroughSequence,currentMessageId:message.id,authority})
}
/** Data snapshot only; every classifier still checks current bound input authority. */
export async function captureAttendedSessionClassification(input:ClassificationInput):Promise<object>{
 const {authority,session,message}=input
 const execution=authority.execution,accumulator=authority.accumulator
 if(message.sessionId!==session.id||message.role!=='user')throw new DerivedScopeError('scope_evidence_missing')
 const query=await acquireClassificationQuery(input,message.sequenceNum-1)
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
 if(!input.capture)return acquireClassificationQuery(input,topicThroughSequence)
 const captured=classificationCaptures.get(input.capture)
 if(!captured||captured.authority!==input.authority||captured.sessionId!==input.session.id||captured.messageId!==input.message.id||captured.sequence!==input.message.sequenceNum)
  throw new DerivedScopeError('scope_evidence_missing')
 if(input.authority.execution!==captured.execution||input.authority.accumulator!==captured.accumulator)throw new DerivedScopeError('scope_source_changed')
 await input.authority.execution.security.authority.assertCurrent()
 if(input.authority.execution!==captured.execution||input.authority.accumulator!==captured.accumulator)throw new DerivedScopeError('scope_source_changed')
 return captured.query
}

function copyBoundHistory(history:readonly SessionMessage[]):SessionMessage[]{
 return history.map(row=>bindScopeSources(structuredClone(row),structuredClone(boundScopeSources(row))))
}
type ClassifiedInput={classification:TopicClassification;reply:Awaited<ReturnType<typeof resolveReplyText>>;history:SessionMessage[];pendingAnnotation?:object;
 readHistory:(authority:SessionContextAuthority,fromSequence?:number|null)=>Promise<PreparedAttendedSessionHistory>}
type TopicAssessment={assertCurrent:()=>Promise<void>;publish:()=>Promise<ClassifiedInput>;defer:()=>Promise<ClassifiedInput>;
 /** The classifier's verdict as data for turn routing; `defer`/`publish` still prove authority before it is used. */
 classification:TopicClassification}
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

const rowText=(row:SessionMessage)=>typeof row.content==='string'?row.content:Array.isArray(row.content)?row.content.flatMap(block=>
 typeof block==='object'&&block!==null&&'type' in block&&block.type==='text'&&'text' in block&&typeof block.text==='string'?[block.text]:[]).join(' ').trim():''
const plainInput=(content:unknown)=>typeof content==='string'||Array.isArray(content)&&content.every(block=>
 typeof block==='object'&&block!==null&&'type' in block&&block.type==='text'&&'text' in block&&typeof block.text==='string')

function annotatedHistory(query:ConversationFrame):SessionMessage[]{
 const annotations=new Map(query.annotations.map(row=>[row.id,row]))
 const history=query.history.map(row=>{
  const annotation=annotations.get(row.id)
  return bindScopeSources({...row,topicLabel:annotation?.topicLabel??null,topicConfidence:annotation?.topicConfidence??null,replyToText:annotation?.replyToText??null},
   [...boundScopeSources(row),...(annotation?boundScopeSources(annotation):[])])
 })
 return bindScopeSources(history,boundScopeSources(query))
}

/** Turn-routing input projected from one captured admitted query (M3 adapter switch,
 * docs/architecture/features/research.md "Adapter switch"). Data only: the projection
 * reads the same rows the lane classifiers read, and every lane still proves its own
 * fork before its result is adopted. `shortcut` is the trivial-topic continuation: no
 * annotation, history continued from this query, so the main-turn read is not repeated.
 */
function attendedRoutingCapture(input:ClassificationInput&{capture:object;text:string;
 reply?:Pick<ResolveReplyParams,'replyToMessageId'|'clientSnippet'>}):{capture:TurnRoutingCapture;shortcut:(classification:TopicClassification)=>ClassifiedInput}{
 const {authority,session,message}=input
 const captured=classificationCaptures.get(input.capture)
 if(!captured||captured.authority!==authority||captured.sessionId!==session.id||captured.messageId!==message.id||captured.sequence!==message.sequenceNum
  ||authority.execution!==captured.execution||authority.accumulator!==captured.accumulator)throw new DerivedScopeError('scope_evidence_missing')
 const {query,sequence,messageId,rootExecution}=captured
 const current=query.history.find(row=>row.id===messageId)
 if(!current||current.role!=='user')throw new DerivedScopeError('scope_source_changed')
 const history=annotatedHistory(query)
 const earlier=history.filter(row=>row.sequenceNum<sequence)
 const plain=plainInput(current.content)&&plainInput(message.content)
 const allowTrivialShortcut=!input.reply?.replyToMessageId&&!input.reply?.clientSnippet&&plain&&!current.attachments?.length
 const ephemeral=allowTrivialShortcut&&isTrivialChatMessage(rowText(current))
 const capture:TurnRoutingCapture={
  message:input.text,
  recentConversation:earlier.filter(row=>row.role==='user'||row.role==='assistant')
   .filter(row=>!(row.role==='assistant'&&Array.isArray(row.content)&&row.content.some(block=>
    typeof block==='object'&&block!==null&&'type' in block&&block.type==='tool_use')))
   .map(row=>({role:row.role as 'user'|'assistant',text:rowText(row)})).filter(row=>row.text.trim().length>0).slice(-6),
  topic:{
   recentUserTurns:earlier.filter(row=>row.role==='user'&&(!ephemeral||row.topicLabel)).slice(-8)
    .map(row=>({text:rowText(row),topicLabel:row.topicLabel})).filter(turn=>turn.text.length>0),
   ...topicEvidenceFromHistory(earlier),
   // Reply-target resolution stays with the topic lane; any reply target already
   // disables the trivial shortcut above, so planning never needs its text.
   replyToText:null,
   allowTrivialShortcut,
  },
 }
 return{capture,shortcut:classification=>({
  classification:structuredClone(classification),reply:null,history:bindScopeSources(copyBoundHistory(history),boundScopeSources(query)),
  readHistory:async(currentAuthority:SessionContextAuthority,from?:number|null)=>{
   const frame=await query.current(currentAuthority,currentAuthority.execution===rootExecution?sequence-1:undefined,{id:messageId,sequence})
   return prepareAdmittedSessionHistory(currentAuthority,session.id,frame,from)
  },
 })}
}

/** The actual current authored row is selected and scoped before text is formatted. */
export async function assessAttendedSessionMessage(input:{
 authority:SessionContextAuthority;session:Session;message:SessionMessage;
 provider:TopicClassifierOptions['provider'];model:string;decisionRuntime?:TopicClassifierOptions['decisionRuntime'];
 reply?:Pick<ResolveReplyParams,'channelType'|'replyToMessageId'|'clientSnippet'>;
 capture?:object;
 measure?:Measure;
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
 const history=annotatedHistory(query)
 const reply=input.reply?await resolveReplyText({...input.reply,session,readableHistory:history}):null
 // Exact acknowledgments need no durable generated annotation. The result
 // still retains the complete admitted query and current authority checks.
 const plain=plainInput(current.content)&&plainInput(message.content)
 const allowTrivialShortcut=!input.reply?.replyToMessageId&&!input.reply?.clientSnippet&&plain&&!current.attachments?.length
 const ephemeral=!reply&&allowTrivialShortcut&&isTrivialChatMessage(rowText(current))
 // Only metadata is read for CAS. The old generated value is not an input to
 // this new classification; its immutable revision remains in native history.
 const expected=ephemeral?undefined:(await getPool().query<{id:string}>('SELECT scope_revision_id AS id FROM session_message_annotation_heads WHERE workspace_id=$1 AND session_id=$2 AND message_id=$3',
  [authority.execution.security.access.workspaceId,session.id,message.id])).rows[0]?.id
 const context={...executionToolContext(authority.execution,{appId:'native-session-topic'}),scopeAccumulator:authority.accumulator}
 let refusal:unknown
 const check=async()=>{
  if(refusal)throw refusal
  try{
   assertBinding()
   await(measure?measure('topic_authority',()=>admitClassifierInput(session, context)):admitClassifierInput(session, context))
   assertBinding()
  }catch(error){
   if(!(error instanceof DerivedScopeError)&&!isAuthorityChangedError(error))throw error
   refusal=Object.assign(error,{reason:'authority_changed',retrySafe:false});throw refusal
  }
 }
 const querySources=boundScopeSources(query)
 const options=bindScopeSources<TopicClassifierOptions>({provider:input.provider,model:input.model,decisionRuntime:input.decisionRuntime,
  allowTrivialShortcut,currentMessage:rowText(current),recentUserTurns:history.filter(row=>row.sequenceNum<message.sequenceNum&&row.role==='user'&&(!ephemeral||row.topicLabel)).slice(-8)
   .map(row=>({text:rowText(row),topicLabel:row.topicLabel})).filter(turn=>turn.text.length>0),
  ...topicEvidenceFromHistory(history.filter(row=>row.sequenceNum<message.sequenceNum)),replyToText:reply?.text??null,
  authority,assertInputAuthority:check,workspaceId:authority.execution.security.access.workspaceId,
  runId:'memory-topic-'+message.id},querySources)
 if(querySources.length && querySources.every(source=>source.resourceKind==='conversation_record')) bindRecordTopicAdmission(options)
 const classification=await classifyTopic(options)
 const defer=async()=>{
  await check()
  const selectedClassification=bindScopeSources(structuredClone(classification),structuredClone(boundScopeSources(classification)))
  const selectedHistory=bindScopeSources(copyBoundHistory(history),boundScopeSources(query))
  const selectedReply=reply?bindScopeSources(structuredClone(reply),boundScopeSources(reply)):null
  const pendingAnnotation=ephemeral?undefined:await prepareSessionMessageAnnotation({sessionId:session.id,messageId:message.id,
   classification:selectedClassification,replyToText:selectedReply?.text??null,authority,expectedRevision:expected})
  assertBinding()
  return{classification:selectedClassification,reply:selectedReply,history:selectedHistory,pendingAnnotation,
   readHistory:async(current:SessionContextAuthority,from?:number|null)=>{
    const frame=await query.current(current,current.execution===execution?sequence-1:undefined,{id:messageId,sequence})
    return prepareAdmittedSessionHistory(current,session.id,frame,from)
   }}
 }
 const assessment:TopicAssessment={assertCurrent:check,defer,classification,publish:async()=>{
 if(ephemeral)await check()
 const annotation=ephemeral?null:await writeSessionMessageAnnotation({sessionId:session.id,messageId:message.id,classification,replyToText:reply?.text??null,authority,expectedRevision:expected})
 if(!ephemeral&&!annotation)throw new DerivedScopeError('scope_source_changed')
 await authority.execution.security.authority.assertCurrent()
 return{classification,reply,history,readHistory:async(current,from)=>{
  const frame=await query.current(current,undefined,{id:messageId,sequence,annotationRevisionId:annotation?.revisionId})
  return prepareAdmittedSessionHistory(current,session.id,frame,from)
 }}
 }}
 return Object.freeze(assessment)
}

/** Assess only an authored current row and the complete admitted original body cohort. */
export async function classifyAttendedResearchMessage(input:{
 authority:SessionContextAuthority;session:Session;message:SessionMessage;
 provider:ResearchClassifyOptions['provider'];model:string;decisionRuntime?:ResearchClassifyOptions['decisionRuntime'];
 toolCandidates?:ResearchClassifyOptions['toolCandidates'];
 capture?:object;
 measure?:Measure;
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
  assertInputAuthority:()=>input.measure?input.measure('research_authority',()=>admitClassifierInput(session, context)):admitClassifierInput(session, context),workspaceId:authority.execution.security.access.workspaceId,
  runId:'research-intent-'+message.id},boundScopeSources(query))
 return classifyResearchIntent(options)
}

/** Data-only preparation for the invariant Standard splitter route. Classification
 * may overlap sibling assessments; task generation is consumed only at the old
 * preflight boundary after a NEW input proof. This object is never an allow receipt.
 */
export async function prepareAttendedSplitMessage(input:ClassificationInput&{
 provider:ResearchClassifyOptions['provider'];rawMessage:string;signal:AbortSignal;measure?:Measure;decisionRuntime?:SplitOptions['decisionRuntime'];
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
   await (measure?measure('split_authority',()=>admitClassifierInput(session, context)):admitClassifierInput(session, context))
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

/** Route one turn through the kernel preparation port. */
export async function routeAttendedTurn(input: AttendedTurnRoutingInput): Promise<AttendedTurnRoute> {
  const { native, legacy, provider, model, decisionRuntime, signal } = input
  const measure: Measure = input.measure ?? ((_counter, run) => run())
  const nativeCapture = native ? await measure('classification_capture', () => captureAttendedSessionClassification({
    authority: native.authority, session: native.session, message: native.message,
  })) : undefined
  const projection = native && nativeCapture
    ? attendedRoutingCapture({ authority: native.authority, session: native.session, message: native.message, capture: nativeCapture,
      text: input.message, reply: native.reply }) : undefined
  const capture: TurnRoutingCapture = projection?.capture ?? (legacy ? legacyCapture(input.message, legacy) : {
    // Page-bound turns route without history: research and topic are skipped.
    message: input.message, recentConversation: [],
    topic: { recentUserTurns: [], knownTopicsThisSession: [], replyToText: null, allowTrivialShortcut: true },
  })
  const fork = () => native && nativeCapture
    ? forkAttendedSessionClassification({ authority: native.authority, session: native.session, message: native.message, capture: nativeCapture })
    : undefined
  const forks = { research: fork(), topic: fork(), split: fork() }
  const context = (lane: TurnRoutingLane) => {
    const branch = forks[lane]!
    return { ...executionToolContext(branch.authority.execution, { appId: `native-session-${lane}` }), scopeAccumulator: branch.authority.accumulator }
  }
  // A port that returns has already proved its fork after the model output (the
  // classifier's own final admission). The route's lane check right after it is
  // that same boundary, so it consumes the proof once; a shortcut or a later
  // consumer admits freshly.
  const proved = new Set<TurnRoutingLane>()
  const proveLane = (lane: TurnRoutingLane) => async () => {
    if (!forks[lane]) return
    if (proved.delete(lane)) return
    await admitClassifierInput(native!.session, context(lane))
  }

  let assessment: Awaited<ReturnType<typeof assessAttendedSessionMessage>> | undefined
  let legacyTopicFailed = false
  const guardSplit = async (run: () => Promise<SplitResult>, laneSignal: AbortSignal): Promise<SplitResult> => {
    try { return await run() } catch (error) {
      // A verdict-cancelled or stopped split rejects with the signal's own reason.
      if (laneSignal.aborted) throw laneSignal.reason
      if (authorityFailure(error)) throw error
      console.error('[turn-routing] split classifier failed, continuing without:', error)
      return NO_SPLIT
    }
  }
  const unboundSplit = (phase: 'concurrent' | 'late', laneSignal: AbortSignal) =>
    phase === 'late' && input.split.late === 'coordinator'
      ? classifySplit({ provider, message: input.message, model, decisionRuntime, workspaceId: input.workspaceId,
        runId: `research-split-${input.runId}`, signal: laneSignal })
      : classifySplit({ provider, message: input.message, signal: laneSignal })

  let routeError: unknown
  try {
    const route = await routePreparedTurn({
      facts: input.facts,
      capture,
      ...(input.roster ? { roster: input.roster } : {}),
      attribution: input.attribution,
      signal,
      recordUsage: input.recordUsage,
      authority: {
        research: proveLane('research'),
        topic: async () => {
          if (proved.delete('topic')) return
          if (assessment) return assessment.assertCurrent()
          return proveLane('topic')()
        },
        split: proveLane('split'),
      },
      ports: {
        research: request => measure('research_classify', async (): Promise<ResearchClassifyResult> => {
          if (native && forks.research) {
            const result = await classifyAttendedResearchMessage({
              authority: forks.research.authority, session: native.session, message: native.message,
              provider, model, decisionRuntime, capture: forks.research.capture, measure,
              ...(request.toolCandidates ? { toolCandidates: request.toolCandidates.map(ref => ({ name: ref.name, description: ref.description })) } : {}),
            })
            proved.add('research')
            return result
          }
          if (!legacy || legacy.research === 'refuse') throw unavailable()
          try {
            return await classifyResearchIntent({ provider, message: request.input.message, model,
              recentConversation: request.input.recentConversation.map(turn => ({ ...turn })), decisionRuntime, workspaceId: input.workspaceId })
          } catch (error) {
            if (isInputAuthorityError(error)) throw error
            console.warn('[turn-routing] adaptive-research classifier failed:', error)
            return { research: false, operateSite: false, reason: null, usage: null, model: null }
          }
        }),
        topic: request => measure('topic_classify', async (): Promise<TopicClassification> => {
          if (native && forks.topic) {
            assessment = await assessAttendedSessionMessage({
              authority: forks.topic.authority, session: native.session, message: native.message,
              provider, model, decisionRuntime, capture: forks.topic.capture, measure, reply: native.reply,
            })
            proved.add('topic')
            return assessment.classification
          }
          try {
            const topic = request.input.topic
            return await classifyTopic({ provider, model, signal: request.signal,
              recentUserTurns: topic.recentUserTurns.map(turn => ({ ...turn })), replyToText: topic.replyToText,
              currentMessage: legacy?.topicText ?? request.input.message,
              knownTopicsThisSession: [...topic.knownTopicsThisSession],
              ...(topic.topicAnchors ? { topicAnchors: structuredClone(topic.topicAnchors) } : {}),
              decisionRuntime, workspaceId: input.workspaceId, runId: `memory-topic-${input.runId}` })
          } catch (error) {
            if (isInputAuthorityError(error)) throw error
            console.error('[turn-routing] topic classifier failed:', error)
            legacyTopicFailed = true
            return FALLBACK_TOPIC
          }
        }),
        split: request => measure('split_classify', () => guardSplit(async () => {
          if (request.phase === 'concurrent' && input.split.concurrent === 'admitted' && native && forks.split) {
            const prepared = await prepareAttendedSplitMessage({
              authority: forks.split.authority, session: native.session, message: native.message, capture: forks.split.capture,
              provider, rawMessage: input.message, decisionRuntime, signal: request.signal, measure,
            })
            // A body that is not the exact authored text takes the unbound splitter,
            // as the late preflight did.
            if (!prepared) return unboundSplit('concurrent', request.signal)
            const result = await prepared.read()
            proved.add('split')
            return result
          }
          return unboundSplit(request.phase, request.signal)
        }, request.signal)),
      },
    })
    const topic = assessment
      ? { classification: assessment.classification, assertCurrent: assessment.assertCurrent, defer: assessment.defer, publish: assessment.publish }
      : projection && route.topic.ephemeral && route.topic.classification ? (() => {
        const classification = route.topic.classification!
        const continued = () => Promise.resolve().then(async () => { await proveLane('topic')(); return projection.shortcut(classification) })
        return { classification, assertCurrent: () => proveLane('topic')(), defer: continued, publish: continued }
      })() : undefined
    let consumed = false
    return {
      route,
      ...(topic ? { topic } : {}),
      legacyClassification: !native && legacy && !legacyTopicFailed ? route.topic.classification : null,
      consumeSplit: async () => {
        if (consumed) throw Object.assign(new DerivedScopeError('scope_source_changed'), { reason: 'authority_changed', retrySafe: false })
        consumed = true
        if (!route.split) return null
        signal.throwIfAborted()
        await proveLane('split')()
        signal.throwIfAborted()
        return [...route.split.tasks]
      },
    }
  } catch (error) {
    routeError = error
    throw error
  } finally {
    // Every fork's evidence returns to the turn, on success and on refusal alike.
    for (const branch of Object.values(forks)) {
      try { branch?.mergeEvidence() } catch (error) { if (!routeError) throw error }
    }
  }
}

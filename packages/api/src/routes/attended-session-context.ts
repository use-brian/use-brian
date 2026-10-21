/** Current native attended history and annotations. [COMP:api/application-persistence] */
import {bindScopeSources,boundScopeSources,classifyTopic,DerivedScopeError,executionToolContext,
 type TopicClassifierOptions,type SessionContextAuthority,type TopicClassification} from '@use-brian/core'
import {getPool} from '../db/client.js'
import {readAdmittedSessionQuery} from '../db/session-query-reader.js'
import {writeSessionMessageAnnotation} from '../db/session-message-annotations.js'
import type {Session,SessionMessage} from '../db/sessions.js'
import {assertSourceModelInputAuthority} from '../application-platform/model-source-authority.js'
import {resolveReplyText,type ResolveReplyParams} from '../routes/_reply-context.js'

/** The actual current authored row is selected and scoped before text is formatted. */
export async function classifyAttendedSessionMessage(input:{
 authority:SessionContextAuthority;session:Session;message:SessionMessage;
 provider:TopicClassifierOptions['provider'];model:string;decisionRuntime?:TopicClassifierOptions['decisionRuntime'];
 reply?:Pick<ResolveReplyParams,'channelType'|'replyToMessageId'|'clientSnippet'>;
}):Promise<{classification:TopicClassification;reply:Awaited<ReturnType<typeof resolveReplyText>>;history:SessionMessage[]}>{
 const {authority,session,message}=input
 if(message.sessionId!==session.id||message.role!=='user')throw new DerivedScopeError('scope_evidence_missing')
 const query=await readAdmittedSessionQuery({sessionId:session.id,throughSequence:message.sequenceNum,topicThroughSequence:message.sequenceNum-1,authority})
 const current=query.history.find(row=>row.id===message.id)
 if(!current)throw new DerivedScopeError('scope_source_changed')
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
 // Only metadata is read for CAS. The old generated value is not an input to
 // this new classification; its immutable revision remains in native history.
 const expected=(await getPool().query<{id:string}>('SELECT scope_revision_id AS id FROM session_message_annotation_heads WHERE workspace_id=$1 AND session_id=$2 AND message_id=$3',
  [authority.execution.security.access.workspaceId,session.id,message.id])).rows[0]?.id
 const context={...executionToolContext(authority.execution,{appId:'native-session-topic'}),scopeAccumulator:authority.accumulator}
 const options=bindScopeSources<TopicClassifierOptions>({provider:input.provider,model:input.model,decisionRuntime:input.decisionRuntime,
  currentMessage:text(current),recentUserTurns:history.filter(row=>row.sequenceNum<message.sequenceNum&&row.role==='user').slice(-8)
   .map(row=>({text:text(row),topicLabel:row.topicLabel})).filter(turn=>turn.text.length>0),
  knownTopicsThisSession:[...new Set(query.annotations.map(row=>row.topicLabel))].slice(-20),replyToText:reply?.text??null,
  authority,assertInputAuthority:()=>assertSourceModelInputAuthority(context),workspaceId:authority.execution.security.access.workspaceId,
  runId:'memory-topic-'+message.id},boundScopeSources(query))
 const classification=await classifyTopic(options)
 const annotation=await writeSessionMessageAnnotation({sessionId:session.id,messageId:message.id,classification,replyToText:reply?.text??null,authority,expectedRevision:expected})
 if(!annotation)throw new DerivedScopeError('scope_source_changed')
 await authority.execution.security.authority.assertCurrent()
 return{classification,reply,history}
}

/** Capture before filtering/formatting, retaining complete query obligations even for an empty window. */
export async function readAttendedSessionHistory(authority:SessionContextAuthority,sessionId:string,fromSequence?:number|null):Promise<SessionMessage[]> {
 const high=(await getPool().query<{sequence:number}>(
  'SELECT coalesce(max(sequence_num),0)::int AS sequence FROM session_messages WHERE workspace_id=$1 AND session_id=$2',
  [authority.execution.security.access.workspaceId,sessionId])).rows[0].sequence
 const query=await readAdmittedSessionQuery({sessionId,throughSequence:high,authority})
 const annotations=new Map(query.annotations.map(row=>[row.id,row]))
 const history=query.history.filter(row=>fromSequence==null||row.sequenceNum>=fromSequence).map(row=>{
  const annotation=annotations.get(row.id)
  return bindScopeSources({...row,topicLabel:annotation?.topicLabel??null,topicConfidence:annotation?.topicConfidence??null,replyToText:annotation?.replyToText??null},
   [...boundScopeSources(row),...(annotation?boundScopeSources(annotation):[])])
 })
 return bindScopeSources(history,boundScopeSources(query))
}

import {readPrivateTranscript} from './private-transcript.js'
/** Current native session query captures. [COMP:api/application-persistence] */
import {z} from 'zod'
import type {PoolClient} from 'pg'
import {bindScopeSources,boundScopeSources,ContextScopeAccumulator,DerivedScopeError,type ScopeSource,type SessionContextAuthority} from '@use-brian/core'
import {applicationJsonSchema} from '@use-brian/shared'
import {getPool} from './client.js'
import {readSessionMessageScopeSource,type SessionMessage} from './sessions.js'
import {readJointSessionQueryFrame,readRetainedContextFrame} from './session-context-revisions.js'
import {nativeSessionAnnotationSchema as annotation} from '../application-platform/native-session-query-evidence.js'

const source=z.object({workspaceId:z.string().uuid(),userId:z.string().uuid().nullable(),assistantId:z.string().uuid().nullable(),
 resourceKind:z.enum(['application_field','external_source']),resourceId:z.string().uuid(),version:z.string().min(1),
 sensitivity:z.enum(['public','internal','confidential']),compartments:z.array(z.string()),projectIds:z.array(z.string().uuid())}).strict()
const capture=z.object({row:z.record(applicationJsonSchema).nullable(),sources:z.array(source).min(1)}).strict()
export type SessionQueryAnnotation=z.infer<typeof annotation>
function changed():never{throw new DerivedScopeError('scope_source_changed')}
async function readCapture(client:Pick<PoolClient,'query'>,workspaceId:string,sessionId:string,through:number,kind:'history'|'topics'){
 const sql=kind==='history'?'SELECT value FROM read_native_application_session_history($1,$2,$3)':'SELECT value FROM read_native_application_session_topics($1,$2,$3)'
 const rows=(await client.query<{value:unknown}>(sql,[workspaceId,sessionId,through])).rows.map(row=>capture.parse(row.value))
 if(!rows.length||rows[0].row!==null||rows.slice(1).some(row=>row.row===null)
  ||rows.some(row=>row.sources[0].resourceKind!=='application_field'||row.sources.some(s=>s.workspaceId!==workspaceId)))changed()
 return rows
}
/** Internal capture inside a canonical session-query frame; returned values retain every query obligation. */
export async function captureSessionTopics(client:Pick<PoolClient,'query'>,workspaceId:string,sessionId:string,through:number):Promise<SessionQueryAnnotation[]>{
 const rows=await readCapture(client,workspaceId,sessionId,through,'topics')
 return bindScopeSources(rows.slice(1).map(row=>bindScopeSources(annotation.parse(row.row),row.sources)),rows.flatMap(row=>row.sources))
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
/** The selector is server query metadata, never source authority or a client allow token. */
export async function readAdmittedSessionQuery(input:{sessionId:string;throughSequence:number;topicThroughSequence?:number;currentMessageId?:string;currentMessageSequence?:number;authority:SessionContextAuthority}):Promise<{
 history:SessionMessage[];annotations:SessionQueryAnnotation[]}> {
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
    if(!row)changed()
    return bindScopeSources(row,[currentSource])
   })
   const index=history.findIndex(row=>row.id===current.id)
   if(index<0)history.push(current);else history[index]=current
   sources.push(currentSource)
  }
  history.sort((a,b)=>a.sequenceNum-b.sequenceNum)
  bindScopeSources(history,sources)
  const result=bindScopeSources({history,annotations:[] as SessionQueryAnnotation[]},sources)
  authority.accumulator.note({sources})
  return result
 }
 // Discover immutable identities only. Neither owner discovery nor metadata is
 // an authorization decision; the non-owner projection admits every candidate.
 const roots=await sessionQueryRootMetadata(workspaceId,sessionId,throughSequence,topicThrough)
 const captured=await readJointSessionQueryFrame(authority,roots,{sessionId,throughSequence,topicThroughSequence:topicThrough})
 const history=captured.history.slice(1).map(row=>{
  const value=row.row!
  return bindScopeSources<SessionMessage>({...value,sessionId,createdAt:new Date(value.createdAt),replyToText:null,topicLabel:null,topicConfidence:null},row.sources)
 })
 bindScopeSources(history,captured.history.flatMap(row=>row.sources))
 const annotations=bindScopeSources(captured.annotations.slice(1).map(row=>bindScopeSources(row.row!,row.sources)),captured.annotations.flatMap(row=>row.sources))
 const result=bindScopeSources({history,annotations},[...boundScopeSources(history),...boundScopeSources(annotations)])
 authority.accumulator.note({sources:boundScopeSources(result)})
 return result
}

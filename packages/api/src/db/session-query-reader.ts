/** Current native session query captures. [COMP:api/application-persistence] */
import {z} from 'zod'
import {bindScopeSources,boundScopeSources,ContextScopeAccumulator,DerivedScopeError,type ScopeSource,type SessionContextAuthority} from '@use-brian/core'
import {applicationJsonSchema} from '@use-brian/shared'
import {getPool} from './client.js'
import type {SessionMessage} from './sessions.js'
import {readSessionQueryFrame} from './session-context-revisions.js'

const source=z.object({workspaceId:z.string().uuid(),userId:z.string().uuid().nullable(),assistantId:z.string().uuid().nullable(),
 resourceKind:z.enum(['application_field','external_source']),resourceId:z.string().uuid(),version:z.string().min(1),
 sensitivity:z.enum(['public','internal','confidential']),compartments:z.array(z.string()),projectIds:z.array(z.string().uuid())}).strict()
const capture=z.object({row:z.record(applicationJsonSchema).nullable(),sources:z.array(source).min(1)}).strict()
const attachment=z.object({fileId:z.string().uuid(),workspaceId:z.string().uuid(),path:z.string(),name:z.string(),mime:z.string(),
 sizeBytes:z.number().int().nonnegative(),caption:z.string().optional()}).strict()
const body=z.object({id:z.string().uuid(),role:z.string(),content:applicationJsonSchema,sequenceNum:z.number().int().positive(),
 createdAt:z.string().datetime({offset:true}),senderUserId:z.string().uuid().nullable(),senderAssistantId:z.string().uuid().nullable(),
 channelMessageId:z.string().nullable(),attachments:z.array(attachment)}).strict()
const annotation=z.object({id:z.string().uuid(),sequenceNum:z.number().int().positive(),topicLabel:z.string().min(1).max(200),
 topicConfidence:z.number().finite().min(0).max(1),replyToText:z.string().max(8000).nullable()}).strict()
export type SessionQueryAnnotation=z.infer<typeof annotation>
function changed():never{throw new DerivedScopeError('scope_source_changed')}
/** The selector is server query metadata, never source authority or a client allow token. */
export async function readAdmittedSessionQuery(input:{sessionId:string;throughSequence:number;topicThroughSequence?:number;authority:SessionContextAuthority}):Promise<{
 history:SessionMessage[];annotations:SessionQueryAnnotation[]}> {
 const {authority,sessionId,throughSequence}=input,{execution}=authority
 const topicThrough=input.topicThroughSequence??throughSequence,workspaceId=execution.security.access.workspaceId
 if(!(authority.accumulator instanceof ContextScopeAccumulator)||execution.lifecycle.sessionId!==sessionId||execution.lifecycle.sessionPersisted===false
  ||![throughSequence,topicThrough].every(value=>Number.isSafeInteger(value)&&value>=0&&value<=2147483647))changed()
 await execution.security.authority.assertCurrent()
 // Discover immutable identities only. Neither owner discovery nor metadata is
 // an authorization decision; the non-owner projection admits every candidate.
 const roots=(await getPool().query<{source:ScopeSource|null}>(`SELECT read_scope_source(m.workspace_id,'session_message',m.id) AS source
  FROM session_messages m WHERE m.workspace_id=$1 AND m.session_id=$2 AND m.sequence_num<=$3
  UNION ALL SELECT read_scope_source(h.workspace_id,'session_context_revision',h.scope_revision_id) AS source
  FROM session_message_annotation_heads h JOIN session_messages m ON m.workspace_id=h.workspace_id AND m.id=h.message_id AND m.session_id=h.session_id
  WHERE h.workspace_id=$1 AND h.session_id=$2 AND m.sequence_num<=$4`,[workspaceId,sessionId,throughSequence,topicThrough])).rows
  .flatMap(row=>row.source?[row.source]:[])
 const result=await readSessionQueryFrame(authority,roots,async client=>{
  async function select(kind:'history'|'topics',through:number){
   const sql=kind==='history'?'SELECT value FROM read_native_application_session_history($1,$2,$3)':'SELECT value FROM read_native_application_session_topics($1,$2,$3)'
   const rows=(await client.query<{value:unknown}>(sql,[workspaceId,sessionId,through])).rows.map(row=>capture.parse(row.value))
   if(!rows.length||rows[0].row!==null||rows.slice(1).some(row=>row.row===null)
    ||rows.some(row=>row.sources[0].resourceKind!=='application_field'||row.sources.some(s=>s.workspaceId!==workspaceId)))changed()
   return rows
  }
  const historyCapture=await select('history',throughSequence),topicCapture=await select('topics',topicThrough)
  const history=historyCapture.slice(1).map(row=>{
   const value=body.parse(row.row)
   return bindScopeSources<SessionMessage>({...value,sessionId,createdAt:new Date(value.createdAt),replyToText:null,topicLabel:null,topicConfidence:null},row.sources)
  })
  const annotations=topicCapture.slice(1).map(row=>bindScopeSources(annotation.parse(row.row),row.sources))
  bindScopeSources(history,historyCapture.flatMap(row=>row.sources));bindScopeSources(annotations,topicCapture.flatMap(row=>row.sources))
  const value=bindScopeSources({history,annotations},[...boundScopeSources(history),...boundScopeSources(annotations)])
  return {value,sources:boundScopeSources(value)}
 })
 authority.accumulator.note({sources:boundScopeSources(result)})
 return result
}

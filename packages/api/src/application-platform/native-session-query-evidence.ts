/** Identity-only joint native query acquisition. [COMP:api/application-persistence] */
import {z} from 'zod'
import type {PoolClient} from 'pg'
import {ContextScopeAccumulator,DerivedScopeError,resourceScopeKey,type ScopeSource} from '@use-brian/core'
import {applicationJsonSchema} from '@use-brian/shared'
import type {readNativeSessionEvidence} from './native-session-evidence.js'

export type NativeSessionQuerySelection=Readonly<{sessionId:string;throughSequence:number;topicThroughSequence:number}>
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
export const nativeSessionAnnotationSchema=z.object({id:z.string().uuid(),sequenceNum:z.number().int().positive(),topicLabel:z.string().min(1).max(200),
 topicConfidence:z.number().finite().min(0).max(1),replyToText:z.string().max(8000).nullable()}).strict()
// Strict DTO parsing stays inside the acquisition transaction, including the
// ordinary fallback, so malformed payloads cannot commit observations.
const captures=z.object({history:z.array(capture.extend({row:body.nullable()})).min(1),
 annotations:z.array(capture.extend({row:nativeSessionAnnotationSchema.nullable()})).min(1)}).strict()
const packet=captures.extend({proof:z.object({admitted:z.literal(true),immutable:z.array(source),current:z.array(source)}).strict()})
export type NativeSessionQueryCaptures=z.infer<typeof captures>
type CompleteNativeEvidence=Extract<Awaited<ReturnType<typeof readNativeSessionEvidence>>,{kind:'complete'}>

export function nativeSessionQueryCaptureSources(value:NativeSessionQueryCaptures,workspaceId:string):ScopeSource[]{
 for(const rows of [value.history,value.annotations]){
  if(rows[0].row!==null||rows.slice(1).some(row=>row.row===null)
   ||rows.some(row=>row.sources[0].resourceKind!=='application_field'||row.sources.some(source=>source.workspaceId!==workspaceId)))throw new DerivedScopeError('scope_source_changed')
 }
 return new ContextScopeAccumulator({sources:[...value.history,...value.annotations].flatMap(row=>row.sources)}).evidence.sources??[]
}

/** The ordinary two readers remain the complete fallback. */
export async function readOriginalNativeSessionQueryCaptures(client:Pick<PoolClient,'query'>,workspaceId:string,
 selection:NativeSessionQuerySelection):Promise<NativeSessionQueryCaptures>{
 const history=(await client.query<{value:unknown}>('SELECT value FROM read_native_application_session_history($1,$2,$3)',
  [workspaceId,selection.sessionId,selection.throughSequence])).rows.map(row=>row.value)
 const annotations=(await client.query<{value:unknown}>('SELECT value FROM read_native_application_session_topics($1,$2,$3)',
  [workspaceId,selection.sessionId,selection.topicThroughSequence])).rows.map(row=>row.value)
 return captures.parse({history,annotations})
}

/** The database creates the proof here; no caller can supply a proof carrier. */
export async function readNativeSessionQueryEvidence(client:Pick<PoolClient,'query'>,workspaceId:string,
 selection:NativeSessionQuerySelection):Promise<{captures:NativeSessionQueryCaptures;sources:ScopeSource[];native:CompleteNativeEvidence}|null>{
 const args=[workspaceId,selection.sessionId,selection.throughSequence,selection.topicThroughSequence]
 // Presence is deployment capability metadata, never admission. The private
 // operation repeats its code, actor and source checks on every invocation.
 const installed=(await client.query<{available:boolean}>(
  "SELECT to_regprocedure('public.read_native_turn_session_query(uuid,uuid,integer,integer)') IS NOT NULL AS available")).rows[0]?.available===true
 let raw:unknown=installed?(await client.query<{value:unknown}>('SELECT read_native_turn_session_query($1,$2,$3,$4) AS value',args)).rows[0]?.value:null
 // NULL is possible only before observation writes. A post-write exception or
 // malformed packet must abort the enclosing frame, never retry the old reader.
 if(raw===null)raw=(await client.query<{value:unknown}>('SELECT read_native_session_query_evidence($1,$2,$3,$4) AS value',args)).rows[0]?.value
 if(raw===null)return null
 const parsed=packet.parse(raw),value={history:parsed.history,annotations:parsed.annotations}
 const roots=nativeSessionQueryCaptureSources(value,workspaceId)
 if([...parsed.proof.immutable,...parsed.proof.current].some(value=>value.workspaceId!==workspaceId)
  ||roots.some(root=>!parsed.proof.immutable.some(value=>value.resourceKind===root.resourceKind&&value.resourceId===root.resourceId
   &&value.version===root.version&&resourceScopeKey(value)===resourceScopeKey(root))))throw new Error('Native query evidence unavailable')
 return{captures:value,sources:roots,native:{kind:'complete',
  evidence:new ContextScopeAccumulator({sources:[...roots,...parsed.proof.immutable]}).evidence,current:parsed.proof.current}}
}

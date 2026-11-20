/** Committed buffered web outcomes, never content or delivery grants. [COMP:api/native-turn-frame] */
import {randomUUID} from 'node:crypto'
import {z} from 'zod'
import type {SessionContextAuthority} from '@use-brian/core/memory/session-state-types.js'
import {DerivedScopeError} from '@use-brian/agent-runtime/security/derived-scope.js'
import type {ExecutionContext} from '@use-brian/agent-runtime/security/execution-context.js'
import type {ClientBase} from 'pg'
import {getPool} from './client.js'
import {readRetainedContextFrame} from './session-context-revisions.js'

export type BufferedWebPublication=Readonly<{operationId:string;inputMessageId:string;actorUserId:string;assistantId:string;turnToken:string;slot:'buffered_transcript'}>
const roots=new WeakMap<BufferedWebPublication,ExecutionContext>()
function changed():never{throw new DerivedScopeError('scope_source_changed')}
/** Chosen after authored input, before classifier/main-loop effects. It grants nothing. */
export function createBufferedWebPublication(authority:SessionContextAuthority,inputMessageId:string,turnToken:string):BufferedWebPublication{
 const {execution}=authority
 if(execution.identity.kind!=='attended'||execution.identity.principal.kind!=='workspace_member'
  ||execution.identity.principal.authenticationKind!=='native_session'
  ||execution.identity.principal.userId!==execution.security.access.userId
  ||execution.ownership.kind!=='workspace'||execution.ownership.workspaceId!==execution.security.access.workspaceId
  ||execution.assistant.id!==execution.security.access.assistantId
  ||execution.lifecycle.channelType!=='web'||!execution.security.access.sharedAudience
  ||execution.lifecycle.sessionPersisted===false||execution.surface.readOnly)changed()
 const root=Object.freeze({operationId:randomUUID(),inputMessageId:z.string().uuid().parse(inputMessageId),
  actorUserId:execution.security.access.userId,assistantId:execution.assistant.id,
  turnToken:z.string().uuid().parse(turnToken),slot:'buffered_transcript' as const})
 roots.set(root,execution)
 return root
}
/** Only the original host invocation can submit this logical operation. */
export function bufferedWebPublicationDescriptor(root:BufferedWebPublication,authority:SessionContextAuthority,
 publication:{turnToken?:string;stoppedTurnToken?:string}|undefined){
 if(roots.get(root)!==authority.execution||root.turnToken!==(publication?.turnToken??publication?.stoppedTurnToken)
  ||publication?.turnToken&&publication?.stoppedTurnToken)changed()
 return{version:1 as const,...root,stopped:!!publication?.stoppedTurnToken}
}

const uuid=z.string().uuid(),digest=z.string().regex(/^[a-f0-9]{64}$/)
const cursor=z.object({createdAt:z.string().datetime({offset:true}),operationId:uuid}).strict()
const reference=z.discriminatedUnion('kind',[
 z.object({kind:z.literal('session_message'),id:uuid,version:z.literal('1'),frameId:uuid,derivationId:uuid,
  sequence:z.number().int().positive().max(2147483647),payloadDigest:digest}).strict(),
 z.object({kind:z.literal('message_annotation'),id:uuid,version:z.literal('1'),frameId:uuid,derivationId:uuid,
  parentId:uuid,payloadDigest:digest}).strict(),
])
const identity={operationId:uuid,inputMessageId:uuid,assistantId:uuid}
const item=z.discriminatedUnion('state',[
 z.object({...identity,state:z.literal('committed'),outputs:z.array(reference).max(513)}).strict(),
 z.object({...identity,state:z.literal('denied'),reason:z.string().min(1).max(128)}).strict(),
 z.object({...identity,state:z.literal('unavailable'),reason:z.string().min(1).max(128)}).strict(),
])
const page=z.object({version:z.literal(1),scope:z.object({actorUserId:uuid,assistantId:uuid}).strict(),
 items:z.array(item).max(20),nextCursor:cursor.nullable()}).strict()
export type BufferedWebPublicationPage=z.infer<typeof page>

/** First bounded actor/assistant page only. Omitted operations remain unknown. */
export async function discoverBufferedWebPublications(authority:SessionContextAuthority,sessionId:string):Promise<BufferedWebPublicationPage>{
 const {execution}=authority
 if(execution.lifecycle.sessionId!==sessionId||execution.lifecycle.channelType!=='web'
  ||!execution.security.access.sharedAudience)changed()
 return readRetainedContextFrame(authority,[],async client=>{
  const result=page.parse((await client.query<{value:unknown}>(
   'SELECT read_native_conversation_publications($1,$2,NULL,20) AS value',
   [execution.security.access.workspaceId,sessionId])).rows[0]?.value)
  if(result.scope.actorUserId!==execution.security.access.userId||result.scope.assistantId!==execution.assistant.id
   ||result.items.some(item=>item.assistantId!==result.scope.assistantId))changed()
  return result
 })
}


/* Durable completion header for every owned turn (migration 8277).
 * One immutable row per owned turn, written by the owner's reply publication in
 * the same transaction as the reply rows, for web (shared and private), channel,
 * public API, callee and durable resume, in both editions. Identities and
 * sequences only: never content, never an authorization or delivery grant.
 * Spec: docs/architecture/platform/database-schema.md "Durable turn completion
 * header (8277)"; session-messages.md "Reply publication belongs to the turn owner". */
export const turnCompletionLanes=['web','channel','public','callee','resume'] as const
export type TurnCompletionLane=typeof turnCompletionLanes[number]
const completionInput=z.discriminatedUnion('kind',[
 z.object({kind:z.literal('session_message'),ref:uuid}).strict(),
 z.object({kind:z.literal('approval'),ref:uuid}).strict(),
 z.object({kind:z.literal('delegation'),ref:z.string().min(1).max(200)}).strict(),
])
export type TurnCompletionInput=z.infer<typeof completionInput>
const bindingSchema=z.object({operationId:uuid,lane:z.enum(turnCompletionLanes),assistantId:uuid,input:completionInput.nullable()}).strict()
/** The owner's completion identity for one turn. Data, never a capability. */
export type TurnCompletionBinding=Readonly<z.infer<typeof bindingSchema>>
export function bindTurnCompletion(value:TurnCompletionBinding):TurnCompletionBinding{
 return Object.freeze({...bindingSchema.parse(value),input:value.input?Object.freeze({...value.input}):null})
}
const completionOutput=z.object({id:uuid,sequence:z.number().int().positive().max(2147483647),role:z.enum(['assistant','user'])}).strict()
const completionRecord=z.object({operationId:uuid,turnId:z.string().regex(/^[a-f0-9]{64}$/).nullable(),
 lane:z.enum(['web_shared','web_private','channel','public','callee','resume']),assistantId:uuid,input:completionInput.nullable(),
 stopped:z.boolean(),publishedReply:z.boolean(),outputs:z.array(completionOutput).min(1).max(512),createdAt:z.string().datetime({offset:true})}).strict()
export type TurnCompletionRecord=z.infer<typeof completionRecord>
const completionReceipt=completionRecord.extend({version:z.literal(1),duplicate:z.boolean()}).strict()
export type TurnCompletionReceipt=z.infer<typeof completionReceipt>
const completionOutcome=z.object({version:z.literal(1),state:z.enum(['committed','in_progress','not_committed']),live:z.boolean(),
 completions:z.array(completionRecord).max(20)}).strict().refine(value=>(value.state==='committed')===(value.completions.length>0))
/** `committed`: visible after the session lock. `in_progress`: the token can
 * still publish. `not_committed`: the token is superseded and never committed. */
export type TurnCompletionOutcome=z.infer<typeof completionOutcome>

/** The one completion statement of a reply publication. It must run inside the
 * publishing transaction after the reply rows; SQL proves the rows are its own. */
export async function recordTurnCompletion(client:Pick<ClientBase,'query'>,input:{workspaceId:string|null;sessionId:string;
 token:string;stopped:boolean;binding:TurnCompletionBinding;rows:readonly {id:string;sequenceNum:number}[]}):Promise<TurnCompletionReceipt>{
 const binding=bindTurnCompletion(input.binding)
 if(input.rows.length<1||input.rows.length>512)throw new DerivedScopeError('scope_evidence_missing')
 const raw=(await client.query<{value:unknown}>('SELECT record_native_turn_completion($1,$2,$3,$4) AS value',
  [input.workspaceId,input.sessionId,uuid.parse(input.token),JSON.stringify({...binding,stopped:input.stopped,messages:input.rows.map(row=>row.id)})])).rows[0]?.value
 return verifyTurnCompletionReceipt(raw,binding,input.rows)
}

/** Reuse the original durable receipt check when publication and completion share a statement. */
export function verifyTurnCompletionReceipt(raw:unknown,binding:TurnCompletionBinding,rows:readonly {id:string;sequenceNum:number}[]):TurnCompletionReceipt{
 const receipt=completionReceipt.parse(raw)
 const expected=[...rows].sort((a,b)=>a.sequenceNum-b.sequenceNum)
 if(receipt.operationId!==binding.operationId||receipt.assistantId!==binding.assistantId||receipt.outputs.length!==expected.length
  ||receipt.outputs.some((output,index)=>output.id!==expected[index]!.id||output.sequence!==expected[index]!.sequenceNum))changed()
 return receipt
}

/** Fresh reconciliation by the owner's lease token or by the turn's input. The
 * session row lock waits for any in-flight publisher, so a missing row after a
 * superseded token is a definite non-commit. The default client is the system
 * owner pool; pass an application client to read under the caller's audience. */
export async function reconcileTurnCompletion(input:{workspaceId:string|null;sessionId:string}&({token:string;input?:never}|{token?:never;input:TurnCompletionInput}),
 client:Pick<ClientBase,'query'>=getPool()):Promise<TurnCompletionOutcome>{
 const raw=(await client.query<{value:unknown}>('SELECT read_native_turn_completion($1,$2,$3,$4) AS value',[input.workspaceId,input.sessionId,
  input.token===undefined?null:uuid.parse(input.token),input.input===undefined?null:JSON.stringify(completionInput.parse(input.input))])).rows[0]?.value
 if(raw===undefined||raw===null)throw new Error('turn_completion_unavailable')
 return completionOutcome.parse(raw)
}

/** Restart rule for a turn input (resume's approval, a callee delegation): a
 * committed completion is reused and never replayed; otherwise the caller, which
 * must already hold the new lease, may run exactly once. */
export async function committedTurnCompletion(input:{workspaceId:string|null;sessionId:string;input:TurnCompletionInput},
 client?:Pick<ClientBase,'query'>):Promise<TurnCompletionRecord|null>{
 const outcome=await reconcileTurnCompletion(input,client)
 return outcome.state==='committed'?outcome.completions[0]!:null
}

/** Fresh admission for record roots. All other source families keep their
 * existing owners. [COMP:api/conversation-visibility] */
import {z} from 'zod'
import type {Pool,PoolClient} from 'pg'
import {ContextScopeAccumulator,type ScopeEvidence} from '@use-brian/agent-runtime/security/context-scope.js'
import {DerivedScopeError,resourceScopeKey,type ScopeSource} from '@use-brian/agent-runtime/security/derived-scope.js'
import type {ExecutionContext} from '@use-brian/agent-runtime/security/execution-context.js'
import {RANK} from '@use-brian/agent-runtime/security/sensitivity.js'
import {getApplicationExecutionBinding} from '../application-platform/execution-context.js'
import {getAppPool,rlsGucSettings,runWithAgentAccess} from '../db/client.js'
import {conversationRecordSourceSchema,parseTurnConversationRecord,type ConversationRecord} from '../db/conversation-record.js'
import {captureSessionAuthority} from './authority-lease.js'
import {assertScopeEvidenceFitsCeiling} from './caller-evidence.js'
import {sessionAuthorityFactsParameters,type SessionAuthorityFactsInput} from './session-authority-facts.js'

const destinationSchema=z.object({sensitivity:z.enum(['public','internal','confidential']),
 compartments:z.array(z.string()),projectIds:z.array(z.string().uuid()),generation:z.string().regex(/^[1-9][0-9]*$/)}).strict()
const frameSchema=z.object({authority:z.unknown(),destination:destinationSchema,records:z.array(conversationRecordSourceSchema)}).strict()
const historySchema=z.object({authority:z.unknown(),destination:destinationSchema,record:z.unknown()}).strict()
type Destination=z.infer<typeof destinationSchema>
type RecordBoundary='dispatch'|'frame'|'publication'|'stopped_publication'
type LockedPublication = { transactionId:string; state:'active'|'stopping'|'stopped' }
const lockedPublicationSchema=z.object({value:z.unknown(),transactionId:z.string().regex(/^[1-9][0-9]*$/),
 state:z.enum(['active','stopping','stopped'])}).strict()
const historySignature='public.capture_native_turn_conversation_record(uuid,uuid,uuid,uuid,uuid,integer,uuid,boolean,boolean,uuid,integer,integer,integer)'

function changed():never{throw new DerivedScopeError('scope_source_changed')}
function eligible(execution:ExecutionContext):boolean{
 const {identity,ownership,security,surface}=execution
 return identity.kind==='attended'&&identity.principal.kind==='workspace_member'
  &&identity.principal.authenticationKind==='native_session'&&identity.principal.userId===security.access.userId
  &&ownership.kind==='workspace'&&ownership.workspaceId===security.access.workspaceId
  &&security.access.assistantId===execution.assistant.id&&!surface.systemRead&&!surface.clientSelfMemory
  &&!security.access.systemRead&&!getApplicationExecutionBinding(execution)
  &&security.authority.snapshotNativeSessionCredential?.()?.userId===security.access.userId
}
export function nativeTurnAuthorityParameters(execution:ExecutionContext,input:SessionAuthorityFactsInput){
 if(!input.turn||!input.credential||input.workspaceId!==execution.security.access.workspaceId
  ||input.userId!==execution.security.access.userId||input.credential.userId!==input.userId
  ||input.assistantId!==execution.assistant.id||input.sessionId!==execution.lifecycle.sessionId)changed()
 return [...sessionAuthorityFactsParameters(input),input.turn.token]
}
const placeholders='$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13'

// Cache feature presence on the exact pool once observed. Existing databases
// retain their history owner before this successor grants the protected port.
// Failure of an activated capture always propagates.
const enabledPools=new WeakSet<Pool>()
export async function tryReadTurnConversationRecord(execution:ExecutionContext,from?:number|null,through?:number,topicThrough?:number):Promise<ConversationRecord|null>{
 if(!eligible(execution))return null
 const pool=getAppPool()
 if(!enabledPools.has(pool)){
  const installed=(await pool.query<{installed:boolean}>(`SELECT coalesce(
    has_function_privilege(current_user,to_regprocedure($1),'EXECUTE'),false) AS installed`,[historySignature])).rows[0]?.installed
  if(!installed)return null
  enabledPools.add(pool)
 }
 const after=Math.max(0,(from??1)-1)
 return runWithAgentAccess(execution.security.access,async()=>{
  const captured=await captureSessionAuthority(execution.security.authority,async input=>{
   const parameters=nativeTurnAuthorityParameters(execution,input)
   const settings=rlsGucSettings(input.userId,input.assistantId)
   // One implicit transaction binds the local actor, reads the protected
   // selection and records its immutable identity. The host verifies returned
   // authority and the exact manifest before releasing any captured bytes.
   const raw=(await pool.query<{value:unknown}>(`WITH context AS MATERIALIZED (
    SELECT count(set_config(setting.name,setting.value,true)) FROM unnest($14::text[],$15::text[]) AS setting(name,value)
   ) SELECT public.capture_native_turn_conversation_record(${placeholders}) AS value FROM context`,
   [...parameters,after,through??null,topicThrough??null,settings.map(([name])=>name),settings.map(([,value])=>value)])).rows[0]?.value
   const result=historySchema.parse(raw)
   const record=parseTurnConversationRecord(result.record,input.workspaceId,input.sessionId,after,through,topicThrough)
   if(record.generation!==result.destination.generation)changed()
   assertScopeEvidenceFitsCeiling({sources:[record.source]},execution.security.ceiling,'caller')
   return{authority:result.authority,value:record}
  })
  if(!captured)changed()
  return captured.value
 })
}

/** The records are separated only for admission by their positive owner.
 * The original scalar floor stays present in each delegated validation and
 * the final evidence retains every source. */
export function recordEvidenceParts(evidence:ScopeEvidence):{records:ScopeSource[];fresh:ScopeEvidence}|null{
 const sources=evidence.sources??[]
 const records=sources.filter(source=>source.resourceKind==='conversation_record')
 return records.length?{records,fresh:{...evidence,sources:sources.filter(source=>source.resourceKind!=='conversation_record')}}:null
}

export function assertConversationFloor(evidence:ScopeEvidence,destination:Destination):void{
 const floor=new ContextScopeAccumulator(evidence).evidence
 if(floor.sensitivity&&RANK[floor.sensitivity]>RANK[destination.sensitivity]
  ||floor.compartments?.some(label=>!destination.compartments.includes(label))
  ||floor.projectIds?.some(project=>!destination.projectIds.includes(project)))changed()
}

/** Acquires the exact record roots and the current destination from the same
 * command as the original live facts. The optional publication client already
 * holds the kernel's destination lock. */
export async function admitTurnConversationRecords(execution:ExecutionContext,records:readonly ScopeSource[],
 boundary:RecordBoundary,client?:Pick<PoolClient,'query'>,lock?:{buffered:boolean}):Promise<{sources:ScopeSource[];destination:Destination;locked?:LockedPublication}>{
 if(!eligible(execution)||!records.length||boundary.endsWith('publication')!==!!client||lock&&!client)changed()
 const expected=records.map(source=>conversationRecordSourceSchema.parse(source))
 const admitted=await captureSessionAuthority(execution.security.authority,async input=>{
  if(expected.some(source=>source.workspaceId!==input.workspaceId))changed()
  const parameters=[...nativeTurnAuthorityParameters(execution,input),boundary,expected.map(source=>source.resourceId),expected.map(source=>source.version)]
  const command=`SELECT public.admit_native_turn_conversation_records(${placeholders}) AS value`
  let raw:unknown,locked:LockedPublication|undefined
  if(client&&lock){
   const settings=[...rlsGucSettings(input.userId,input.assistantId)]
   if(execution.security.access.sharedAudience)settings.push(['app.page_thread_session_id',input.sessionId])
   const received=(await client.query(`WITH allowed AS MATERIALIZED (
     SELECT r.oid FROM pg_roles r JOIN pg_class c ON c.oid='public.session_context_revision_contents'::regclass
     WHERE r.rolname=current_user AND NOT (r.rolsuper OR r.rolbypassrls OR pg_has_role(r.oid,c.relowner,'USAGE'))
    ), context AS MATERIALIZED (
     SELECT count(set_config(setting.name,setting.value,true)) FROM allowed
     CROSS JOIN unnest($14::text[],$15::text[]) AS setting(name,value) GROUP BY allowed.oid
    ), locked AS MATERIALIZED (
     SELECT lock_native_session_context_publication($1,$4),pg_current_xact_id()::text AS "transactionId" FROM context
    ), gate AS MATERIALIZED (
     SELECT "transactionId", CASE WHEN $16 THEN native_session_turn_publication_state($1,$4,$10)
      WHEN native_session_turn_publication_allowed($1,$4,$10,$11='stopped_publication') THEN
       CASE WHEN $11='stopped_publication' THEN 'stopped' ELSE 'active' END END state FROM locked
    ) SELECT "transactionId",state, CASE WHEN state IN('active','stopped','stopping') THEN public.admit_native_turn_conversation_records(
     $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,CASE WHEN state IN('stopping','stopped') THEN 'stopped_publication' ELSE $11 END,$12,$13) END value FROM gate`,
    [...parameters,settings.map(([name])=>name),settings.map(([,value])=>value),lock.buffered])).rows[0]
   if(!received?.state)changed()
   const row=lockedPublicationSchema.parse(received)
   raw=row.value;locked={transactionId:row.transactionId,state:row.state}
  }else if(client){
   raw=(await client.query<{value:unknown}>(command,parameters)).rows[0]?.value
  }else{
   raw=await runWithAgentAccess(execution.security.access,async()=>{
    const settings=rlsGucSettings(input.userId,input.assistantId)
    return (await getAppPool().query<{value:unknown}>(`WITH context AS MATERIALIZED (
     SELECT count(set_config(setting.name,setting.value,true)) FROM unnest($14::text[],$15::text[]) AS setting(name,value)
    ) SELECT public.admit_native_turn_conversation_records(${placeholders}) AS value FROM context`,
    [...parameters,settings.map(([name])=>name),settings.map(([,value])=>value)])).rows[0]?.value
   })
  }
  const result=frameSchema.parse(raw)
  if(result.records.length!==expected.length||result.records.some((source,index)=>
   source.resourceId!==expected[index].resourceId||resourceScopeKey(source)!==resourceScopeKey(expected[index])))changed()
  assertScopeEvidenceFitsCeiling({sources:result.records},execution.security.ceiling,'caller')
  return {authority:result.authority,value:{sources:result.records,destination:result.destination,...(locked?{locked}:{})}}
 })
 if(!admitted)changed()
 return admitted.value
}

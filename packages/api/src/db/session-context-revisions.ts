import { nativeSessionQueryContextSources } from '../application-platform/session-query-context.js'
import { z } from 'zod'
import { SourceProtocolError } from '@use-brian/brian-app/connector'
import { createMemory } from './memories.js'
/** Immutable session-context storage. [COMP:api/application-persistence] */
import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import {
  ContextScopeAccumulator, DerivedScopeError, bindScopeSource, boundScopeSources, deriveWriteScope, intersectAccessCeilings, RANK, scopeGrantContains,
  type DerivedWriteEvidence, type ExecutionContext, type ResourceScope, type ScopeSource, type SessionContextAuthority,
} from '@use-brian/core'
import { applyRLSGucs, getAppPool, getPool, rollbackAndRelease, runWithAgentAccess } from './client.js'
import { recordDerivedResource, validateDerivedWriteInputs } from './derived-scope-store.js'
import { validateCallerScopeEvidence } from '../context-scope/caller-evidence.js'
import { readExternalSourceAncestors } from '../application-platform/external-source-ancestry.js'
import { readApplicationFieldAncestors } from '../application-platform/field-evidence.js'
import { getSharedRetainedSourceAuthority } from '../application-platform/source-runtime.js'
import { applyApplicationRLSContext, getApplicationExecutionBinding, releaseApplicationTransactionBinding } from '../application-platform/execution-context.js'
import { assertPreparedExternalSourceAuthorityCurrent, pinPreparedExternalSourceAuthority,
  type PreparedExternalSourceAuthority } from '../application-platform/retained-source-authority.js'

export type SessionContextKind = 'session_state' | 'episodic_memory' | 'compact_summary' | 'message_annotation' | 'session_title'
export type SessionContextRevision = {
  id: string; parentId: string; sessionId: string; source: ScopeSource; content: Record<string, unknown>
  userId: string; assistantId: string; createdAt: Date; lastAccessedAt: Date; accessCount: number; survivalCount: number
}
type Prepare = (execution: ExecutionContext, sources: readonly ScopeSource[], action: 'context' | 'retain') => Promise<PreparedExternalSourceAuthority>
const retainedHosts = new WeakMap<ExecutionContext, Prepare>()
/** R4 supplies its real invocation's prepared operation; no service/creator impersonation. */
export function bindSessionContextRetainedAuthority(execution: ExecutionContext, prepare: Prepare): void {
  retainedHosts.set(execution, prepare)
}
function missing(): never { throw new DerivedScopeError('scope_evidence_missing') }
function changed(cause?:unknown): never { throw Object.assign(new DerivedScopeError('scope_source_changed'),cause===undefined?{}:{cause}) }
function requireAuthority(authority: SessionContextAuthority | undefined): SessionContextAuthority {
  if (!authority?.execution || !(authority.accumulator instanceof ContextScopeAccumulator)) missing()
  return authority
}
/** Only the original current native delegated member can enter this host port. */
function nativeDelegatedSessionPublication(execution:ExecutionContext):boolean{
 const {identity,security,ownership,surface}=execution,access=security.access
 return identity.kind==='delegated'&&ownership.kind==='workspace'&&ownership.workspaceId===access.workspaceId
  &&identity.actorUserId===access.userId&&identity.parentCeiling.userId===access.userId
  &&identity.parentCeiling.workspaceId===access.workspaceId&&access.assistantId===execution.assistant.id
  &&!surface.readOnly&&!surface.systemRead&&!surface.clientSelfMemory&&!access.systemRead
  &&!getApplicationExecutionBinding(execution)
}
async function transaction<T>(authority: SessionContextAuthority, sources: readonly ScopeSource[], action: 'context' | 'retain',
  owner: boolean, run: (client: PoolClient) => Promise<T>, writeSessionId?: string, stoppedTurnToken?:string, activeTurnToken?:string,nativeMutation=false): Promise<T> {
  let publicationAttempted=false
  try {
    const { execution, accumulator } = requireAuthority(authority), before = JSON.stringify(accumulator.evidence)
    await execution.security.authority.assertCurrent()
    const finalizing=!!stoppedTurnToken&&!owner&&action==='retain'&&!!writeSessionId
      &&execution.identity.kind==='attended'&&execution.identity.principal.kind==='workspace_member'
    if (execution.lifecycle.abortSignal.aborted&&!finalizing || sources.some(source => source.workspaceId !== execution.security.access.workspaceId)) changed()
    const external = sources.some(source => source.resourceKind === 'external_source')
      || (await readExternalSourceAncestors(execution.security.access.workspaceId, sources)).length > 0
    const wiring = getSharedRetainedSourceAuthority(), host = retainedHosts.get(execution)
    const prepare = host ?? (wiring ? (e: ExecutionContext, s: readonly ScopeSource[], a: 'context' | 'retain') => wiring.coordinator.prepare(e,s,a) : undefined)
    const fields = await readApplicationFieldAncestors(execution.security.access.workspaceId, sources)
    const cohort = fields.length ? await nativeSessionQueryContextSources(execution, sources, prepare) : { sources, independent: false }
    if ((external || cohort.independent) && !prepare) changed()
    let contextProof: PreparedExternalSourceAuthority | undefined
    let prepared: PreparedExternalSourceAuthority | undefined
    const client = await (owner ? getPool() : getAppPool()).connect()
    let result: T
    try {
      result = await runWithAgentAccess(execution.security.access, async () => {
        await client.query('BEGIN')
        if (!owner) {
          const role = (await client.query<{ bypass: boolean }>(`SELECT r.rolsuper OR r.rolbypassrls OR pg_has_role(r.oid,c.relowner,'USAGE') AS bypass
            FROM pg_roles r JOIN pg_class c ON c.oid='session_context_revision_contents'::regclass WHERE r.rolname=current_user`)).rows[0]
          if (role?.bypass !== false) changed()
        }
        await applyRLSGucs(client, execution.security.access.userId)
        // Native publication needs the exact original assistant even with the
        // legacy department policy. The v2 flag remains unchanged.
        if (execution.identity.kind === 'attended' && execution.identity.principal.kind === 'workspace_member'
          ||nativeDelegatedSessionPublication(execution)) {
          await client.query("SELECT set_config('app.v2_assistant_id',$1,true)", [execution.assistant.id])
        }
        // Native admission takes workspace SHARE locks too. Pin that row before
        // any source/parent reader can lock a session: a reader holding a session
        // while waiting for promotion's workspace lock otherwise forms a cycle.
        // NO KEY UPDATE permits the trusted source pin's separate FK insert;
        // createMemory upgrades only after those pin inserts have committed.
        if(writeSessionId&&!owner)await client.query('SELECT lock_native_session_context_publication($1,$2)',[execution.security.access.workspaceId,writeSessionId])
        else {
          const locked=await client.query(owner||nativeMutation
            ? 'SELECT id FROM workspaces WHERE id=$1 FOR NO KEY UPDATE'
            : 'SELECT id FROM workspaces WHERE id=$1 FOR SHARE',[execution.security.access.workspaceId])
          if(nativeMutation&&locked.rows.length!==1)changed()
        }
        if (finalizing || activeTurnToken) {
          const admitted=(await client.query<{allowed:boolean}>('SELECT native_session_turn_publication_allowed($1,$2,$3,$4) AS allowed',
            [execution.security.access.workspaceId,writeSessionId,activeTurnToken??stoppedTurnToken,finalizing])).rows[0]?.allowed
          if(admitted!==true)changed()
        }
        await applyApplicationRLSContext(client, execution)
        // Take the publication lock before any native source reader takes a
        // parent SHARE lock. Two simultaneous upgrades otherwise deadlock.
        if(writeSessionId&&owner)await client.query('SELECT id FROM sessions WHERE id=$1 FOR UPDATE',[writeSessionId])
        // Source receipts are short-lived. Acquire each after native lock
        // waits and immediately before the boundary that consumes it.
        contextProof = external || cohort.independent ? await prepare!(execution, cohort.sources, 'context') : undefined
        if (contextProof) await pinPreparedExternalSourceAuthority(client, execution, contextProof)
        await validateCallerScopeEvidence({ sources: [...sources] }, execution.security.ceiling, client)
        prepared = external && action==='retain' ? await prepare!(execution, sources, 'retain') : undefined
        if (prepared) await pinPreparedExternalSourceAuthority(client, execution, prepared)
        const value = await run(client)
        await execution.security.authority.assertCurrent()
        if (execution.lifecycle.abortSignal.aborted&&!finalizing || JSON.stringify(accumulator.evidence) !== before
          || host !== retainedHosts.get(execution) || !host && wiring !== getSharedRetainedSourceAuthority()) changed()
        if(nativeMutation)publicationAttempted=true
        await client.query('COMMIT')
        return value
      })
    } finally { releaseApplicationTransactionBinding(client); await rollbackAndRelease(client) }
    if (contextProof) await assertPreparedExternalSourceAuthorityCurrent(execution, contextProof)
    if (prepared) await assertPreparedExternalSourceAuthorityCurrent(execution, prepared)
    await execution.security.authority.assertCurrent()
    return result
  } catch (error) {
    if(nativeMutation&&publicationAttempted)throw Object.assign(error instanceof Error?error:new Error('scope_source_changed'),{retrySafe:false,operationMayHaveExecuted:true})
    const sql = error as { code?: unknown; message?: unknown } | null
    if (sql && ['P0001','42501','22023'].includes(String(sql.code)) && sql.message === 'scope_source_changed') {
      throw Object.assign(new DerivedScopeError('scope_source_changed'), { cause: error })
    }
    if (error instanceof SourceProtocolError) {
      if (error.code === 'source_access_denied') changed(error)
      // Unavailability, malformed proof and uncertain source effects must not
      // become a normal storage failure. Preserve their code and retry policy.
      throw Object.assign(error, { reason: 'authority_changed' as const })
    }
    if (typeof error === 'object' && error !== null && 'reason' in error
      && error.reason === 'caller_evidence_unavailable') changed(error)
    throw error
  }
}

/** Current retained read using the original lease and the complete canonical validator.
 * The callback receives exactly the non-owner transaction carrying fresh source pins.
 * No session query floor or serialized source identifier can create this authority.
 */
export function readRetainedContextFrame<T>(authority:SessionContextAuthority,sources:readonly ScopeSource[],
 capture:(client:PoolClient)=>Promise<T>):Promise<T>{
 return transaction(authority,structuredClone(sources),'context',false,capture)
}

/** Native durable publication uses the original retained operation and non-owner connection. */
export function writeRetainedContextFrame<T>(authority:SessionContextAuthority,sources:readonly ScopeSource[],
 publish:(client:PoolClient)=>Promise<T>):Promise<T>{
 const {execution}=requireAuthority(authority)
 if(execution.identity.kind!=='attended'||execution.identity.principal.kind!=='workspace_member'
  ||execution.ownership.kind!=='workspace'||execution.surface.readOnly||execution.surface.systemRead
  ||execution.lifecycle.abortSignal.aborted)missing()
 return transaction(authority,structuredClone(sources),'retain',false,publish,undefined,undefined,undefined,true)
}

/** Current native query frame. Physical metadata grants nothing: only genuine
 * source denials exclude candidates, and one fresh operation pins the admitted
 * cohort after native lock waits. Original caller/lease validation brackets it.
 */
export async function readRetainedQueryFrame<T>(authority:SessionContextAuthority,rawRoots:readonly ScopeSource[],
 capture:(client:PoolClient)=>Promise<{value:T;sources:readonly ScopeSource[]}>):Promise<T>{
 const {execution}=requireAuthority(authority),roots=structuredClone(rawRoots)
 await execution.security.authority.assertCurrent()
 if(roots.some(root=>root.workspaceId!==execution.security.access.workspaceId))changed()
 const wiring=getSharedRetainedSourceAuthority(),host=retainedHosts.get(execution)
 const prepare=host??(wiring?((e:ExecutionContext,s:readonly ScopeSource[],a:'context'|'retain')=>wiring.coordinator.prepare(e,s,a)):undefined)
 const admitted:ScopeSource[]=[]
 for(const root of roots){
  if(root.resourceKind!=='external_source'&&!(await readExternalSourceAncestors(root.workspaceId,[root])).length)continue
  if(!prepare)changed()
  try{await prepare(execution,[root],'context');admitted.push(root)}
  catch(error){if(!(error instanceof SourceProtocolError)||error.code!=='source_access_denied')throw error}
 }
 const assertWiring=()=>{if(host!==retainedHosts.get(execution)||!host&&wiring!==getSharedRetainedSourceAuthority())changed()}
 const captured=await transaction(authority,[],'context',false,async client=>{
  assertWiring()
  const proof=admitted.length?await prepare!(execution,admitted,'context'):undefined
  if(proof)await pinPreparedExternalSourceAuthority(client,execution,proof)
  const result=await capture(client)
  assertWiring()
  if(admitted.length){
   const refreshed=await prepare!(execution,admitted,'context')
   await pinPreparedExternalSourceAuthority(client,execution,refreshed)
  }
  await validateCallerScopeEvidence({sources:[...result.sources]},execution.security.ceiling,client)
  assertWiring();return result
 })
 if(admitted.length){
  let current:PreparedExternalSourceAuthority|undefined
  await transaction(authority,[],'context',false,async client=>{
   assertWiring();current=await prepare!(execution,admitted,'context')
   await pinPreparedExternalSourceAuthority(client,execution,current)
   await validateCallerScopeEvidence({sources:[...captured.sources]},execution.security.ceiling,client)
   assertWiring()
  })
  if(!current)changed()
  await assertPreparedExternalSourceAuthorityCurrent(execution,current)
 }
 assertWiring();await execution.security.authority.assertCurrent();return captured.value
}

const queryFloor=z.object({workspaceId:z.string().uuid(),userId:z.string().uuid().nullable(),assistantId:z.null(),
 sensitivity:z.enum(['public','internal','confidential']),compartments:z.array(z.string()),projectIds:z.array(z.string().uuid())}).strict()
async function pinNativeSessionQueryFloor(authority:SessionContextAuthority,client:PoolClient){
 const {execution}=authority,actor=execution.security.access.userId,workspaceId=execution.security.access.workspaceId
 const floor=queryFloor.parse((await client.query<{scope:unknown}>('SELECT read_native_session_query_floor($1,$2) AS scope',[workspaceId,execution.lifecycle.sessionId])).rows[0]?.scope)
 if(floor.workspaceId!==workspaceId||floor.userId!==null&&floor.userId!==actor)changed()
 if(floor.userId===null&&execution.security.access.sharedAudience){
  const maximum={workspaceId,userId:actor,clearance:floor.sensitivity,compartments:floor.compartments,mutationCompartments:[],
   projectIds:floor.projectIds,visibilityAssistantIds:execution.security.ceiling.visibilityAssistantIds}
  const bounded=intersectAccessCeilings(execution.security.ceiling,maximum)
  await runWithAgentAccess({...execution.security.access,...bounded,sharedAudience:true},()=>applyRLSGucs(client,actor))
  return floor
 }
 return null
}

/** Internal current-reader frame for original session queries, including empty collections. */
export async function readSessionQueryFrame<T>(authority:SessionContextAuthority,rawRoots:readonly ScopeSource[],
 capture:(client:PoolClient)=>Promise<{value:T;sources:readonly ScopeSource[]}>):Promise<T> {
 try{
 const {execution}=requireAuthority(authority),roots=structuredClone(rawRoots)
 await execution.security.authority.assertCurrent()
 const wiring=getSharedRetainedSourceAuthority(),host=retainedHosts.get(execution)
 const prepare=host??(wiring?((e:ExecutionContext,s:readonly ScopeSource[],a:'context'|'retain')=>wiring.coordinator.prepare(e,s,a)):undefined)
 // Discover immutable metadata only. Native-only reads need no additional
 // floor transaction; their acquisition frame applies it before any payload.
 const externalRoots:ScopeSource[]=[]
 for(const root of roots){
  if(root.workspaceId!==execution.security.access.workspaceId)changed()
  if(root.resourceKind==='external_source'||(await readExternalSourceAncestors(root.workspaceId,[root])).length)externalRoots.push(root)
 }
 const floor=externalRoots.length?await transaction(authority,[],'context',false,client=>pinNativeSessionQueryFloor(authority,client)):null
 const admittedRoots:ScopeSource[]=[]
 for(const root of externalRoots){
  if(floor&&(root.userId!==null||RANK[root.sensitivity]>RANK[floor.sensitivity]
   ||!scopeGrantContains(floor.compartments,root.compartments)||!scopeGrantContains(floor.projectIds,root.projectIds)))continue
  if(!prepare)changed()
  try{await prepare(execution,[root],'context');admittedRoots.push(root)}
  catch(error){if(!(error instanceof SourceProtocolError)||error.code!=='source_access_denied')throw error}
 }
 // One real source operation binds all admitted roots; separate operation IDs
 // must never replace one another's transaction-scoped source pins.
 let proof:PreparedExternalSourceAuthority|undefined
 const assertWiring=()=>{if(host!==retainedHosts.get(execution)||!host&&wiring!==getSharedRetainedSourceAuthority())changed()}
 assertWiring()
 const captured=await transaction(authority,[],'context',false,async client=>{
  await pinNativeSessionQueryFloor(authority,client)
  proof=admittedRoots.length?await prepare!(execution,admittedRoots,'context'):undefined
  assertWiring()
  if(proof)await pinPreparedExternalSourceAuthority(client,execution,proof)
  const result=await capture(client)
  await validateCallerScopeEvidence({sources:[...result.sources]},execution.security.ceiling,client)
  assertWiring()
  return result
 })
 if(proof){
  // The acquisition frame may consume a short receipt's lifetime. A fresh
  // source decision plus real SQL revalidation qualifies the return value;
  // expired acquisition permission is never treated as current authority.
  let currentProof:PreparedExternalSourceAuthority|undefined
  assertWiring()
  await transaction(authority,[],'context',false,async client=>{
   await pinNativeSessionQueryFloor(authority,client)
   currentProof=await prepare!(execution,admittedRoots,'context')
   assertWiring()
   await pinPreparedExternalSourceAuthority(client,execution,currentProof)
   await validateCallerScopeEvidence({sources:[...captured.sources]},execution.security.ceiling,client)
   assertWiring()
  })
  if(!currentProof)changed()
  await assertPreparedExternalSourceAuthorityCurrent(execution,currentProof)
 }
 assertWiring();await execution.security.authority.assertCurrent()
 const value=captured.value
 return value
 }catch(error){
  // Stored-entry transactions keep their holding normalization. A query
  // caller still receives the authentic current source protocol refusal.
  const cause=error instanceof DerivedScopeError&&error.code==='scope_source_changed'&&'cause'in error?error.cause:undefined
  if(cause instanceof SourceProtocolError&&cause.code==='source_access_denied'){
   throw Object.assign(cause,{reason:'authority_changed' as const,retrySafe:false})
  }
  throw error
 }
}

const messagePublications=new WeakMap<object,{authority:SessionContextAuthority}>()
/** Atomic native transcript batch; the callback never receives an owner connection. */
export async function withSessionMessagePublication<T>(authority:SessionContextAuthority,sources:readonly ScopeSource[],
 run:(client:PoolClient)=>Promise<T>,options?:{turnToken?:string;stoppedTurnToken?:string}):Promise<T>{
 const {execution}=requireAuthority(authority)
 const turnToken=options?.turnToken,stoppedTurnToken=options?.stoppedTurnToken
 if(turnToken&&stoppedTurnToken)changed()
 if(execution.lifecycle.sessionPersisted===false||execution.identity.kind!=='attended'||execution.identity.principal.kind!=='workspace_member')changed()
 return transaction(authority,structuredClone(sources),'retain',false,async client=>{
  messagePublications.set(client,{authority})
  try{return await run(client)}finally{messagePublications.delete(client)}
 },execution.lifecycle.sessionId,stoppedTurnToken,turnToken)
}
/** A JSON descriptor, owner transaction or retained callback cannot mint a live frame. */
export function assertSessionMessagePublicationFrame(client:object,authority:SessionContextAuthority):void{
 if(messagePublications.get(client)?.authority!==authority)missing()
}

/** Discover immutable metadata only. Historical plaintext is never selected. */
export async function readSessionContextRevisions(sessionId: string, kind: SessionContextKind,
  authority?: SessionContextAuthority, options?: { includePromoted?: boolean; parentId?: string }): Promise<SessionContextRevision[]> {
  if (!authority) return []
  requireAuthority(authority)
  await authority.execution.security.authority.assertCurrent()
  const workspaceId = authority.execution.security.access.workspaceId
  const candidates = (await getPool().query<Omit<SessionContextRevision,'content'> & { source: ScopeSource }>(`SELECT r.id,r.parent_id AS "parentId",r.session_id AS "sessionId",
    read_scope_source(r.workspace_id,'session_context_revision',r.id) AS source,s.user_id AS "userId",s.assistant_id AS "assistantId",
    r.created_at AS "createdAt",coalesce(e.last_accessed_at,r.created_at) AS "lastAccessedAt",
    coalesce(e.access_count,0) AS "accessCount",coalesce(e.survival_count,0) AS "survivalCount"
    FROM session_context_scope_revisions r JOIN sessions s ON s.workspace_id=r.workspace_id AND s.id=r.session_id
    LEFT JOIN session_state st ON r.parent_kind='session_state' AND st.id=r.parent_id AND st.scope_revision_id=r.id AND st.session_id=r.session_id
    LEFT JOIN episodic_memories e ON r.parent_kind='episodic_memory' AND e.id=r.parent_id AND e.scope_revision_id=r.id AND e.session_id=r.session_id
    LEFT JOIN session_message_annotation_heads annotation ON r.parent_kind='message_annotation' AND annotation.message_id=r.parent_id AND annotation.scope_revision_id=r.id AND annotation.workspace_id=r.workspace_id AND annotation.session_id=r.session_id
    LEFT JOIN session_title_heads title ON r.parent_kind='session_title' AND title.scope_revision_id=r.id AND title.workspace_id=r.workspace_id AND title.session_id=r.session_id
    WHERE r.workspace_id=$1 AND r.session_id=$2 AND r.parent_kind=$3 AND ($5::uuid IS NULL OR r.parent_id=$5)
      AND (title.session_id IS NOT NULL OR annotation.message_id IS NOT NULL OR st.id IS NOT NULL OR e.id IS NOT NULL AND ($4::boolean OR e.promoted_memory_id IS NULL) OR r.parent_kind='compact_summary' AND s.compact_scope_revision_id=r.id)
    ORDER BY r.id`, [workspaceId,sessionId,kind,options?.includePromoted === true,options?.parentId ?? null])).rows
  const rows: SessionContextRevision[] = []
  for (const candidate of candidates) {
    if (!candidate.source || candidate.source.resourceKind !== 'session_context_revision' || (candidate.source as ScopeSource & { held?: boolean }).held !== false) continue
    const {workspaceId: sourceWorkspace,userId,assistantId,sensitivity,compartments,projectIds,resourceKind,resourceId,version}=candidate.source
    const source:ScopeSource={workspaceId:sourceWorkspace,userId,assistantId,sensitivity,compartments,projectIds,resourceKind,resourceId,version}
    // A withdrawn independent source holds this entry. It must not poison a
    // different entry or another reader's immutable observation.
    try {
      const content = await transaction(authority,[source],'context',false,async client =>
        (await client.query<{ content: Record<string,unknown> | null }>(kind === 'session_title'
          ? 'SELECT read_session_title_revision($1,$2,$3) AS content' : 'SELECT read_session_context_revision($1,$2) AS content',
          kind === 'session_title' ? [workspaceId,sessionId,candidate.id] : [workspaceId,candidate.id])).rows[0]?.content)
      if (content) rows.push(bindScopeSource({ ...candidate, source, content }, source))
    } catch (error) {
      if (error instanceof DerivedScopeError || typeof error === 'object' && error !== null
        && ('reason' in error && error.reason === 'caller_evidence_unavailable' || 'code' in error && error.code === 'source_access_denied')) continue
      throw error
    }
  }
  return rows
}

/** Metadata CAS token; never a content count or an authorization result. */
export async function sessionContextGeneration(sessionId: string): Promise<string> {
  const value=(await getPool().query<{generation:string}>('SELECT session_context_generation::text AS generation FROM sessions WHERE id=$1',[sessionId])).rows[0]?.generation
  if(value===undefined)changed()
  return value
}

/** Canonical semantic write; pointer/CAS/receipt and payload commit together. */
export async function writeSessionContextRevision(input: {
  sessionId: string; parentId?: string; kind: SessionContextKind; content: Record<string, unknown>
  authority?: SessionContextAuthority; derivation?: DerivedWriteEvidence; expectedRevision?: string
  expectedCursor?: number | null; expectedGeneration?: string
}): Promise<SessionContextRevision | null> {
  const authority = requireAuthority(input.authority), { execution } = authority
  // Snapshot semantic inputs before the first await. The original live
  // authority is not serializable and must remain the canonical instance.
  const command = structuredClone({ sessionId: input.sessionId, parentId: input.parentId, kind: input.kind,
    content: input.content, derivation: input.derivation, expectedRevision: input.expectedRevision,
    expectedCursor: input.expectedCursor, expectedGeneration: input.expectedGeneration })
  // Target session is a real persisted invocation, but read sources may be
  // different sessions authorized under the same canonical actor.
  if (execution.lifecycle.sessionPersisted === false || execution.lifecycle.sessionId !== command.sessionId || execution.surface.readOnly) changed()
  const accumulated = new ContextScopeAccumulator(execution.security.provenance)
  accumulated.note(authority.accumulator.evidence)
  if (!command.derivation) missing()
  accumulated.note({ sources: command.derivation.sources })
  if (command.kind==='message_annotation') {
    if (!command.parentId) missing()
    const native=(await getPool().query<{source:ScopeSource & {held?:boolean}}>(`SELECT read_scope_source($1,'session_message',id) AS source
      FROM session_messages WHERE workspace_id=$1 AND session_id=$2 AND id=$3`,
      [execution.security.access.workspaceId,command.sessionId,command.parentId])).rows[0]?.source
    if (!native || native.held!==false) changed()
    const {workspaceId,userId,assistantId,sensitivity,compartments,projectIds,resourceKind,resourceId,version}=native
    accumulated.noteSource({workspaceId,userId,assistantId,sensitivity,compartments,projectIds,resourceKind,resourceId,version})
  }
  const evidence: DerivedWriteEvidence = { producer: command.derivation.producer, sources: accumulated.evidence.sources ?? [] }
  deriveWriteScope(evidence, { workspaceId: execution.security.access.workspaceId, userId: execution.security.access.userId,
    assistantId: null, sensitivity: 'public', compartments: [], projectIds: [] }, execution.security.access.userId)
  const ancestors = [...await readExternalSourceAncestors(execution.security.access.workspaceId,evidence.sources),
    ...await readApplicationFieldAncestors(execution.security.access.workspaceId,evidence.sources)]
  const all = new ContextScopeAccumulator({ sources: [...evidence.sources,...ancestors] })
  evidence.sources = all.evidence.sources ?? []
  const payload = structuredClone(command.content), parentId = command.parentId ?? randomUUID(), id = randomUUID()
  const stored = await transaction(authority,evidence.sources,'retain',false,async client => {
    const result=(await client.query<{value:{source:ScopeSource;createdAt:string;userId:string;assistantId:string}|null}>(
      'SELECT publish_native_session_context_revision($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) AS value',
      [execution.security.access.workspaceId,command.sessionId,command.kind,(command.kind==='compact_summary'||command.kind==='session_title')?command.sessionId:parentId,id,
       payload,evidence.producer,JSON.stringify(evidence.sources),command.expectedRevision??null,command.expectedGeneration??null,command.expectedCursor??null])).rows[0]?.value
    if(!result)return null
    const source=result.source
    if(source.workspaceId!==execution.security.access.workspaceId||source.resourceKind!=='session_context_revision'||source.resourceId!==id||source.version!=='1')changed()
    const createdAt=new Date(result.createdAt)
    return bindScopeSource({id,parentId:(command.kind==='compact_summary'||command.kind==='session_title')?command.sessionId:parentId,sessionId:command.sessionId,source,content:payload,
      userId:result.userId,assistantId:result.assistantId,createdAt,lastAccessedAt:createdAt,accessCount:0,survivalCount:0},source)
  },command.sessionId)
  if (stored) authority.accumulator.note({ sources: boundScopeSources(stored) })
  return stored
}

/** Nonsemantic counters and retention deletes keep the same current source gate. */
export async function mutateSessionContextParents(authority: SessionContextAuthority | undefined,
  kind: 'session_state' | 'episodic_memory', rows: readonly SessionContextRevision[], action: 'delete' | 'access' | 'survive'): Promise<number> {
  requireAuthority(authority)
  if (!rows.length) return 0
  return transaction(authority!, rows.map(row=>row.source),'context',true,async client => {
    for (const row of rows) {
      const admitted = (await client.query<{ allowed: boolean }>('SELECT session_context_revision_allowed($1,$2) AS allowed',
        [row.source.workspaceId,row.id])).rows[0]?.allowed
      if (admitted !== true) changed()
    }
    const table = kind === 'session_state' ? 'session_state' : 'episodic_memories'
    if (kind==='session_state' && action!=='delete') changed()
    const prefix = action==='delete' ? `DELETE FROM ${table}` : action==='access'
      ? `UPDATE ${table} SET last_accessed_at=now(),access_count=access_count+1`
      : `UPDATE ${table} SET survival_count=survival_count+1`
    const result = await client.query(`${prefix} WHERE scope_revision_id=ANY($1::uuid[]) RETURNING id`,[rows.map(row=>row.id)])
    return result.rowCount ?? 0
  })
}

/** Canonical episode promotion; only admitted immutable payloads reach the writer. */
export async function promoteSessionContextEpisode(parentId: string, inputAuthority: SessionContextAuthority): Promise<{ memoryId: string; created: boolean }> {
  const authority = requireAuthority(inputAuthority), { execution } = authority
  if (execution.lifecycle.sessionPersisted === false || execution.surface.readOnly) changed()
  const row = (await readSessionContextRevisions(execution.lifecycle.sessionId ?? '', 'episodic_memory', authority, { includePromoted: true }))
    .find(candidate => candidate.parentId === parentId)
  if (!row) changed()
  const { topicLabel, summary } = row.content
  if (typeof topicLabel !== 'string' || !topicLabel || typeof summary !== 'string' || !summary) changed()
  const accumulated = new ContextScopeAccumulator(execution.security.provenance)
  accumulated.note(authority.accumulator.evidence)
  accumulated.note({ sources: boundScopeSources(row) })
  const derivation: DerivedWriteEvidence = { producer: 'compaction:episodic-promotion', sources: accumulated.evidence.sources ?? [] }
  const result = await transaction(authority, derivation.sources, 'retain', true, async client => {
    const current = (await client.query<{ revision: string; promoted: string | null; access: number; survival: number }>(`SELECT scope_revision_id AS revision,promoted_memory_id AS promoted,access_count AS access,survival_count AS survival
      FROM episodic_memories WHERE id=$1 AND session_id=$2 FOR UPDATE`, [parentId,execution.lifecycle.sessionId])).rows[0]
    if (!current || current.revision !== row.id) changed()
    if (current.promoted) return { memoryId: current.promoted, created: false }
    if (current.access < 1 || current.survival + 1 < 3) changed()
    const allowed = (await client.query<{ allowed: boolean }>('SELECT session_context_revision_allowed($1,$2) AS allowed', [row.source.workspaceId,row.id])).rows[0]?.allowed
    if (allowed !== true) changed()
    const memory = await createMemory({
      workspaceId: row.source.workspaceId, assistantId: execution.assistant.id,
      userId: row.source.userId, derivationTarget: { userId: row.source.userId, assistantId: row.source.assistantId },
      summary: `Recurring topic: ${topicLabel}`, detail: summary,
      scope: row.source.userId ? 'private' : 'shared', sensitivity: row.source.sensitivity,
      compartments: row.source.compartments, projectIds: row.source.projectIds,
      source: 'episodic-graduation', sourceSessionId: row.sessionId, tags: ['episodic-graduation',topicLabel],
      confidence: 0.7, createdByUserId: execution.security.access.userId, createdByAssistantId: execution.assistant.id,
      derivation,
    }, undefined, client)
    await client.query('UPDATE episodic_memories SET promoted_memory_id=$2 WHERE id=$1 AND scope_revision_id=$3', [parentId,memory.id,row.id])
    return { memoryId: memory.id, created: true }
  }, execution.lifecycle.sessionId)
  authority.accumulator.note({ sources: boundScopeSources(row) })
  return result
}

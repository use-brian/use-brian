import { SourceProtocolError } from '@use-brian/brian-app/connector'
import { createMemory } from './memories.js'
/** Immutable session-context storage. [COMP:api/application-persistence] */
import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import {
  ContextScopeAccumulator, DerivedScopeError, bindScopeSource, boundScopeSources, deriveWriteScope,
  type DerivedWriteEvidence, type ExecutionContext, type ResourceScope, type ScopeSource, type SessionContextAuthority,
} from '@use-brian/core'
import { applyRLSGucs, getAppPool, getPool, rollbackAndRelease, runWithAgentAccess } from './client.js'
import { recordDerivedResource, validateDerivedWriteInputs } from './derived-scope-store.js'
import { validateCallerScopeEvidence } from '../context-scope/caller-evidence.js'
import { readExternalSourceAncestors } from '../application-platform/external-source-ancestry.js'
import { readApplicationFieldAncestors } from '../application-platform/field-evidence.js'
import { getSharedRetainedSourceAuthority } from '../application-platform/source-runtime.js'
import { applyApplicationRLSContext, releaseApplicationTransactionBinding } from '../application-platform/execution-context.js'
import { assertPreparedExternalSourceAuthorityCurrent, pinPreparedExternalSourceAuthority,
  type PreparedExternalSourceAuthority } from '../application-platform/retained-source-authority.js'

export type SessionContextKind = 'session_state' | 'episodic_memory' | 'compact_summary' | 'message_annotation'
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
async function transaction<T>(authority: SessionContextAuthority, sources: readonly ScopeSource[], action: 'context' | 'retain',
  owner: boolean, run: (client: PoolClient) => Promise<T>, writeSessionId?: string): Promise<T> {
  try {
    const { execution, accumulator } = requireAuthority(authority), before = JSON.stringify(accumulator.evidence)
    await execution.security.authority.assertCurrent()
    if (execution.lifecycle.abortSignal.aborted || sources.some(source => source.workspaceId !== execution.security.access.workspaceId)) changed()
    const external = sources.some(source => source.resourceKind === 'external_source')
      || (await readExternalSourceAncestors(execution.security.access.workspaceId, sources)).length > 0
    const wiring = getSharedRetainedSourceAuthority(), host = retainedHosts.get(execution)
    const prepare = host ?? (wiring ? (e: ExecutionContext, s: readonly ScopeSource[], a: 'context' | 'retain') => wiring.coordinator.prepare(e,s,a) : undefined)
    if (external && !prepare) changed()
    const contextProof = external ? await prepare!(execution, sources, 'context') : undefined
    const prepared = external && action==='retain' ? await prepare!(execution, sources, 'retain') : undefined
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
        // Native admission takes workspace SHARE locks too. Pin that row before
        // any source/parent reader can lock a session: a reader holding a session
        // while waiting for promotion's workspace lock otherwise forms a cycle.
        // NO KEY UPDATE permits the trusted source pin's separate FK insert;
        // createMemory upgrades only after those pin inserts have committed.
        if(writeSessionId&&!owner)await client.query('SELECT lock_native_session_context_publication($1,$2)',[execution.security.access.workspaceId,writeSessionId])
        else await client.query(owner
          ? 'SELECT id FROM workspaces WHERE id=$1 FOR NO KEY UPDATE'
          : 'SELECT id FROM workspaces WHERE id=$1 FOR SHARE', [execution.security.access.workspaceId])
        await applyApplicationRLSContext(client, execution)
        // Take the publication lock before any native source reader takes a
        // parent SHARE lock. Two simultaneous upgrades otherwise deadlock.
        if(writeSessionId&&owner)await client.query('SELECT id FROM sessions WHERE id=$1 FOR UPDATE',[writeSessionId])
        if (contextProof) await pinPreparedExternalSourceAuthority(client, execution, contextProof)
        await validateCallerScopeEvidence({ sources: [...sources] }, execution.security.ceiling, client)
        if (prepared) await pinPreparedExternalSourceAuthority(client, execution, prepared)
        const value = await run(client)
        await execution.security.authority.assertCurrent()
        if (execution.lifecycle.abortSignal.aborted || JSON.stringify(accumulator.evidence) !== before
          || host !== retainedHosts.get(execution) || !host && wiring !== getSharedRetainedSourceAuthority()) changed()
        await client.query('COMMIT')
        return value
      })
    } finally { releaseApplicationTransactionBinding(client); await rollbackAndRelease(client) }
    if (contextProof) await assertPreparedExternalSourceAuthorityCurrent(execution, contextProof)
    if (prepared) await assertPreparedExternalSourceAuthorityCurrent(execution, prepared)
    await execution.security.authority.assertCurrent()
    return result
  } catch (error) {
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

/** Internal current-reader frame for original session queries, including empty collections. */
export async function readSessionQueryFrame<T>(authority:SessionContextAuthority,rawRoots:readonly ScopeSource[],
 capture:(client:PoolClient)=>Promise<{value:T;sources:readonly ScopeSource[]}>):Promise<T> {
 const {execution}=requireAuthority(authority),roots=structuredClone(rawRoots)
 await execution.security.authority.assertCurrent()
 const wiring=getSharedRetainedSourceAuthority(),host=retainedHosts.get(execution)
 const prepare=host??(wiring?((e:ExecutionContext,s:readonly ScopeSource[],a:'context'|'retain')=>wiring.coordinator.prepare(e,s,a)):undefined)
 const admittedRoots:ScopeSource[]=[]
 for(const root of roots){
  if(root.workspaceId!==execution.security.access.workspaceId)changed()
  if(!(await readExternalSourceAncestors(root.workspaceId,[root])).length&&root.resourceKind!=='external_source')continue
  if(!prepare)changed()
  try{await prepare(execution,[root],'context');admittedRoots.push(root)}
  catch(error){if(!(error instanceof SourceProtocolError)||error.code!=='source_access_denied')throw error}
 }
 // One real source operation binds all admitted roots; separate operation IDs
 // must never replace one another's transaction-scoped source pins.
 const proof=admittedRoots.length?await prepare!(execution,admittedRoots,'context'):undefined
 const assertWiring=()=>{if(host!==retainedHosts.get(execution)||!host&&wiring!==getSharedRetainedSourceAuthority())changed()}
 assertWiring()
 const captured=await transaction(authority,[],'context',false,async client=>{
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
  const currentProof=await prepare!(execution,admittedRoots,'context')
  assertWiring()
  await transaction(authority,[],'context',false,async client=>{
   await pinPreparedExternalSourceAuthority(client,execution,currentProof)
   await validateCallerScopeEvidence({sources:[...captured.sources]},execution.security.ceiling,client)
   assertWiring()
  })
  await assertPreparedExternalSourceAuthorityCurrent(execution,currentProof)
 }
 assertWiring();await execution.security.authority.assertCurrent()
 const value=captured.value
 return value
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
    WHERE r.workspace_id=$1 AND r.session_id=$2 AND r.parent_kind=$3 AND ($5::uuid IS NULL OR r.parent_id=$5)
      AND (annotation.message_id IS NOT NULL OR st.id IS NOT NULL OR e.id IS NOT NULL AND ($4::boolean OR e.promoted_memory_id IS NULL) OR r.parent_kind='compact_summary' AND s.compact_scope_revision_id=r.id)
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
        (await client.query<{ content: Record<string,unknown> | null }>('SELECT read_session_context_revision($1,$2) AS content', [workspaceId,candidate.id])).rows[0]?.content)
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
  // Target session is a real persisted invocation, but read sources may be
  // different sessions authorized under the same canonical actor.
  if (execution.lifecycle.sessionPersisted === false || execution.lifecycle.sessionId !== input.sessionId || execution.surface.readOnly) changed()
  const accumulated = new ContextScopeAccumulator(execution.security.provenance)
  accumulated.note(authority.accumulator.evidence)
  if (!input.derivation) missing()
  accumulated.note({ sources: input.derivation.sources })
  if (input.kind==='message_annotation') {
    if (!input.parentId) missing()
    const native=(await getPool().query<{source:ScopeSource & {held?:boolean}}>(`SELECT read_scope_source($1,'session_message',id) AS source
      FROM session_messages WHERE workspace_id=$1 AND session_id=$2 AND id=$3`,
      [execution.security.access.workspaceId,input.sessionId,input.parentId])).rows[0]?.source
    if (!native || native.held!==false) changed()
    const {workspaceId,userId,assistantId,sensitivity,compartments,projectIds,resourceKind,resourceId,version}=native
    accumulated.noteSource({workspaceId,userId,assistantId,sensitivity,compartments,projectIds,resourceKind,resourceId,version})
  }
  const evidence: DerivedWriteEvidence = { producer: input.derivation.producer, sources: accumulated.evidence.sources ?? [] }
  deriveWriteScope(evidence, { workspaceId: execution.security.access.workspaceId, userId: execution.security.access.userId,
    assistantId: null, sensitivity: 'public', compartments: [], projectIds: [] }, execution.security.access.userId)
  const ancestors = [...await readExternalSourceAncestors(execution.security.access.workspaceId,evidence.sources),
    ...await readApplicationFieldAncestors(execution.security.access.workspaceId,evidence.sources)]
  const all = new ContextScopeAccumulator({ sources: [...evidence.sources,...ancestors] })
  evidence.sources = all.evidence.sources ?? []
  const payload = structuredClone(input.content), parentId = input.parentId ?? randomUUID(), id = randomUUID()
  const stored = await transaction(authority,evidence.sources,'retain',false,async client => {
    const result=(await client.query<{value:{source:ScopeSource;createdAt:string;userId:string;assistantId:string}|null}>(
      'SELECT publish_native_session_context_revision($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) AS value',
      [execution.security.access.workspaceId,input.sessionId,input.kind,input.kind==='compact_summary'?input.sessionId:parentId,id,
       payload,evidence.producer,JSON.stringify(evidence.sources),input.expectedRevision??null,input.expectedGeneration??null,input.expectedCursor??null])).rows[0]?.value
    if(!result)return null
    const source=result.source
    if(source.workspaceId!==execution.security.access.workspaceId||source.resourceKind!=='session_context_revision'||source.resourceId!==id||source.version!=='1')changed()
    const createdAt=new Date(result.createdAt)
    return bindScopeSource({id,parentId:input.kind==='compact_summary'?input.sessionId:parentId,sessionId:input.sessionId,source,content:payload,
      userId:result.userId,assistantId:result.assistantId,createdAt,lastAccessedAt:createdAt,accessCount:0,survivalCount:0},source)
  },input.sessionId)
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

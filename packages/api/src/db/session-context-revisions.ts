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

export type SessionContextKind = 'session_state' | 'episodic_memory' | 'compact_summary'
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
function changed(): never { throw new DerivedScopeError('scope_source_changed') }
function requireAuthority(authority: SessionContextAuthority | undefined): SessionContextAuthority {
  if (!authority?.execution || !(authority.accumulator instanceof ContextScopeAccumulator)) missing()
  return authority
}
async function transaction<T>(authority: SessionContextAuthority, sources: readonly ScopeSource[], action: 'context' | 'retain',
  owner: boolean, run: (client: PoolClient) => Promise<T>, writeSessionId?: string): Promise<T> {
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
      await applyApplicationRLSContext(client, execution)
      // Take the publication lock before any native source reader takes a
      // parent SHARE lock. Two simultaneous upgrades otherwise deadlock.
      if(writeSessionId)await client.query('SELECT id FROM sessions WHERE id=$1 FOR UPDATE',[writeSessionId])
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
}

/** Discover immutable metadata only. Historical plaintext is never selected. */
export async function readSessionContextRevisions(sessionId: string, kind: SessionContextKind,
  authority?: SessionContextAuthority): Promise<SessionContextRevision[]> {
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
    WHERE r.workspace_id=$1 AND r.session_id=$2 AND r.parent_kind=$3
      AND (st.id IS NOT NULL OR e.id IS NOT NULL OR r.parent_kind='compact_summary' AND s.compact_scope_revision_id=r.id)
    ORDER BY r.id`, [workspaceId,sessionId,kind])).rows
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
  const evidence: DerivedWriteEvidence = { producer: input.derivation.producer, sources: accumulated.evidence.sources ?? [] }
  deriveWriteScope(evidence, { workspaceId: execution.security.access.workspaceId, userId: execution.security.access.userId,
    assistantId: null, sensitivity: 'public', compartments: [], projectIds: [] }, execution.security.access.userId)
  const ancestors = [...await readExternalSourceAncestors(execution.security.access.workspaceId,evidence.sources),
    ...await readApplicationFieldAncestors(execution.security.access.workspaceId,evidence.sources)]
  const all = new ContextScopeAccumulator({ sources: [...evidence.sources,...ancestors] })
  evidence.sources = all.evidence.sources ?? []
  const payload = structuredClone(input.content), parentId = input.parentId ?? randomUUID(), id = randomUUID()
  const stored = await transaction(authority,evidence.sources,'retain',true,async client => {
    const target = (await client.query<{ target: ResourceScope & { createdBy: string; assistant: string } | null }>(
      'SELECT session_context_parent_snapshot($1,$2) AS target', [execution.security.access.workspaceId,input.sessionId])).rows[0]?.target
    if (!target) changed()
    // Serialize logical key updates and compaction publication at the parent.
    const generation=(await client.query<{generation:string}>('SELECT session_context_generation::text AS generation FROM sessions WHERE id=$1 FOR UPDATE',[input.sessionId])).rows[0]?.generation
    if(input.expectedGeneration!==undefined && generation!==input.expectedGeneration)return null
    if(input.kind==='session_state' && !input.parentId && input.expectedGeneration===undefined)missing()
    if (input.kind === 'compact_summary') {
      const current = (await client.query<{ cursor: number | null }>('SELECT compact_boundary_sequence AS cursor FROM sessions WHERE id=$1',[input.sessionId])).rows[0]
      if (!current || current.cursor !== input.expectedCursor) return null
    } else if (input.parentId) {
      const table = input.kind === 'session_state' ? 'session_state' : 'episodic_memories'
      const previous = (await client.query<{ revision: string | null }>(`SELECT scope_revision_id AS revision FROM ${table} WHERE id=$1 AND session_id=$2 FOR UPDATE`, [parentId,input.sessionId])).rows[0]
      if (!previous || previous.revision !== input.expectedRevision) return null
    }
    // Explicit current native-parent admission precedes every derivative; the
    // owner connection alone confers no member/source authority.
    for (const source of evidence.sources) {
      const name = source.resourceKind === 'external_source' ? 'external_source_snapshot($1,$2)'
        : source.resourceKind === 'application_field' ? 'read_admitted_application_field_snapshot($1,$2,$3)'
        : 'read_admitted_native_scope_snapshot($1,$2,$3)'
      const current = (await client.query<{ source: ScopeSource & { held?: boolean } }>(`SELECT ${name} AS source`,
        source.resourceKind === 'application_field' ? [source.workspaceId,source.resourceId,source.version]
          : source.resourceKind === 'external_source' ? [source.workspaceId,source.resourceId]
          : [source.workspaceId,source.resourceKind,source.resourceId])).rows[0]?.source
      if (!current || current.held !== false || current.version !== source.version) changed()
    }
    await validateDerivedWriteInputs(client,evidence)
    const scope = deriveWriteScope(evidence,target,execution.security.access.userId)
    const source: ScopeSource = { ...scope,resourceKind: 'session_context_revision',resourceId: id,version: '1' }
    await client.query(`INSERT INTO session_context_scope_revisions(id,workspace_id,session_id,parent_kind,parent_id,user_id,assistant_id,sensitivity,compartments,project_ids,payload_sha256)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,encode(sha256(convert_to($11::jsonb::text,'UTF8')),'hex'))`,
      [id,scope.workspaceId,input.sessionId,input.kind,input.kind==='compact_summary'?input.sessionId:parentId,scope.userId,scope.assistantId,scope.sensitivity,scope.compartments,scope.projectIds,JSON.stringify(payload)])
    await client.query('INSERT INTO session_context_revision_contents(workspace_id,revision_id,content) VALUES($1,$2,$3)',[scope.workspaceId,id,payload])
    if (input.kind === 'session_state') {
      await client.query(`INSERT INTO session_state(id,session_id,user_id,assistant_id,key,status,summary,detail,source,scope_revision_id)
        VALUES($1::uuid,$2,$3,$4,$1::uuid::text,'open','',NULL,'tool',$5)
        ON CONFLICT(id) DO UPDATE SET scope_revision_id=EXCLUDED.scope_revision_id,updated_at=now()`, [parentId,input.sessionId,target.createdBy,target.assistant,id])
    } else if (input.kind === 'episodic_memory') {
      await client.query(`INSERT INTO episodic_memories(id,user_id,assistant_id,session_id,topic_label,summary,message_span,scope_revision_id)
        VALUES($1,$2,$3,$4,'','','{}',$5)`,[parentId,target.createdBy,target.assistant,input.sessionId,id])
    } else {
      await client.query(`UPDATE sessions SET compact_summary=NULL,compact_scope_revision_id=$2,compact_boundary_sequence=$3,
        compaction_count=compaction_count+1,last_compacted_at=now() WHERE id=$1`,[input.sessionId,id,payload.boundarySequence])
    }
    await client.query('UPDATE sessions SET session_context_generation=session_context_generation+1 WHERE id=$1',[input.sessionId])
    await recordDerivedResource(client,evidence,source,execution.security.access.userId)
    return bindScopeSource({ id,parentId: input.kind==='compact_summary'?input.sessionId:parentId,sessionId: input.sessionId,source,content: payload,
      userId: target.createdBy,assistantId: target.assistant,createdAt: new Date(),lastAccessedAt: new Date(),accessCount: 0,survivalCount: 0 },source)
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

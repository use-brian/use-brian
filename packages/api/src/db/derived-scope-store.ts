import {
  DerivedScopeError, deriveContextFloor, deriveResourceScope, deriveWriteScope, isSensitivity, resourceScopeKey,
  type DerivedWriteEvidence, type ResourceScope, type ScopeSource,
} from '@use-brian/core'
import type pg from 'pg'

type CanonicalEvidenceRow = ResourceScope & {
  version: string
  held: boolean
  retractedAt: Date | null
  validTo: Date | null
  causalEntityId?: string
}

/** Keep the owner-only native snapshot function outside the app-role external statement. */
async function scopeSnapshots(client: Pick<pg.ClientBase, 'query'>, workspaceId: string, sources: readonly ScopeSource[],
  reader: 'read_scope_source' | 'read_entity_derivation_source' = 'read_scope_source', workflowRunId?: string, requiredExternalAction?: 'context' | 'deliver', admittedNative = false, recordedFields = false) {
  const result: Array<{ ord: number; snapshot: CanonicalEvidenceRow | null }> = []
  for (const profile of ['native','field','external'] as const) {
    const group = sources.map((source,index) => ({ source,index })).filter(({ source }) =>
      (source.resourceKind === 'external_source' ? 'external' : source.resourceKind === 'application_field' ? 'field' : 'native') === profile)
    if (group.length === 0) continue
    const rows = profile === 'field' ? (await client.query<{ ord: number; snapshot: CanonicalEvidenceRow | null }>(
      recordedFields ? 'SELECT ord,snapshot FROM read_native_session_field_snapshots($1,$2,$3)'
        : `SELECT t.ord::int AS ord,read_entity_derivation_source($1,'application_field',t.id) AS snapshot
       FROM unnest($2::uuid[],$3::text[]) WITH ORDINALITY AS t(id,version,ord)`,
      [workspaceId,group.map(({ source }) => source.resourceId),group.map(({ source }) => source.version)])).rows
      : profile === 'external' ? (await client.query<{ ord: number; snapshot: CanonicalEvidenceRow | null }>(
      `SELECT t.ord::int AS ord,${requiredExternalAction ? "CASE WHEN current_setting('app.external_source_action',true)=$3 THEN external_source_snapshot($1,t.id) ELSE '{\"held\":true}'::jsonb END" : 'external_source_snapshot($1,t.id)'} AS snapshot
        FROM unnest($2::uuid[]) WITH ORDINALITY AS t(id,ord)`,
      [workspaceId,group.map(({ source }) => source.resourceId),...(requiredExternalAction ? [requiredExternalAction] : [])])).rows
      : (await client.query<{ ord: number; snapshot: CanonicalEvidenceRow | null }>(
        `SELECT t.ord::int AS ord,${workflowRunId ? 'read_workflow_validation_source($1,$4,t.kind,t.id)' : `${admittedNative ? 'read_admitted_native_scope_snapshot' : reader}($1,t.kind,t.id)`} AS snapshot
          FROM unnest($2::text[],$3::uuid[]) WITH ORDINALITY AS t(kind,id,ord)`,
        [workspaceId,group.map(({ source }) => source.resourceKind),group.map(({ source }) => source.resourceId),...(workflowRunId ? [workflowRunId] : [])])).rows
    for (const row of rows) if (group[row.ord - 1]) result.push({ ord: group[row.ord - 1].index + 1, snapshot: row.snapshot })
  }
  return result
}

/** Context/read receipts cannot authorize durable derivatives. SQL independently guards lineage inserts. */
async function requireExternalRetention(client: Pick<pg.PoolClient, 'query'>, evidence: DerivedWriteEvidence) {
  const external = evidence.sources.filter(source => source.resourceKind === 'external_source')
  if (!external.length) return
  const rows = (await client.query<{ allowed: boolean }>(`SELECT external_source_retention_allowed(t.workspace,t.id,t.version) AS allowed
    FROM unnest($1::uuid[],$2::uuid[],$3::text[]) AS t(workspace,id,version)`,
    [external.map(source => source.workspaceId),external.map(source => source.resourceId),external.map(source => source.version)])).rows
  if (rows.length !== external.length || rows.some(row => row.allowed !== true)) throw new DerivedScopeError('scope_source_changed')
}

/** Must run inside the SAME transaction as the canonical writer. */
export async function validateDerivedMemoryInputs(
  client: Pick<pg.PoolClient, 'query'>,
  evidence: DerivedWriteEvidence,
): Promise<ResourceScope> {
  const floor = deriveResourceScope(evidence)
  await requireExternalRetention(client, evidence)
  await revalidateScopeSources(client, floor.workspaceId, evidence.sources)
  return floor
}

/** Entity/knowledge metadata adapter preserves app-role read authority. */
export async function validateDerivedEntityInputs(
  client: Pick<pg.PoolClient, 'query'>, evidence: DerivedWriteEvidence,
): Promise<ResourceScope> {
  const floor = deriveResourceScope(evidence)
  await requireExternalRetention(client, evidence)
  await revalidateScopeSources(client, floor.workspaceId, evidence.sources, 'read_entity_derivation_source')
  return floor
}

/**
 * Inputs of a model-driven write (decision D3). Same exact-version lineage
 * as `validateDerivedMemoryInputs`, but only the LABEL floor comes back: the
 * write keeps its target's own visibility (`deriveWriteScope`), so a primary
 * that read several assistants' rows can still save. Must run inside the
 * canonical writer's transaction.
 */
export async function validateDerivedWriteInputs(
  client: Pick<pg.PoolClient, 'query'>,
  evidence: DerivedWriteEvidence,
): Promise<Pick<ResourceScope, 'workspaceId' | 'sensitivity' | 'compartments' | 'projectIds'>> {
  const labels = deriveContextFloor(evidence)
  await requireExternalRetention(client, evidence)
  const workspaceId = evidence.sources[0]!.workspaceId
  await revalidateScopeSources(client, workspaceId, evidence.sources)
  return { workspaceId, ...labels }
}

/**
 * Prove every source is still live and at the exact version read. This is
 * lineage for a derived write, locked FOR SHARE inside the writer's
 * transaction. Audience and consult checks judge current labels instead
 * (`readCurrentScopeSources`).
 *
 * One statement per authority profile (native and external). A round trip per source made a transcript
 * flush cost `rows x sources` round trips (45 s for eight buffered tool rounds
 * over ~100 sources on 2026-09-29). `unnest ... WITH ORDINALITY` evaluates
 * `read_scope_source`, and so takes its locks, in array order, which keeps the
 * shared sorted native lock order every writer uses. External observations use
 * their separate receipt-scoped facade and never grant access to native snapshots.
 */
async function revalidateScopeSources(
  client: Pick<pg.PoolClient, 'query'>,
  workspaceId: string,
  sources: readonly ScopeSource[],
  reader: 'read_scope_source' | 'read_entity_derivation_source' = 'read_scope_source',
): Promise<void> {
  const unique = new Map(sources.map(source=>[`${source.resourceKind}:${source.resourceId}`,source]))
  // All writers use the same lock order, including mixed primitive prompts.
  const list=[...unique.values()].sort((a,b)=>`${a.resourceKind}:${a.resourceId}`.localeCompare(`${b.resourceKind}:${b.resourceId}`))
  for(const source of list)if(source.workspaceId!==workspaceId)throw new DerivedScopeError('scope_workspace_mismatch')
  if(list.length===0)return
  const rows=await scopeSnapshots(client,workspaceId,list,reader,undefined,undefined,list.some(source=>source.resourceKind==='application_field'))
  const byOrd=new Map(rows.map(row=>[row.ord,row.snapshot]))
  list.forEach((source,index)=>{
    const row=byOrd.get(index+1)
    if(!row||row.held||row.retractedAt||row.validTo||row.version!==source.version
      ||resourceScopeKey(row)!==resourceScopeKey(source))throw new DerivedScopeError('scope_source_changed')
    // A historical event's audience is only half of its current authorization.
    // Require the live entity edge even if a future producer forgets to add it.
    if(source.resourceKind==='crm_event' && (!row.causalEntityId
      || !unique.has(`entity:${row.causalEntityId}`))) throw new DerivedScopeError('scope_evidence_missing')
  })
}

/**
 * What became of a source between the read and an audience/consult check.
 * `gone` covers delete, supersession, retraction and legacy rows: the content
 * was read under the recorded envelope, and removing it later does not make
 * that read unauthorized (scoped-context.md -> "Audience checks are per
 * source", decision D1). External observations never use that historical
 * allowance: missing, retired or changed observations are unverifiable.
 */
export type CurrentSourceState =
  | { state: 'current'; source: ScopeSource }
  | { state: 'changed'; source: ScopeSource; current: ResourceScope }
  | { state: 'gone'; source: ScopeSource }
  | { state: 'held'; source: ScopeSource }
  | { state: 'unverifiable'; source: ScopeSource }
  /** A causal input (a CRM event) whose content changed: exact-version only. */
  | { state: 'stale_input'; source: ScopeSource }

/**
 * One round trip per authority profile, no write transaction: an audience check couples
 * no write to these rows, so it needs the current envelope, not a lock held
 * across a later statement. Derived writers use `revalidateScopeSources`.
 */
export async function readCurrentScopeSources(
  client: Pick<pg.ClientBase, 'query'>,
  workspaceId: string,
  sources: readonly ScopeSource[],
  workflowRunId?: string,
  requiredExternalAction?: 'context' | 'deliver',
  admittedNative = false,
): Promise<CurrentSourceState[]> {
  const unique = new Map(sources.map(source=>[`${source.resourceKind}:${source.resourceId}`,source]))
  const list = [...unique.values()]
  if (list.length === 0) return []
  if (list.some(source=>source.workspaceId!==workspaceId)) throw new DerivedScopeError('scope_workspace_mismatch')
  const rows = await scopeSnapshots(client,workspaceId,list,'read_scope_source',workflowRunId,requiredExternalAction,admittedNative,true)
  const byOrd = new Map(rows.map(row=>[row.ord, row.snapshot]))
  return list.map((source, index): CurrentSourceState => {
    // No result row at all is a failed read, not a deleted source.
    if (!byOrd.has(index + 1)) return { state: 'unverifiable', source }
    const row = byOrd.get(index + 1) ?? null
    // A CRM event snapshot is withheld (NULL) while held or retired, so its
    // absence is not proof of deletion.
    if (!row) return source.resourceKind === 'external_source' || source.resourceKind === 'application_field' || source.resourceKind === 'session_context_revision' ? { state: 'unverifiable', source }
      : source.resourceKind === 'crm_event' ? { state: 'held', source } : { state: 'gone', source }
    if (row.held) return { state: 'held', source }
    if (source.resourceKind === 'crm_event' && (!row.causalEntityId
      || !unique.has(`entity:${row.causalEntityId}`))) return { state: 'unverifiable', source }
    if (row.retractedAt || row.validTo) return source.resourceKind === 'external_source' ? { state: 'unverifiable', source } : { state: 'gone', source }
    if (row.version === source.version && resourceScopeKey(row) === resourceScopeKey(source)) {
      return { state: 'current', source }
    }
    if (source.resourceKind === 'external_source') return { state: 'unverifiable', source }
    // An outbox event is immutable by nature and is the run's causal input:
    // a changed payload means the run would finish on stale input, so its
    // version must still match (scoped-context.md -> "CRM workflow input
    // provenance"). Current-label judgement is for rows a turn edits itself.
    if (source.resourceKind === 'crm_event') return { state: 'stale_input', source }
    // The current envelope is judged against the receiver, so it must be
    // complete: a missing label axis is not General.
    if (!isSensitivity(row.sensitivity) || !Array.isArray(row.compartments) || !Array.isArray(row.projectIds)
      || typeof row.workspaceId !== 'string') return { state: 'unverifiable', source }
    return { state: 'changed', source, current: {
      workspaceId: row.workspaceId, userId: row.userId, assistantId: row.assistantId,
      sensitivity: row.sensitivity, compartments: row.compartments, projectIds: row.projectIds,
    } }
  })
}

/** The database validates the output reference and envelope again. */
export async function recordDerivedResource(
  client: Pick<pg.PoolClient, 'query'>,
  evidence: DerivedWriteEvidence,
  output: ScopeSource,
  /** The acting author, whose own private rows may feed a wider target (D3). */
  actorUserId?: string | null,
): Promise<void> {
  // The output must carry every label it was derived from and must not take
  // another person's private rows anywhere else; its assistant visibility is
  // the target's own (decision D3).
  await requireExternalRetention(client, evidence)
  const floor = deriveWriteScope(evidence, output, actorUserId)
  if (resourceScopeKey(floor) !== resourceScopeKey(output)) {
    throw new DerivedScopeError('scope_visibility_incompatible')
  }
  if (evidence.sources.some(source => source.resourceKind === 'application_field')) {
    await client.query('SELECT record_admitted_application_field_derivation($1,$2,$3,$4,$5,$6)',
      [output.workspaceId,output.resourceKind,output.resourceId,output.version,evidence.producer,JSON.stringify(evidence.sources)])
    return
  }
  await client.query(`INSERT INTO workspace_access_policies(workspace_id) VALUES($1) ON CONFLICT DO NOTHING`, [output.workspaceId])
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO scope_derivations(workspace_id,resource_kind,resource_id,resource_version,producer,
       user_id,assistant_id,sensitivity,compartments,project_ids,source_policy_revision)
     SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,revision FROM workspace_access_policies WHERE workspace_id = $1
     RETURNING id`,
    [output.workspaceId, output.resourceKind, output.resourceId, output.version, evidence.producer,
      output.userId, output.assistantId, output.sensitivity, output.compartments, output.projectIds],
  )
  const unique = new Map(evidence.sources.map((source) => [`${source.resourceKind}:${source.resourceId}`, source]))
  const list = [...unique.values()].sort((a,b)=>`${a.resourceKind}:${a.resourceId}`.localeCompare(`${b.resourceKind}:${b.resourceId}`))
  if (list.length === 0) return
  // One multi-row insert: lineage is bounded by rows written, not by sources read.
  await client.query(
    `INSERT INTO scope_derivation_sources(workspace_id,derivation_id,source_kind,source_id,source_version)
     SELECT $1,$2,t.kind,t.id,t.version FROM unnest($3::text[],$4::uuid[],$5::text[]) AS t(kind,id,version)`,
    [output.workspaceId, rows[0].id, list.map(s=>s.resourceKind), list.map(s=>s.resourceId), list.map(s=>s.version)],
  )
  // Page lineage is enforced only on files and their segments (migration
  // 730). For every other family, run the deferred dependency check now, so a
  // page-derived write is refused here as a typed error with a recovery path
  // instead of failing at COMMIT with a raw code.
  if (!PAGE_LINEAGE_OUTPUT_KINDS.has(output.resourceKind)) {
    try {
      await client.query('SET CONSTRAINTS page_derivation_dependencies IMMEDIATE')
    } catch (error) {
      if (error instanceof Error && error.message === 'page_derivation_output_not_integrated') {
        throw new DerivedScopeError('scope_output_not_integrated')
      }
      throw error
    }
    await client.query('SET CONSTRAINTS page_derivation_dependencies DEFERRED')
  }
}

/** Output families whose readers enforce page ancestry. */
const PAGE_LINEAGE_OUTPUT_KINDS = new Set(['workspace_file', 'file_segment', 'session_context_revision'])

import {
  DerivedScopeError, deriveResourceScope, resourceScopeKey,
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

/** Must run inside the SAME transaction as the canonical writer. */
export async function validateDerivedMemoryInputs(
  client: Pick<pg.PoolClient, 'query'>,
  evidence: DerivedWriteEvidence,
): Promise<ResourceScope> {
  const floor = deriveResourceScope(evidence)
  const unique = new Map(evidence.sources.map(source=>[`${source.resourceKind}:${source.resourceId}`,source]))
  // All writers use the same lock order, including mixed primitive prompts.
  for(const source of [...unique.values()].sort((a,b)=>`${a.resourceKind}:${a.resourceId}`.localeCompare(`${b.resourceKind}:${b.resourceId}`))) {
    const result=await client.query<{snapshot:CanonicalEvidenceRow|null}>(
      'SELECT read_scope_source($1,$2,$3) AS snapshot',[floor.workspaceId,source.resourceKind,source.resourceId],
    )
    const row=result.rows[0]?.snapshot
    if(!row||row.held||row.retractedAt||row.validTo||row.version!==source.version
      ||resourceScopeKey(row)!==resourceScopeKey(source))throw new DerivedScopeError('scope_source_changed')
    // A historical event's audience is only half of its current authorization.
    // Require the live entity edge even if a future producer forgets to add it.
    if(source.resourceKind==='crm_event' && (!row.causalEntityId
      || !unique.has(`entity:${row.causalEntityId}`))) throw new DerivedScopeError('scope_evidence_missing')
  }
  return floor
}

/** The database validates the output reference and envelope again. */
export async function recordDerivedResource(
  client: Pick<pg.PoolClient, 'query'>,
  evidence: DerivedWriteEvidence,
  output: ScopeSource,
): Promise<void> {
  const floor = deriveResourceScope(evidence, output)
  if (resourceScopeKey(floor) !== resourceScopeKey(output)) {
    throw new DerivedScopeError('scope_visibility_incompatible')
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
  for (const source of [...unique.values()].sort((a,b)=>`${a.resourceKind}:${a.resourceId}`.localeCompare(`${b.resourceKind}:${b.resourceId}`))) {
    await client.query(
      `INSERT INTO scope_derivation_sources(workspace_id,derivation_id,source_kind,source_id,source_version)
       VALUES($1,$2,$3,$4,$5)`,
      [output.workspaceId, rows[0].id, source.resourceKind, source.resourceId, source.version],
    )
  }
}

/** Backward-compatible memory writer name used by canonical memory stores. */
export const recordMemoryDerivation = recordDerivedResource

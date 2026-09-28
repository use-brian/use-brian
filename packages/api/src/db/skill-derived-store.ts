import {
  bindScopeSource,
  bornActivated,
  bornConfidence,
  bornVerified,
  SKILL_USAGE_CONFIDENCE_CAP,
  SKILL_USAGE_CONFIDENCE_INCREMENT,
  type DerivedWriteEvidence,
  type ResourceScope,
  type ScopeSource,
} from '@use-brian/core'
import type pg from 'pg'
import { getPool } from './client.js'
import { recordDerivedResource, validateDerivedMemoryInputs } from './derived-scope-store.js'

type RevisionRow = ResourceScope & {
  id: string
  skillId: string
  scopeVersion: string
  scopeHeld: boolean
}

function revisionSource(row: RevisionRow): ScopeSource {
  return {
    workspaceId: row.workspaceId,
    userId: row.userId,
    assistantId: row.assistantId,
    sensitivity: row.sensitivity,
    compartments: row.compartments,
    projectIds: row.projectIds,
    resourceKind: 'workspace_skill_revision',
    resourceId: row.id,
    version: row.scopeVersion,
  }
}

export function bindWorkspaceSkillRevision<T extends object>(value: T, row: RevisionRow | null): T {
  return row && !row.scopeHeld ? bindScopeSource(value, revisionSource(row)) : value
}

export async function readWorkspaceSkillRevisionSource(
  workspaceId: string,
  skillId: string,
  client?: Pick<pg.ClientBase, 'query'>,
): Promise<ScopeSource | null> {
  const db = client ?? getPool()
  const result = await db.query<RevisionRow>(
    `SELECT sr.id, sr.skill_id AS "skillId", sr.workspace_id AS "workspaceId",
            sr.user_id AS "userId", sr.assistant_id AS "assistantId",
            sr.sensitivity, sr.compartments, sr.project_ids AS "projectIds",
            sr.scope_version::text AS "scopeVersion", sr.scope_held AS "scopeHeld"
       FROM workspace_skills s
       JOIN workspace_skill_scope_revisions sr ON sr.id=s.scope_revision_id
      WHERE s.workspace_id=$1 AND s.id=$2 AND NOT sr.scope_held`,
    [workspaceId, skillId],
  )
  return result.rows[0] ? revisionSource(result.rows[0]) : null
}

async function appendRevision(
  client: Pick<pg.ClientBase, 'query'>,
  skillId: string,
  evidence: DerivedWriteEvidence,
): Promise<ScopeSource> {
  const scope = await validateDerivedMemoryInputs(client, evidence)
  const result = await client.query<RevisionRow>(
    `INSERT INTO workspace_skill_scope_revisions(
       workspace_id,skill_id,revision,user_id,assistant_id,sensitivity,compartments,project_ids
     )
     SELECT $1,$2,COALESCE(MAX(revision),0)+1,$3,$4,$5,$6,$7
       FROM workspace_skill_scope_revisions WHERE skill_id=$2
     RETURNING id,skill_id AS "skillId",workspace_id AS "workspaceId",
       user_id AS "userId",assistant_id AS "assistantId",sensitivity,compartments,
       project_ids AS "projectIds",scope_version::text AS "scopeVersion",scope_held AS "scopeHeld"`,
    [scope.workspaceId, skillId, scope.userId, scope.assistantId, scope.sensitivity,
      scope.compartments, scope.projectIds],
  )
  const source = revisionSource(result.rows[0])
  await recordDerivedResource(client, evidence, source)
  await client.query(
    `UPDATE workspace_skills SET scope_revision_id=$1,updated_at=now()
      WHERE id=$2 AND workspace_id=$3`,
    [source.resourceId, skillId, scope.workspaceId],
  )
  return source
}

async function withCurrentRevision(
  client: Pick<pg.ClientBase, 'query'>,
  workspaceId: string,
  revisionId: string | null,
  evidence: DerivedWriteEvidence,
): Promise<DerivedWriteEvidence> {
  if (!revisionId) throw new Error('scope_evidence_missing')
  const current = await client.query<{ snapshot: ScopeSource | null }>(
    `SELECT read_scope_source($1,'workspace_skill_revision',$2) AS snapshot`,
    [workspaceId, revisionId],
  )
  const source = current.rows[0]?.snapshot
  if (!source) throw new Error('scope_source_changed')
  if (evidence.sources.some((candidate) =>
    candidate.resourceKind === source.resourceKind
    && candidate.resourceId === source.resourceId
    && candidate.version === source.version)) return evidence
  return { ...evidence, sources: [...evidence.sources, source] }
}

async function inTransaction<T>(work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect()
  try {
    await client.query('BEGIN')
    const result = await work(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }
}

export async function applyDerivedSkillPatch(params: {
  workspaceId: string
  skillId: string
  content: string
  diff: string | null
  evidence: DerivedWriteEvidence
  leaseHolderId?: string
}): Promise<void> {
  await inTransaction(async (client) => {
    await validateDerivedMemoryInputs(client, params.evidence)
    const values: unknown[] = [params.content, params.diff, params.skillId, params.workspaceId]
    const lease = params.leaseHolderId
      ? `AND review_lease_held_by=$5 AND review_lease_until>now()`
      : ''
    if (params.leaseHolderId) values.push(params.leaseHolderId)
    const updated = await client.query<{ scopeRevisionId: string | null }>(
      `UPDATE workspace_skills
          SET content=$1,last_patch_diff=$2,last_patch_diff_at=now(),updated_at=now()
        WHERE id=$3 AND workspace_id=$4 AND valid_to IS NULL ${lease}
        RETURNING scope_revision_id AS "scopeRevisionId"`,
      values,
    )
    if ((updated.rowCount ?? 0) !== 1) throw new Error('scope_source_changed')
    const evidence = await withCurrentRevision(
      client,
      params.workspaceId,
      updated.rows[0].scopeRevisionId,
      params.evidence,
    )
    await appendRevision(client, params.skillId, evidence)
  })
}

export async function recordDerivedSkillRederivation(params: {
  workspaceId: string
  skillId: string
  evidence: DerivedWriteEvidence
}): Promise<void> {
  await inTransaction(async (client) => {
    const locked = await client.query<{ scopeRevisionId: string | null }>(
      `UPDATE workspace_skills
          SET rederivation_count=rederivation_count+1,
              confidence=CASE WHEN verified_at IS NULL
                THEN LEAST(confidence+$3,$4) ELSE confidence END,
              updated_at=now()
        WHERE id=$1 AND workspace_id=$2 AND valid_to IS NULL
        RETURNING scope_revision_id AS "scopeRevisionId"`,
      [params.skillId, params.workspaceId,
        SKILL_USAGE_CONFIDENCE_INCREMENT, SKILL_USAGE_CONFIDENCE_CAP],
    )
    if ((locked.rowCount ?? 0) !== 1) throw new Error('scope_source_changed')
    const evidence = await withCurrentRevision(
      client,
      params.workspaceId,
      locked.rows[0].scopeRevisionId,
      params.evidence,
    )
    await appendRevision(client, params.skillId, evidence)
  })
}

export async function applyDerivedSkillSupportFile(params: {
  workspaceId: string
  skillId: string
  kind: 'reference' | 'template' | 'script'
  name: string
  content: string
  description?: string | null
  evidence: DerivedWriteEvidence
  leaseHolderId?: string
}): Promise<void> {
  await inTransaction(async (client) => {
    await validateDerivedMemoryInputs(client, params.evidence)
    const lock = await client.query<{ scopeRevisionId: string | null }>(
      `SELECT scope_revision_id AS "scopeRevisionId" FROM workspace_skills
       WHERE id=$1 AND workspace_id=$2 AND valid_to IS NULL
        ${params.leaseHolderId ? 'AND review_lease_held_by=$3 AND review_lease_until>now()' : ''}
        FOR UPDATE`,
      params.leaseHolderId
        ? [params.skillId, params.workspaceId, params.leaseHolderId]
        : [params.skillId, params.workspaceId],
    )
    if ((lock.rowCount ?? 0) !== 1) throw new Error('scope_source_changed')
    const evidence = await withCurrentRevision(
      client,
      params.workspaceId,
      lock.rows[0].scopeRevisionId,
      params.evidence,
    )
    await client.query(
      `INSERT INTO workspace_skill_files(workspace_skill_id,kind,name,content,description)
       VALUES($1,$2,$3,$4,$5)
       ON CONFLICT(workspace_skill_id,kind,name) DO UPDATE SET
         content=EXCLUDED.content,description=EXCLUDED.description,updated_at=now()`,
      [params.skillId, params.kind, params.name, params.content, params.description ?? null],
    )
    await appendRevision(client, params.skillId, evidence)
  })
}

export async function createDerivedWorkspaceSkill(params: {
  workspaceId: string
  authorUserId: string | null
  slug: string
  name: string
  description: string
  whenToUse?: string | null
  content: string
  category?: string
  requiresConnectors?: string[]
  source: 'user' | 'auto-generated'
  writeOrigin: 'foreground' | 'background_review'
  originatingAssistantId?: string | null
  inductionSource?: 'self' | 'ingested' | 'authored'
  /** True only after an attended human admission gate. Silent curator
   * creations remain suggested even when their induction source is self. */
  humanApproved: boolean
  evidence: DerivedWriteEvidence
}): Promise<{ rowId: string; slug: string }> {
  return inTransaction(async (client) => {
    const scope = await validateDerivedMemoryInputs(client, params.evidence)
    if (scope.workspaceId !== params.workspaceId) throw new Error('scope_workspace_mismatch')
    const inductionSource = params.inductionSource ?? 'self'
    const confidence = params.humanApproved ? bornConfidence(inductionSource) : 0
    const activated = params.humanApproved && bornActivated(inductionSource)
    const verified = params.humanApproved && bornVerified(inductionSource)
    const created = await client.query<{ id: string; slug: string }>(
      `INSERT INTO workspace_skills(
         slug,name,description,when_to_use,content,category,requires_connectors,
         source,author_id,workspace_id,write_origin,originating_assistant_id,
         auto_generated_at,induction_source,confidence,activated_at,
         verified_by_user_id,verified_at
       ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,
         CASE WHEN $8='auto-generated' THEN now() ELSE NULL END,$13,$14,
         CASE WHEN $15 THEN now() ELSE NULL END,
         CASE WHEN $16 THEN $9::uuid ELSE NULL END,
         CASE WHEN $16 THEN now() ELSE NULL END)
       RETURNING id,slug`,
      [params.slug,params.name,params.description,params.whenToUse ?? null,params.content,
        params.category ?? 'custom',params.requiresConnectors ?? [],params.source,
        params.authorUserId,params.workspaceId,params.writeOrigin,
        params.originatingAssistantId ?? null,inductionSource,confidence,activated,verified],
    )
    const row = created.rows[0]
    await appendRevision(client, row.id, params.evidence)
    return { rowId: row.id, slug: row.slug }
  })
}

export async function softDeprecateScopedSkill(params: {
  workspaceId: string
  skillId: string
  source: ScopeSource
}): Promise<void> {
  await inTransaction(async (client) => {
    await validateDerivedMemoryInputs(client, { producer: 'skill:decay', sources: [params.source] })
    const result = await client.query(
      `UPDATE workspace_skills SET valid_to=now(),updated_at=now()
        WHERE id=$1 AND workspace_id=$2 AND scope_revision_id=$3 AND valid_to IS NULL`,
      [params.skillId, params.workspaceId, params.source.resourceId],
    )
    if ((result.rowCount ?? 0) !== 1) throw new Error('scope_source_changed')
  })
}

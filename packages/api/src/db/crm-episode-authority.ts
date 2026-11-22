import type pg from 'pg'
import type { AccessContext } from '@use-brian/agent-runtime/security/access-context.js'
import { resourceScopeKey, type DerivedWriteEvidence, type ScopeSource } from '@use-brian/agent-runtime/security/derived-scope.js'
import type { CrmEpisodeScope } from '@use-brian/core/crm/types.js'

import { readAdmissionPolicy } from '../workspace-access/admission-policy-read.js'
import { buildAccessPredicate, buildCurrentMemberSourcePredicate } from './access-predicate.js'
import { runWithAgentAccess } from './agent-access-context.js'
import { applyRLSGucs } from './client.js'
import { inspectExtractionEntityTarget } from './entities-store.js'

export type CrmEpisodeExecution = {
  sourceScope?: CrmEpisodeScope
  replayAccess?: AccessContext
}

export class CrmEpisodeHold extends Error {
  constructor(readonly code: 'application_crm_source_changed' | 'application_entity_scope_mismatch'
    | 'application_crm_merge_provenance_required' | 'application_crm_policy_unavailable' | 'application_entity_identity_ambiguous') {
    super(code)
  }
}

type CrmEpisodeAuthority = {
  source: ScopeSource
  access: AccessContext
  replayAccess: AccessContext
  derivation: DerivedWriteEvidence
}

/** The Episode's author supplies the origin. The applying actor still needs live mutation reach. */
export async function authorizeCrmEpisode(
  client: pg.PoolClient,
  author: AccessContext,
  episodeId: string,
  execution?: CrmEpisodeExecution,
): Promise<CrmEpisodeAuthority> {
  const replay = execution?.replayAccess ?? author
  const expected = execution?.sourceScope
  const workspaceId = author.workspaceId
  if (replay.workspaceId !== workspaceId || (expected && expected.workspaceId !== workspaceId)) {
    throw new CrmEpisodeHold('application_crm_source_changed')
  }

  // CRM admission and entity derivation both lock the workspace before the resource.
  await client.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [workspaceId])
  await applyRLSGucs(client, author.userId)
  const application = buildAccessPredicate(replay, { alias: 'e', operation: 'mutation', startIdx: 4 })
  const member = buildCurrentMemberSourcePredicate(replay.userId, { alias: 'e', operation: 'mutation', startIdx: application.nextIdx })
  const result = await client.query<{ source: (ScopeSource & { held: boolean }) | null }>(
    `SELECT read_entity_derivation_source($1,'episode',$2) AS source
       FROM episodes e
      WHERE e.workspace_id=$1 AND e.id=$2 AND e.created_by_user_id=$3
        AND NOT e.scope_held AND NOT e.extraction_locked
        AND ${application.sql} AND ${member.sql}`,
    [workspaceId, episodeId, author.userId, ...application.params, ...member.params],
  )
  const row = result.rows[0]?.source
  if (!row || row.held || (expected && (resourceScopeKey(row) !== resourceScopeKey(expected)
    || (expected.scopeVersion !== undefined && row.version !== expected.scopeVersion)))) {
    throw new CrmEpisodeHold('application_crm_source_changed')
  }

  const source: ScopeSource = {
    resourceId: episodeId, resourceKind: 'episode', version: row.version, workspaceId,
    userId: row.userId, assistantId: row.assistantId, sensitivity: row.sensitivity,
    compartments: row.compartments, projectIds: row.projectIds,
  }
  const access: AccessContext = {
    ...author,
    clearance: source.sensitivity,
    assistantId: source.assistantId ?? '',
    visibilityAssistantIds: source.assistantId ? [source.assistantId] : [],
    sharedAudience: source.userId === null,
    compartments: source.compartments,
    mutationCompartments: source.compartments,
    projectIds: source.projectIds,
  }
  await runWithAgentAccess({ ...access, clearance: source.sensitivity, compartments: source.compartments, projectIds: source.projectIds },
    () => applyRLSGucs(client, author.userId, source.assistantId ?? undefined))
  return { source, access, replayAccess: replay, derivation: { producer: 'pipeline-b', sources: [source] } }
}

/** Match a company identity under source authority without reading its CRM field data. */
export async function findCrmEpisodeCompanyId(
  client: pg.PoolClient,
  authority: CrmEpisodeAuthority,
  name: string,
): Promise<string | undefined> {
  const { access } = authority
  const projection = buildAccessPredicate(access, { alias: 'e', startIdx: 3 })
  const member = buildCurrentMemberSourcePredicate(access.userId, { alias: 'e', operation: 'read', startIdx: projection.nextIdx })
  const result = await client.query<{ id: string }>(
    `SELECT e.id FROM entities e WHERE e.workspace_id=$1 AND e.kind='company'
      AND lower(e.display_name)=lower($2) AND e.valid_from<=now()
      AND e.valid_to IS NULL AND e.retracted_at IS NULL AND NOT e.scope_held
      AND ${projection.sql} AND ${member.sql} LIMIT 2`,
    [access.workspaceId, name, ...projection.params, ...member.params],
  )
  if (result.rows.length > 1) throw new CrmEpisodeHold('application_entity_identity_ambiguous')
  return result.rows[0]?.id
}

/** An automatic merge cannot move Episode evidence into a wider existing audience. */
export async function assertCrmEpisodeMergeTarget(
  client: pg.PoolClient,
  authority: CrmEpisodeAuthority,
  id: string,
  kind: 'person' | 'company',
): Promise<void> {
  const { source } = authority
  const row = await inspectExtractionEntityTarget(authority.access, authority.replayAccess, {
    id, kind, canonicalId: null, normalizedName: '',
  }, client)
  if (!row || (source.userId !== null && source.userId !== row.userId)
    || (source.assistantId !== null && source.assistantId !== row.assistantId)
    || row.sensitivity !== source.sensitivity
    || source.compartments.some((label) => !row.compartments.includes(label))
    || source.projectIds.some((projectId) => !row.projectIds.includes(projectId))) {
    throw new CrmEpisodeHold('application_entity_scope_mismatch')
  }
}

/** The canonical derivation writer records the existing policy revision. */
export async function ensureCrmEpisodeDerivationPolicy(client: pg.PoolClient, workspaceId: string): Promise<void> {
  if (await readAdmissionPolicy(client, workspaceId)) return
  const role = await client.query<{ ownsPolicy: boolean }>(
    `SELECT pg_has_role(current_user, c.relowner, 'USAGE') AS "ownsPolicy"
       FROM pg_catalog.pg_class c WHERE c.oid='public.workspace_access_policies'::regclass`,
  )
  // Older installations can lack the default policy. Only the durable owner
  // transaction may initialize it without granting policy writes to app users.
  if (role.rows[0]?.ownsPolicy !== true) throw new CrmEpisodeHold('application_crm_policy_unavailable')
  await client.query(`INSERT INTO workspace_access_policies(workspace_id)
    SELECT $1::uuid WHERE NOT EXISTS (SELECT 1 FROM workspace_access_policies WHERE workspace_id=$1::uuid)
    ON CONFLICT DO NOTHING`, [workspaceId])
}

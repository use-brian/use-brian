/** Closed R5 source/binding/job inventory. [COMP:api/workspace-scope-review] */
import type {
  ScopeReviewAction,
  ScopeReviewCoverage,
  ScopeReviewKind,
} from '@use-brian/shared'

export const SCOPE_REVIEW_REGISTRY_REVISION = 2

type SourceAdapter = {
  table: string
  category: 'source' | 'impact'
  actions: readonly ScopeReviewAction[]
  from: string
  workspacePredicate: string
}

const DIRECT_ACTIONS = ['confirm_general', 'assign_team', 'hold'] as const
const IMPACT_ACTIONS = ['confirm_general', 'hold'] as const
const HOLD_ACTIONS = ['hold'] as const

export const SCOPE_REVIEW_SOURCE_ADAPTERS: Readonly<Record<ScopeReviewKind, SourceAdapter>> = Object.freeze({
  memory: { table: 'memories', category: 'source', actions: DIRECT_ACTIONS, from: 'memories r', workspacePredicate: 'r.workspace_id=$1' },
  entity: { table: 'entities', category: 'source', actions: DIRECT_ACTIONS, from: 'entities r', workspacePredicate: 'r.workspace_id=$1' },
  entity_link: { table: 'entity_links', category: 'source', actions: DIRECT_ACTIONS, from: 'entity_links r', workspacePredicate: 'r.workspace_id=$1' },
  task: { table: 'tasks', category: 'source', actions: DIRECT_ACTIONS, from: 'tasks r', workspacePredicate: 'r.workspace_id=$1' },
  workspace_file: { table: 'workspace_files', category: 'source', actions: DIRECT_ACTIONS, from: 'workspace_files r', workspacePredicate: 'r.workspace_id=$1' },
  episode: { table: 'episodes', category: 'source', actions: DIRECT_ACTIONS, from: 'episodes r', workspacePredicate: 'r.workspace_id=$1' },
  knowledge_entry: { table: 'knowledge_entries', category: 'source', actions: DIRECT_ACTIONS, from: 'knowledge_entries r', workspacePredicate: 'r.workspace_id=$1' },
  kb_chunk: { table: 'kb_chunks', category: 'source', actions: DIRECT_ACTIONS, from: 'kb_chunks r', workspacePredicate: 'r.workspace_id=$1' },
  crm_event: { table: 'crm_domain_event_outbox', category: 'source', actions: HOLD_ACTIONS, from: 'crm_domain_event_outbox r', workspacePredicate: 'r.workspace_id=$1' },
  memory_verification: { table: 'memory_verifications', category: 'source', actions: HOLD_ACTIONS, from: 'memory_verifications r', workspacePredicate: 'r.workspace_id=$1' },
  brain_verification: { table: 'brain_verifications', category: 'source', actions: HOLD_ACTIONS, from: 'brain_verifications r', workspacePredicate: 'r.workspace_id=$1' },
  correction_audit: { table: 'correction_audit', category: 'source', actions: HOLD_ACTIONS, from: 'correction_audit r', workspacePredicate: 'r.workspace_id=$1' },
  session_message: { table: 'session_messages', category: 'source', actions: HOLD_ACTIONS, from: 'session_messages r JOIN sessions parent ON parent.id=r.session_id', workspacePredicate: 'coalesce(r.workspace_id,parent.workspace_id)=$1' },
  feedback_event: { table: 'analytics_events', category: 'source', actions: HOLD_ACTIONS, from: 'analytics_events r LEFT JOIN assistants parent ON parent.id=r.assistant_id', workspacePredicate: "coalesce(r.workspace_id,parent.workspace_id)=$1 AND r.event_name='feedback_negative'" },
  workspace_skill_revision: { table: 'workspace_skill_scope_revisions', category: 'source', actions: HOLD_ACTIONS, from: 'workspace_skill_scope_revisions r', workspacePredicate: 'r.workspace_id=$1' },
  file_cache: { table: 'file_cache', category: 'impact', actions: IMPACT_ACTIONS, from: 'file_cache r', workspacePredicate: 'r.workspace_id=$1' },
  file_segment: { table: 'file_segments', category: 'impact', actions: IMPACT_ACTIONS, from: 'file_segments r', workspacePredicate: 'r.workspace_id=$1' },
  recording: { table: 'recordings', category: 'impact', actions: IMPACT_ACTIONS, from: 'recordings r', workspacePredicate: 'r.workspace_id=$1' },
  transcript_segment: { table: 'transcript_segments', category: 'impact', actions: IMPACT_ACTIONS, from: 'transcript_segments r', workspacePredicate: 'r.workspace_id=$1' },
  entity_instance: { table: 'entity_instances', category: 'impact', actions: IMPACT_ACTIONS, from: 'entity_instances r', workspacePredicate: 'r.workspace_id=$1' },
  blueprint_record: { table: 'blueprint_records', category: 'impact', actions: IMPACT_ACTIONS, from: 'blueprint_records r', workspacePredicate: 'r.workspace_id=$1' },
  office_artifact: { table: 'office_artifacts', category: 'impact', actions: IMPACT_ACTIONS, from: 'office_artifacts r', workspacePredicate: 'r.workspace_id=$1' },
})

export const SCOPE_REVIEW_KINDS = Object.freeze(Object.keys(SCOPE_REVIEW_SOURCE_ADAPTERS) as ScopeReviewKind[])

export function sourceAdapter(kind: ScopeReviewKind): SourceAdapter {
  return SCOPE_REVIEW_SOURCE_ADAPTERS[kind]
}

type QueryPort = {query<T extends Record<string,unknown>>(text:string,values?:unknown[]):Promise<{rows:T[]}>}

const bindingQueries = [
  ['assistants', `SELECT count(*)::text total,
      count(*) FILTER(WHERE context_binding_origin='legacy')::text unresolved,
      count(*) FILTER(WHERE context_binding_origin='held')::text held
    FROM assistants WHERE workspace_id=$1`],
  ['sessions', `SELECT count(*)::text total,
      count(*) FILTER(WHERE context_binding_origin='legacy')::text unresolved,
      count(*) FILTER(WHERE context_binding_origin='held')::text held
    FROM sessions WHERE workspace_id=$1`],
  ['brain_keys', `SELECT count(*)::text total,
      count(*) FILTER(WHERE context_binding_origin='legacy' AND status='active')::text unresolved,
      count(*) FILTER(WHERE context_binding_origin='held' OR status<>'active')::text held
    FROM brain_keys WHERE workspace_id=$1`],
  ['connector_instance', `SELECT count(*)::text total,
      count(*) FILTER(WHERE context_binding_origin='legacy' AND connected)::text unresolved,
      count(*) FILTER(WHERE context_binding_origin='held' OR NOT connected)::text held
    FROM connector_instance WHERE workspace_id=$1`],
  ['connector_grant', `SELECT count(*)::text total,
      count(*) FILTER(WHERE context_binding_origin='legacy')::text unresolved,
      count(*) FILTER(WHERE context_binding_origin='held')::text held
    FROM connector_grant WHERE target_type='workspace' AND target_id=$1`],
  ['ingest_rules', `SELECT count(*)::text total,
      count(*) FILTER(WHERE r.scope_binding_origin='legacy')::text unresolved,
      count(*) FILTER(WHERE r.scope_binding_origin='held')::text held
    FROM ingest_rules r LEFT JOIN connector_instance c ON c.id=r.connector_instance_id
      LEFT JOIN programmatic_capture_profiles p ON p.id=r.capture_profile_id
    WHERE coalesce(c.workspace_id,p.workspace_id)=$1`],
  ['pending_ingest_batches', `SELECT count(*)::text total,
      count(*) FILTER(WHERE scope_binding_origin='legacy' AND NOT scope_held AND processed_at IS NULL)::text unresolved,
      count(*) FILTER(WHERE scope_held)::text held
    FROM pending_ingest_batches WHERE workspace_id=$1`],
] as const

const jobQueries = [
  ['workflows', `SELECT count(*)::text total,
      count(*) FILTER(WHERE enabled AND authoring_authority IS NULL)::text unresolved,
      count(*) FILTER(WHERE NOT enabled)::text held FROM workflows WHERE workspace_id=$1`],
  ['goals', `SELECT count(*)::text total,
      count(*) FILTER(WHERE status IN('active','running','awaiting_approval') AND authoring_authority IS NULL)::text unresolved,
      count(*) FILTER(WHERE status IN('blocked','done','abandoned'))::text held FROM goals WHERE workspace_id=$1`],
  ['scheduled_jobs', `SELECT count(*)::text total,
      count(*) FILTER(WHERE j.enabled AND (w.id IS NULL OR w.authoring_authority IS NULL))::text unresolved,
      count(*) FILTER(WHERE NOT j.enabled)::text held
    FROM scheduled_jobs j JOIN assistants a ON a.id=j.assistant_id
      LEFT JOIN workflows w ON w.id=j.workflow_id AND w.workspace_id=a.workspace_id
    WHERE a.workspace_id=$1`],
  ['episode_extraction_applications', `SELECT count(*)::text total,
      count(*) FILTER(WHERE application_state IN('not_started','partial') AND NOT scope_held)::text unresolved,
      count(*) FILTER(WHERE scope_held OR application_state='blocked')::text held
    FROM episode_extraction_runs WHERE workspace_id=$1`],
] as const

export async function getScopeReviewCoverage(
  queryPort: QueryPort,
  workspaceId: string,
): Promise<ScopeReviewCoverage> {
  const families: ScopeReviewCoverage['families'] = []
  for (const kind of SCOPE_REVIEW_KINDS) {
    const adapter = sourceAdapter(kind)
    const result = await queryPort.query<{ total: string; unresolved: string; held: string }>(
      `SELECT count(*)::text AS total,
          count(*) FILTER(WHERE NOT coalesce((evidence.body->>'held')::boolean,false) AND (
            evidence.body->>'sensitivity' IS NULL OR jsonb_typeof(evidence.body->'compartments') IS DISTINCT FROM 'array'
            OR jsonb_typeof(evidence.body->'projectIds') IS DISTINCT FROM 'array'
            OR (jsonb_array_length(evidence.body->'compartments')=0
              AND NOT EXISTS(SELECT 1 FROM scope_resource_states s
                WHERE s.workspace_id=$1 AND s.resource_kind=$2 AND s.resource_id=rows.id
                  AND s.resource_version=evidence.body->>'version' AND s.review_state='reviewed'))
          ))::text AS unresolved,
          count(*) FILTER(WHERE coalesce((evidence.body->>'held')::boolean,false))::text AS held
        FROM (SELECT r.id FROM ${adapter.from} WHERE ${adapter.workspacePredicate}) rows
        CROSS JOIN LATERAL (SELECT read_scope_review_source($1,$2,rows.id) AS body) evidence
        WHERE evidence.body IS NOT NULL`,
      [workspaceId, kind],
    )
    const row = result.rows[0] ?? { total: '0', unresolved: '0', held: '0' }
    families.push({ family: kind, category: adapter.category, ...row })
  }
  for (const [family, sql] of bindingQueries) {
    const row = (await queryPort.query<{ total: string; unresolved: string; held: string }>(sql, [workspaceId])).rows[0]
      ?? { total: '0', unresolved: '0', held: '0' }
    families.push({ family, category: 'binding', ...row })
  }
  for (const [family, sql] of jobQueries) {
    const row = (await queryPort.query<{ total: string; unresolved: string; held: string }>(sql, [workspaceId])).rows[0]
      ?? { total: '0', unresolved: '0', held: '0' }
    families.push({ family, category: 'job', ...row })
  }
  return {
    registryRevision: String(SCOPE_REVIEW_REGISTRY_REVISION),
    unresolved: String(families.reduce((sum, family) => sum + Number(family.unresolved), 0)),
    families,
  }
}

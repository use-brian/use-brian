import { ContextScopeAccumulator, isSensitivity, type ScopeEvidence, type ScopeSource } from '@use-brian/core'
import { getPool } from '../db/client.js'
import type { PoolClient } from 'pg'

/** An empty canonical envelope is explicit; a missing historical one is not. */
export function parseWorkflowCopyEvidence(value: unknown): ScopeEvidence | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const saved = value as ScopeEvidence
  if (!isSensitivity(saved.sensitivity) || !Array.isArray(saved.compartments) || !Array.isArray(saved.projectIds)
    || [...saved.compartments, ...saved.projectIds].some(label => typeof label !== 'string' || !label.trim())
    || (saved.sources !== undefined && !Array.isArray(saved.sources))) return null
  try { return new ContextScopeAccumulator(saved).evidence } catch { return null }
}

/** Follow only durable causal bindings, including copied outcomes and goal resumes. */
export async function readWorkflowInputEvidence(runId: string, workspaceId: string, transaction?: PoolClient): Promise<ScopeEvidence> {
  const client = transaction ?? await getPool().connect()
  const reader = transaction ? 'read_entity_derivation_source' : 'read_scope_source'
  try {
    if (!transaction) await client.query('BEGIN')
    else if (!(await client.query('SELECT id FROM workflow_runs WHERE id=$1 AND workspace_id=$2', [runId,workspaceId])).rows.length) {
      throw new Error('scope_source_changed')
    }
    const events = await client.query<{ id: string }>(`WITH RECURSIVE lineage(id) AS (
      SELECT id FROM workflow_runs WHERE id=$1 AND workspace_id=$2
      UNION SELECT s.source_run_id FROM workflow_run_copy_sources s JOIN lineage l ON l.id=s.run_id
        WHERE s.workspace_id=$2
    ), events(id) AS (
      SELECT r.crm_event_id FROM lineage l JOIN workflow_runs r ON r.id=l.id WHERE r.crm_event_id IS NOT NULL
      UNION SELECT s.event_id FROM lineage l JOIN workflow_runs r ON r.id=l.id
        JOIN goal_crm_event_sources s ON s.goal_id=r.source_goal_id AND s.workspace_id=$2
    ) SELECT id FROM events ORDER BY id`, [runId,workspaceId])
    const accumulator = new ContextScopeAccumulator()
    const taskEvents = await client.query<{ evidence: unknown; verified: boolean }>(`WITH RECURSIVE lineage(id) AS (
      SELECT id FROM workflow_runs WHERE id=$1 AND workspace_id=$2
      UNION SELECT s.source_run_id FROM workflow_run_copy_sources s JOIN lineage l ON l.id=s.run_id WHERE s.workspace_id=$2
    ) SELECT coalesce(r.task_event_evidence,r.knowledge_event_evidence,r.page_event_evidence) AS evidence,r.primitive_event_metadata_verified AS verified FROM lineage l JOIN workflow_runs r ON r.id=l.id
      WHERE r.input#>>'{trigger,sourceType}' IN ('task','knowledge','page') OR r.task_event_evidence IS NOT NULL OR r.knowledge_event_evidence IS NOT NULL OR r.page_event_evidence IS NOT NULL`, [runId,workspaceId])
    for (const row of taskEvents.rows) {
      if (!row.verified) throw new Error('primitive_event_metadata_missing')
      const evidence = parseWorkflowCopyEvidence(row.evidence)
      if (!evidence?.sources?.length) throw new Error('scope_source_changed')
      accumulator.note(evidence)
    }
    for (const { id } of events.rows) {
      const event = (await client.query<{ source: ScopeSource | null; entityId: string | null }>(
        `SELECT source,source->>'causalEntityId' AS "entityId"
         FROM (SELECT ${reader}($1,'crm_event',$2) AS source) snapshot`,
        [workspaceId,id],
      )).rows[0]
      if (!event?.source || !event.entityId) throw new Error('scope_source_changed')
      const entity = (await client.query<{ source: ScopeSource | null }>(
        `SELECT ${reader}($1,'entity',$2) AS source`, [workspaceId,event.entityId],
      )).rows[0]?.source
      if (!entity) throw new Error('scope_source_changed')
      accumulator.note({ sources:[event.source,entity] })
    }
    const blueprints = await client.query<{ captured: boolean; matches: boolean; source: ScopeSource | null;
      runMatches: boolean; runEvidence: ScopeEvidence | null }>(`
      WITH RECURSIVE lineage(id) AS (
        SELECT id FROM workflow_runs WHERE id=$1 AND workspace_id=$2
        UNION SELECT s.source_run_id FROM workflow_run_copy_sources s JOIN lineage l ON l.id=s.run_id
          WHERE s.workspace_id=$2
      ) SELECT s.blueprint_source IS NOT NULL AS captured,
        s.blueprint_source IS NOT DISTINCT FROM CASE WHEN s.blueprint_source='null'::jsonb THEN 'null'::jsonb
          ELSE ${reader}($2,'blueprint_record',(s.blueprint_source->>'resourceId')::uuid) END AS matches,
        s.blueprint_source AS source,
        s.run_source_version=r.derivation_source_version AND s.run_scope_evidence IS NOT NULL
          AND s.run_scope_evidence IS NOT DISTINCT FROM r.vars->'__contextScopeEvidence' AS "runMatches",
        s.run_scope_evidence AS "runEvidence"
      FROM lineage l JOIN workflow_run_copy_sources s ON s.run_id=l.id AND s.workspace_id=$2
        LEFT JOIN workflow_runs r ON r.id=s.source_run_id AND r.workspace_id=s.workspace_id
      ORDER BY s.run_id,s.source_run_id`, [runId,workspaceId])
    for (const blueprint of blueprints.rows) {
      if (!blueprint.captured || !blueprint.matches || !blueprint.runMatches || !blueprint.runEvidence) throw new Error('scope_source_changed')
      const saved = parseWorkflowCopyEvidence(blueprint.runEvidence)
      if (!saved) throw new Error('scope_source_changed')
      accumulator.note(saved)
      if (blueprint.source) accumulator.note({ sources: [blueprint.source] })
    }
    if (!transaction) await client.query('COMMIT')
    return accumulator.evidence
  } catch (error) {
    if (!transaction) await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally { if (!transaction) client.release() }
}

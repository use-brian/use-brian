import { ContextScopeAccumulator, type ScopeEvidence, type ScopeSource } from '@use-brian/core'
import { getPool } from '../db/client.js'

/** Follow only durable causal bindings, including copied outcomes and goal resumes. */
export async function readWorkflowInputEvidence(runId: string, workspaceId: string): Promise<ScopeEvidence> {
  const client = await getPool().connect()
  try {
    await client.query('BEGIN')
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
    for (const { id } of events.rows) {
      const event = (await client.query<{ source: ScopeSource | null; entityId: string | null }>(
        `SELECT read_scope_source($1,'crm_event',$2) AS source,
          (SELECT scope_source->>'resourceId' FROM crm_domain_event_outbox WHERE workspace_id=$1 AND id=$2) AS "entityId"`,
        [workspaceId,id],
      )).rows[0]
      if (!event?.source || !event.entityId) throw new Error('scope_source_changed')
      const entity = (await client.query<{ source: ScopeSource | null }>(
        "SELECT read_scope_source($1,'entity',$2) AS source", [workspaceId,event.entityId],
      )).rows[0]?.source
      if (!entity) throw new Error('scope_source_changed')
      accumulator.note({ sources:[event.source,entity] })
    }
    await client.query('COMMIT')
    return accumulator.evidence
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally { client.release() }
}

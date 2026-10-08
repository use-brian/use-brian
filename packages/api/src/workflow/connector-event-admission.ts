/**
 * Connector event admission for event-triggered workflow runs (migration 734).
 * A connector event carries the connector audience's provider content, so in a
 * department-read v2 workspace it may only start a run whose department context
 * holds that audience and whose author currently does too. Called before the
 * storm guard: an inadmissible event causes no run, pause or audit.
 * [COMP:workflow/context-scope]
 */
import { query } from '../db/client.js'

export async function connectorWorkflowEventAdmissibleSystem(
  workflowId: string, workspaceId: string, connectorInstanceId: string,
): Promise<boolean> {
  const result = await query<{ admissible: boolean | null }>(
    'SELECT workflow_connector_event_admissible($1,$2,$3) AS admissible', [workflowId, workspaceId, connectorInstanceId])
  return result.rows[0]?.admissible === true
}

/** Current intake credential/definition admission. [COMP:crm/operations-store] */
import type { PoolClient } from 'pg'
import { CrmOperationsError, type DepartmentReadGrant } from '@use-brian/core'
import { renewCrmIntegrationBinding, crmIntegrationExecutionLimits, type CrmIntegrationExecutionLimits } from './integration-department-authority.js'

export async function readCrmIntakeAuthority(
  client: PoolClient, workspaceId: string, credentialId: string, definitionId: string,
  lock = false,
): Promise<{ replayScopeId: string; departmentRead?: DepartmentReadGrant; executionLimits?: CrmIntegrationExecutionLimits }> {
  const result = await client.query(`SELECT c.replay_scope_id AS "replayScopeId",c.created_by_user_id AS issuer,
    c.department_binding AS binding,(SELECT department_read_v2 FROM workspaces WHERE id=$1) AS v2
    FROM crm_intake_credentials c
    JOIN crm_intake_credential_definitions b ON b.workspace_id=c.workspace_id AND b.credential_id=c.id
    JOIN crm_intake_definitions d ON d.workspace_id=b.workspace_id AND d.id=b.definition_id
    WHERE c.workspace_id=$1 AND c.id=$2 AND b.definition_id=$3 AND c.revoked_at IS NULL AND d.active
    ${lock ? 'FOR SHARE OF c,b,d' : ''}`, [workspaceId, credentialId, definitionId])
  const row = result.rows[0]
  if (!row) throw new CrmOperationsError('credential_revoked', 'The intake credential or definition is unavailable.')
  const departmentRead = row.v2 ? await renewCrmIntegrationBinding(client, workspaceId, row.issuer, row.binding) : undefined
  return { replayScopeId: row.replayScopeId, ...(departmentRead ? { departmentRead, executionLimits: await crmIntegrationExecutionLimits(client, row.binding) } : {}) }
}

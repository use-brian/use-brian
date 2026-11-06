/** Live origin of an atomic native Office job. [COMP:api/office-chat-generation] */
import type { PoolClient } from 'pg'
import type { OfficeGenerationJobRow } from '../db/office-generation.js'
import { sessionKindSql } from '../session-kind.js'
import { WorkspaceAccessError } from '../workspace-access/policy.js'

/** Static aliases only; shared by claim and publication so neither has a weaker gate. */
export function officeGenerationOriginAllowsSql(alias: string): string {
  if (!/^[a-z_]+$/.test(alias)) throw new Error('office_origin_alias_invalid')
  const binding = `${alias}.authority_projection->'creationBinding'`
  return `(CASE WHEN ${alias}.authority_projection ? 'workspaceDelegation' THEN
    workspace_mcp_parent_current(${alias}.authority_projection->'workspaceDelegation')
    ELSE (EXISTS (SELECT 1 FROM auth_sessions s JOIN users u ON u.id=s.user_id
      JOIN workspace_members om ON om.user_id=u.id AND om.workspace_id=${alias}.workspace_id
      WHERE s.id::text=${binding}->>'authSessionId' AND s.user_id=${alias}.initiated_by_user_id
        AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp() AND s.auth_version=u.auth_version
      FOR SHARE OF s,u,om)
    AND CASE WHEN ${binding}->>'origin'='native_personal_chat' THEN
    ${binding}->>'protocol'='office_department_v2'
    AND EXISTS (SELECT 1 FROM sessions os JOIN workspace_members om
      ON om.workspace_id=${alias}.workspace_id AND om.user_id=${alias}.initiated_by_user_id
      WHERE os.id::text=${binding}->>'chatSessionId' AND os.workspace_id=${alias}.workspace_id
        AND os.user_id=${alias}.initiated_by_user_id AND os.assistant_id=${alias}.assistant_id
        AND ${sessionKindSql.personalConversation('os')}
        AND coalesce(os.context_group_id::text,'')=coalesce(${binding}->>'contextGroupId','')
        AND coalesce(os.context_project_id::text,'')=coalesce(${binding}->>'contextProjectId','')
        AND os.context_locked_at=(${binding}->>'contextLockedAt')::timestamptz
      FOR SHARE OF os,om)
    ELSE NOT (${binding} ? 'origin') AND NOT (${binding} ? 'chatSessionId')
    END) END)`
}

export async function assertOfficeGenerationOrigin(client: PoolClient, job: OfficeGenerationJobRow): Promise<void> {
  const result = await client.query<{ allowed: boolean }>(`SELECT ${officeGenerationOriginAllowsSql('j')} AS allowed
    FROM office_generation_jobs j WHERE j.id=$1 AND j.workspace_id=$2 AND j.initiated_by_user_id=$3`,
  [job.id, job.workspaceId, job.initiatedByUserId])
  if (result.rows[0]?.allowed !== true) throw new WorkspaceAccessError('office_source_unavailable', 404)
}

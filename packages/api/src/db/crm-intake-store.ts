/**
 * Read/authentication store for CRM intake definitions and credentials.
 * Authentication is deliberately separate from Brain/API keys: an intake
 * principal resolves only a workspace and one bound definition.
 *
 * [COMP:api/crm-intake-route]
 */

import { query } from './client.js'
import { verifySecret } from './api-key-store.js'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const KEY_PREFIX = 'sk_intake_'

export function parseCrmIntakeToken(token: string): { credentialId: string; secret: string } | null {
  if (!token.startsWith(KEY_PREFIX)) return null
  const rest = token.slice(KEY_PREFIX.length)
  const separator = rest.indexOf('_')
  if (separator < 0) return null
  const credentialId = rest.slice(0, separator)
  const secret = rest.slice(separator + 1)
  if (!UUID_RE.test(credentialId) || !secret || secret.length > 200) return null
  return { credentialId, secret }
}

export type CrmIntakePrincipal = {
  workspaceId: string
  credentialId: string
  definitionId: string
  definitionKey: string
}

type AuthRow = CrmIntakePrincipal & {
  secretHash: string
  revokedAt: Date | null
}

export type CrmIntakeReadStore = {
  authenticate(token: string, definitionKey: string): Promise<CrmIntakePrincipal | null>
  listDefinitions(workspaceId: string): Promise<Array<Record<string, unknown>>>
  listCredentials(workspaceId: string): Promise<Array<Record<string, unknown>>>
}

export function createDbCrmIntakeReadStore(): CrmIntakeReadStore {
  return {
    async authenticate(token, definitionKey) {
      const parsed = parseCrmIntakeToken(token)
      if (!parsed) return null
      const found = await query<AuthRow>(
        `SELECT c.id AS "credentialId", c.workspace_id AS "workspaceId",
                c.secret_hash AS "secretHash", c.revoked_at AS "revokedAt",
                d.id AS "definitionId", d.definition_key AS "definitionKey"
           FROM crm_intake_credentials c
           JOIN crm_intake_credential_definitions b
             ON b.workspace_id = c.workspace_id AND b.credential_id = c.id
           JOIN crm_intake_definitions d
             ON d.workspace_id = b.workspace_id AND d.id = b.definition_id
          WHERE c.id = $1 AND d.definition_key = $2 AND d.active`,
        [parsed.credentialId, definitionKey],
      )
      const row = found.rows[0]
      if (!row || row.revokedAt || !await verifySecret(parsed.secret, row.secretHash)) return null
      await query(
        `UPDATE crm_intake_credentials SET last_used_at = now()
          WHERE workspace_id = $1 AND id = $2 AND revoked_at IS NULL`,
        [row.workspaceId, row.credentialId],
      )
      return {
        workspaceId: row.workspaceId,
        credentialId: row.credentialId,
        definitionId: row.definitionId,
        definitionKey: row.definitionKey,
      }
    },

    async listDefinitions(workspaceId) {
      const result = await query<Record<string, unknown>>(
        `SELECT d.id, d.definition_key AS "definitionKey", d.label, d.active,
                d.current_version AS "currentVersion", v.field_catalog AS fields,
                v.identity_policy AS "identityPolicy",
                v.allowed_identity_provider AS "allowedIdentityProvider",
                v.consent_mappings AS "consentMappings", v.queue_key AS "queueKey",
                v.owner_user_id AS "ownerUserId",
                v.follow_up_task_template AS "followUpTaskTemplate",
                v.follow_up_due_minutes AS "followUpDueMinutes",
                v.max_payload_bytes AS "maxPayloadBytes",
                v.workflow_hint AS "workflowHint", v.schema_hash AS "schemaHash",
                d.created_at AS "createdAt", d.updated_at AS "updatedAt"
           FROM crm_intake_definitions d
           JOIN crm_intake_definition_versions v
             ON v.workspace_id = d.workspace_id AND v.definition_id = d.id
            AND v.version = d.current_version
          WHERE d.workspace_id = $1
          ORDER BY d.label, d.id
          LIMIT 200`,
        [workspaceId],
      )
      return result.rows
    },

    async listCredentials(workspaceId) {
      const result = await query<Record<string, unknown>>(
        `SELECT c.id, c.label, c.secret_prefix AS prefix,
                c.revoked_at AS "revokedAt", c.last_used_at AS "lastUsedAt",
                c.created_at AS "createdAt",
                COALESCE(array_agg(b.definition_id ORDER BY b.definition_id)
                  FILTER (WHERE b.definition_id IS NOT NULL), '{}') AS "definitionIds"
           FROM crm_intake_credentials c
           LEFT JOIN crm_intake_credential_definitions b
             ON b.workspace_id = c.workspace_id AND b.credential_id = c.id
          WHERE c.workspace_id = $1
          GROUP BY c.id
          ORDER BY c.created_at DESC, c.id DESC
          LIMIT 200`,
        [workspaceId],
      )
      return result.rows
    },
  }
}

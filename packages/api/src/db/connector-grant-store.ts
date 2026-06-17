/**
 * Connector-grant store — member-exposure grants (Stage 4 of the
 * team-connector promotion).
 *
 * "Alice exposes her user-scoped `connector_instance` to team T." The
 * store records the grant and provides:
 *   - per-team listing (used by `injectMcpTools` when resolving tools
 *     available to team assistants)
 *   - per-grantor listing (used by the settings UI)
 *   - revoke (grantor-initiated or team-member-removal cascade)
 *
 * Invariant: only user-scoped instances are granted. Team-scoped
 * instances are team-visible by virtue of `connector_instance.scope='team'`
 * and need no grant. The store enforces this at create time.
 *
 * See docs/architecture/integrations/mcp.md.
 * Component tag: [COMP:api/connector-grant-store].
 */

import { query, queryWithRLS } from './client.js'
import type { ConnectorInstance } from './connector-instance-store.js'

export type ConnectorGrantTarget = 'workspace'

export type ConnectorGrant = {
  id: string
  connectorInstanceId: string
  targetType: ConnectorGrantTarget
  targetId: string
  grantedByUserId: string
  grantedAt: Date
}

/** A grant joined with its underlying instance — the shape tool-injection wants. */
export type GrantWithInstance = ConnectorGrant & {
  instance: ConnectorInstance
}

const GRANT_COLS = `
  id,
  connector_instance_id AS "connectorInstanceId",
  target_type AS "targetType",
  target_id AS "targetId",
  granted_by_user_id AS "grantedByUserId",
  granted_at AS "grantedAt"
` as const

const INSTANCE_COLS_AS = `
  ci.id AS "instance_id",
  ci.scope AS "instance_scope",
  ci.user_id AS "instance_userId",
  ci.workspace_id AS "instance_workspaceId",
  ci.provider AS "instance_provider",
  ci.label AS "instance_label",
  ci.connected_email AS "instance_connectedEmail",
  ci.url AS "instance_url",
  ci.custom AS "instance_custom",
  ci.config AS "instance_config",
  ci.sensitivity AS "instance_sensitivity",
  ci.connected AS "instance_connected",
  ci.ingestion_enabled AS "instance_ingestionEnabled",
  ci.credentials_type AS "instance_credentialsType",
  ci.created_by AS "instance_createdBy",
  ci.created_at AS "instance_createdAt",
  ci.updated_at AS "instance_updatedAt"
` as const

type FlatGrantInstanceRow = ConnectorGrant & {
  instance_id: string
  instance_scope: 'user' | 'workspace'
  instance_userId: string | null
  instance_workspaceId: string | null
  instance_provider: string
  instance_label: string
  instance_connectedEmail: string | null
  instance_url: string | null
  instance_custom: boolean
  instance_config: Record<string, unknown>
  instance_sensitivity: 'public' | 'internal' | 'confidential'
  instance_connected: boolean
  instance_ingestionEnabled: boolean
  instance_credentialsType: ConnectorInstance['credentialsType']
  instance_createdBy: string | null
  instance_createdAt: Date
  instance_updatedAt: Date
}

function unflatten(row: FlatGrantInstanceRow): GrantWithInstance {
  return {
    id: row.id,
    connectorInstanceId: row.connectorInstanceId,
    targetType: row.targetType,
    targetId: row.targetId,
    grantedByUserId: row.grantedByUserId,
    grantedAt: row.grantedAt,
    instance: {
      id: row.instance_id,
      scope: row.instance_scope,
      userId: row.instance_userId,
      workspaceId: row.instance_workspaceId,
      provider: row.instance_provider,
      label: row.instance_label,
      connectedEmail: row.instance_connectedEmail,
      url: row.instance_url,
      custom: row.instance_custom,
      config: row.instance_config,
      sensitivity: row.instance_sensitivity,
      connected: row.instance_connected,
      ingestionEnabled: row.instance_ingestionEnabled,
      credentialsType: row.instance_credentialsType,
      createdBy: row.instance_createdBy,
      createdAt: row.instance_createdAt,
      updatedAt: row.instance_updatedAt,
    },
  }
}

export type ConnectorGrantStore = {
  /**
   * Create a grant. Validates that the target instance is user-scoped and
   * owned by the grantor. Returns the grant row. RLS-gated.
   */
  create(params: {
    actingUserId: string
    connectorInstanceId: string
    targetType: ConnectorGrantTarget
    targetId: string
  }): Promise<ConnectorGrant>

  /** Revoke a grant by id. RLS-gated — grantor and team-admin both pass. */
  revoke(actingUserId: string, grantId: string): Promise<boolean>

  /**
   * System-level: list all grants + their underlying instance rows for a
   * target (e.g. a team). Used by `injectMcpTools` which runs per turn
   * and must see grants regardless of the chatting user's role in the
   * grantors' source teams.
   */
  listForTargetSystem(targetType: ConnectorGrantTarget, targetId: string): Promise<GrantWithInstance[]>

  /**
   * System-level: find a single connected, member-exposed instance of a given
   * provider granted to a target (e.g. a workspace). Used by the KB sync
   * credential provider as the fallback for the team's GitHub PAT now that the
   * unified-connectors model has no separate team-native type — every
   * connector is a personal instance exposed via a grant. Oldest grant wins.
   */
  findGrantedInstanceByProviderSystem(
    targetType: ConnectorGrantTarget,
    targetId: string,
    provider: string,
  ): Promise<ConnectorInstance | null>

  /** List grants by grantor — for the settings UI. RLS-gated. */
  listByGrantor(actingUserId: string): Promise<ConnectorGrant[]>

  /**
   * System-level cascade: delete every grant by a given user to a given
   * team. Called from team-store.removeMember when a user leaves a team.
   */
  deleteByGrantorAndTargetSystem(grantedByUserId: string, targetType: ConnectorGrantTarget, targetId: string): Promise<number>
}

export function createConnectorGrantStore(): ConnectorGrantStore {
  return {
    async create(params) {
      // Validate: instance is user-scoped and owned by the grantor.
      const check = await query<{ scope: string; userId: string | null }>(
        `SELECT scope, user_id AS "userId"
         FROM connector_instance WHERE id = $1`,
        [params.connectorInstanceId],
      )
      const instance = check.rows[0]
      if (!instance) throw new Error(`connector_instance ${params.connectorInstanceId} not found`)
      if (instance.scope !== 'user') {
        throw new Error(`cannot grant workspace-scoped instance (already workspace-visible)`)
      }
      if (instance.userId !== params.actingUserId) {
        throw new Error(`only the instance owner can grant it`)
      }

      const result = await queryWithRLS<ConnectorGrant>(
        params.actingUserId,
        `INSERT INTO connector_grant
           (connector_instance_id, target_type, target_id, granted_by_user_id)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (connector_instance_id, target_type, target_id) DO NOTHING
         RETURNING ${GRANT_COLS}`,
        [params.connectorInstanceId, params.targetType, params.targetId, params.actingUserId],
      )
      if (result.rows[0]) return result.rows[0]

      // Grant already existed — fetch and return it.
      const existing = await queryWithRLS<ConnectorGrant>(
        params.actingUserId,
        `SELECT ${GRANT_COLS} FROM connector_grant
         WHERE connector_instance_id = $1 AND target_type = $2 AND target_id = $3`,
        [params.connectorInstanceId, params.targetType, params.targetId],
      )
      return existing.rows[0]
    },

    async revoke(actingUserId, grantId) {
      // RLS allows grantor (cg_grantor_see_own) or team member
      // (cg_target_member); the route layer additionally gates team-admin
      // revocation via requireTeamRole before calling this.
      const result = await queryWithRLS(
        actingUserId,
        `DELETE FROM connector_grant WHERE id = $1`,
        [grantId],
      )
      return (result.rowCount ?? 0) > 0
    },

    async listForTargetSystem(targetType, targetId) {
      const result = await query<FlatGrantInstanceRow>(
        `SELECT
           cg.id, cg.connector_instance_id AS "connectorInstanceId",
           cg.target_type AS "targetType", cg.target_id AS "targetId",
           cg.granted_by_user_id AS "grantedByUserId",
           cg.granted_at AS "grantedAt",
           ${INSTANCE_COLS_AS}
         FROM connector_grant cg
         JOIN connector_instance ci ON ci.id = cg.connector_instance_id
         WHERE cg.target_type = $1 AND cg.target_id = $2`,
        [targetType, targetId],
      )
      return result.rows.map(unflatten)
    },

    async findGrantedInstanceByProviderSystem(targetType, targetId, provider) {
      const result = await query<ConnectorInstance>(
        `SELECT
           ci.id, ci.scope,
           ci.user_id AS "userId",
           ci.workspace_id AS "workspaceId",
           ci.provider, ci.label,
           ci.connected_email AS "connectedEmail",
           ci.url, ci.custom, ci.config, ci.sensitivity, ci.connected,
           ci.ingestion_enabled AS "ingestionEnabled",
           ci.credentials_type AS "credentialsType",
           ci.created_by AS "createdBy",
           ci.created_at AS "createdAt",
           ci.updated_at AS "updatedAt"
         FROM connector_grant cg
         JOIN connector_instance ci ON ci.id = cg.connector_instance_id
         WHERE cg.target_type = $1 AND cg.target_id = $2
           AND ci.scope = 'user' AND ci.provider = $3 AND ci.connected = true
         ORDER BY cg.granted_at ASC
         LIMIT 1`,
        [targetType, targetId, provider],
      )
      return result.rows[0] ?? null
    },

    async listByGrantor(actingUserId) {
      const result = await queryWithRLS<ConnectorGrant>(
        actingUserId,
        `SELECT ${GRANT_COLS} FROM connector_grant
         WHERE granted_by_user_id = $1
         ORDER BY granted_at DESC`,
        [actingUserId],
      )
      return result.rows
    },

    async deleteByGrantorAndTargetSystem(grantedByUserId, targetType, targetId) {
      const result = await query(
        `DELETE FROM connector_grant
         WHERE granted_by_user_id = $1
           AND target_type = $2
           AND target_id = $3`,
        [grantedByUserId, targetType, targetId],
      )
      return result.rowCount ?? 0
    },
  }
}

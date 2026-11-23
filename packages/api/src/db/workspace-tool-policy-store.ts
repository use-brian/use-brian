/**
 * Workspace-scoped tool policy store (migration 312).
 *
 * allow/ask/block for a connector tool, keyed by WORKSPACE rather than user.
 * This is the shared-governance counterpart to `mcp_tool_settings` (per-user):
 * a **team-owned** (`scope='workspace'`) connector's tools resolve their policy
 * from here, so any member with sufficient clearance governs what the shared
 * assistant may call. Personal and personal-exposed connectors keep the
 * per-user `mcp_tool_settings` path untouched.
 *
 * Reads at tool-injection time are system-level (no acting user), exactly like
 * `mcp-settings-store`. Writes come from the clearance-gated route.
 *
 * See docs/plans/workspace-owned-connector-transfer.md §2C and
 * docs/architecture/integrations/mcp.md.
 * Component tag: [COMP:api/workspace-tool-policy-store].
 */

import type { ToolClassification } from '@use-brian/agent-runtime/mcp/classifier.js'
import type { McpSettingsStore, McpToolSetting } from '@use-brian/agent-runtime/mcp/types.js'
import { query } from './client.js'

export type WorkspaceToolPolicy = {
  id: string
  workspaceId: string
  serverName: string
  toolName: string
  policy: 'allow' | 'ask' | 'block'
  classification: ToolClassification | null
  updatedBy: string | null
  updatedAt: Date
}

const COLS = `
  id,
  workspace_id AS "workspaceId",
  server_name AS "serverName",
  tool_name AS "toolName",
  policy, classification,
  updated_by AS "updatedBy",
  updated_at AS "updatedAt"
` as const

export type WorkspaceToolPolicyStore = {
  /** Resolve the workspace's policy for one tool. Null when unset (→ caller fallback). */
  getPolicy(workspaceId: string, serverName: string, toolName: string): Promise<WorkspaceToolPolicy | null>
  getPolicies?(workspaceId: string, serverNames: readonly string[], toolNames: readonly string[]): Promise<WorkspaceToolPolicy[]>

  /** Upsert the workspace's policy for one tool. */
  setPolicy(params: {
    workspaceId: string
    serverName: string
    toolName: string
    policy: 'allow' | 'ask' | 'block'
    classification?: ToolClassification | null
    updatedBy: string
  }): Promise<WorkspaceToolPolicy>

  /** Every policy row for a workspace — drives the management UI. */
  listForWorkspace(workspaceId: string): Promise<WorkspaceToolPolicy[]>
}

export function createWorkspaceToolPolicyStore(): WorkspaceToolPolicyStore {
  return {
    async getPolicy(workspaceId, serverName, toolName) {
      const result = await query<WorkspaceToolPolicy>(
        `SELECT ${COLS} FROM workspace_tool_policy
         WHERE workspace_id = $1 AND server_name = $2 AND tool_name = $3`,
        [workspaceId, serverName, toolName],
      )
      return result.rows[0] ?? null
    },

    async getPolicies(workspaceId, serverNames, toolNames) {
      if (serverNames.length === 0 || toolNames.length === 0) return []
      const result = await query<WorkspaceToolPolicy>(
        `SELECT ${COLS} FROM workspace_tool_policy
         WHERE workspace_id = $1 AND server_name = ANY($2::text[]) AND tool_name = ANY($3::text[])`,
        [workspaceId, serverNames, toolNames],
      )
      return result.rows
    },

    async setPolicy(params) {
      const result = await query<WorkspaceToolPolicy>(
        `INSERT INTO workspace_tool_policy (workspace_id, server_name, tool_name, policy, classification, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (workspace_id, server_name, tool_name) DO UPDATE
           SET policy = $4, classification = COALESCE($5, workspace_tool_policy.classification), updated_by = $6
         RETURNING ${COLS}`,
        [params.workspaceId, params.serverName, params.toolName, params.policy, params.classification ?? null, params.updatedBy],
      )
      return result.rows[0]
    },

    async listForWorkspace(workspaceId) {
      const result = await query<WorkspaceToolPolicy>(
        `SELECT ${COLS} FROM workspace_tool_policy
         WHERE workspace_id = $1
         ORDER BY server_name, tool_name`,
        [workspaceId],
      )
      return result.rows
    },
  }
}

/**
 * Adapt a `WorkspaceToolPolicyStore` to the `McpSettingsStore` interface the
 * connector activation expects, keyed to one workspace. Team-native lanes and
 * their picker reads use workspace policy instead of a user's settings.
 *
 * The adapter reads rows once by workspace and server name, then maps them
 * back to the caller's requested scope keys. Usage counters and auto-promotion are intentionally
 * inert here: the shared policy changes only via the explicit clearance-gated
 * route, never by one member's confirmations silently graduating the team's
 * tool to always-allow.
 */
export function workspacePolicyAsSettingsStore(
  store: WorkspaceToolPolicyStore,
  workspaceId: string,
): McpSettingsStore {
  const toSetting = (row: WorkspaceToolPolicy, assistantId: string, userId: string): McpToolSetting => ({
    id: row.id,
    assistantId,
    userId,
    serverName: row.serverName,
    toolName: row.toolName,
    policy: row.policy,
    classification: row.classification ?? 'unknown',
    timesAllowed: 0,
    timesDenied: 0,
  })

  return {
    async getPolicy({ assistantId, userId, serverName, toolName }) {
      const row = await store.getPolicy(workspaceId, serverName, toolName)
      return row ? toSetting({ ...row, serverName, toolName }, assistantId, userId) : null
    },
    ...(store.getPolicies ? {
      async getPolicies({ userId, scopes, toolNames }) {
        const rows = await store.getPolicies!(workspaceId, [...new Set(scopes.map(scope => scope.serverName))], toolNames)
        return scopes.flatMap(({ assistantId, serverName }) => rows
          .filter(row => row.serverName === serverName)
          .map(row => toSetting(row, assistantId, userId)))
      },
    } : {}),
    // The shared policy is only ever set through the clearance-gated route.
    async setPolicy() { /* inert — see doc comment */ },
    async recordUsage() { /* inert */ },
    async recordUsageAndGetCount() { return { timesAllowed: 0, timesDenied: 0 } },
  }
}

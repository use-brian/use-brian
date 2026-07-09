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

import type { McpSettingsStore, McpToolSetting, ToolClassification } from '@sidanclaw/core'
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
 * per-provider injectors expect, keyed to one workspace. Used ONLY in the
 * team-native injection branch (`inject.ts`) so a `scope='workspace'`
 * connector's tools resolve policy from `workspace_tool_policy` instead of a
 * user's `mcp_tool_settings`.
 *
 * `getPolicy` ignores `assistantId`/`userId` and keys on the bound workspace.
 * `resolveEffectivePolicy` calls it twice (L1 with APP_LEVEL, L2 with the real
 * assistant) and takes the strictest — both return the same row, so the strict
 * combine is a no-op. Usage counters and auto-promotion are intentionally
 * inert here: the shared policy changes only via the explicit clearance-gated
 * route, never by one member's confirmations silently graduating the team's
 * tool to always-allow.
 */
export function workspacePolicyAsSettingsStore(
  store: WorkspaceToolPolicyStore,
  workspaceId: string,
): McpSettingsStore {
  return {
    async getPolicy({ assistantId, userId, serverName, toolName }) {
      const row = await store.getPolicy(workspaceId, serverName, toolName)
      if (!row) return null
      const setting: McpToolSetting = {
        id: row.id,
        assistantId,
        userId,
        serverName,
        toolName,
        policy: row.policy,
        classification: (row.classification ?? 'unknown') as ToolClassification,
        timesAllowed: 0,
        timesDenied: 0,
      }
      return setting
    },
    // The shared policy is only ever set through the clearance-gated route.
    async setPolicy() { /* inert — see doc comment */ },
    async recordUsage() { /* inert */ },
    async recordUsageAndGetCount() { return { timesAllowed: 0, timesDenied: 0 } },
  }
}

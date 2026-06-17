import type { McpSettingsStore, McpToolSetting } from '@sidanclaw/core'
import { query } from './client.js'

export function createDbMcpSettingsStore(): McpSettingsStore {
  return {
    async getPolicy(params) {
      const result = await query<McpToolSetting>(
        `SELECT id, assistant_id as "assistantId", user_id as "userId",
                server_name as "serverName", tool_name as "toolName",
                policy, classification, times_allowed as "timesAllowed",
                times_denied as "timesDenied"
         FROM mcp_tool_settings
         WHERE assistant_id = $1 AND user_id = $2 AND server_name = $3 AND tool_name = $4`,
        [params.assistantId, params.userId, params.serverName, params.toolName],
      )
      return result.rows[0] ?? null
    },

    async setPolicy(params) {
      await query(
        `INSERT INTO mcp_tool_settings (assistant_id, user_id, server_name, tool_name, policy, classification)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (assistant_id, user_id, server_name, tool_name) DO UPDATE
           SET policy = $5, classification = $6`,
        [params.assistantId, params.userId, params.serverName, params.toolName, params.policy, params.classification],
      )
    },

    async recordUsage(params) {
      const field = params.allowed ? 'times_allowed' : 'times_denied'
      await query(
        `UPDATE mcp_tool_settings SET ${field} = ${field} + 1
         WHERE assistant_id = $1 AND user_id = $2 AND server_name = $3 AND tool_name = $4`,
        [params.assistantId, params.userId, params.serverName, params.toolName],
      )
    },

    async recordUsageAndGetCount(params) {
      const field = params.allowed ? 'times_allowed' : 'times_denied'
      const result = await query<{ timesAllowed: number; timesDenied: number }>(
        `UPDATE mcp_tool_settings SET ${field} = ${field} + 1
         WHERE assistant_id = $1 AND user_id = $2 AND server_name = $3 AND tool_name = $4
         RETURNING times_allowed AS "timesAllowed", times_denied AS "timesDenied"`,
        [params.assistantId, params.userId, params.serverName, params.toolName],
      )
      return result.rows[0] ?? { timesAllowed: 0, timesDenied: 0 }
    },
  }
}

/**
 * List all MCP tool settings for a user's assistant.
 */
export async function listMcpToolSettings(assistantId: string, userId: string): Promise<McpToolSetting[]> {
  const result = await query<McpToolSetting>(
    `SELECT id, assistant_id as "assistantId", user_id as "userId",
            server_name as "serverName", tool_name as "toolName",
            policy, classification, times_allowed as "timesAllowed",
            times_denied as "timesDenied"
     FROM mcp_tool_settings
     WHERE assistant_id = $1 AND user_id = $2
     ORDER BY server_name, tool_name`,
    [assistantId, userId],
  )
  return result.rows
}

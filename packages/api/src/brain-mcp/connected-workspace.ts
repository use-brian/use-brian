import { queryWithRLS } from '../db/client.js'
import { getAuthenticatedBrainCredentialCurrent, type BrainAuth } from './auth.js'
import type { BrainTool } from './tools.js'

export function connectedWorkspaceTool(auth: BrainAuth): BrainTool {
  return {
    name: 'getConnectedWorkspace',
    description: 'Which Brian am I using? Check the name and ID of the workspace authorized for this connection before a named save or recall.',
    inputSchema: {},
    async handler() {
      if (auth.actingUserId && await getAuthenticatedBrainCredentialCurrent(auth)?.()) {
        const { rows } = await queryWithRLS<{ id: string; name: string }>(auth.actingUserId,
          `SELECT w.id, w.name FROM workspaces w JOIN workspace_members m ON w.id = m.workspace_id
            WHERE w.id = $1 AND m.user_id = $2 AND m.role IN ('owner','admin')`,
          [auth.workspaceId, auth.actingUserId])
        if (rows[0]) return { content: [{ type: 'text', text: JSON.stringify(rows[0]) }], structuredContent: rows[0] }
      }
      return { isError: true, content: [{ type: 'text', text: 'The authorized workspace is unavailable. Reconnect to Brian.' }] }
    },
  }
}

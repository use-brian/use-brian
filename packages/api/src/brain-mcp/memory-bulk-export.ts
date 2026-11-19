/** Connected entry point for the signed-in Memory download. [COMP:api/memory-bulk-export] */
import { z } from 'zod'
import { getAuthenticatedBrainCredentialCurrent, type BrainAuth } from './auth.js'
import type { BrainTool } from './tools.js'
import { memoryExportFormat, type MemoryExportEntitlement, type MemoryExportObserver } from '../memory-bulk-export.js'
import { getWorkspaceRoleSystem, type Workspace } from '../db/workspace-store.js'

const input = z.object({
  format: memoryExportFormat.default('markdown').describe('File format.'),
  workspace: z.string().trim().min(1).max(256).optional().describe('Exact workspace name, when the user names one.'),
}).strict()

export type MemoryExportMcpOptions = {
  appOrigin: string
  entitled: MemoryExportEntitlement
  observe?: MemoryExportObserver
  workspaceStore: { getByIdSystem(workspaceId: string): Promise<Pick<Workspace, 'name'> | null> }
}

export function createMemoryExportTool(auth: BrainAuth, options: MemoryExportMcpOptions): BrainTool | undefined {
  const userId = auth.actingUserId
  const credentialCurrent = getAuthenticatedBrainCredentialCurrent(auth)
  if (auth.authKind !== 'oauth_token' || auth.workspaceMcpConsent || !userId || !credentialCurrent) return undefined
  const workspaceId = auth.workspaceId

  return {
    name: 'exportMemories',
    description: 'Open the Markdown or CSV download of visible memories in the connected Brian workspace. Use when the user explicitly requests a bulk export. The signed-in user completes the download in Brian.',
    inputSchema: input,
    async handler(args) {
      const failure = (text: string) => ({ isError: true, content: [{ type: 'text' as const, text }] })
      const { format, workspace } = input.parse(args)
      const accessCurrent = async () => await credentialCurrent() && !!await getWorkspaceRoleSystem(userId, workspaceId, true)
      try {
        if (!await accessCurrent()) return failure('This connection can no longer access the workspace. Reconnect Brian.')
        const connected = await options.workspaceStore.getByIdSystem(workspaceId)
        if (!connected) return failure('The connected workspace is unavailable.')
        if (workspace && workspace.normalize() !== connected.name.normalize()) {
          return failure(`This connection is for "${connected.name}". Connect the named workspace to export its memories.`)
        }
        const entitled = await options.entitled(workspaceId)
        if (!await accessCurrent()) return failure('This connection can no longer access the workspace. Reconnect Brian.')
        if (!entitled) options.observe?.({ userId, workspaceId, format, entrypoint: 'mcp', outcome: 'upgrade_required' })
        const url = new URL(`/w/${encodeURIComponent(workspaceId)}/brain`, options.appOrigin)
        url.searchParams.set('memoryExport', format)
        const text = entitled
          ? `Open Brian to download memories from "${connected.name}": ${url.href}`
          : `Bulk memory export requires a paid plan for "${connected.name}". Open Brian for plan options: ${url.href}`
        return {
          content: [{ type: 'text' as const, text }],
          structuredContent: { status: entitled ? 'ready' : 'upgrade_required', workspace: connected.name, format, url: url.href },
        }
      } catch {
        return failure('Brian could not check the workspace export. Try again shortly.')
      }
    },
  }
}

import { z } from 'zod'
import { buildTool, type Tool } from '@use-brian/agent-runtime/tools/types.js'

type LinkValue = {
  workspaceId: string
  workspaceAlias: string
  pageId?: string
  pageAlias?: string
  sharePath: string
  url: string
  canonicalPath: string
}

type LinkResult =
  | { ok: true; value: LinkValue }
  | { ok: false; reason: string; suggestion?: string }

export type InternalLinkToolsPort = {
  ensure(userId: string, input: { workspaceId: string; pageId?: string }): Promise<LinkResult>
  renameWorkspace(userId: string, workspaceId: string, alias: string): Promise<LinkResult>
  renamePage(userId: string, pageId: string, alias: string): Promise<LinkResult>
}

function failed(result: Exclude<LinkResult, { ok: true }>) {
  return {
    data: {
      error: result.reason,
      suggestion: result.suggestion,
      note: 'Nothing was changed. Do not claim a link exists unless this command returns it.',
    },
    isError: true,
  }
}

/** Brian-native access to the same internal-link commands used by the UI. */
export function createInternalLinkTools(port: InternalLinkToolsPort): {
  getInternalShareLink: Tool
  setWorkspaceLinkAlias: Tool
  setPageLinkAlias: Tool
} {
  const getInternalShareLink = buildTool({
    name: 'getInternalShareLink',
    description:
      'Get or create the confirmed private link for the current workspace or one readable page. ' +
      'The link works only for authorized members, does not publish the page, and remains valid when names or titles change. ' +
      'Omit pageId for the workspace link. Never invent an alias or URL yourself.',
    inputSchema: z.object({ pageId: z.string().uuid().optional() }),
    isConcurrencySafe: false,
    async execute(input, context) {
      if (!context.workspaceId) {
        return { data: 'This assistant is not bound to a workspace, so it cannot create an internal link.', isError: true }
      }
      const result = await port.ensure(context.userId, {
        workspaceId: context.workspaceId,
        pageId: input.pageId,
      })
      return result.ok ? { data: result.value } : failed(result)
    },
  })

  const setWorkspaceLinkAlias = buildTool({
    name: 'setWorkspaceLinkAlias',
    description:
      'Set the readable private-link alias for the current workspace. Requires workspace owner/admin authority. ' +
      'Use lowercase ASCII letters and digits separated by single hyphens, up to 32 characters. Old links keep working.',
    inputSchema: z.object({ alias: z.string().min(1).max(32) }),
    isConcurrencySafe: false,
    async execute(input, context) {
      if (!context.workspaceId) {
        return { data: 'This assistant is not bound to a workspace, so it cannot change a workspace link.', isError: true }
      }
      const result = await port.renameWorkspace(context.userId, context.workspaceId, input.alias)
      return result.ok ? { data: result.value } : failed(result)
    },
  })

  const setPageLinkAlias = buildTool({
    name: 'setPageLinkAlias',
    description:
      'Set the readable private-link alias for a page. Requires the same page-owner/workspace-admin authority as Share settings. ' +
      'Use lowercase ASCII letters and digits separated by single hyphens, up to 64 characters. Old links keep working.',
    inputSchema: z.object({
      pageId: z.string().uuid(),
      alias: z.string().min(1).max(64),
    }),
    isConcurrencySafe: false,
    async execute(input, context) {
      const result = await port.renamePage(context.userId, input.pageId, input.alias)
      return result.ok ? { data: result.value } : failed(result)
    },
  })

  return { getInternalShareLink, setWorkspaceLinkAlias, setPageLinkAlias }
}

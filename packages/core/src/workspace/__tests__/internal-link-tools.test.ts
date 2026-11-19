import { describe, expect, it, vi } from 'vitest'
import { createInternalLinkTools, type InternalLinkToolsPort } from '../internal-link-tools.js'
import type { ToolContext } from '@use-brian/agent-runtime/tools/types.js'

const WORKSPACE_ID = '00000000-0000-4000-8000-000000000001'
const PAGE_ID = '00000000-0000-4000-8000-000000000002'

const context = (workspaceId: string | null = WORKSPACE_ID) => ({
  userId: 'user-1', assistantId: 'assistant-1', sessionId: 'session-1',
  appId: 'Use Brian', channelType: 'web', channelId: 'channel-1', workspaceId,
}) as ToolContext

function port(): InternalLinkToolsPort {
  const value = {
    workspaceId: WORKSPACE_ID,
    workspaceAlias: 'product',
    pageId: PAGE_ID,
    pageAlias: 'roadmap',
    sharePath: '/s/product/roadmap',
    url: 'https://brain.example/s/product/roadmap',
    canonicalPath: `/w/${WORKSPACE_ID}/p/${PAGE_ID}`,
  }
  return {
    ensure: vi.fn(async () => ({ ok: true as const, value })),
    renameWorkspace: vi.fn(async () => ({ ok: true as const, value })),
    renamePage: vi.fn(async () => ({ ok: true as const, value })),
  }
}

describe('[COMP:api/internal-links] Brian internal-link command parity', () => {
  it('gets a page link through the shared ensure command', async () => {
    const service = port()
    const tools = createInternalLinkTools(service)
    const result = await tools.getInternalShareLink.execute({ pageId: PAGE_ID }, context())
    expect(service.ensure).toHaveBeenCalledWith('user-1', {
      workspaceId: WORKSPACE_ID, pageId: PAGE_ID,
    })
    expect(result.data).toMatchObject({ sharePath: '/s/product/roadmap' })
  })

  it('routes both alias mutations through the same service port as UI', async () => {
    const service = port()
    const tools = createInternalLinkTools(service)
    await tools.setWorkspaceLinkAlias.execute({ alias: 'new-product' }, context())
    await tools.setPageLinkAlias.execute({ pageId: PAGE_ID, alias: 'new-roadmap' }, context())
    expect(service.renameWorkspace).toHaveBeenCalledWith('user-1', WORKSPACE_ID, 'new-product')
    expect(service.renamePage).toHaveBeenCalledWith('user-1', PAGE_ID, 'new-roadmap')
  })

  it('never invents a link when the command rejects access or conflicts', async () => {
    const service = port()
    vi.mocked(service.renamePage).mockResolvedValueOnce({
      ok: false, reason: 'conflict', suggestion: 'roadmap-ab12cd-2',
    })
    const result = await createInternalLinkTools(service).setPageLinkAlias.execute(
      { pageId: PAGE_ID, alias: 'roadmap' }, context(),
    )
    expect(result.isError).toBe(true)
    expect(result.data).toMatchObject({
      error: 'conflict', suggestion: 'roadmap-ab12cd-2',
    })
  })

  it('refuses workspace commands outside a workspace-bound session', async () => {
    const service = port()
    const result = await createInternalLinkTools(service).getInternalShareLink.execute({}, context(null))
    expect(result.isError).toBe(true)
    expect(service.ensure).not.toHaveBeenCalled()
  })
})

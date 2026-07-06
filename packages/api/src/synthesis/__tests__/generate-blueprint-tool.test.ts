import { describe, it, expect, vi } from 'vitest'
import { createGenerateBlueprintTool } from '../generate-blueprint-tool.js'

/**
 * The model-callable generate tool (structural-synthesis). Component tag:
 * [COMP:api/generate-blueprint-tool]. generateSynthesize + the page-template
 * store are mocked; the test exercises the tool's own logic: blueprint
 * resolution by (loose) name, the runnable-only filter, the workspace gate,
 * confirmation gating, and the actor threaded straight from the ToolContext.
 */

function makeTool(over?: { templates?: unknown[] }) {
  const generateSynthesize = vi.fn(async () => ({ pageId: 'page-9' as string | null }))
  const pageTemplateStore = {
    list: vi.fn(async () =>
      over?.templates ?? [
        { id: 'bp-1', name: 'HKTV Shops Brief', extraction: { sections: [{}], capture: [] } },
        { id: 'bp-2', name: 'Plain Skeleton', extraction: null },
      ],
    ),
  }
  const tool = createGenerateBlueprintTool({
    generateSynthesize: generateSynthesize as never,
    pageTemplateStore: pageTemplateStore as never,
  })
  return { tool, generateSynthesize, pageTemplateStore }
}

const ctx = { userId: 'user-1', assistantId: 'a-1', workspaceId: 'ws-1' } as never

describe('[COMP:api/generate-blueprint-tool] fillBlueprintFromBrain tool', () => {
  it('is a confirmation-gated write tool', () => {
    const { tool } = makeTool()
    expect(tool.name).toBe('fillBlueprintFromBrain')
    expect(tool.requiresConfirmation).toBe(true)
  })

  it('resolves the blueprint by a loose name and fills it under the ToolContext actor', async () => {
    const { tool, generateSynthesize } = makeTool()
    const res = await tool.execute({ blueprint: 'hktv shops', subject: 'HKTV Mall' }, ctx)
    expect(res.isError).toBeFalsy()
    expect(res.data).toMatchObject({ pageId: 'page-9', blueprint: 'HKTV Shops Brief' })
    expect(generateSynthesize).toHaveBeenCalledWith(
      expect.objectContaining({
        blueprintSlug: 'bp-1', subject: 'HKTV Mall', workspaceId: 'ws-1', userId: 'user-1', assistantId: 'a-1',
      }),
    )
  })

  it('errors (never crashes) with the available list when nothing matches', async () => {
    const { tool, generateSynthesize } = makeTool()
    const res = await tool.execute({ blueprint: 'nonexistent', subject: 'x' }, ctx)
    expect(res.isError).toBe(true)
    expect(String((res.data as { error: string }).error)).toContain('HKTV Shops Brief')
    expect(generateSynthesize).not.toHaveBeenCalled()
  })

  it('ignores plain templates that carry no extraction spec (runnable-only)', async () => {
    const { tool, generateSynthesize } = makeTool()
    const res = await tool.execute({ blueprint: 'Plain Skeleton', subject: 'x' }, ctx)
    expect(res.isError).toBe(true)
    expect(generateSynthesize).not.toHaveBeenCalled()
  })

  it('requires a workspace context', async () => {
    const { tool } = makeTool()
    const res = await tool.execute({ blueprint: 'hktv', subject: 'x' }, { userId: 'u', assistantId: 'a' } as never)
    expect(res.isError).toBe(true)
    expect(String((res.data as { error: string }).error).toLowerCase()).toContain('workspace')
  })
})

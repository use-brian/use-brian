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

  // Failures are message-first TEXT (docs/architecture/engine/tool-executor.md
  // → "Failure copy"): what did not happen, why, the fillable blueprints that
  // DO exist, and the retry verdict. A fill is confirmation-gated and spends a
  // model run, so "no run was spent" is part of the account.
  it('errors (never crashes) with the available list when nothing matches', async () => {
    const { tool, generateSynthesize } = makeTool()
    const res = await tool.execute({ blueprint: 'nonexistent', subject: 'x' }, ctx)
    expect(res.isError).toBe(true)
    const text = res.data as string
    expect(typeof text).toBe('string')
    expect(text).toContain('no blueprint in this workspace matches "nonexistent"')
    expect(text).toContain('HKTV Shops Brief')
    expect(text).toContain('No model run was spent')
    expect(text).toContain('Do NOT retry this exact name.')
    expect(generateSynthesize).not.toHaveBeenCalled()
  })

  it('ignores plain templates that carry no extraction spec (runnable-only)', async () => {
    const { tool, generateSynthesize } = makeTool()
    const res = await tool.execute({ blueprint: 'Plain Skeleton', subject: 'x' }, ctx)
    expect(res.isError).toBe(true)
    expect(generateSynthesize).not.toHaveBeenCalled()
  })

  it('requires a workspace context, and says which surface has one', async () => {
    const { tool } = makeTool()
    const res = await tool.execute({ blueprint: 'hktv', subject: 'x' }, { userId: 'u', assistantId: 'a' } as never)
    expect(res.isError).toBe(true)
    const text = res.data as string
    expect(text.toLowerCase()).toContain('workspace')
    // The gate names the surface that is missing and the remedy — never a bare
    // "not available in this context".
    expect(text).toContain('Run it from a workspace chat')
    expect(text).toContain('nothing was written')
  })
})

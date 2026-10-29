import { describe, expect, it, vi } from 'vitest'
import { createDrawingTools } from '../drawing-tools.js'
import { DOC_MUTATION_TOOLS } from '../edit-agent.js'
import type { DocToolDeps } from '../tools.js'
import type { ToolContext } from '../../tools/types.js'
const context: ToolContext = { userId: 'user', assistantId: 'assistant', sessionId: 'session', appId: 'test', channelType: 'web', channelId: 'web', workspaceId: 'workspace', clearance: 'internal', compartments: [], projectIds: [], abortSignal: new AbortController().signal }
const live = { namespace: 'drawing:diagram:epoch:base', scene: { version: 1, elements: [{ id: 'a', type: 'rectangle', x: 10, y: 20, width: 50, height: 50 }], files: {}, appState: { viewBackgroundColor: '#fff' } }, changedElementIds: ['a'] }
function tools(over: Partial<DocToolDeps> = {}) {
  const drawing = vi.fn().mockResolvedValue(live)
  const deps = { docGateway: { drawing, applyOps: vi.fn() }, anchorPageId: 'page', ...over } as DocToolDeps
  return { ...createDrawingTools(deps), drawing }
}
describe('[COMP:doc/drawing-tools] assistant tool surface', () => {
  it('reads live metadata and writes actions without a snapshot/CAS replacement', async () => {
    const t = tools()
    const read = await t.getDrawing.execute({ pageId: 'page', blockId: 'diagram', offset: 0, limit: 100 }, context)
    expect(read.data).toMatchObject({ namespace: live.namespace, total: 1, elements: [{ id: 'a', x: 10 }] })
    const result = await t.editDrawing.execute({ pageId: 'page', blockId: 'diagram', namespace: live.namespace, actions: [{ type: 'move', elementIds: ['a'], dx: 30, dy: 0 }] }, context)
    expect(result.isError).toBeFalsy()
    expect(t.drawing).toHaveBeenLastCalledWith({ userId: 'user', pageId: 'page', blockId: 'diagram', namespace: live.namespace, actions: [{ type: 'move', elementIds: ['a'], dx: 30, dy: 0 }] })
    expect(DOC_MUTATION_TOOLS.has('editDrawing')).toBe(true)
  })
  it('fails closed without a live service, workspace or selected-page match', async () => {
    const noService = tools({ docGateway: undefined })
    expect((await noService.getDrawing.execute({ pageId: 'page', blockId: 'diagram', offset: 0, limit: 100 }, context)).isError).toBe(true)
    const t = tools()
    for (const [pageId, ctx] of [['other', context], ['page', { ...context, workspaceId: null }]] as const) {
      expect((await t.editDrawing.execute({ pageId, blockId: 'diagram', namespace: live.namespace, actions: [{ type: 'connect', fromId: 'a', toId: 'b' }] }, ctx)).isError).toBe(true)
    }
    expect(t.drawing).not.toHaveBeenCalled()
  })
  it('lists and resolves built-in library IDs without model-authored geometry', async () => {
    const t = tools()
    const listing = await t.listDrawingLibrary.execute({ query: 'use-brian-bordered', offset: 0, limit: 50 }, context)
    const item = (listing.data as { items: { id: string }[] }).items[0]
    expect(item.id).toContain('brian-default')
    const input = { pageId: 'page', blockId: 'diagram', namespace: live.namespace, actions: [{ type: 'insertLibraryItem' as const, itemId: item.id, x: 100, y: 200 }] }
    expect((await t.editDrawing.execute(input, context)).isError).toBeFalsy()
    expect(t.drawing.mock.calls[0][0].actions[0]).toMatchObject({ type: 'insertLibraryItem', item: { id: item.id, elements: expect.any(Array) } })
    expect(t.editDrawing.inputSchema.safeParse({ ...input, actions: [{ ...input.actions[0], item: {} }] }).success).toBe(false)
  })
  it('reads attached libraries with workspace clearance and refuses unavailable items before a write', async () => {
    const get = vi.fn().mockResolvedValue({ fileName: 'shapes.excalidrawlib', content: JSON.stringify({ type: 'excalidrawlib', version: 2, libraryItems: [{ id: 'item', elements: live.scene.elements }] }) })
    const t = tools({ fileStore: { get } as unknown as DocToolDeps['fileStore'] })
    const result = await t.editDrawing.execute({ pageId: 'page', blockId: 'diagram', namespace: live.namespace,
      actions: [{ type: 'insertLibraryItem', libraryFileId: 'file', itemId: 'item', x: 100, y: 200 }] }, context)
    expect(result.isError).toBeFalsy()
    expect(get).toHaveBeenCalledWith('file', expect.objectContaining({ workspaceId: 'workspace', userId: 'user', clearance: 'internal', compartments: [], projectIds: [] }))
    get.mockResolvedValue(null); t.drawing.mockClear()
    expect((await t.editDrawing.execute({ pageId: 'page', blockId: 'diagram', namespace: live.namespace,
      actions: [{ type: 'insertLibraryItem', libraryFileId: 'file', itemId: 'item', x: 100, y: 200 }] }, context)).isError).toBe(true)
    expect(t.drawing).not.toHaveBeenCalled()
  })
  it('surfaces server conflicts as failures', async () => {
    const t = tools(); t.drawing.mockResolvedValue({ error: 'Drawing was replaced' })
    expect(await t.editDrawing.execute({ pageId: 'page', blockId: 'diagram', namespace: live.namespace, actions: [{ type: 'resize', elementId: 'a', width: 100, height: 80 }] }, context)).toMatchObject({ isError: true, data: expect.stringContaining('Drawing was replaced'), meta: { retrySafe: false } })
  })
})

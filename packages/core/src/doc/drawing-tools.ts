import { z } from 'zod'
import { defaultDrawingLibrary, parseLibrary, describeDrawing, drawingActionSchema,
  type DrawingAction, type DrawingLibraryItem } from '@use-brian/shared/drawing'
import { buildTool, type ToolContext } from '../tools/types.js'
import type { DocToolDeps } from './tools.js'
import { actorFromContext } from '../retrieval/tools.js'

const id = z.string().min(1).max(128)
const target = { pageId: id, blockId: id }
const librarySource = { libraryFileId: id.optional().describe('Attached .excalidrawlib file ID. Omit for the built-in Brian library.') }
const publicAction = z.discriminatedUnion('type', [
  drawingActionSchema.options[0], drawingActionSchema.options[1], drawingActionSchema.options[2],
  z.object({ type: z.literal('insertLibraryItem'), itemId: z.string().min(1).max(200), ...librarySource,
    x: z.number().finite().min(-10_000_000).max(10_000_000), y: z.number().finite().min(-10_000_000).max(10_000_000) }).strict(),
])
function gate(deps: DocToolDeps, pageId: string, context: ToolContext): string | undefined {
  if (!context.workspaceId) return 'A workspace chat is required for drawing tools.'
  if (deps.anchorPageId && pageId !== deps.anchorPageId && !deps.turnCreatedPageIds?.has(pageId)) return 'This drawing tool is pinned to the selected Page. Use its page ID and read the drawing again.'
  if (!deps.docGateway?.drawing) return 'Live drawing tools are unavailable: configure or update the document sync service. No scene was replaced.'
}
function failure(error: unknown) {
  return { data: error instanceof z.ZodError ? error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')
    : error instanceof Error ? error.message : String(error), isError: true as const }
}
async function library(deps: DocToolDeps, fileId: string | undefined, context: ToolContext): Promise<DrawingLibraryItem[]> {
  if (!context.workspaceId) throw new Error('A workspace chat is required for drawing tools.')
  if (!fileId) return defaultDrawingLibrary()
  if (!deps.fileStore) throw new Error('Attached drawing libraries are unavailable in this context')
  const actor = actorFromContext(context)
  if ('error' in actor) throw new Error(actor.error)
  const file = await deps.fileStore.get(fileId, { ...actor, sharedAudience: context.sharedAudience, visibilityAssistantIds: context.visibilityAssistantIds })
  if (!file) throw new Error('Library file not found or access denied')
  if (!file.fileName.toLowerCase().endsWith('.excalidrawlib')) throw new Error('Select an attached .excalidrawlib file')
  const items = parseLibrary(file.content)
  context.scopeAccumulator?.note({ sensitivity: file.sensitivity, compartments: file.compartments, projectIds: file.projectIds })
  if (file.sensitivity) context.sensitivity?.note(file.sensitivity)
  return items
}

export function createDrawingTools(deps: DocToolDeps) {
  const getDrawing = buildTool({
    name: 'getDrawing', requiresCapability: 'page', isReadOnly: true, isConcurrencySafe: true,
    allowsRepeatCalls: true, timeoutMs: 30_000,
    description: 'Read current live Excalidraw shape IDs, positions, sizes, text, groups and arrow bindings. Use before editDrawing; retain its namespace to detect replacement. Coordinates are scene units. Paged metadata has no image bytes; use getBlock for an available exported image. Requires edit access to the Page and the live sync service.',
    inputSchema: z.object({ ...target, offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(200).default(100) }).strict(),
    async execute(input, context) {
      const denied = gate(deps, input.pageId, context)
      if (denied) return failure(denied)
      try {
        const result = await deps.docGateway!.drawing!({ userId: context.userId, ...input, actions: [] })
        if ('error' in result) return failure(result.error)
        const elements = describeDrawing(result.scene)
        return { data: { pageId: input.pageId, blockId: input.blockId, namespace: result.namespace, title: result.title,
          elements: elements.slice(input.offset, input.offset + input.limit), total: elements.length,
          nextOffset: input.offset + input.limit < elements.length ? input.offset + input.limit : null } }
      } catch (error) { return failure(error) }
    },
  })
  const listDrawingLibrary = buildTool({
    name: 'listDrawingLibrary', requiresCapability: 'page', isReadOnly: true, isConcurrencySafe: true,
    description: 'List insertable drawing library item IDs and names from the built-in Brian library or an attached .excalidrawlib file. Insert with editDrawing using itemId and the same libraryFileId. Personal libraries live only in the browser; export and attach one to use its items. No raw element JSON is needed.',
    inputSchema: z.object({ ...librarySource, query: z.string().max(200).optional(), offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(100).default(50) }).strict(),
    async execute(input, context) {
      try {
        const items = (await library(deps, input.libraryFileId, context)).filter(i => !input.query || `${i.name ?? ''} ${i.id}`.toLowerCase().includes(input.query.toLowerCase()))
        return { data: { libraryFileId: input.libraryFileId ?? null, items: items.slice(input.offset, input.offset + input.limit).map(i => ({ id: i.id, name: i.name ?? i.id, elementCount: i.elements.length })),
          total: items.length, nextOffset: input.offset + input.limit < items.length ? input.offset + input.limit : null } }
      } catch (error) { return failure(error) }
    },
  })
  const editDrawing = buildTool({
    name: 'editDrawing', requiresCapability: 'page', isReadOnly: false, isConcurrencySafe: false, timeoutMs: 30_000,
    description: 'Edit an existing live Excalidraw diagram with shape actions, visible immediately to connected editors. Read getDrawing first and pass its namespace. move offsets selected shapes/groups by dx/dy; resize sets dimensions; connect creates a bound arrow between two rectangles, diamonds or ellipses; insertLibraryItem clones an item from listDrawingLibrary at x/y. Bound labels and straight connectors follow shapes. Locked/missing shapes or a replaced drawing reject the entire batch. Uses current live geometry, preserves unrelated edits and image assets. Do not replace the scene JSON for these operations. Changes are shared immediately and are not in a human editor’s local undo history.',
    inputSchema: z.object({ ...target, namespace: z.string().min(1).max(512), actions: z.array(publicAction).min(1).max(64) }).strict(),
    async execute(input, context) {
      const denied = gate(deps, input.pageId, context)
      if (denied) return failure(denied)
      try {
        const loaded = new Map<string, DrawingLibraryItem[]>()
        const actions: DrawingAction[] = []
        for (const action of input.actions) {
          if (action.type !== 'insertLibraryItem') { actions.push(action); continue }
          const key = action.libraryFileId ?? ''
          if (!loaded.has(key)) loaded.set(key, await library(deps, action.libraryFileId, context))
          const item = loaded.get(key)!.find(i => i.id === action.itemId)
          if (!item) return failure('Library item not found; listDrawingLibrary again using the same libraryFileId')
          actions.push({ type: action.type, item, x: action.x, y: action.y })
        }
        const result = await deps.docGateway!.drawing!({ userId: context.userId, pageId: input.pageId, blockId: input.blockId, namespace: input.namespace, actions })
        if ('error' in result) return { ...failure(`${result.error}. Re-read getDrawing before retrying; a transport failure may follow an applied edit.`), meta: { retrySafe: false, operationMayHaveExecuted: true } }
        const changed = new Set(result.changedElementIds)
        return { data: { pageId: input.pageId, blockId: input.blockId, namespace: result.namespace,
          changedElementIds: result.changedElementIds,
          elements: describeDrawing(result.scene).filter(e => changed.has(e.id)).slice(0, 100),
          changedCount: changed.size, message: 'Applied to the live drawing. Use getDrawing for further shape details.' } }
      } catch (error) { return failure(error) }
    },
  })
  return { getDrawing, listDrawingLibrary, editDrawing }
}

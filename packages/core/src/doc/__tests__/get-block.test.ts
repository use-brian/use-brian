/**
 * [COMP:doc/tools] `getBlock` failure copy.
 *
 * `getBlock` has three ways to fail and each one used to end the model's
 * search rather than redirect it:
 *
 *   - the PAGE misses      → `pageNotFound` (already the reference shape)
 *   - the BLOCK misses     → an id that changed under the model; the outline
 *                            is where a current one comes from
 *   - the block is CORRUPT → a stored-data fault, not a bad argument, and the
 *                            old copy pasted `ZodError.message` (a raw JSON
 *                            dump of the issue array) into the tool result
 *
 * The last one is why this suite exists: a validation failure now renders
 * through `formatToolError` (compact `path: message` lines) and says outright
 * that the arguments are fine and the same id will keep failing, so the model
 * routes around the block instead of re-sending it.
 *
 * Spec: `docs/architecture/engine/tool-executor.md` → "Failure copy".
 */

import { describe, expect, it, vi } from 'vitest'
import { deflateSync } from 'node:zlib'
import CRC32 from 'crc-32'
import sharp from 'sharp'
import { createCanvas } from '@napi-rs/canvas'
import type { SavedViewStore } from '../../views/types.js'
import type { CrmStore } from '../../crm/types.js'
import type { TaskStore } from '../../tasks/types.js'
import type { WorkflowRunStore } from '../../workflow/types.js'
import { createGetBlockTool, createGetCurrentPageTool } from '../tools.js'
import { drawingPreviewSchema, drawingSceneDigest, type DrawingBlock } from '@use-brian/shared/drawing'
import { queryLoop } from '../../engine/query-loop.js'
import { NOOP_TURN_LEDGER } from '../../engine/turn-ledger.js'
import { runDocEditAgent } from '../edit-agent.js'
import { createOpenAICompatProvider } from '../../providers/openai-compat.js'
import type { DocToolDeps } from '../tools.js'
import type { Block, Page } from '../page-types.js'

const WORKSPACE_ID = '00000000-0000-0000-0000-000000000010'
const USER_ID = '00000000-0000-0000-0000-000000000020'
const PAGE_ID = '00000000-0000-0000-0000-0000000000b1'

function ctx(overrides: { workspaceId?: string | null } = {}) {
  return {
    userId: USER_ID,
    assistantId: 'asst-1',
    sessionId: 'sess-1',
    appId: 'Use Brian',
    channelType: 'web',
    channelId: 'web-1',
    workspaceId:
      overrides.workspaceId === undefined ? WORKSPACE_ID : overrides.workspaceId,
    activeCapabilities: new Set(['page', 'home_app:page:read']),
    abortSignal: new AbortController().signal,
  }
}

/** Minimal dep bag — `getBlock` only ever touches `docPageStore.getVersionedPage`. */
function deps(page: Page | null): DocToolDeps {
  return {
    savedViewStore: {
      getPage: vi.fn().mockResolvedValue(page),
    } as unknown as SavedViewStore,
    docPageStore: {
      getVersionedPage: vi.fn().mockResolvedValue(page ? { page, version: 1, title: 'Current page', nameOrigin: 'user', icon: null } : null),
      applyPatch: vi.fn(),
    },
    taskStore: {} as TaskStore,
    crmStore: {} as CrmStore,
    workflowRunStore: {} as WorkflowRunStore,
    workspaceDirectory: {
      listMembers: vi.fn().mockResolvedValue([]),
      get: vi.fn().mockResolvedValue(null),
      batchGet: vi.fn().mockResolvedValue(new Map()),
    },
  }
}

const TEXT_BLOCK: Block = { kind: 'text', id: 'b1', text: 'hello' } as Block

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVR4nGP4////fwAJ+wP9KobjigAAAABJRU5ErkJggg=='

function pngChunk(type: string, data: Buffer): Buffer {
  const chunk = Buffer.alloc(12 + data.length)
  chunk.writeUInt32BE(data.length)
  chunk.write(type, 4, 'ascii')
  data.copy(chunk, 8)
  chunk.writeUInt32BE(CRC32.buf(chunk.subarray(4, -4)) >>> 0, chunk.length - 4)
  return chunk
}
async function drawing(): Promise<DrawingBlock> {
  const scene: DrawingBlock['scene'] = { version: 1, elements: [], appState: { viewBackgroundColor: '#fff' },
    files: { f: { id: 'f', mimeType: 'image/png', dataURL: `data:image/png;base64,${png}`, created: 1 } } }
  return { kind: 'drawing', id: 'd1', scene,
    preview: { mimeType: 'image/png', width: 1, height: 1, data: png, sceneDigest: await drawingSceneDigest(scene) } }
}

describe('[COMP:doc/drawing-read] visual evidence', () => {
  it('reads named and legacy drawings and exposes names in outlines without losing visual evidence', async () => {
    const { buildOutline } = await import('../outline.js')
    for (const title of [undefined, 'Architecture sketch']) {
      const block = { ...await drawing(), ...(title ? { title } : {}) }
      const result = await createGetBlockTool(deps({ blocks: [block] })).execute({ pageId: PAGE_ID, blockId: 'd1' }, ctx())
      expect(result.images).toHaveLength(1)
      if (title) expect(JSON.stringify(result.data)).toContain(title)
      expect(buildOutline({ blocks: [block] }).blocks[0].preview).toBe(`${title ? '"Architecture sketch" ' : ''}drawing (Excalidraw, 0 elements)`)
    }
  })
  it.each([
    'missing IDAT', 'invalid compressed data', 'bad zlib checksum', 'invalid pixel filter',
    'bad IDAT CRC', 'bad ancillary CRC', 'oversized chunk length', 'undersized chunk length',
    'excess inflated data', 'duplicate oversized IHDR',
  ])('reports %s as unavailable, despite matching scene digest and valid envelope', async fault => {
    const block = await drawing()
    const source = Buffer.from(png, 'base64')
    const header = source.subarray(0, 33)
    const end = source.subarray(-12)
    const image = source.subarray(54, -12)
    let bytes = Buffer.from(source)
    if (fault === 'missing IDAT') bytes = Buffer.concat([header, pngChunk('tEXt', Buffer.alloc(0)), end]) // 57-byte fake
    if (fault === 'invalid compressed data') bytes = Buffer.concat([header, pngChunk('IDAT', Buffer.from([1, 2, 3, 4])), end])
    if (fault === 'bad zlib checksum') {
      const compressed = Buffer.from(image.subarray(8, -4))
      compressed[compressed.length - 1] ^= 1
      bytes = Buffer.concat([header, pngChunk('IDAT', compressed), end])
    }
    if (fault === 'invalid pixel filter') bytes = Buffer.concat([header, pngChunk('IDAT', deflateSync(Buffer.from([5, 255, 255, 255, 255]))), end])
    if (fault === 'bad IDAT CRC') bytes[bytes.length - 13] ^= 1
    if (fault === 'bad ancillary CRC') bytes[53] ^= 1
    if (fault === 'oversized chunk length') bytes.writeUInt32BE(0xffffffff, 54)
    if (fault === 'undersized chunk length') bytes.writeUInt32BE(1, 54)
    if (fault === 'excess inflated data') {
      // A 1x1 PNG cannot authorize a megabyte of inflated scanline data.
      bytes = Buffer.concat([header, pngChunk('IDAT', deflateSync(Buffer.alloc(1024 * 1024))), end])
    }
    if (fault === 'duplicate oversized IHDR') {
      const ihdr = Buffer.from(source.subarray(16, 29))
      ihdr.writeUInt32BE(0x7fffffff)
      bytes = Buffer.concat([header, pngChunk('IHDR', ihdr), image, end])
    }
    const preview = { ...block.preview!, data: bytes.toString('base64') }
    expect(drawingPreviewSchema.safeParse(preview).success).toBe(true)
    const result = await createGetBlockTool(deps({ blocks: [{ ...block, preview }] })).execute({ pageId: PAGE_ID, blockId: 'd1' }, ctx())
    expect(result.isError).not.toBe(true)
    expect(result.images).toBeUndefined()
    expect(result.data).toMatchObject({ block: { id: 'd1', scene: { elements: block.scene.elements }, previewStatus: expect.stringContaining('unavailable:') } })
    expect(JSON.stringify(result.data)).not.toContain(preview.data)
  })
  it('decodes a real canvas PNG and sends the same pixels in a valid regenerated PNG', async () => {
    const canvas = createCanvas(48, 32)
    const context = canvas.getContext('2d')
    context.fillStyle = '#ffffff'
    context.fillRect(0, 0, 48, 32)
    context.fillStyle = '#123456'
    context.fillRect(8, 8, 16, 16)
    const exported = canvas.toBuffer('image/png')
    const block = await drawing()
    block.preview = { ...block.preview!, width: 48, height: 32, data: exported.toString('base64') }
    const result = await createGetBlockTool(deps({ blocks: [block] })).execute({ pageId: PAGE_ID, blockId: 'd1' }, ctx())
    expect(result.images).toHaveLength(1)
    const received = Buffer.from(result.images![0].data, 'base64')
    expect(await sharp(received, { failOn: 'warning' }).raw().toBuffer()).toEqual(await sharp(exported).raw().toBuffer())
    expect(result.images![0].mimeType).toBe('image/png')
  })
  it('drops compressed ancillary metadata instead of inflating or forwarding it', async () => {
    const source = Buffer.from(png, 'base64')
    const bytes = Buffer.concat([source.subarray(0, 33), pngChunk('zTXt', Buffer.concat([
      Buffer.from('note\0\0'), deflateSync(Buffer.alloc(1024 * 1024, 'a')),
    ])), source.subarray(33)])
    const block = await drawing()
    block.preview = { ...block.preview!, data: bytes.toString('base64') }
    const result = await createGetBlockTool(deps({ blocks: [block] })).execute({ pageId: PAGE_ID, blockId: 'd1' }, ctx())
    expect(result.images).toHaveLength(1)
    const received = Buffer.from(result.images![0].data, 'base64')
    expect(received.includes(Buffer.from('zTXt'))).toBe(false)
    expect(await sharp(received).raw().toBuffer()).toEqual(Buffer.from([255, 255, 255, 255]))
  })
  it('delivers PNG separately from text only after a user-scoped page read', async () => {
    const block = await drawing()
    const store = deps({ blocks: [block] })
    const result = await createGetBlockTool(store).execute({ pageId: PAGE_ID, blockId: 'd1' }, ctx())
    expect(store.docPageStore.getVersionedPage).toHaveBeenCalledWith(USER_ID, PAGE_ID, expect.objectContaining({ userId: USER_ID }))
    expect(result.images).toEqual([{ mimeType: 'image/png', data: expect.any(String) }])
    expect(await sharp(Buffer.from(result.images![0].data, 'base64')).raw().toBuffer()).toEqual(Buffer.from([255, 255, 255, 255]))
    expect(JSON.stringify(result.data)).not.toContain(png)
    expect(JSON.stringify(result.data)).toContain('attached:')
    const denied = await createGetBlockTool(deps(null)).execute({ pageId: PAGE_ID, blockId: 'd1' }, ctx())
    expect(denied.isError).toBe(true)
    expect(denied.images).toBeUndefined()
    const gated = await createGetBlockTool(store).execute({ pageId: PAGE_ID, blockId: 'd1' }, ctx({ workspaceId: null }))
    expect(gated.isError).toBe(true)
    expect(gated.images).toBeUndefined()
    expect(store.docPageStore.getVersionedPage).toHaveBeenCalledTimes(1)
  })
  it('reports missing, invalid and stale exports without exposing bytes or rejecting the editable scene', async () => {
    const block = await drawing()
    for (const preview of [undefined, { ...block.preview!, data: 'https://private.example/a.png' }, { ...block.preview!, sceneDigest: '0'.repeat(64) }]) {
      const result = await createGetBlockTool(deps({ blocks: [{ ...block, preview }] })).execute({ pageId: PAGE_ID, blockId: 'd1' }, ctx())
      expect(result.isError).not.toBe(true)
      expect(result.images).toBeUndefined()
      expect(JSON.stringify(result.data)).toContain('unavailable:')
      expect(JSON.stringify(result.data)).not.toContain(png)
      expect(JSON.stringify(result.data)).not.toContain('private.example')
    }
  })
  it('keeps bulk reads binary-free and points to targeted visual reading', async () => {
    const block = await drawing()
    const store = deps({ blocks: [block] })
    vi.mocked(store.docPageStore.getVersionedPage).mockResolvedValue({ page: { blocks: [block] }, version: 1, title: 'Sketch', nameOrigin: 'user', icon: null })
    const result = await createGetCurrentPageTool(store).execute({ pageId: PAGE_ID, fields: 'full' }, ctx())
    expect(result.images).toBeUndefined()
    expect(JSON.stringify(result.data)).not.toContain(png)
    expect(JSON.stringify(result.data)).toContain('available: use getBlock')
  })
  it.each(['parent', 'delegate'])('passes a drawing through the %s loop and real provider adapter as image_url, not tool text', async lane => {
    const block = await drawing()
    const tool = createGetBlockTool(deps({ blocks: [block] }))
    // Prove text truncation cannot cut the image payload.
    tool.maxResultSizeChars = 100
    const tools = new Map([['getBlock', tool]])
    const bodies: Array<{ messages: Array<{ role: string; content: unknown }> }> = []
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      bodies.push(JSON.parse(init!.body as string))
      const delta = bodies.length === 1
        ? { tool_calls: [{ index: 0, id: 'read-drawing', function: { name: 'getBlock', arguments: JSON.stringify({ pageId: PAGE_ID, blockId: 'd1' }) } }] }
        : { content: 'Read the drawing.' }
      return new Response(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: bodies.length === 1 ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`, { headers: { 'Content-Type': 'text/event-stream' } })
    })
    try {
      const provider = createOpenAICompatProvider({ apiKey: 'test', baseURL: 'https://llm.example/v1', label: 'test', supportsVision: true })
      if (lane === 'delegate') {
        await runDocEditAgent({ provider, model: 'test', systemPrompt: 'Read drawings.', instruction: 'Read the drawing.', tools,
          context: ctx(), loadPageContext: async () => `pageId=${PAGE_ID} d1 drawing` })
      } else {
        for await (const _event of queryLoop({ ledger: NOOP_TURN_LEDGER, provider, model: 'test', systemPrompt: 'Read drawings.',
          messages: [{ role: 'user', content: 'Read the drawing.' }], tools, context: ctx(), stateless: true, maxTurns: 3 })) { /* drain */ }
      }
      expect(bodies).toHaveLength(2)
      const imageParts = bodies[1].messages.filter(message => message.role === 'user')
        .flatMap(message => Array.isArray(message.content) ? message.content : [])
        .filter(part => part.type === 'image_url')
      expect(imageParts).toHaveLength(1)
      const imageURL: string = imageParts[0].image_url.url
      expect(imageURL).toMatch(/^data:image\/png;base64,/)
      const imageData = imageURL.slice('data:image/png;base64,'.length)
      expect(await sharp(Buffer.from(imageData, 'base64'), { failOn: 'warning' }).raw().toBuffer()).toEqual(Buffer.from([255, 255, 255, 255]))
      const textResults = bodies[1].messages.filter(message => message.role === 'tool')
      expect(JSON.stringify(textResults)).not.toContain(png)
      expect(JSON.stringify(textResults)).not.toContain(imageData)
      expect(JSON.stringify(textResults)).toContain('[Result truncated]')
    } finally { fetch.mockRestore() }
  })
})

describe('[COMP:doc/tools] getBlock failure copy', () => {
  it('sends a block miss back to the outline and forbids the blind retry', async () => {
    const tool = createGetBlockTool(deps({ blocks: [TEXT_BLOCK] }))
    const res = await tool.execute({ pageId: PAGE_ID, blockId: 'b-gone' }, ctx())

    expect(res.isError).toBe(true)
    const data = String(res.data)
    expect(data).toContain('b-gone')
    expect(data).toContain(PAGE_ID)
    // Why a valid-looking id can miss + where a current one comes from.
    expect(data).toContain('stale')
    expect(data).toContain('getCurrentPage')
    expect(data).toContain('Do NOT retry this exact block id')
  })

  it('renders a corrupt block through formatToolError, not the raw ZodError dump', async () => {
    // A block whose `kind` is real but whose payload does not satisfy the wire
    // format — the shape a hand-edited / migrated JSONB column produces.
    const corrupt = { kind: 'text', id: 'b1', text: 42 } as unknown as Block
    const tool = createGetBlockTool(deps({ blocks: [corrupt] }))
    const res = await tool.execute({ pageId: PAGE_ID, blockId: 'b1' }, ctx())

    expect(res.isError).toBe(true)
    const data = String(res.data)
    // formatToolError's compact `path: message` lines…
    expect(data).toContain('Validation failed:')
    expect(data).toMatch(/\btext\b\s*:/)
    // …and never the raw ZodError JSON dump the old copy interpolated.
    expect(data).not.toContain('"code"')
    expect(data).not.toContain('[\n')
    // A stored-data fault: say the arguments are fine and close the retry.
    expect(data).toContain('Nothing is wrong with your arguments')
    expect(data).toContain('will keep failing')
    expect(data).toContain('getCurrentPage')
  })

  it('still routes a missing page through the page-not-found pointer', async () => {
    const tool = createGetBlockTool(deps(null))
    const res = await tool.execute({ pageId: PAGE_ID, blockId: 'b1' }, ctx())

    expect(res.isError).toBe(true)
    const data = String(res.data)
    expect(data).toContain(PAGE_ID)
    expect(data).toContain('findPage')
  })
})

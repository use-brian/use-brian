import { describe, it, expect, vi } from 'vitest'
import { createRenderPdfTool, normalizePdfPath } from '../render-pdf.js'
import { createFileTools } from '../tools.js'
import type { FilesApi, FilesWriteBytesParams } from '../api.js'
import type { WorkspaceFile } from '../types.js'
import type { ToolContext } from '../../tools/types.js'
import { PdfRenderError, type PdfRenderer } from '../../doc/convert/to-pdf.js'
import { markdownToBlocks } from '../../doc/markdown.js'

// ── Fixtures ─────────────────────────────────────────────────

function fakeFile(over: Partial<WorkspaceFile> = {}): WorkspaceFile {
  const now = new Date()
  return {
    id: '00000000-0000-0000-0000-000000000042',
    workspaceId: 'ws-1',
    path: '/reports/q3.pdf',
    parentPath: '/reports',
    name: 'q3.pdf',
    title: 'Q3 summary',
    summary: null,
    mime: 'application/pdf',
    sizeBytes: 4321,
    tags: [],
    relatedIds: [],
    storageUri: 'gs://test/ws-1/f42',
    sensitivity: 'internal',
    metadata: {},
    userId: null,
    assistantId: null,
    source: 'user',
    sourceEpisodeId: null,
    verifiedByUserId: null,
    verifiedAt: null,
    validFrom: now,
    validTo: null,
    supersededBy: null,
    retractedAt: null,
    retractedReason: null,
    retractedBy: null,
    createdByUserId: 'u-1',
    createdByAssistantId: null,
    createdAt: now,
    updatedAt: now,
    ...over,
  }
}

/** writeBytes-only fake — the tool must persist through writeBytes and nothing else. */
function writeBytesApi(onWrite: (params: FilesWriteBytesParams) => void, result: WorkspaceFile | { kind: string } = fakeFile()): FilesApi {
  const reject = () => {
    throw new Error('renderPdf must only call writeBytes')
  }
  return {
    write: reject,
    append: reject,
    read: reject,
    readBytes: reject,
    search: reject,
    setMeta: reject,
    delete: reject,
    stat: reject,
    async writeBytes(_ctx: unknown, params: FilesWriteBytesParams) {
      onWrite(params)
      if ('kind' in result) return { ok: false, error: result }
      return { ok: true, value: { ...result, path: params.path, name: params.path.split('/').pop()!, sizeBytes: params.bytes.length } }
    },
  } as unknown as FilesApi
}

const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d])

function fakeRenderer(over: Partial<PdfRenderer> = {}): PdfRenderer & { calls: Array<{ kind: 'page' | 'markdown'; title?: string; input: unknown }> } {
  const calls: Array<{ kind: 'page' | 'markdown'; title?: string; input: unknown }> = []
  return {
    calls,
    async fromPage(page, opts) {
      calls.push({ kind: 'page', title: opts?.title, input: page })
      return { bytes: PDF, pageCount: 2, mime: 'application/pdf' }
    },
    async fromMarkdown(markdown, opts) {
      calls.push({ kind: 'markdown', title: opts?.title, input: markdown })
      return { bytes: PDF, pageCount: 1, mime: 'application/pdf' }
    },
    ...over,
  }
}

function makeContext(over: Partial<ToolContext> = {}): ToolContext {
  return {
    userId: 'u-1',
    assistantId: 'a-1',
    sessionId: 's-1',
    appId: 'Use Brian',
    channelType: 'telegram',
    channelId: 'c-1',
    workspaceId: 'ws-1',
    abortSignal: new AbortController().signal,
    ...over,
  }
}

describe('[COMP:files/render-pdf] renderPdf', () => {
  it('normalizes the path to a .pdf file', () => {
    expect(normalizePdfPath('reports/q3')).toBe('/reports/q3.pdf')
    expect(normalizePdfPath('/reports/q3.PDF')).toBe('/reports/q3.pdf')
    expect(normalizePdfPath('/reports/q3.pdf')).toBe('/reports/q3.pdf')
    expect(normalizePdfPath('  ')).toBeNull()
    expect(normalizePdfPath('/reports/')).toBeNull()
    expect(normalizePdfPath('/reports/.pdf')).toBeNull()
  })

  it('renders Markdown, persists the bytes as application/pdf, and points the model at sendFile', async () => {
    let written: FilesWriteBytesParams | null = null
    const renderer = fakeRenderer()
    const events: unknown[] = []
    const tool = createRenderPdfTool(writeBytesApi((p) => { written = p }), {
      renderer,
      onFileCreated: (evt) => events.push(evt),
    })

    const result = await tool.execute(
      { path: 'reports/q3-summary', markdown: '# Q3\n\nRevenue grew.', title: 'Q3 summary', summary: 'Quarter recap', tags: ['report'], sensitivity: 'internal' },
      makeContext(),
    )

    expect(result.isError).toBeUndefined()
    expect(renderer.calls).toEqual([{ kind: 'markdown', title: 'Q3 summary', input: '# Q3\n\nRevenue grew.' }])
    expect(written).toMatchObject({ path: '/reports/q3-summary.pdf', mime: 'application/pdf', title: 'Q3 summary', summary: 'Quarter recap', tags: ['report'], sensitivity: 'internal' })
    expect(Array.from(written!.bytes)).toEqual(Array.from(PDF))
    expect(result.data).toContain('Rendered /reports/q3-summary.pdf (1 page')
    expect(result.data).toContain('id=00000000-0000-0000-0000-000000000042')
    expect(result.data).toContain('sendFile with file="00000000-0000-0000-0000-000000000042"')
    expect(events).toEqual([{ fileId: '00000000-0000-0000-0000-000000000042', path: '/reports/q3-summary.pdf', sizeBytes: PDF.length, pageCount: 1 }])
  })

  it('renders an existing doc page via the boot-wired reader and defaults the title to the page title', async () => {
    const renderer = fakeRenderer()
    const page = { blocks: markdownToBlocks('## Agenda\n\n- a') }
    const readDocPage = vi.fn(async (userId: string, pageId: string) => (pageId === 'p-1' ? { title: 'Sync notes', page } : null))
    let written: FilesWriteBytesParams | null = null
    const tool = createRenderPdfTool(writeBytesApi((p) => { written = p }), { renderer, readDocPage })

    const result = await tool.execute({ path: '/notes/sync.pdf', pageId: 'p-1' }, makeContext())

    expect(result.isError).toBeUndefined()
    expect(readDocPage).toHaveBeenCalledWith('u-1', 'p-1')
    expect(renderer.calls).toEqual([{ kind: 'page', title: 'Sync notes', input: page }])
    expect(written).toMatchObject({ path: '/notes/sync.pdf', title: 'Sync notes', mime: 'application/pdf' })
    expect(result.data).toContain('2 pages')
  })

  it('reports an unknown page honestly (RLS-scoped reader returns null)', async () => {
    const tool = createRenderPdfTool(writeBytesApi(() => { throw new Error('must not write') }), { renderer: fakeRenderer(), readDocPage: async () => null })
    const result = await tool.execute({ path: '/x.pdf', pageId: 'nope' }, makeContext())
    expect(result.isError).toBe(true)
    expect(result.data).toContain('Page not found')
  })

  it('refuses pageId when no page reader is wired (still renders markdown)', async () => {
    const tool = createRenderPdfTool(writeBytesApi(() => { throw new Error('must not write') }), { renderer: fakeRenderer() })
    const result = await tool.execute({ path: '/x.pdf', pageId: 'p-1' }, makeContext())
    expect(result.isError).toBe(true)
    expect(result.data).toContain('pass the content as `markdown`')
  })

  it('rejects a call with both or neither of markdown / pageId at the schema boundary', () => {
    const tool = createRenderPdfTool(writeBytesApi(() => {}), { renderer: fakeRenderer() })
    expect(tool.inputSchema.safeParse({ path: '/x.pdf' }).success).toBe(false)
    expect(tool.inputSchema.safeParse({ path: '/x.pdf', markdown: 'a', pageId: 'p' }).success).toBe(false)
    expect(tool.inputSchema.safeParse({ path: '/x.pdf', markdown: 'a' }).success).toBe(true)
  })

  it('surfaces a missing converter in Brian words and never writes a file', async () => {
    const write = vi.fn()
    const renderer = fakeRenderer({
      async fromMarkdown() {
        throw new PdfRenderError('converter_unavailable', { cause: 'spawn soffice ENOENT' })
      },
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const tool = createRenderPdfTool(writeBytesApi(write), { renderer })
      const result = await tool.execute({ path: '/x.pdf', markdown: 'hello' }, makeContext())
      expect(result.isError).toBe(true)
      expect(result.data).toContain('PDF rendering is unavailable')
      expect(result.data).toContain('could not be produced')
      expect(result.data).not.toContain('ENOENT')
      expect(write).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })

  it('surfaces a path conflict from the files API as an honest error', async () => {
    const tool = createRenderPdfTool(writeBytesApi(() => {}, { kind: 'conflict', reference: '/x.pdf' } as never), { renderer: fakeRenderer() })
    const result = await tool.execute({ path: '/x.pdf', markdown: 'hello' }, makeContext())
    expect(result.isError).toBe(true)
  })

  it('requires a workspace', async () => {
    const tool = createRenderPdfTool(writeBytesApi(() => {}), { renderer: fakeRenderer() })
    const result = await tool.execute({ path: '/x.pdf', markdown: 'hello' }, makeContext({ workspaceId: null }))
    expect(result.isError).toBe(true)
  })

  it('is blocked by an execute-time block policy', async () => {
    const tool = createRenderPdfTool(writeBytesApi(() => {}), { renderer: fakeRenderer(), resolvePolicy: async () => 'block' })
    const result = await tool.execute({ path: '/x.pdf', markdown: 'hello' }, makeContext())
    expect(result.isError).toBe(true)
    expect(result.data).toContain('blocked by tool policy')
  })

  it('is registered by createFileTools with the files capability and no static confirmation', () => {
    const tools = createFileTools(writeBytesApi(() => {}), { pdfRenderer: fakeRenderer() })
    expect(tools.renderPdf.name).toBe('renderPdf')
    expect(tools.renderPdf.requiresCapability).toBe('files')
    expect(tools.renderPdf.requiresConfirmation).toBe(false)
    expect(tools.renderPdf.isReadOnly).toBe(false)
  })
})

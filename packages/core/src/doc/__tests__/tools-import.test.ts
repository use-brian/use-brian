/**
 * [COMP:doc/tools] importToPage — the faithful + transform AI import tool
 * (journeys F + Phase 4). Spec: docs/architecture/features/doc-conversion.md.
 */

import { describe, it, expect, vi } from 'vitest'
import { createImportToPageTool } from '../tools.js'
import type { DocToolDeps } from '../tools.js'

const WORKSPACE_ID = '00000000-0000-0000-0000-000000000010'
const USER_ID = '00000000-0000-0000-0000-000000000020'

function ctx(workspaceId: string | null = WORKSPACE_ID) {
  return {
    userId: USER_ID,
    assistantId: 'asst-1',
    sessionId: 'sess-1',
    appId: 'Use Brian',
    channelType: 'web',
    channelId: 'web-1',
    workspaceId,
    userMessageText: 'import this',
    abortSignal: new AbortController().signal,
  } as never
}

function cachedFile(over: Record<string, unknown> = {}) {
  return {
    id: 'file-1',
    sessionId: 'sess-1',
    fileName: 'report.md',
    mimeType: 'text/markdown',
    content: '# Title\n\nA paragraph.\n\n- one\n- two',
    summary: null,
    sizeBytes: 42,
    ...over,
  }
}

function deps(over: Partial<DocToolDeps> = {}, file: unknown = cachedFile()): {
  deps: DocToolDeps
  createDraft: ReturnType<typeof vi.fn>
} {
  const createDraft = vi.fn().mockResolvedValue({ id: 'new-page' })
  const d = {
    savedViewStore: { createDraft },
    fileStore: { get: vi.fn().mockResolvedValue(file) },
    turnCreatedPageIds: new Set<string>(),
    onEvent: vi.fn(),
    ...over,
  } as unknown as DocToolDeps
  return { deps: d, createDraft }
}

describe('[COMP:doc/tools] importToPage', () => {
  it('faithfully imports a Markdown file into a new draft (no model authoring)', async () => {
    const { deps: d, createDraft } = deps()
    const tool = createImportToPageTool(d)
    const res = await tool.execute({ fileId: 'file-1' }, ctx())
    expect(res.isError).toBeFalsy()
    const data = res.data as { kind: string; pageId: string; blockCount: number }
    expect(data.kind).toBe('doc_import')
    expect(data.pageId).toBe('new-page')
    expect(data.blockCount).toBeGreaterThan(0)
    expect(createDraft).toHaveBeenCalledOnce()
    const arg = createDraft.mock.calls[0][0]
    expect(arg.name).toBe('report')
    expect(arg.nameOrigin).toBe('user')
    // page_rendered + turn-created registration (same as renderPage).
    expect((d.turnCreatedPageIds as Set<string>).has('new-page')).toBe(true)
    expect(d.onEvent).toHaveBeenCalledOnce()
  })

  it('honors an explicit title', async () => {
    const { deps: d, createDraft } = deps()
    const tool = createImportToPageTool(d)
    await tool.execute({ fileId: 'file-1', title: 'Q3 Report' }, ctx())
    expect(createDraft.mock.calls[0][0].name).toBe('Q3 Report')
  })

  it('transform mode returns the text for the model to author (no draft created)', async () => {
    const { deps: d, createDraft } = deps()
    const tool = createImportToPageTool(d)
    const res = await tool.execute({ fileId: 'file-1', mode: 'transform' }, ctx())
    const data = res.data as { kind: string; mode: string; content: string; fileName: string }
    expect(data.mode).toBe('transform')
    expect(data.content).toContain('# Title')
    expect(data.fileName).toBe('report.md')
    expect(createDraft).not.toHaveBeenCalled()
  })

  it('treats a .docx (already turndown Markdown in the cache) as importable', async () => {
    const file = cachedFile({
      fileName: 'memo.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      content: '## Memo\n\nbody',
    })
    const { deps: d, createDraft } = deps({}, file)
    const tool = createImportToPageTool(d)
    const res = await tool.execute({ fileId: 'file-1' }, ctx())
    expect(res.isError).toBeFalsy()
    expect(createDraft).toHaveBeenCalledOnce()
    expect(createDraft.mock.calls[0][0].name).toBe('memo')
  })

  it('rejects an unsupported file type', async () => {
    const file = cachedFile({ fileName: 'photo.png', mimeType: 'image/png', content: '' })
    const { deps: d } = deps({}, file)
    const res = await createImportToPageTool(d).execute({ fileId: 'file-1' }, ctx())
    expect(res.isError).toBe(true)
  })

  it('errors when the file is gone', async () => {
    const { deps: d } = deps({}, null)
    const res = await createImportToPageTool(d).execute({ fileId: 'missing' }, ctx())
    expect(res.isError).toBe(true)
  })

  it('errors when no fileStore is wired', async () => {
    const { deps: d } = deps({ fileStore: undefined })
    const res = await createImportToPageTool(d).execute({ fileId: 'file-1' }, ctx())
    expect(res.isError).toBe(true)
  })

  it('gates on a missing workspace', async () => {
    const { deps: d } = deps()
    const res = await createImportToPageTool(d).execute({ fileId: 'file-1' }, ctx(null))
    expect(res.isError).toBe(true)
  })
})

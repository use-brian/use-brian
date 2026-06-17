/**
 * [COMP:doc/tools] exportPage — the Markdown-export chat tool (journey C).
 * Spec: docs/architecture/features/doc-conversion.md.
 */

import { describe, it, expect, vi } from 'vitest'
import { createExportPageTool } from '../tools.js'
import type { DocToolDeps } from '../tools.js'
import type { Page } from '../page-types.js'

const WORKSPACE_ID = '00000000-0000-0000-0000-000000000010'
const USER_ID = '00000000-0000-0000-0000-000000000020'
const PAGE_ID = '00000000-0000-0000-0000-0000000000b1'

const PAGE: Page = {
  blocks: [
    { kind: 'heading', id: 'h', level: 1, text: 'My Doc' },
    { kind: 'text', id: 't', text: 'Body line.' },
    { kind: 'bulleted_list_item', id: 'b', richText: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'point' }] }] } as never },
  ],
}

function ctx(workspaceId: string | null = WORKSPACE_ID) {
  return {
    userId: USER_ID,
    assistantId: 'asst-1',
    sessionId: 'sess-1',
    appId: 'sidanclaw',
    channelType: 'web',
    channelId: 'web-1',
    workspaceId,
    abortSignal: new AbortController().signal,
  } as never
}

function deps(over: Partial<DocToolDeps> = {}, page: Page | null = PAGE): DocToolDeps {
  return {
    docPageStore: {
      getVersionedPage: vi.fn().mockResolvedValue(page ? { page, version: 1, title: 'My Doc' } : null),
      applyPatch: vi.fn(),
    },
    anchorPageId: PAGE_ID,
    ...over,
  } as unknown as DocToolDeps
}

describe('[COMP:doc/tools] exportPage', () => {
  it('exports the open (anchor) page as Markdown when no pageId is given', async () => {
    const tool = createExportPageTool(deps())
    const res = await tool.execute({}, ctx())
    expect(res.isError).toBeFalsy()
    const data = res.data as { markdown: string; format: string; pageId: string }
    expect(data.format).toBe('markdown')
    expect(data.pageId).toBe(PAGE_ID)
    expect(data.markdown).toContain('# My Doc')
    expect(data.markdown).toContain('Body line.')
    expect(data.markdown).toContain('- point')
  })

  it('exports an explicitly named page', async () => {
    const d = deps()
    const tool = createExportPageTool(d)
    await tool.execute({ pageId: PAGE_ID }, ctx())
    expect((d.docPageStore.getVersionedPage as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(USER_ID, PAGE_ID)
  })

  it('errors when no page is open and none is given', async () => {
    const tool = createExportPageTool(deps({ anchorPageId: null }))
    const res = await tool.execute({}, ctx())
    expect(res.isError).toBe(true)
  })

  it('errors when the page is not found', async () => {
    const tool = createExportPageTool(deps({}, null))
    const res = await tool.execute({ pageId: PAGE_ID }, ctx())
    expect(res.isError).toBe(true)
  })

  it('gates on a missing workspace', async () => {
    const tool = createExportPageTool(deps())
    const res = await tool.execute({}, ctx(null))
    expect(res.isError).toBe(true)
  })
})

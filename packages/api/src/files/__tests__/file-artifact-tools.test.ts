import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../db/retrieval-store.js', () => ({
  searchFileSegments: vi.fn(),
  readFileSegmentRange: vi.fn(),
}))

import { createSearchFileContentTool } from '../file-artifact-tools.js'
import { searchFileSegments, readFileSegmentRange } from '../../db/retrieval-store.js'
import type { ToolContext } from '@use-brian/core'

const mockSearch = vi.mocked(searchFileSegments)
const mockRange = vi.mocked(readFileSegmentRange)

const FILE_ID = '3f2a0000-0000-4000-8000-000000000001'

const ctx = {
  workspaceId: 'ws-1',
  userId: 'u-1',
  assistantId: 'a-1',
  assistantKind: 'standard',
  clearance: 'internal',
  compartments: [],
} as unknown as ToolContext

const HIT = { segment_index: 3, char_start: 10, char_end: 90, heading_path: ['Report'], content: 'Revenue grew.' }

describe('[COMP:files/artifact-tools] searchFileContent tool', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  it('query mode routes to searchFileSegments with the actor built from ToolContext', async () => {
    mockSearch.mockResolvedValue([HIT])
    const tool = createSearchFileContentTool({ embedder: { embed: vi.fn() } })
    const res = await tool.execute({ fileId: FILE_ID, query: 'revenue' }, ctx)
    expect(res.isError).toBeFalsy()
    expect(res.data).toEqual([HIT])
    expect(mockSearch).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 'ws-1',
        userId: 'u-1',
        assistantId: 'a-1',
        clearance: 'internal',
      }),
      { fileId: FILE_ID, query: 'revenue', topK: undefined },
      expect.objectContaining({ embedder: expect.anything() }),
    )
    expect(mockRange).not.toHaveBeenCalled()
  })

  it('range mode routes to readFileSegmentRange with the +9 default window', async () => {
    mockRange.mockResolvedValue([HIT])
    const tool = createSearchFileContentTool()
    const res = await tool.execute({ fileId: FILE_ID, query: '', fromIndex: 5 }, ctx)
    expect(res.data).toEqual([HIT])
    expect(mockRange).toHaveBeenCalledWith(expect.anything(), { fileId: FILE_ID, fromIndex: 5, toIndex: 14 })
    expect(mockSearch).not.toHaveBeenCalled()
  })

  it('explicit toIndex wins over the default window', async () => {
    mockRange.mockResolvedValue([])
    const tool = createSearchFileContentTool()
    await tool.execute({ fileId: FILE_ID, query: '', fromIndex: 2, toIndex: 4 }, ctx)
    expect(mockRange).toHaveBeenCalledWith(expect.anything(), { fileId: FILE_ID, fromIndex: 2, toIndex: 4 })
  })

  it('errors cleanly without a workspace-scoped session', async () => {
    const tool = createSearchFileContentTool()
    const res = await tool.execute(
      { fileId: FILE_ID, query: 'x' },
      { ...(ctx as object), workspaceId: undefined } as unknown as ToolContext,
    )
    expect(res.isError).toBe(true)
    expect(String(res.data)).toContain('workspace')
    expect(mockSearch).not.toHaveBeenCalled()
  })

  it('store failures surface as tool errors, never throws', async () => {
    mockSearch.mockRejectedValue(new Error('boom'))
    const tool = createSearchFileContentTool()
    const res = await tool.execute({ fileId: FILE_ID, query: 'x' }, ctx)
    expect(res.isError).toBe(true)
    expect(String(res.data)).toContain('boom')
  })

  it('is read-only, concurrency-safe, and never asks confirmation', () => {
    const tool = createSearchFileContentTool()
    expect(tool.isReadOnly).toBe(true)
    expect(tool.isConcurrencySafe).toBe(true)
    expect(tool.requiresConfirmation).toBeFalsy()
  })
})

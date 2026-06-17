import { describe, it, expect, vi } from 'vitest'
import { createGDriveFilesTools, type GDriveFilesStore, type GDriveFile } from '../base/gdrive-files.js'
import type { ToolContext } from '../types.js'

const ctx: ToolContext = {
  userId: 'u1',
  assistantId: 'a1',
  sessionId: 's1',
  appId: 'test',
  channelType: 'web',
  channelId: 'c1',
  abortSignal: new AbortController().signal,
}

function makeFile(overrides: Partial<GDriveFile> = {}): GDriveFile {
  return {
    id: 'row-1',
    userId: 'u1',
    kind: 'sheet',
    externalId: 'ext-1',
    title: 'Budget',
    url: 'https://docs.google.com/spreadsheets/d/ext-1/edit',
    createdAt: new Date('2026-04-20T10:00:00Z'),
    lastSeenAt: new Date('2026-04-20T10:00:00Z'),
    ...overrides,
  }
}

describe('[COMP:tools/gdrive-files] findGDriveFiles', () => {
  it('returns results shaped for the model and passes params through', async () => {
    const list = vi.fn().mockResolvedValue([makeFile()])
    const store: Pick<GDriveFilesStore, 'list'> = { list }

    const [tool] = createGDriveFilesTools(store, 'u1')
    const result = await tool.execute({ kind: 'sheet', query: 'Budget', limit: 10 }, ctx)

    expect(list).toHaveBeenCalledWith('u1', { kind: 'sheet', query: 'Budget', limit: 10 })
    expect(result.isError).toBeFalsy()
    expect(result.data).toEqual({
      count: 1,
      files: [{
        kind: 'sheet',
        title: 'Budget',
        url: 'https://docs.google.com/spreadsheets/d/ext-1/edit',
        externalId: 'ext-1',
        createdAt: '2026-04-20T10:00:00.000Z',
      }],
    })
  })

  it('surfaces store errors without throwing', async () => {
    const store: Pick<GDriveFilesStore, 'list'> = {
      list: vi.fn().mockRejectedValue(new Error('db down')),
    }

    const [tool] = createGDriveFilesTools(store, 'u1')
    const result = await tool.execute({}, ctx)

    expect(result.isError).toBe(true)
    expect(result.data).toContain('db down')
  })

  it('is marked read-only and concurrency-safe', () => {
    const [tool] = createGDriveFilesTools({ list: vi.fn().mockResolvedValue([]) }, 'u1')
    expect(tool.isReadOnly).toBe(true)
    expect(tool.isConcurrencySafe).toBe(true)
    expect(tool.requiresConfirmation).toBeFalsy()
  })

  it('rejects out-of-range limit via the zod schema', () => {
    const [tool] = createGDriveFilesTools({ list: vi.fn().mockResolvedValue([]) }, 'u1')
    expect(tool.inputSchema.safeParse({ limit: 0 }).success).toBe(false)
    expect(tool.inputSchema.safeParse({ limit: 500 }).success).toBe(false)
    expect(tool.inputSchema.safeParse({ limit: 100 }).success).toBe(true)
  })
})

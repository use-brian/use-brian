/** Google Drive list/search adapter. Component tag: [COMP:tools/google-drive]. */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { getDriveFileBytesWithMetadata, listDriveFiles } from '../client.js'

afterEach(() => vi.unstubAllGlobals())

describe('[COMP:tools/google-drive] Drive search adapter', () => {
  it('searches title plus Google full-text index and includes Shared Drives', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ files: [] }),
    })
    vi.stubGlobal('fetch', fetchMock)

    await listDriveFiles('access-1', { query: "customer's \\roadmap", folderId: 'folder-1' })

    const url = new URL(String(fetchMock.mock.calls[0]![0]))
    expect(url.searchParams.get('supportsAllDrives')).toBe('true')
    expect(url.searchParams.get('includeItemsFromAllDrives')).toBe('true')
    expect(url.searchParams.get('q')).toBe(
      "trashed = false and 'folder-1' in parents and (name contains 'customer\\'s \\\\roadmap' or fullText contains 'customer\\'s \\\\roadmap')",
    )
  })

  it('exports Google Workspace files as parser-friendly text bytes', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: 'doc-1',
          name: 'Account plan',
          mimeType: 'application/vnd.google-apps.document',
          version: '7',
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        arrayBuffer: async () => new TextEncoder().encode('Plan content').buffer,
      })
    vi.stubGlobal('fetch', fetchMock)

    const result = await getDriveFileBytesWithMetadata('access-1', 'doc-1')

    expect(result.mimeType).toBe('text/plain')
    expect(new TextDecoder().decode(result.bytes)).toBe('Plan content')
    expect(String(fetchMock.mock.calls[1]![0])).toContain('/export?mimeType=text%2Fplain')
  })

  it('preserves regular file bytes and provider MIME for document parsing', async () => {
    const originalBytes = new Uint8Array([80, 75, 3, 4])
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: 'docx-1',
          name: 'Account plan.docx',
          mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          version: '8',
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        arrayBuffer: async () => originalBytes.buffer,
      })
    vi.stubGlobal('fetch', fetchMock)

    const result = await getDriveFileBytesWithMetadata('access-1', 'docx-1')

    expect(result.mimeType).toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document')
    expect([...result.bytes]).toEqual([...originalBytes])
    expect(String(fetchMock.mock.calls[1]![0])).toContain('alt=media')
  })
})

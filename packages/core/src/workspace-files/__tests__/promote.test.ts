import { describe, it, expect, vi } from 'vitest'
import { promoteCachedFile, cachedFileBytes } from '../promote.js'
import type { FilesApi, FilesContext } from '../api.js'
import type { CachedFile } from '../../files/types.js'

// 1x1 transparent PNG.
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

const CTX: FilesContext = {
  workspaceId: 'w_1', userId: 'u_1', assistantId: 'a_1',
  assistantKind: 'standard', clearance: 'confidential', compartments: [],
} as unknown as FilesContext

function cached(over: Partial<CachedFile> = {}): CachedFile {
  return {
    id: 'f_1', sessionId: 's_1', fileName: 'hojicha.png', mimeType: 'image/png',
    content: `data:image/png;base64,${PNG_B64}`, summary: 'pouch photo', sizeBytes: 100,
    ...over,
  } as CachedFile
}

function fakeApi() {
  const writeBytes = vi.fn().mockImplementation(async (_ctx, params) => ({
    ok: true, value: { id: 'wf_1', path: params.path, name: params.title, mime: params.mime },
  }))
  return { api: { writeBytes } as unknown as FilesApi, writeBytes }
}

describe('[COMP:files/tools] Cached-file promotion', () => {
  it('decodes a base64 data URL to the ORIGINAL bytes, not the URL text', () => {
    // Writing the data-URL string as UTF-8 yields a file that uploads happily
    // and is a corrupt image — the failure this single decoder exists to stop.
    const bytes = cachedFileBytes(cached())
    expect(bytes.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    expect(bytes.length).toBe(Buffer.from(PNG_B64, 'base64').length)
  })

  it('treats a non-data-URL cache entry as UTF-8 text', () => {
    const bytes = cachedFileBytes(cached({ content: 'plain notes', mimeType: 'text/plain', fileName: 'n.txt' }))
    expect(bytes.toString('utf-8')).toBe('plain notes')
  })

  it('defaults to /uploads/<original filename> and carries the binary mime through', async () => {
    const { api, writeBytes } = fakeApi()
    const res = await promoteCachedFile(api, CTX, cached())
    expect(res.ok).toBe(true)
    expect(writeBytes).toHaveBeenCalledWith(CTX, expect.objectContaining({
      path: '/uploads/hojicha.png',
      mime: 'image/png',
      title: 'hojicha.png',
      summary: 'pouch photo',
    }))
  })

  it('lets an explicit path and title win over the cached defaults', async () => {
    const { api, writeBytes } = fakeApi()
    await promoteCachedFile(api, CTX, cached(), { path: '/products/x.png', title: 'Pouch' })
    expect(writeBytes).toHaveBeenCalledWith(CTX, expect.objectContaining({
      path: '/products/x.png', title: 'Pouch',
    }))
  })
})

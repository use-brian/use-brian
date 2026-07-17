/**
 * [COMP:api/site-icon-tool] `fetchSiteIcon` tool — token mint + store wiring.
 *
 * Drives the tool's execute with a fake fetch (via the injected `fetchFn`
 * seam) and a mock FilesApi. Pins: the stored file lands under /doc/icons/
 * with the fetched mime, the returned `icon` is the canonical
 * `img:<workspaceId>/<fileId>` token (the value patchPage setIcon accepts),
 * and fetch/store failures come back as isError with a actionable hint.
 */

import { describe, expect, it, vi } from 'vitest'
import type { FilesApi } from '@sidanclaw/core'
import { isImageIcon } from '@sidanclaw/shared'
import { createFetchSiteIconTool as createReal } from '../site-icon-tool.js'
import type { FetchSiteIconDeps } from '../site-icon-tool.js'
import type { BytesFetchFn } from '../site-icon.js'
import { validateUrl } from '../../routes/doc-og.js'

// Inject the sync SSRF validator so no test touches real DNS.
const createFetchSiteIconTool = (deps: FetchSiteIconDeps) =>
  createReal({ validate: validateUrl, ...deps })

const WS = '11111111-2222-3333-4444-555555555555'
const FILE_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47])

const context = {
  userId: 'user-1',
  assistantId: 'asst-1',
  sessionId: 's1',
  appId: 'app',
  channelType: 'web',
  channelId: 'c1',
  workspaceId: WS,
  assistantKind: 'primary' as const,
  abortSignal: new AbortController().signal,
}

const imageFetch: BytesFetchFn = async () => ({
  ok: true,
  status: 200,
  headers: {
    get: (k: string) => (k.toLowerCase() === 'content-type' ? 'image/png' : null),
  },
  arrayBuffer: async () =>
    PNG.buffer.slice(PNG.byteOffset, PNG.byteOffset + PNG.byteLength) as ArrayBuffer,
})

function filesApiWith(writeBytes: ReturnType<typeof vi.fn>): FilesApi {
  return { writeBytes } as unknown as FilesApi
}

describe('[COMP:api/site-icon-tool] fetchSiteIcon tool', () => {
  it('stores the fetched image and returns the img: token', async () => {
    const writeBytes = vi.fn().mockResolvedValue({
      ok: true,
      value: { id: FILE_ID },
    })
    const tool = createFetchSiteIconTool({
      filesApi: filesApiWith(writeBytes),
      workspaceId: WS,
      fetchFn: imageFetch,
    })

    const result = await tool.execute(
      { url: 'https://cdn.example.com/logo.png' },
      context,
    )

    expect(result.isError).toBeUndefined()
    const data = result.data as { icon: string; mime: string; nextStep: string }
    expect(data.icon).toBe(`img:${WS}/${FILE_ID}`)
    expect(isImageIcon(data.icon)).toBe(true)
    expect(data.mime).toBe('image/png')
    expect(data.nextStep).toContain('setIcon')

    const [ctx, params] = writeBytes.mock.calls[0]
    expect(ctx).toMatchObject({ workspaceId: WS, userId: 'user-1' })
    expect(params.path).toMatch(/^\/doc\/icons\/.+cdn\.example\.com\.png$/)
    expect(params.mime).toBe('image/png')
  })

  it('surfaces a store failure as an actionable error', async () => {
    const writeBytes = vi.fn().mockResolvedValue({
      ok: false,
      error: { kind: 'quota_exceeded' },
    })
    const tool = createFetchSiteIconTool({
      filesApi: filesApiWith(writeBytes),
      workspaceId: WS,
      fetchFn: imageFetch,
    })

    const result = await tool.execute({ url: 'example.com' }, context)
    expect(result.isError).toBe(true)
    expect(String(result.data)).toContain('quota_exceeded')
  })

  it('surfaces a fetch failure without touching the files store', async () => {
    const writeBytes = vi.fn()
    const failingFetch: BytesFetchFn = async () => {
      throw new Error('down')
    }
    const tool = createFetchSiteIconTool({
      filesApi: filesApiWith(writeBytes),
      workspaceId: WS,
      fetchFn: failingFetch,
    })

    const result = await tool.execute({ url: 'https://example.com' }, context)
    expect(result.isError).toBe(true)
    expect(writeBytes).not.toHaveBeenCalled()
  })
})

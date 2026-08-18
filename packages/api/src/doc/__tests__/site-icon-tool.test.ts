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
import type { FilesApi } from '@use-brian/core'
import { isImageIcon } from '@use-brian/shared'
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

  // Failure copy (docs/architecture/engine/tool-executor.md → "Failure copy"):
  // a store refusal must say the icon was fetched but NOT stored, carry the
  // files vocabulary's own diagnosis (never a bare `error.kind`), and name the
  // emoji fallback plus the retry verdict.
  it('reports a store failure in the files vocabulary with the emoji fallback', async () => {
    const writeBytes = vi.fn().mockResolvedValue({
      ok: false,
      error: {
        kind: 'quota_exceeded',
        currentBytes: 1_000,
        limitBytes: 1_024,
        attemptedBytes: 512,
      },
    })
    const tool = createFetchSiteIconTool({
      filesApi: filesApiWith(writeBytes),
      workspaceId: WS,
      fetchFn: imageFetch,
    })

    const result = await tool.execute({ url: 'example.com' }, context)
    expect(result.isError).toBe(true)
    const data = String(result.data)
    // WHAT: fetched, not stored, no page touched.
    expect(data).toMatch(/no icon token was produced and no page was changed/i)
    // WHY: the shared workspace-files wording, not the raw kind.
    expect(data).toMatch(/Workspace storage quota exceeded/i)
    expect(data).toContain('1024')
    // NEXT STEP + verdict.
    expect(data).toContain('patchPage')
    expect(data).toMatch(/hits the same storage failure/i)
  })

  it('names the url, the cause, and the retry verdict on a fetch failure', async () => {
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
    const data = String(result.data)
    expect(data).toContain('https://example.com')
    expect(data).toMatch(/no page was changed/i)
    expect(data).toMatch(/never answered|redirected in a loop/i)
    expect(data).toMatch(/direct image URL/i)
  })

  it('tells the model a domain with no icon can never succeed, and offers the emoji path', async () => {
    // A site that answers 200 with something that is neither an image nor
    // HTML carrying an icon declaration — the `no_icon_found` branch.
    const noIconFetch: BytesFetchFn = async () => ({
      ok: true,
      status: 200,
      headers: {
        get: (k: string) => (k.toLowerCase() === 'content-type' ? 'text/plain' : null),
      },
      arrayBuffer: async () => new ArrayBuffer(0),
    })
    const writeBytes = vi.fn()
    const tool = createFetchSiteIconTool({
      filesApi: filesApiWith(writeBytes),
      workspaceId: WS,
      fetchFn: noIconFetch,
    })

    const result = await tool.execute({ url: 'example.com' }, context)
    expect(result.isError).toBe(true)
    expect(writeBytes).not.toHaveBeenCalled()
    const data = String(result.data)
    expect(data).toContain('example.com')
    expect(data).toMatch(/keep finding nothing/i)
    expect(data).toContain('setIcon')
  })
})

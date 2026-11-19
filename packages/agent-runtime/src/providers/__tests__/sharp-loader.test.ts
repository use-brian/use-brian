import { afterEach, describe, expect, it, vi } from 'vitest'
import { FEED_IMAGE_CAPABILITY } from '@use-brian/shared'

// The image codec is a lazy, optional native module (docs/architecture/engine/
// tool-hooks.md → "Image codec"). These tests mock `sharp` per case, so each
// one re-imports the providers on a fresh module graph.
afterEach(() => {
  vi.doUnmock('sharp')
  vi.resetModules()
})

describe('[COMP:core/gemini-image] lazy image codec', () => {
  it('does not load sharp when the image providers are imported, only when an image is validated', async () => {
    vi.resetModules()
    const factory = vi.fn(() => {
      const metadata = async () => ({ format: 'png', width: 1, height: 1, pages: 1 })
      return { default: () => ({ metadata, raw: () => ({ toBuffer: async () => Buffer.alloc(4) }) }) }
    })
    vi.doMock('sharp', factory)
    const { validateFeedImageSource } = await import('../gemini-image.js')
    await import('../codex-app-server/image.js')
    expect(factory).not.toHaveBeenCalled()
    await validateFeedImageSource(new Uint8Array([1, 2, 3]), 'image/png')
    expect(factory).toHaveBeenCalledTimes(1)
  })

  it('reports an unloadable codec as image_codec_unavailable before any provider dispatch', async () => {
    vi.resetModules()
    vi.doMock('sharp', () => { throw new Error('fixture: native binding missing') })
    const { createGeminiImageProvider, validateFeedImageSource } = await import('../gemini-image.js')
    const { aiStudioTransport } = await import('../google-transport.js')
    const fetcher = vi.fn()
    const generation = createGeminiImageProvider(aiStudioTransport('fixture-key'), fetcher)
      .generate({ model: FEED_IMAGE_CAPABILITY.model, prompt: 'Square', signal: AbortSignal.timeout(1000) })
    await expect(generation).rejects.toMatchObject({ code: 'image_codec_unavailable', name: 'ImageCodecUnavailableError' })
    await expect(generation).rejects.toThrow(/install/i)
    expect(fetcher).not.toHaveBeenCalled()
    // Never presented as a malformed source image.
    await expect(validateFeedImageSource(new Uint8Array([1]), 'image/png'))
      .rejects.toMatchObject({ code: 'image_codec_unavailable' })
  })
})

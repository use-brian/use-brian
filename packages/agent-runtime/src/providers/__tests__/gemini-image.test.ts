import { describe, it, expect, vi } from 'vitest'
import { createGeminiImageProvider, parseGeminiImageReceipt, validateFeedImageSource } from '../gemini-image.js'
import { aiStudioTransport, vertexTransport } from '../google-transport.js'
import { FEED_IMAGE_CAPABILITY, feedImageCost } from '@use-brian/shared'
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXioAAAAASUVORK5CYII='
const output = (parts: unknown[] = [{ inlineData: { mimeType: 'image/png', data: png } }]) => ({ responseId: 'fictional-response', candidates: [{ finishReason: 'STOP', content: { parts } }], usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 1120, thoughtsTokenCount: 12, candidatesTokensDetails: [{ modality: 'IMAGE', tokenCount: 1120 }] } })
describe('[COMP:core/gemini-image] native HTTP contract', () => {
  it('sends one bounded generateContent request through AI Studio auth and retains MIME and measured usage', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify(output())))
    const result = await createGeminiImageProvider(aiStudioTransport('fictional-key'), fetcher).generate({ model: FEED_IMAGE_CAPABILITY.model, prompt: 'A fictional blue square', aspectRatio: '16:9', signal: AbortSignal.timeout(1000) })
    expect(fetcher).toHaveBeenCalledTimes(1)
    const [url, init] = fetcher.mock.calls[0]!
    expect(url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-nano-banana-2.1:generateContent')
    expect(init.headers['x-goog-api-key']).toBe('fictional-key')
    const generationConfig = JSON.parse(init.body).generationConfig
    expect(generationConfig).toMatchObject({ candidateCount: 1, responseModalities: ['IMAGE'], imageConfig: { imageSize: '1K', aspectRatio: '16:9' }, thinkingConfig: { thinkingLevel: 'MINIMAL', includeThoughts: false } })
    expect(generationConfig).not.toHaveProperty('responseFormat')
    expect(result).toMatchObject({ image: { mimeType: 'image/png', data: png }, responseId: 'fictional-response', usage: { inputTokens: 100, outputTokens: 1132, imageTokens: 1120, measured: true } })
    expect(feedImageCost(FEED_IMAGE_CAPABILITY.rates, 100, 1132, 1120)).toBeCloseTo(0.03384)
  })
  it('uses Vertex endpoint and bearer token without alternate-host fallback', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response('{}', { status: 404 }))
    const result = await createGeminiImageProvider(vertexTransport({ project: 'fixture-project', location: 'asia-east2', tokenSource: async () => 'fixture-token' }), fetcher).generate({ model: FEED_IMAGE_CAPABILITY.model, prompt: 'Square', signal: AbortSignal.timeout(1000) })
    expect(fetcher.mock.calls[0]![0]).toContain('https://asia-east2-aiplatform.googleapis.com/v1/projects/fixture-project/locations/asia-east2/')
    expect(fetcher.mock.calls[0]![1].headers.Authorization).toBe('Bearer fixture-token')
    expect(result.error).toBe('image_provider_rejected'); expect(fetcher).toHaveBeenCalledTimes(1)
  })
  it('retains bounded provider diagnostics for a rejected request', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { status: 'INVALID_ARGUMENT', message: 'Invalid value at image config\n', details: [{ fieldViolations: [{ field: 'generation_config.image_config.image_size' }, { field: 'unsafe field path!' }] }] } }), { status: 400 }))
    const result = await createGeminiImageProvider(aiStudioTransport('fixture-key'), fetcher).generate({ model: FEED_IMAGE_CAPABILITY.model, prompt: 'Square', signal: AbortSignal.timeout(1000) })
    expect(result).toMatchObject({ error: 'image_provider_rejected', status: 400, providerError: { code: 'INVALID_ARGUMENT', message: 'Invalid value at image config', fields: ['generation_config.image_config.image_size'] }, usage: { inputTokens: 0, outputTokens: 0, measured: false } })
  })
  it('keeps a known provider rejection when its advisory diagnostic stream fails', async () => {
    const body = new ReadableStream({ start(controller) { controller.error(new Error('broken diagnostic stream')) } })
    const fetcher = vi.fn().mockResolvedValue(new Response(body, { status: 400 }))
    const result = await createGeminiImageProvider(aiStudioTransport('fixture-key'), fetcher).generate({ model: FEED_IMAGE_CAPABILITY.model, prompt: 'Square', signal: AbortSignal.timeout(1000) })
    expect(result).toMatchObject({ error: 'image_provider_rejected', status: 400, usage: { inputTokens: 0, outputTokens: 0, measured: false } })
    expect(result.providerError).toBeUndefined()
  })
  it('refuses missing transport and credentials before HTTP', async () => {
    const fetcher = vi.fn(); const input = { model: FEED_IMAGE_CAPABILITY.model, prompt: 'Square', signal: AbortSignal.timeout(1000) }
    await expect(createGeminiImageProvider(undefined, fetcher).generate(input)).rejects.toThrow('unavailable')
    await expect(createGeminiImageProvider(aiStudioTransport(undefined), fetcher).generate(input)).rejects.toThrow('unavailable')
    expect(fetcher).not.toHaveBeenCalled()
  })
  it('retains a refusal or malformed receipt but never promotes text, thought images, invalid base64 or MIME', () => {
    expect(parseGeminiImageReceipt({ promptFeedback: { blockReason: 'SAFETY' } }).error).toBe('image_refused')
    expect(parseGeminiImageReceipt(output([{ text: 'Here is the image' }])).error).toBe('image_missing')
    expect(parseGeminiImageReceipt(output([{ thought: true, inlineData: { mimeType: 'image/png', data: png } }])).error).toBe('image_missing')
    for (const inlineData of [{ mimeType: 'image/png', data: 'not-base64!' }, { mimeType: 'text/plain', data: png }, { mimeType: 'image/jpeg', data: png }]) expect(parseGeminiImageReceipt(output([{ inlineData }])).error).toBe('image_malformed')
    expect(parseGeminiImageReceipt(output([{ inlineData: { mimeType: 'image/png', data: png } }, { inlineData: { mimeType: 'image/png', data: png } }])).error).toBe('image_malformed')
  })
  it('rejects a truncated image with a valid signature while retaining the charged receipt', async () => {
    const truncated = Buffer.from(png, 'base64').subarray(0, 40).toString('base64')
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify(output([{ inlineData: { mimeType: 'image/png', data: truncated } }]))))
    const receipt = await createGeminiImageProvider(aiStudioTransport('fixture-key'), fetcher).generate({ model: FEED_IMAGE_CAPABILITY.model, prompt: 'Square', signal: AbortSignal.timeout(1000) })
    expect(receipt).toMatchObject({ error: 'image_malformed', responseId: 'fictional-response', usage: { imageTokens: 1120, measured: true } })
    expect(receipt.image).toBeUndefined(); expect(fetcher).toHaveBeenCalledTimes(1)
  })
  it('retries when every socket cause proves the image request never connected', async () => {
    vi.useFakeTimers()
    try {
      const causes = [Object.assign(new Error('connect timed out'), { code: 'ETIMEDOUT' }), Object.assign(new Error('route unavailable'), { code: 'ENETUNREACH' })]
      const failure = new TypeError('fetch failed', { cause: new AggregateError(causes, 'connect failed') })
      const fetcher = vi.fn().mockRejectedValueOnce(failure).mockResolvedValue(new Response(JSON.stringify(output())))
      const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const pending = createGeminiImageProvider(aiStudioTransport('fixture-key'), fetcher).generate({ model: FEED_IMAGE_CAPABILITY.model, prompt: 'Square', signal: new AbortController().signal })
      await vi.runAllTimersAsync()
      await expect(pending).resolves.toMatchObject({ image: { mimeType: 'image/png' } })
      expect(fetcher).toHaveBeenCalledTimes(2)
      expect(warning).toHaveBeenCalledWith('[gemini-image] connection failed before provider dispatch; retrying', expect.objectContaining({ attempt: 1, maxAttempts: 3, causeCodes: ['ETIMEDOUT', 'ENETUNREACH'] }))
    } finally { vi.useRealTimers() }
  })
  it('labels exhausted connection attempts as provably undispatched', async () => {
    vi.useFakeTimers()
    try {
      const failure = new TypeError('fetch failed', { cause: Object.assign(new Error('connect timeout'), { code: 'UND_ERR_CONNECT_TIMEOUT' }) })
      const fetcher = vi.fn().mockRejectedValue(failure)
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      const pending = createGeminiImageProvider(aiStudioTransport('fixture-key'), fetcher).generate({ model: FEED_IMAGE_CAPABILITY.model, prompt: 'Square', signal: new AbortController().signal })
      const rejection = expect(pending).rejects.toMatchObject({ name: 'GoogleRequestNotDispatchedError', causeCodes: ['UND_ERR_CONNECT_TIMEOUT'] })
      await vi.runAllTimersAsync()
      await rejection
      expect(fetcher).toHaveBeenCalledTimes(3)
    } finally { vi.useRealTimers() }
  })
  it('does not retry a transport timeout with an uncertain provider outcome', async () => {
    const fetcher = vi.fn().mockRejectedValue(new DOMException('Timeout', 'TimeoutError'))
    await expect(createGeminiImageProvider(aiStudioTransport('fixture-key'), fetcher).generate({ model: FEED_IMAGE_CAPABILITY.model, prompt: 'Square', signal: AbortSignal.timeout(1000) })).rejects.toThrow('Timeout')
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
})

describe('[COMP:core/gemini-image] bounded visual edit input', () => {
  it('sends source pixels in the same one-call request as the requested edit', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify(output())))
    const image = { data: png, mimeType: 'image/png' as const }
    await createGeminiImageProvider(aiStudioTransport('fictional-key'), fetcher).generate({ model: FEED_IMAGE_CAPABILITY.model, prompt: 'Change only the background', sourceImage: image, signal: AbortSignal.timeout(1000) })
    expect(JSON.parse(fetcher.mock.calls[0]![1].body).contents[0].parts).toEqual([{ inlineData: image }, { text: 'Change only the background' }])
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
  it('bounds and decodes source pixels and rejects MIME confusion before provider dispatch', async () => {
    const bytes = Buffer.from(png, 'base64')
    expect(await validateFeedImageSource(bytes, 'image/png')).toMatchObject({ image: { data: png, mimeType: 'image/png' }, inputTokens: 1120 })
    await expect(validateFeedImageSource(bytes, 'image/jpeg')).rejects.toThrow('image_source_invalid')
    await expect(validateFeedImageSource(new Uint8Array(FEED_IMAGE_CAPABILITY.maxSourceImageBytes + 1), 'image/png')).rejects.toThrow('image_source_invalid')
    await expect(validateFeedImageSource(bytes.subarray(0, 40), 'image/png')).rejects.toThrow()
  })
  it('validates multi-megabyte base64 without recursive-regex stack overflow', () => {
    const bytes = Buffer.alloc(6_000_000); Buffer.from(png, 'base64').copy(bytes)
    const data = bytes.toString('base64')
    expect(parseGeminiImageReceipt(output([{ inlineData: { mimeType: 'image/png', data } }])).image?.data).toBe(data)
  })
})

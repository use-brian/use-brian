import { describe, it, expect, vi } from 'vitest'
import { transcribeAudio } from '../transcribe.js'

function mockResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  })
}

describe('[COMP:media/transcribe] transcribeAudio', () => {
  it('posts inlineData with base64 buffer and passed mime to Gemini generateContent', async () => {
    const captured: { url?: string; init?: RequestInit } = {}
    const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      captured.url = String(url)
      captured.init = init
      return mockResponse({
        candidates: [{ content: { parts: [{ text: 'hello world' }] } }],
      })
    })

    const buffer = Buffer.from('fake-audio-bytes')
    const result = await transcribeAudio(
      { buffer, mime: 'audio/ogg; codecs=opus' },
      { apiKey: 'test-key', fetchFn: fetchFn as unknown as typeof fetch },
    )

    expect(result.text).toBe('hello world')
    expect(result.model).toBe('gemini-2.5-flash')
    expect(result.usage).toBeNull()
    expect(captured.url).toContain('/models/gemini-2.5-flash:generateContent')
    const headers = captured.init?.headers as Record<string, string>
    expect(headers['x-goog-api-key']).toBe('test-key')
    expect(headers['Content-Type']).toBe('application/json')

    const body = JSON.parse(captured.init!.body as string)
    const parts = body.contents[0].parts
    expect(parts[0].text).toMatch(/transcribe/i)
    expect(parts[1].inlineData.mimeType).toBe('audio/ogg; codecs=opus')
    expect(parts[1].inlineData.data).toBe(buffer.toString('base64'))
    expect(body.generationConfig.temperature).toBe(0)
  })

  it('honors custom model and prompt', async () => {
    const captured: { init?: RequestInit; url?: string } = {}
    const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      captured.url = String(url)
      captured.init = init
      return mockResponse({
        candidates: [{ content: { parts: [{ text: 'ok' }] } }],
      })
    })

    await transcribeAudio(
      { buffer: Buffer.from('x'), mime: 'audio/webm' },
      {
        apiKey: 'k',
        model: 'gemini-custom',
        prompt: 'do the thing',
        fetchFn: fetchFn as unknown as typeof fetch,
      },
    )

    expect(captured.url).toContain('/models/gemini-custom:generateContent')
    const body = JSON.parse(captured.init!.body as string)
    expect(body.contents[0].parts[0].text).toBe('do the thing')
  })

  it('throws on non-OK HTTP with a body snippet', async () => {
    const fetchFn = vi.fn(async () =>
      mockResponse('internal boom', { status: 500, headers: { 'content-type': 'text/plain' } }),
    )

    await expect(
      transcribeAudio(
        { buffer: Buffer.from('x'), mime: 'audio/ogg' },
        { apiKey: 'k', fetchFn: fetchFn as unknown as typeof fetch },
      ),
    ).rejects.toThrow(/HTTP 500.*internal boom/)
  })

  it('throws when the response has no candidates / no text parts', async () => {
    const fetchFn = vi.fn(async () => mockResponse({ candidates: [] }))

    await expect(
      transcribeAudio(
        { buffer: Buffer.from('x'), mime: 'audio/ogg' },
        { apiKey: 'k', fetchFn: fetchFn as unknown as typeof fetch },
      ),
    ).rejects.toThrow(/missing text/)
  })

  it('extracts usageMetadata into the result so callers can record overhead', async () => {
    const fetchFn = vi.fn(async () =>
      mockResponse({
        candidates: [{ content: { parts: [{ text: 'transcript' }] } }],
        usageMetadata: {
          promptTokenCount: 100,
          candidatesTokenCount: 8,
          thoughtsTokenCount: 3,
          cachedContentTokenCount: 20,
        },
      }),
    )

    const result = await transcribeAudio(
      { buffer: Buffer.from('x'), mime: 'audio/ogg' },
      { apiKey: 'k', fetchFn: fetchFn as unknown as typeof fetch },
    )

    expect(result.usage).toEqual({
      inputTokens: 80, // 100 - 20 cached
      outputTokens: 11, // 8 + 3 thinking
      cacheReadTokens: 20,
    })
  })

  it('aborts the request when timeoutMs elapses', async () => {
    const fetchFn = vi.fn(async (_url: unknown, init?: RequestInit) => {
      await new Promise((resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
        setTimeout(resolve, 200)
      })
      return mockResponse({})
    })

    await expect(
      transcribeAudio(
        { buffer: Buffer.from('x'), mime: 'audio/ogg' },
        { apiKey: 'k', timeoutMs: 10, fetchFn: fetchFn as unknown as typeof fetch },
      ),
    ).rejects.toThrow(/aborted/)
  })
})

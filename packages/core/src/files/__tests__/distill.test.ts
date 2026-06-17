import { describe, it, expect, vi } from 'vitest'
import { distillFileToText } from '../distill.js'

function mockResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  })
}

describe('[COMP:files/distill] distillFileToText', () => {
  it('posts inlineData with the base64 buffer + mime and returns the Markdown', async () => {
    const captured: { url?: string; init?: RequestInit } = {}
    const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      captured.url = String(url)
      captured.init = init
      return mockResponse({
        candidates: [{ content: { parts: [{ text: '# Heading\n\nbody' }] } }],
        usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 20 },
      })
    })

    const buffer = Buffer.from('fake-pdf-bytes')
    const result = await distillFileToText(
      { buffer, mime: 'application/pdf' },
      { apiKey: 'test-key', fetchFn: fetchFn as unknown as typeof fetch },
    )

    expect(result.text).toBe('# Heading\n\nbody')
    expect(result.model).toBe('gemini-2.5-flash')
    expect(result.usage).toEqual({ inputTokens: 50, outputTokens: 20 })

    expect(captured.url).toContain('/models/gemini-2.5-flash:generateContent')
    const headers = captured.init?.headers as Record<string, string>
    expect(headers['x-goog-api-key']).toBe('test-key')

    const body = JSON.parse(captured.init!.body as string)
    const parts = body.contents[0].parts
    expect(parts[0].text).toMatch(/markdown/i)
    expect(parts[1].inlineData.mimeType).toBe('application/pdf')
    expect(parts[1].inlineData.data).toBe(buffer.toString('base64'))
    expect(body.generationConfig.temperature).toBe(0)
  })

  it('returns empty text (NOT an error) when the document yields nothing', async () => {
    const fetchFn = vi.fn(async () =>
      mockResponse({ candidates: [{ content: { parts: [{ text: '' }] } }] }),
    )
    const result = await distillFileToText(
      { buffer: Buffer.from('blank'), mime: 'image/png' },
      { apiKey: 'k', fetchFn: fetchFn as unknown as typeof fetch },
    )
    expect(result.text).toBe('')
  })

  it('throws on a non-ok HTTP response', async () => {
    const fetchFn = vi.fn(async () => mockResponse('nope', { status: 500 }))
    await expect(
      distillFileToText(
        { buffer: Buffer.from('x'), mime: 'application/pdf' },
        { apiKey: 'k', fetchFn: fetchFn as unknown as typeof fetch },
      ),
    ).rejects.toThrow(/distillation failed/i)
  })
})

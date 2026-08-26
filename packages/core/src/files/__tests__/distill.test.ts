import { describe, it, expect, vi } from 'vitest'
import sharp from 'sharp'
import { distillFileToText } from '../distill.js'
import { pdfPageCompletionMarker } from '../pdf-distill.js'
import { minimalPdf } from './pdf-fixture.js'

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
        candidates: [{ content: { parts: [{ text: `## Page 1\n\n# Heading\n\nbody\n\n${pdfPageCompletionMarker(1)}` }] } }],
        usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 20 },
      })
    })

    const buffer = minimalPdf(1, 'body')
    const result = await distillFileToText(
      { buffer, mime: 'application/pdf' },
      { apiKey: 'test-key', fetchFn: fetchFn as unknown as typeof fetch },
    )

    expect(result.text).toBe('## Page 1\n\n# Heading\n\nbody')
    expect(result.model).toBe('gemini-2.5-flash')
    expect(result.usage).toEqual({ inputTokens: 50, outputTokens: 20 })
    expect(result.pageCount).toBe(1)

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

  it('falls back to rendered pages when Gemini ends normally without a page completion marker', async () => {
    const fetchFn = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string)
      const parts = body.contents[0].parts as Array<{
        inlineData?: { mimeType: string }
      }>
      const isNativePdf = parts.some((part) => part.inlineData?.mimeType === 'application/pdf')
      return mockResponse({
        candidates: [{
          content: {
            parts: [{
              text: isNativePdf
                ? '## Page 1\n\ncut off despite STOP'
                : `## Page 1\n\ncomplete text\n\n${pdfPageCompletionMarker(1)}`,
            }],
          },
          finishReason: 'STOP',
        }],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
      })
    })

    const result = await distillFileToText(
      { buffer: minimalPdf(1, 'complete text'), mime: 'application/pdf' },
      { apiKey: 'k', fetchFn: fetchFn as unknown as typeof fetch },
    )

    expect(fetchFn).toHaveBeenCalledTimes(2)
    expect(result.text).toContain('complete text')
    expect(result.text).not.toContain('cut off')
    expect(result.text).not.toContain('PDF_PAGE_1_COMPLETE')
    expect(result.usage).toEqual({ inputTokens: 20, outputTokens: 10 })
    expect(result.pageCount).toBe(1)
    expect(result.truncated).toBe(false)
  })

  it('preserves the visual failure when an image-only PDF has no local text fallback', async () => {
    const fetchFn = vi.fn(async () => mockResponse('vision unavailable', { status: 503 }))

    await expect(
      distillFileToText(
        { buffer: minimalPdf(1, ''), mime: 'application/pdf' },
        { apiKey: 'k', fetchFn: fetchFn as unknown as typeof fetch },
      ),
    ).rejects.toThrow(/Gemini file distillation failed \(HTTP 503/)

    // One native attempt plus the bounded two attempts over the rendered page.
    expect(fetchFn).toHaveBeenCalledTimes(3)
  })

  it('throws on a non-ok HTTP response (no local fallback for images)', async () => {
    // A PDF would degrade to the local text layer here; an image has no local
    // fallback, so a non-ok distillation response must still surface as an error.
    const fetchFn = vi.fn(async () => mockResponse('nope', { status: 500 }))
    await expect(
      distillFileToText(
        { buffer: Buffer.from('x'), mime: 'image/png' },
        { apiKey: 'k', fetchFn: fetchFn as unknown as typeof fetch },
      ),
    ).rejects.toThrow(/distillation failed/i)
  })

  it('downscales oversized images before sending them to DashScope', async () => {
    const oversized = await sharp({
      create: { width: 2000, height: 2000, channels: 3, background: '#446688' },
    }).png({ compressionLevel: 0 }).toBuffer()
    expect(oversized.length).toBeGreaterThan(6 * 1024 * 1024)

    const fetchFn = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string)
      const dataUrl = body.messages[0].content[1].image_url.url as string
      expect(dataUrl).toMatch(/^data:image\/jpeg;base64,/)
      expect(Buffer.byteLength(dataUrl.split(',', 2)[1]!, 'base64')).toBeLessThanOrEqual(6 * 1024 * 1024)
      return mockResponse({ choices: [{ message: { content: 'visible text' } }] })
    })

    const result = await distillFileToText(
      { buffer: oversized, mime: 'image/png' },
      {
        backend: { kind: 'dashscope', apiKey: 'test-key', baseUrl: 'https://dashscope.example/v1' },
        fetchFn: fetchFn as unknown as typeof fetch,
      },
    )

    expect(result.text).toBe('visible text')
    expect(fetchFn).toHaveBeenCalledOnce()
  })

  it('distills a PDF on DashScope by rendering every page to Qwen-VL, not qwen-long', async () => {
    // One track, not two (pdf-universal-read §3). The `qwen-long` file-upload
    // extraction used to run in parallel with a page-per-call vision loop;
    // its output largely duplicated the transcription, so the document was
    // paid for twice. Full-page vision subsumes it — there must be no
    // `/files` upload for a PDF at all.
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init })
      return mockResponse({
        choices: [{ message: { content: `## Page 1\n\n# PDF content\n\n${pdfPageCompletionMarker(1)}` }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 40, completion_tokens: 15 },
      })
    })

    const result = await distillFileToText(
      { buffer: minimalPdf(1, 'PDF content'), mime: 'application/pdf' },
      {
        backend: { kind: 'dashscope', apiKey: 'test-key', baseUrl: 'https://dashscope.example/v1' },
        fetchFn: fetchFn as unknown as typeof fetch,
      },
    )

    expect(result.text).toBe('## Page 1\n\n# PDF content')
    expect(result.model).toBe('qwen-vl-max')
    expect(result.usage).toEqual({ inputTokens: 40, outputTokens: 15 })
    expect(calls.every((c) => !c.url.endsWith('/files'))).toBe(true)

    const body = JSON.parse(calls[0].init!.body as string)
    expect(body.model).toBe('qwen-vl-max')
    const content = body.messages[0].content as Array<{ type: string; image_url?: { url: string } }>
    expect(content[0].type).toBe('text')
    expect(content[1].image_url!.url).toMatch(/^data:image\/jpeg;base64,/)
  })

  it('batches consecutive pages into one vision call and stitches them in order', async () => {
    // Six pages = one DashScope chunk (DASHSCOPE_CHUNK_PAGES), so the whole
    // document is one call — the ~6x prompt-overhead saving over the old
    // page-per-call loop.
    const bodies: unknown[] = []
    const fetchFn = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(init!.body as string))
      return mockResponse({
        choices: [{
          message: {
            content: Array.from(
              { length: 6 },
              (_, index) =>
                `## Page ${index + 1}\n\ncontent ${index + 1}\n\n${pdfPageCompletionMarker(index + 1)}`,
            ).join('\n\n'),
          },
          finish_reason: 'stop',
        }],
      })
    })

    const result = await distillFileToText(
      { buffer: minimalPdf(6), mime: 'application/pdf' },
      {
        backend: { kind: 'dashscope', apiKey: 'k', baseUrl: 'https://ds.test/v1' },
        fetchFn: fetchFn as unknown as typeof fetch,
      },
    )

    expect(fetchFn).toHaveBeenCalledOnce()
    const content = (bodies[0] as { messages: Array<{ content: unknown[] }> }).messages[0].content
    expect(content).toHaveLength(7) // one prompt + six page images
    expect(result.text).toContain('## Page 1')
  })
})

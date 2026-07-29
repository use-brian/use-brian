import { describe, it, expect, vi } from 'vitest'
import { extractPdfText } from '../pdf-text.js'
import { distillFileToText } from '../distill.js'
import { minimalPdf } from './pdf-fixture.js'

describe('[COMP:files/pdf-text] extractPdfText', () => {
  it('extracts the text layer of a PDF', async () => {
    expect(await extractPdfText(minimalPdf())).toBe('Hello PDF World')
  })
})

describe('[COMP:files/distill] PDF local-text fallback', () => {
  it('falls back to local extraction when a DashScope adapter has no vision model', async () => {
    // Reproduce the reported failure shape: the chat completion 404s with
    // "model not found". Distillation must degrade to the local text layer
    // rather than throwing.
    const fetchFn = vi.fn(async () =>
      new Response('{"error":{"message":"model not found"}}', { status: 404 }),
    )

    const result = await distillFileToText(
      { buffer: minimalPdf(1, 'Attention Is All You Need'), mime: 'application/pdf' },
      { backend: { kind: 'dashscope', apiKey: 'k', baseUrl: 'https://ds.test/v1' }, fetchFn },
    )

    expect(result.model).toBe('local-pdf-text')
    expect(result.text).toBe('Attention Is All You Need')
    expect(result.usage).toBeNull()
  })

  it('keeps the vision distillation when the adapter succeeds (no fallback)', async () => {
    const fetchFn = vi.fn(async () =>
      new Response(
        JSON.stringify({ choices: [{ message: { content: '# Native extract' }, finish_reason: 'stop' }] }),
        { status: 200 },
      ),
    )

    const result = await distillFileToText(
      { buffer: minimalPdf(), mime: 'application/pdf' },
      { backend: { kind: 'dashscope', apiKey: 'k', baseUrl: 'https://ds.test/v1' }, fetchFn },
    )

    expect(result.model).toBe('qwen-vl-max')
    expect(result.text).toBe('# Native extract')
  })

  it('surfaces the distillation error, not a pdf.js parse exception, when both paths fail', async () => {
    // Corrupt bytes: rendering throws inside the engine AND the local text
    // layer throws. The operator needs the adapter failure, not "Invalid PDF
    // structure" from the last thing tried.
    const fetchFn = vi.fn(async () => new Response('{"error":"nope"}', { status: 503 }))
    await expect(
      distillFileToText(
        { buffer: Buffer.from('%PDF-1.4 not really a pdf'), mime: 'application/pdf' },
        { backend: { kind: 'dashscope', apiKey: 'k', baseUrl: 'https://ds.test/v1' }, fetchFn },
      ),
    ).rejects.toThrow(/Invalid PDF|distillation/i)
  })
})

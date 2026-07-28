import { describe, it, expect, vi } from 'vitest'
import { extractPdfText } from '../pdf-text.js'
import { distillFileToText } from '../distill.js'

/** A minimal one-page PDF whose text layer reads "Hello PDF World". pdf.js
 *  reconstructs the xref, so an offset table is unnecessary. */
function minimalPdf(text = 'Hello PDF World'): Buffer {
  const content = `BT /F1 24 Tf 72 700 Td (${text}) Tj ET`
  const body =
    `1 0 obj\n<</Type/Catalog/Pages 2 0 R>>\nendobj\n` +
    `2 0 obj\n<</Type/Pages/Kids[3 0 R]/Count 1>>\nendobj\n` +
    `3 0 obj\n<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>\nendobj\n` +
    `4 0 obj\n<</Length ${content.length}>>\nstream\n${content}\nendstream\nendobj\n` +
    `5 0 obj\n<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>\nendobj\n`
  return Buffer.from(`%PDF-1.4\n${body}trailer\n<</Root 1 0 R/Size 6>>\n%%EOF`, 'latin1')
}

describe('[COMP:files/pdf-text] extractPdfText', () => {
  it('extracts the text layer of a PDF', async () => {
    expect(await extractPdfText(minimalPdf())).toBe('Hello PDF World')
  })
})

describe('[COMP:files/distill] PDF local-text fallback', () => {
  it('falls back to local extraction when a DashScope adapter has no qwen-long model', async () => {
    // Reproduce the reported failure: the qwen-long chat completion 404s with
    // "model not found". Distillation must degrade to the local text layer
    // rather than throwing.
    const fetchFn = vi.fn(async (url: string | URL | Request) => {
      const u = String(url)
      if (u.endsWith('/files')) return new Response(JSON.stringify({ id: 'file-1' }), { status: 200 })
      return new Response('{"error":{"message":"model not found"}}', { status: 404 })
    })

    const result = await distillFileToText(
      { buffer: minimalPdf('Attention Is All You Need'), mime: 'application/pdf' },
      { backend: { kind: 'dashscope', apiKey: 'k', baseUrl: 'https://ds.test/v1' }, fetchFn },
    )

    expect(result.model).toBe('local-pdf-text')
    expect(result.text).toBe('Attention Is All You Need')
    expect(result.usage).toBeNull()
  })

  it('keeps the native distillation when the adapter succeeds (no fallback)', async () => {
    const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url)
      if (u.endsWith('/files')) return new Response(JSON.stringify({ id: 'file-1' }), { status: 200 })
      const body = JSON.parse(init!.body as string)
      if (body.model === 'qwen-vl-max') {
        return new Response(JSON.stringify({ choices: [{ message: { content: '' } }] }), { status: 200 })
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: '# Native extract' } }] }), { status: 200 })
    })

    const result = await distillFileToText(
      { buffer: minimalPdf(), mime: 'application/pdf' },
      { backend: { kind: 'dashscope', apiKey: 'k', baseUrl: 'https://ds.test/v1' }, fetchFn },
    )

    expect(result.model).not.toBe('local-pdf-text')
    expect(result.text).toBe('# Native extract')
  })
})

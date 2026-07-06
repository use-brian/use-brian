import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'
import { parseFileContent, shouldInline } from '../parsers.js'

// Minimal real Office Open XML fixtures — see fixtures/make-sample-*.{py,mjs}.
const sampleDocx = readFileSync(new URL('./fixtures/sample.docx', import.meta.url))
const sampleXlsx = readFileSync(new URL('./fixtures/sample.xlsx', import.meta.url))
const samplePptx = readFileSync(new URL('./fixtures/sample.pptx', import.meta.url))
const DOCX_MIME =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
const PPTX_MIME =
  'application/vnd.openxmlformats-officedocument.presentationml.presentation'

describe('[COMP:files/parsers] parseFileContent', () => {
  it('parses text/plain files as UTF-8', async () => {
    const buf = Buffer.from('hello world', 'utf-8')
    const result = await parseFileContent(buf, 'text/plain', 'note.txt')
    expect(result.text).toBe('hello world')
    expect(result.summary).toContain('note.txt')
    expect(result.summary).toContain('11 chars')
  })

  it('parses application/json as UTF-8', async () => {
    const buf = Buffer.from('{"a":1}', 'utf-8')
    const result = await parseFileContent(buf, 'application/json', 'data.json')
    expect(result.text).toBe('{"a":1}')
  })

  it('returns base64 and "Image:" summary for image types', async () => {
    const buf = Buffer.from([0x89, 0x50, 0x4e, 0x47])  // PNG magic bytes
    const result = await parseFileContent(buf, 'image/png', 'photo.png')
    expect(result.text).toBe(buf.toString('base64'))
    expect(result.summary).toContain('Image: photo.png')
  })

  it('returns base64 and "PDF:" summary for PDFs (native inlineData path)', async () => {
    // PDFs ride the same inlineData path as images — Gemini reads them
    // natively. parseFileContent must return the raw base64, NOT extracted
    // text, so the turn builder can emit an `image` ContentBlock.
    const buf = Buffer.from('%PDF-1.4 fake body bytes for the test')
    const result = await parseFileContent(buf, 'application/pdf', 'eStatement.pdf')
    expect(result.text).toBe(buf.toString('base64'))
    expect(result.summary).toContain('PDF: eStatement.pdf')
    // Must never emit the pre-extraction failure sentinel we used to ship.
    expect(result.text).not.toContain('Failed to parse')
    expect(result.text).not.toContain('pdfParse is not a function')
  })

  it('parses CSV files based on filename extension', async () => {
    const buf = Buffer.from('name,age\nAlice,30\nBob,25', 'utf-8')
    const result = await parseFileContent(buf, 'application/octet-stream', 'users.csv')
    expect(result.text).toBe('name,age\nAlice,30\nBob,25')
    expect(result.summary).toContain('CSV: users.csv')
    expect(result.summary).toContain('3 rows')
  })

  it('extracts an .xlsx to per-sheet Markdown tables', async () => {
    const result = await parseFileContent(sampleXlsx, XLSX_MIME, 'financials.xlsx')
    // Sheet names become headings...
    expect(result.text).toContain('## Financials')
    expect(result.text).toContain('## Notes')
    // ...rows render as a Markdown table...
    expect(result.text).toContain('| Metric | Value |')
    // ...dates are ISO, formulas show the computed result, pipes are escaped.
    expect(result.text).toContain('2026-01-15')
    expect(result.text).toContain('80000')
    expect(result.text).toContain('Pipe \\| inside')
    expect(result.summary).toContain('Spreadsheet: financials.xlsx')
    expect(result.text).not.toContain('not yet implemented')
  })

  it('returns an honest placeholder when an .xlsx cannot be parsed', async () => {
    const garbage = Buffer.from('not a real xlsx')
    const result = await parseFileContent(garbage, XLSX_MIME, 'broken.xlsx')
    expect(result.text).toContain('Could not parse')
    expect(result.summary).toContain('Spreadsheet: broken.xlsx')
  })

  it('returns an actionable placeholder for legacy .xls files', async () => {
    const result = await parseFileContent(Buffer.from('biff'), 'application/vnd.ms-excel', 'old.xls')
    expect(result.text).toContain('legacy .xls format is not supported')
    expect(result.summary).toContain('Spreadsheet: old.xls')
  })

  it('extracts a .pptx to slide text + notes in display order', async () => {
    const result = await parseFileContent(samplePptx, PPTX_MIME, 'deck.pptx')
    expect(result.text).toContain('## Slide 1')
    expect(result.text).toContain('Market Analysis')
    expect(result.text).toContain('Q2 revenue up 40%.')
    // Speaker notes are labeled...
    expect(result.text).toContain('**Notes:** Emphasize the EU segment.')
    // ...and slide 1 sorts before slide 2 (via sldIdLst order).
    expect(result.text.indexOf('## Slide 1')).toBeLessThan(result.text.indexOf('## Slide 2'))
    expect(result.text).toContain('Next Steps')
    expect(result.summary).toContain('Presentation: deck.pptx')
  })

  it('returns an actionable placeholder for legacy .ppt files', async () => {
    const result = await parseFileContent(Buffer.from('ppt'), 'application/vnd.ms-powerpoint', 'old.ppt')
    expect(result.text).toContain('legacy .ppt format is not supported')
    expect(result.summary).toContain('Presentation: old.ppt')
  })

  it('extracts a .docx to Markdown (by mime type)', async () => {
    const result = await parseFileContent(sampleDocx, DOCX_MIME, 'analysis.docx')
    // Prose is preserved...
    expect(result.text).toContain('Market Analysis for Discussion')
    // ...emphasis becomes Markdown...
    expect(result.text).toContain('**Confidential**')
    // ...and table content survives (cells are preserved as HTML the model reads).
    expect(result.text).toContain('Metric')
    expect(result.text).toContain('Revenue')
    expect(result.text).toContain('40%')
    expect(result.summary).toContain('Document: analysis.docx')
    expect(result.summary).toContain('chars')
    expect(result.text).not.toContain('not yet implemented')
  })

  it('extracts a .docx detected by filename extension', async () => {
    // Some uploads arrive with a generic octet-stream mime; the .docx
    // extension still routes them to the parser.
    const result = await parseFileContent(sampleDocx, 'application/octet-stream', 'report.docx')
    expect(result.text).toContain('Market Analysis for Discussion')
  })

  it('returns an honest placeholder when a .docx cannot be parsed', async () => {
    const garbage = Buffer.from('this is not a real docx zip')
    const result = await parseFileContent(garbage, DOCX_MIME, 'broken.docx')
    expect(result.text).toContain('Could not parse')
    expect(result.summary).toContain('Document: broken.docx')
  })

  it('returns an actionable placeholder for legacy .doc files', async () => {
    const buf = Buffer.from('fake legacy word content')
    const result = await parseFileContent(buf, 'application/msword', 'old.doc')
    expect(result.text).toContain('legacy .doc format is not supported')
    expect(result.summary).toContain('Document: old.doc')
  })

  it('returns a generic unsupported message for unknown types', async () => {
    const buf = Buffer.from('binary')
    const result = await parseFileContent(buf, 'application/octet-stream', 'mystery.bin')
    expect(result.text).toContain('not supported')
    expect(result.summary).toContain('mystery.bin')
  })
})

describe('[COMP:files/parsers] shouldInline', () => {
  it('inlines small Latin text', () => {
    expect(shouldInline('a'.repeat(1000))).toBe(true)
    // 19K Latin chars ≈ 4,750 tokens, under the 5,000-token line.
    expect(shouldInline('a'.repeat(19_000))).toBe(true)
  })

  it('does not inline large Latin text', () => {
    expect(shouldInline('a'.repeat(100_000))).toBe(false)
  })

  it('keeps ASCII boundary parity with the old length*4 gate', () => {
    // Old gate: length <= 20_000 inline. estimateStringTokens on ASCII is
    // ceil(len/4), so the same 20_000-char boundary must hold.
    expect(shouldInline('a'.repeat(20_000))).toBe(true) // 5,000 tokens
    expect(shouldInline('a'.repeat(20_001))).toBe(false) // 5,001 tokens
  })

  it('does not inline CJK text the old char-count gate would have inlined', () => {
    // 6,000 CJK codepoints ≈ 6,000 tokens (1 token each), over the line —
    // even though 6,000 chars sits well under the old 20K-char threshold.
    expect(shouldInline('中'.repeat(6_000))).toBe(false)
    // A short CJK note still inlines.
    expect(shouldInline('中'.repeat(1_000))).toBe(true)
  })
})

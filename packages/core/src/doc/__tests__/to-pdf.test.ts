import { describe, it, expect } from 'vitest'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import JSZip from 'jszip'
import {
  PdfRenderError,
  defaultPdfRenderer,
  dropDuplicateLeadingTitle,
  renderMarkdownToPdf,
  renderPageToPdf,
} from '../convert/to-pdf.js'
import { markdownToBlocks } from '../markdown.js'
import { LibreOfficeError, type LibreOfficeRunParams } from '../../files/libreoffice.js'

/** A structurally valid PDF with `pages` empty pages (pdf.js reconstructs the xref). */
function minimalPdf(pages: number): Uint8Array {
  const kids = Array.from({ length: pages }, (_, i) => `${4 + i} 0 R`).join(' ')
  const pageObjs = Array.from({ length: pages }, (_, i) => `${4 + i} 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >> endobj\n`).join('')
  const body =
    `%PDF-1.4\n` +
    `1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n` +
    `2 0 obj << /Type /Pages /Kids [${kids}] /Count ${pages} >> endobj\n` +
    `3 0 obj << >> endobj\n` +
    pageObjs +
    `trailer << /Root 1 0 R >>\n%%EOF\n`
  return new TextEncoder().encode(body)
}

/** Fake LibreOffice: asserts it received a DOCX and emits a `pages`-page PDF. */
function fakeSoffice(pages: number, onDocx?: (docx: Uint8Array) => void | Promise<void>) {
  return async ({ inputPath, outputDirectory }: LibreOfficeRunParams) => {
    const docx = new Uint8Array(await readFile(inputPath))
    expect(inputPath.endsWith('/input/document.docx')).toBe(true)
    // ZIP magic — a real .docx package, not Markdown or JSON.
    expect(Array.from(docx.slice(0, 2))).toEqual([0x50, 0x4b])
    await onDocx?.(docx)
    await writeFile(join(outputDirectory, 'document.pdf'), minimalPdf(pages))
  }
}

async function docxText(docx: Uint8Array): Promise<string> {
  const zip = await JSZip.loadAsync(docx)
  return (await zip.file('word/document.xml')!.async('string')).replace(/<[^>]+>/g, ' ')
}

describe('[COMP:doc/to-pdf] Block[] / Markdown → PDF spoke', () => {
  it('renders Markdown through the Block[] → .docx → LibreOffice chain and reads back the page count', async () => {
    let seenDocx: Uint8Array | null = null
    const result = await renderMarkdownToPdf('# Weekly report\n\nRevenue grew 12%.\n\n- one\n- two\n\n| a | b |\n|---|---|\n| 1 | 2 |', {
      title: 'Weekly report',
      run: fakeSoffice(3, (docx) => {
        seenDocx = docx
      }),
    })
    expect(result.mime).toBe('application/pdf')
    expect(result.pageCount).toBe(3)
    expect(result.bytes.length).toBeGreaterThan(0)
    const text = await docxText(seenDocx!)
    expect(text).toContain('Weekly report')
    expect(text).toContain('Revenue grew 12%.')
    expect(text).toContain('one')
  })

  it('renders a doc page (Page object) the same way', async () => {
    const page = { blocks: markdownToBlocks('## Agenda\n\nItem A') }
    const result = await renderPageToPdf(page, { title: 'Sync notes', run: fakeSoffice(1) })
    expect(result.pageCount).toBe(1)
  })

  it('drops a leading H1 that duplicates the title (so the title is not printed twice)', () => {
    const blocks = markdownToBlocks('# Q3 Summary\n\nBody')
    expect(dropDuplicateLeadingTitle(blocks, 'Q3 Summary')).toHaveLength(blocks.length - 1)
    expect(dropDuplicateLeadingTitle(blocks, '  q3   summary ')).toHaveLength(blocks.length - 1)
    expect(dropDuplicateLeadingTitle(blocks, 'Different')).toHaveLength(blocks.length)
    expect(dropDuplicateLeadingTitle(blocks, undefined)).toHaveLength(blocks.length)
    // Only a leading H1 counts — an H2 stays.
    const h2 = markdownToBlocks('## Q3 Summary\n\nBody')
    expect(dropDuplicateLeadingTitle(h2, 'Q3 Summary')).toHaveLength(h2.length)
  })

  it('surfaces a missing converter as a typed, user-safe PdfRenderError (never a fake PDF)', async () => {
    const err = await renderMarkdownToPdf('hello', {
      run: async () => {
        throw new LibreOfficeError('converter_unavailable', { cause: 'spawn soffice ENOENT' })
      },
    }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(PdfRenderError)
    expect((err as PdfRenderError).code).toBe('converter_unavailable')
    expect((err as PdfRenderError).message).toMatch(/PDF rendering is unavailable/)
    expect((err as PdfRenderError).message).not.toContain('ENOENT')
    expect(String((err as PdfRenderError).cause)).toContain('ENOENT')
  })

  it('maps a converter that emits garbage to invalid_pdf', async () => {
    const err = await renderMarkdownToPdf('hello', {
      run: async ({ outputDirectory }) => {
        await writeFile(join(outputDirectory, 'document.pdf'), new TextEncoder().encode('not a pdf'))
      },
    }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(PdfRenderError)
    expect((err as PdfRenderError).code).toBe('invalid_pdf')
  })

  it('exposes a default renderer with both entry points', () => {
    expect(typeof defaultPdfRenderer.fromPage).toBe('function')
    expect(typeof defaultPdfRenderer.fromMarkdown).toBe('function')
  })
})

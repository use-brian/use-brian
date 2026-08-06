import { describe, it, expect } from 'vitest'
import JSZip from 'jszip'
import { parseOdfToMarkdown } from '../odf.js'
import { parseFileContent } from '../parsers.js'

/**
 * Fixtures are built here rather than committed as binaries: an ODF package is
 * a zip with one meaningful entry, so the fixture IS the assertion about the
 * format, and a reader can see exactly what the parser was handed.
 */
async function odf(mimetype: string, body: string): Promise<Buffer> {
  const zip = new JSZip()
  zip.file('mimetype', mimetype)
  zip.file(
    'content.xml',
    `<?xml version="1.0" encoding="UTF-8"?><office:document-content><office:body>${body}</office:body></office:document-content>`,
  )
  return Buffer.from(await zip.generateAsync({ type: 'nodebuffer' }))
}

const TEXT_MIME = 'application/vnd.oasis.opendocument.text'
const SHEET_MIME = 'application/vnd.oasis.opendocument.spreadsheet'
const DECK_MIME = 'application/vnd.oasis.opendocument.presentation'

describe('[COMP:files/odf] .odt', () => {
  it('keeps heading levels, paragraphs and lists in document order', async () => {
    const buf = await odf(
      TEXT_MIME,
      `<office:text>
        <text:h text:outline-level="1">Implementation plan</text:h>
        <text:p>Ship the safety hub first.</text:p>
        <text:h text:outline-level="2">Stage 1</text:h>
        <text:list><text:list-item><text:p>Canonical dossier</text:p></text:list-item>
        <text:list-item><text:p>Recall route</text:p></text:list-item></text:list>
      </office:text>`,
    )
    const { text, kind } = await parseOdfToMarkdown(buf)
    expect(kind).toBe('text')
    expect(text).toBe(
      '# Implementation plan\n\nShip the safety hub first.\n\n## Stage 1\n\n- Canonical dossier\n- Recall route',
    )
  })

  it('decodes entities and expands text:s runs', async () => {
    const buf = await odf(
      TEXT_MIME,
      '<office:text><text:p>R&amp;D<text:s text:c="3"/>&quot;done&quot;</text:p></office:text>',
    )
    expect((await parseOdfToMarkdown(buf)).text).toBe('R&D "done"')
  })

  it('converts an embedded table to a Markdown table', async () => {
    const buf = await odf(
      TEXT_MIME,
      `<office:text><table:table table:name="Batches">
        <table:table-row><table:table-cell><text:p>Batch</text:p></table:table-cell><table:table-cell><text:p>Result</text:p></table:table-cell></table:table-row>
        <table:table-row><table:table-cell><text:p>1W07KPJ</text:p></table:table-cell><table:table-cell><text:p>Exceeded</text:p></table:table-cell></table:table-row>
      </table:table></office:text>`,
    )
    const { text } = await parseOdfToMarkdown(buf)
    expect(text).toContain('**Batches**')
    expect(text).toContain('| Batch | Result |')
    expect(text).toContain('| 1W07KPJ | Exceeded |')
  })

  it('drops annotations, which are editorial chrome rather than content', async () => {
    const buf = await odf(
      TEXT_MIME,
      '<office:text><text:p>Kept<office:annotation><text:p>reviewer note</text:p></office:annotation></text:p></office:text>',
    )
    expect((await parseOdfToMarkdown(buf)).text).toBe('Kept')
  })
})

describe('[COMP:files/odf] .ods', () => {
  it('emits one Markdown table per sheet, named', async () => {
    const buf = await odf(
      SHEET_MIME,
      `<office:spreadsheet>
        <table:table table:name="Q3"><table:table-row>
          <table:table-cell><text:p>Item</text:p></table:table-cell><table:table-cell><text:p>Qty</text:p></table:table-cell>
        </table:table-row><table:table-row>
          <table:table-cell><text:p>Widget</text:p></table:table-cell><table:table-cell office:value-type="float" office:value="2"><text:p>2</text:p></table:table-cell>
        </table:table-row></table:table>
      </office:spreadsheet>`,
    )
    const { text, kind, sections, rows } = await parseOdfToMarkdown(buf)
    expect(kind).toBe('spreadsheet')
    expect(sections).toBe(1)
    expect(rows).toBe(2)
    expect(text).toContain('## Q3')
    expect(text).toContain('| Widget | 2 |')
  })

  /**
   * The failure this exists to prevent: writers pad every sheet to the format's
   * column and row limits with a single repeated empty element. Expanding those
   * literally turns a two-column sheet into megabytes of pipes.
   */
  it('does not expand the empty padding writers use to fill a sheet', async () => {
    const buf = await odf(
      SHEET_MIME,
      `<office:spreadsheet><table:table table:name="Padded">
        <table:table-row><table:table-cell><text:p>A</text:p></table:table-cell>
        <table:table-cell table:number-columns-repeated="1024"/></table:table-row>
        <table:table-row table:number-rows-repeated="1048576"><table:table-cell table:number-columns-repeated="1024"/></table:table-row>
      </table:table></office:spreadsheet>`,
    )
    const { text, rows } = await parseOdfToMarkdown(buf)
    expect(rows).toBe(1)
    expect(text.length).toBeLessThan(120)
    expect(text).toContain('| A |')
  })

  it('still expands a repeat that carries real content', async () => {
    const buf = await odf(
      SHEET_MIME,
      `<office:spreadsheet><table:table table:name="Repeat">
        <table:table-row><table:table-cell table:number-columns-repeated="3"><text:p>x</text:p></table:table-cell></table:table-row>
      </table:table></office:spreadsheet>`,
    )
    expect((await parseOdfToMarkdown(buf)).text).toContain('| x | x | x |')
  })

  it('falls back to the typed value when a cell has no rendered text', async () => {
    const buf = await odf(
      SHEET_MIME,
      `<office:spreadsheet><table:table table:name="Dates">
        <table:table-row><table:table-cell office:value-type="date" office:date-value="2026-08-05"/></table:table-row>
      </table:table></office:spreadsheet>`,
    )
    expect((await parseOdfToMarkdown(buf)).text).toContain('2026-08-05')
  })
})

describe('[COMP:files/odf] .odp', () => {
  it('emits one section per slide in page order', async () => {
    const buf = await odf(
      DECK_MIME,
      `<office:presentation>
        <draw:page draw:name="Intro"><draw:frame><draw:text-box><text:p>Why now</text:p></draw:text-box></draw:frame></draw:page>
        <draw:page draw:name="Plan"><draw:frame><draw:text-box><text:p>Ninety days</text:p></draw:text-box></draw:frame></draw:page>
      </office:presentation>`,
    )
    const { text, kind, sections } = await parseOdfToMarkdown(buf)
    expect(kind).toBe('presentation')
    expect(sections).toBe(2)
    expect(text.indexOf('Why now')).toBeLessThan(text.indexOf('Ninety days'))
    expect(text).toContain('## Slide 1 — Intro')
  })
})

describe('[COMP:files/odf] parseFileContent routing', () => {
  it('routes an .odt by mime', async () => {
    const buf = await odf(TEXT_MIME, '<office:text><text:p>Body text.</text:p></office:text>')
    const { text, summary, placeholder } = await parseFileContent(buf, TEXT_MIME, 'plan.odt')
    expect(placeholder).toBeUndefined()
    expect(text).toBe('Body text.')
    expect(summary).toContain('Document: plan.odt')
  })

  it('routes by extension when the mime is generic', async () => {
    const buf = await odf(SHEET_MIME, '<office:spreadsheet><table:table table:name="S"><table:table-row><table:table-cell><text:p>1</text:p></table:table-cell></table:table-row></table:table></office:spreadsheet>')
    const { summary } = await parseFileContent(buf, 'application/octet-stream', 'BOOK.ODS')
    expect(summary).toContain('Spreadsheet: BOOK.ODS')
    expect(summary).toContain('1 rows')
  })

  it('returns an honest placeholder for a buffer that is not an ODF package', async () => {
    const { text, placeholder } = await parseFileContent(
      Buffer.from('not a zip'),
      TEXT_MIME,
      'broken.odt',
    )
    expect(placeholder).toBe(true)
    expect(text).toContain('Could not parse as OpenDocument')
  })

  it('placeholders an ODF package with no extractable text', async () => {
    const buf = await odf(TEXT_MIME, '<office:text></office:text>')
    const { placeholder } = await parseFileContent(buf, TEXT_MIME, 'empty.odt')
    expect(placeholder).toBe(true)
  })
})

describe('[COMP:files/parsers] OOXML variants and .tsv', () => {
  /**
   * `application/vnd.openxmlformats-officedocument` is a PREFIX in the upload
   * allowlist, so these were accepted at the door and then refused by the
   * parser's unsupported-type fallback. `.ppsx` is an ordinary way to send a
   * deck, and `parsePptxToMarkdown` reads it unchanged.
   */
  it('routes .ppsx / .potx to the pptx parser', async () => {
    const { readFileSync } = await import('node:fs')
    const { fileURLToPath } = await import('node:url')
    const fixture = readFileSync(
      fileURLToPath(new URL('./fixtures/sample.pptx', import.meta.url)),
    )
    for (const [mime, name] of [
      ['application/vnd.openxmlformats-officedocument.presentationml.slideshow', 'deck.ppsx'],
      ['application/octet-stream', 'deck.POTX'],
    ] as const) {
      const { text, placeholder } = await parseFileContent(fixture, mime, name)
      expect(placeholder).toBeUndefined()
      expect(text).toContain('## Slide 1')
    }
  })

  it('labels a .tsv, which the tabular lane already treats as tabular', async () => {
    const tsv = 'name\tqty\nwidget\t2\n'
    const byExt = await parseFileContent(Buffer.from(tsv), 'application/octet-stream', 'rows.TSV')
    expect(byExt.summary).toContain('TSV: rows.TSV')
    const byMime = await parseFileContent(
      Buffer.from(tsv),
      'text/tab-separated-values',
      'rows.txt',
    )
    expect(byMime.summary).toContain('TSV: rows.txt')
  })
})

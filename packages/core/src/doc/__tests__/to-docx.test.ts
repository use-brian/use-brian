import JSZip from 'jszip'
import { describe, it, expect } from 'vitest'
import { blocksToDocx } from '../convert/to-docx.js'
import type { Block, RichTextContent } from '../page-types.js'

function rt(text: string): RichTextContent {
  return { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] } as unknown as RichTextContent
}

/** A .docx file is a ZIP — its first two bytes are the local-file signature. */
function isDocxZip(buf: Buffer): boolean {
  return buf.length > 4 && buf[0] === 0x50 && buf[1] === 0x4b // 'PK'
}

describe('[COMP:doc/to-docx] Block → .docx', () => {
  it('produces a valid (non-empty, PK-signed) docx buffer for every block kind', async () => {
    const blocks: Block[] = [
      { kind: 'heading', id: 'h', level: 1, text: 'Report' },
      { kind: 'text', id: 't', text: 'Body paragraph.' },
      { kind: 'divider', id: 'd' },
      { kind: 'quote', id: 'q', richText: rt('a quote') },
      { kind: 'callout', id: 'c', icon: '💡', richText: rt('note') },
      { kind: 'code', id: 'co', language: 'ts', code: 'const x = 1\nconst y = 2' },
      { kind: 'bulleted_list_item', id: 'b', richText: rt('bullet') },
      { kind: 'numbered_list_item', id: 'n1', richText: rt('first') },
      { kind: 'numbered_list_item', id: 'n2', richText: rt('second') },
      { kind: 'to_do', id: 'td', checked: true, richText: rt('done') },
      { kind: 'toggle', id: 'tg', richText: rt('summary') },
      { kind: 'table', id: 'tb', hasHeaderRow: true, rows: [[rt('A'), rt('B')], [rt('1'), rt('2')]] },
      { kind: 'diagram', id: 'dg', syntax: 'mermaid', code: 'graph TD\nA-->B' },
      { kind: 'bookmark', id: 'bm', url: 'https://example.com', meta: { title: 'Example' } },
      { kind: 'child_page', id: 'cp', childPageId: 'page-123' },
    ]
    const buf = await blocksToDocx(blocks, { title: 'Quarterly Report' })
    expect(isDocxZip(buf)).toBe(true)
    expect(buf.length).toBeGreaterThan(1000)
  })

  it('handles an empty page', async () => {
    const buf = await blocksToDocx([])
    expect(isDocxZip(buf)).toBe(true)
  })

  it('resolves a data block via the injected resolver', async () => {
    const block: Block = { kind: 'data', id: 'a', binding: { type: 'tasks' } as never }
    const buf = await blocksToDocx([block], { resolveData: () => [['Task'], ['Ship']] })
    expect(isDocxZip(buf)).toBe(true)
  })

  it('emits absolute (dxa) table widths, never the percent-string form older LibreOffice reads as 2%', async () => {
    const block: Block = {
      kind: 'table',
      id: 'tb',
      hasHeaderRow: true,
      rows: [
        [rt('Milestone'), rt('Dates'), rt('Fee')],
        [rt('1. Survey design and ecosystem outreach'), rt('1-14 Sep 2026'), rt('US$6,000')],
      ],
    }
    const buf = await blocksToDocx([block])
    const xml = await (await JSZip.loadAsync(buf)).file('word/document.xml')!.async('string')
    expect(xml).not.toContain('w:type="pct"')
    expect(xml).toContain('<w:tblW w:type="dxa"')
    const grid = [...xml.matchAll(/<w:gridCol w:w="(\d+)"\/>/g)].map((m) => Number(m[1]))
    expect(grid).toHaveLength(3)
    // The grid fills the A4 content width exactly, and the prose column
    // outweighs the short fee column.
    expect(grid.reduce((a, b) => a + b, 0)).toBe(9026)
    expect(Math.max(...grid)).toBeGreaterThan(Math.min(...grid))
  })
})

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
})

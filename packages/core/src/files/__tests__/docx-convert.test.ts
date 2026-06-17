import { describe, it, expect } from 'vitest'
import { docxToBlocks } from '../docx-convert.js'
import { blocksToDocx } from '../../doc/convert/to-docx.js'
import { richTextToPlain } from '../../doc/rich-text.js'
import type { Block, RichTextContent } from '../../doc/page-types.js'

function rt(text: string): RichTextContent {
  return { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] } as unknown as RichTextContent
}

/** Flatten any block to its visible text for content assertions. */
function blockText(b: Block): string {
  if (b.kind === 'heading' || b.kind === 'text') return b.text
  if ('richText' in b) return richTextToPlain((b as { richText?: RichTextContent }).richText)
  return ''
}

describe('[COMP:files/docx-convert] .docx → Block[]', () => {
  it('round-trips a docx authored from blocks back into equivalent blocks', async () => {
    const source: Block[] = [
      { kind: 'heading', id: 'h', level: 1, text: 'Quarterly Report' },
      { kind: 'text', id: 't', text: 'Revenue grew this quarter.' },
      { kind: 'bulleted_list_item', id: 'b1', richText: rt('Launched in three regions') },
      { kind: 'bulleted_list_item', id: 'b2', richText: rt('Hired two engineers') },
    ]
    const buf = await blocksToDocx(source)
    const recovered = await docxToBlocks(buf)

    const allText = recovered.map(blockText).join('\n')
    expect(allText).toContain('Quarterly Report')
    expect(allText).toContain('Revenue grew this quarter.')
    expect(allText).toContain('Launched in three regions')
    expect(allText).toContain('Hired two engineers')

    // The bullets survive as list items (mammoth maps <ul><li> reliably).
    expect(recovered.some((b) => b.kind === 'bulleted_list_item')).toBe(true)
  })

  it('throws on a non-OOXML buffer', async () => {
    await expect(docxToBlocks(Buffer.from('not a docx'))).rejects.toBeTruthy()
  })
})

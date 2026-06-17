import { describe, it, expect } from 'vitest'
import { markdownToBlocks, blocksFromMarkdown } from '../markdown.js'
import { blockSchema } from '../page-schemas.js'
import type { Block, RichTextContent } from '../page-types.js'

function seqIds(): () => string {
  let n = 0
  return () => `g${n++}`
}
function expectValid(blocks: Block[]): void {
  for (const b of blocks) expect(blockSchema.safeParse(b).success).toBe(true)
}
/** Deep-scan a richText doc for a link mark href. */
function firstLinkHref(rt: RichTextContent | undefined): string | undefined {
  let found: string | undefined
  const walk = (n: { marks?: { type?: string; attrs?: { href?: string } }[]; content?: unknown[] }) => {
    for (const m of n.marks ?? []) if (m.type === 'link') found ??= m.attrs?.href
    for (const c of (n.content ?? []) as typeof n[]) walk(c)
  }
  walk((rt ?? {}) as never)
  return found
}

describe('[COMP:doc/markdown-normalizer] Markdown importer (markdownToBlocks faithful mode)', () => {
  it('parses a GFM table into a table block', () => {
    const md = '| Name | Age |\n| --- | --- |\n| Alice | 30 |\n| Bob | 25 |'
    const blocks = markdownToBlocks(md, { genId: seqIds() })
    expect(blocks).toHaveLength(1)
    expect(blocks[0].kind).toBe('table')
    const t = blocks[0] as Extract<Block, { kind: 'table' }>
    expect(t.hasHeaderRow).toBe(true)
    expect(t.rows).toHaveLength(3)
    expect(t.rows[0]).toHaveLength(2)
    expectValid(blocks)
  })

  it('maps a GFM alert to a callout with the type emoji', () => {
    const blocks = markdownToBlocks('> [!WARNING]\n> be careful here', { genId: seqIds() })
    expect(blocks).toHaveLength(1)
    expect(blocks[0].kind).toBe('callout')
    expect((blocks[0] as Extract<Block, { kind: 'callout' }>).icon).toBe('⚠️')
    expectValid(blocks)
  })

  it('maps a mermaid fence to a diagram block', () => {
    const blocks = markdownToBlocks('```mermaid\ngraph TD\nA-->B\n```', { genId: seqIds() })
    expect(blocks).toHaveLength(1)
    expect(blocks[0].kind).toBe('diagram')
    expect((blocks[0] as Extract<Block, { kind: 'diagram' }>).code).toContain('graph TD')
    expectValid(blocks)
  })

  it('maps a standalone image to a bookmark card', () => {
    const blocks = markdownToBlocks('![A diagram](https://img.example/x.png)', { genId: seqIds() })
    expect(blocks).toHaveLength(1)
    expect(blocks[0].kind).toBe('bookmark')
    const b = blocks[0] as Extract<Block, { kind: 'bookmark' }>
    expect(b.url).toBe('https://img.example/x.png')
    expect(b.meta?.title).toBe('A diagram')
    expectValid(blocks)
  })

  it('preserves an inline link as a link mark on a list item', () => {
    const blocks = markdownToBlocks('- see [Google](https://g.co)', { genId: seqIds() })
    expect(blocks[0].kind).toBe('bulleted_list_item')
    const rich = (blocks[0] as { richText?: RichTextContent }).richText
    expect(firstLinkHref(rich)).toBe('https://g.co')
    expectValid(blocks)
  })
})

describe('[COMP:doc/markdown-normalizer] Normalizer path is unchanged (no GFM constructs, links stripped)', () => {
  it('keeps a GFM alert as a plain quote', () => {
    const blocks = blocksFromMarkdown('> [!NOTE]\n> hi', seqIds())
    expect(blocks[0].kind).toBe('quote')
  })

  it('keeps a mermaid fence as a code block', () => {
    const blocks = blocksFromMarkdown('```mermaid\ngraph TD\n```', seqIds())
    expect(blocks[0].kind).toBe('code')
    expect((blocks[0] as Extract<Block, { kind: 'code' }>).language).toBe('mermaid')
  })

  it('leaves a GFM table as literal paragraph text', () => {
    const blocks = blocksFromMarkdown('| a | b |\n| --- | --- |\n| 1 | 2 |', seqIds())
    expect(blocks.every((b) => b.kind === 'text')).toBe(true)
  })

  it('drops an inline link to its label (no link mark)', () => {
    const blocks = blocksFromMarkdown('- see [Google](https://g.co)', seqIds())
    const rich = (blocks[0] as { richText?: RichTextContent }).richText
    expect(firstLinkHref(rich)).toBeUndefined()
  })
})

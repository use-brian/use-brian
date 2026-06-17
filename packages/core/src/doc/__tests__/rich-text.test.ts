import { describe, it, expect } from 'vitest'
import { extractInlineSegments, richTextToPlain } from '../rich-text.js'
import type { RichTextContent } from '../page-types.js'

/** Build a one-paragraph richText doc from inline nodes. */
function rt(content: unknown[]): RichTextContent {
  return { type: 'doc', content: [{ type: 'paragraph', content }] } as unknown as RichTextContent
}

describe('[COMP:doc/rich-text] richText inline walker', () => {
  it('reads bold / italic / code / strike marks into flags', () => {
    const doc = rt([
      { type: 'text', text: 'plain ' },
      { type: 'text', text: 'b', marks: [{ type: 'bold' }] },
      { type: 'text', text: 'i', marks: [{ type: 'italic' }] },
      { type: 'text', text: 'c', marks: [{ type: 'code' }] },
      { type: 'text', text: 's', marks: [{ type: 'strike' }] },
    ])
    expect(extractInlineSegments(doc)).toEqual([
      { text: 'plain ' },
      { text: 'b', bold: true },
      { text: 'i', italic: true },
      { text: 'c', code: true },
      { text: 's', strike: true },
    ])
  })

  it('combines multiple marks on one run', () => {
    const doc = rt([{ type: 'text', text: 'x', marks: [{ type: 'bold' }, { type: 'italic' }] }])
    expect(extractInlineSegments(doc)).toEqual([{ text: 'x', bold: true, italic: true }])
  })

  it('reads a link mark href', () => {
    const doc = rt([
      { type: 'text', text: 'go', marks: [{ type: 'link', attrs: { href: 'https://g.co' } }] },
    ])
    expect(extractInlineSegments(doc)).toEqual([{ text: 'go', link: 'https://g.co' }])
  })

  it('inlines person / page mentions as their label', () => {
    const doc = rt([
      { type: 'text', text: 'cc ' },
      { type: 'personMention', attrs: { id: 'u1', name: 'Alice' } },
      { type: 'text', text: ' see ' },
      { type: 'pageMention', attrs: { id: 'p1', title: 'Roadmap' } },
    ])
    expect(richTextToPlain(doc)).toBe('cc @Alice see 📄 Roadmap')
  })

  it('joins paragraph boundaries with a space and hardBreak as a space', () => {
    const doc = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'one' }, { type: 'hardBreak' }, { type: 'text', text: 'two' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'three' }] },
      ],
    } as unknown as RichTextContent
    expect(richTextToPlain(doc)).toBe('one two three')
  })

  it('returns an empty array for absent / empty rich text', () => {
    expect(extractInlineSegments(undefined)).toEqual([])
    expect(extractInlineSegments({ type: 'doc', content: [] } as unknown as RichTextContent)).toEqual([])
  })
})

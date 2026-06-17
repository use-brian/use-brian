import { describe, it, expect } from 'vitest'
import {
  blocksToPMDoc,
  pmDocToBlocks,
  type PMNode,
} from '../block-mapping.js'
import { docSchema } from '../schema.js'

/**
 * [COMP:doc-model/mapping] Inline `@`-mention round-trip.
 *
 * Mentions are inline atoms in the SHARED schema (`personMention` /
 * `pageMention`) so a mention typed by one collaborator round-trips through
 * the Yjs doc to every other end. These tests assert two things:
 *
 *   1. The derived ProseMirror `Schema` actually carries both mention node
 *      types — the load-bearing fact that keeps the two Yjs ends in sync.
 *   2. `block-mapping` preserves mention nodes when converting a page →
 *      ProseMirror doc and back: rich-text-bearing blocks keep the node
 *      verbatim; flat-`text` blocks serialise the mention's label into the
 *      snapshot text (so server-side reads / search still see it).
 */

const personMention = (id: string, name: string): PMNode => ({
  type: 'personMention',
  attrs: { id, name, avatarUrl: null },
})

const pageMention = (id: string, title: string): PMNode => ({
  type: 'pageMention',
  attrs: { id, title },
})

describe('[COMP:doc-model/schema] mention nodes in the derived schema', () => {
  it('registers personMention + pageMention as inline atom nodes', () => {
    const schema = docSchema()
    expect(schema.nodes.personMention).toBeDefined()
    expect(schema.nodes.pageMention).toBeDefined()
    expect(schema.nodes.personMention.isInline).toBe(true)
    expect(schema.nodes.pageMention.isInline).toBe(true)
    expect(schema.nodes.personMention.isAtom).toBe(true)
    expect(schema.nodes.pageMention.isAtom).toBe(true)
  })
})

describe('[COMP:doc-model/mapping] mention round-trip', () => {
  it('preserves a personMention node inside a quote block (rich text)', () => {
    const richText = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'cc ' },
            personMention('u1', 'Jane Doe'),
            { type: 'text', text: ' please review' },
          ],
        },
      ],
    }
    const blocks = [
      { kind: 'quote', id: 'q1', richText } as never,
    ]
    const out = pmDocToBlocks(blocksToPMDoc(blocks))
    const quote = out[0] as unknown as { richText: { content: PMNode[] } }
    const inline = quote.richText.content[0].content ?? []
    const mention = inline.find((n) => n.type === 'personMention')
    expect(mention).toBeDefined()
    expect(mention?.attrs).toMatchObject({ id: 'u1', name: 'Jane Doe' })
  })

  it('preserves a pageMention node inside a callout block (rich text)', () => {
    const richText = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'see ' },
            pageMention('p9', 'Q4 plan'),
          ],
        },
      ],
    }
    const blocks = [
      { kind: 'callout', id: 'c1', icon: '💡', richText } as never,
    ]
    const out = pmDocToBlocks(blocksToPMDoc(blocks))
    const callout = out[0] as unknown as { richText: { content: PMNode[] } }
    const inline = callout.richText.content[0].content ?? []
    const mention = inline.find((n) => n.type === 'pageMention')
    expect(mention).toBeDefined()
    expect(mention?.attrs).toMatchObject({ id: 'p9', title: 'Q4 plan' })
  })

  it('serialises a paragraph mention into the flat text snapshot', () => {
    // A `text` block stores a flat `text` string (no rich JSON), so a
    // mention inside one survives only as its label — mirroring the
    // node `renderText` contract (`@name` / `📄 title`).
    const doc = {
      type: 'doc' as const,
      content: [
        {
          type: 'paragraph',
          attrs: { blockId: 't1' },
          content: [
            { type: 'text', text: 'ping ' },
            personMention('u1', 'Jane Doe'),
            { type: 'text', text: ' and ' },
            pageMention('p2', 'Roadmap'),
          ],
        },
      ],
    }
    const blocks = pmDocToBlocks(doc)
    const text = blocks[0] as { kind: string; text: string }
    expect(text.kind).toBe('text')
    expect(text.text).toBe('ping @Jane Doe and 📄 Roadmap')
  })
})

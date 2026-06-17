import { describe, it, expect } from 'vitest'
import { Node as PMNode } from 'prosemirror-model'
import { getSchema } from '@tiptap/core'
import { docExtensions, docSchema } from '../schema.js'

/**
 * The block-action menu's "Color" stores a whole-block text color + background
 * as two global string attrs (`color` / `bgColor`) added to `DocAttrs`. They
 * MUST exist identically on both Yjs ends (the byte-parity rule) and a node
 * lacking them (a pre-feature doc) must still parse. These guard that.
 */
describe('[COMP:doc-model/schema] block color attrs', () => {
  it('adds color + bgColor (default null) to block nodes — identical on both ends', () => {
    // The browser builds its schema with the view plugins on; the server with
    // them off. Both call the SAME docExtensions(), so the derived attrs
    // are byte-for-byte identical — that's what keeps y-prosemirror in sync.
    const browser = getSchema(docExtensions({ withViewPlugins: true }))
    const server = docSchema()
    for (const schema of [browser, server]) {
      // incl. the list CONTAINERS (the block the drag handle targets) — they
      // must carry the attrs or colouring/linking a list silently no-ops.
      for (const type of [
        'paragraph',
        'heading',
        'callout',
        'embed',
        'listItem',
        'bulletList',
        'orderedList',
        'taskList',
      ]) {
        const attrs = (schema.nodes[type].spec.attrs ?? {}) as Record<
          string,
          { default?: unknown }
        >
        expect(attrs).toHaveProperty('color')
        expect(attrs).toHaveProperty('bgColor')
        expect(attrs.color.default).toBeNull()
        expect(attrs.bgColor.default).toBeNull()
      }
    }
  })

  it('round-trips color/bgColor through toJSON/fromJSON, preserving blockId', () => {
    const schema = docSchema()
    const p = schema.nodes.paragraph.create(
      { color: 'blue', bgColor: 'red', blockId: 'blk1' },
      schema.text('hi'),
    )
    const json = p.toJSON() as { attrs: Record<string, unknown> }
    expect(json.attrs.color).toBe('blue')
    expect(json.attrs.bgColor).toBe('red')
    const back = PMNode.fromJSON(schema, json)
    expect(back.attrs.color).toBe('blue')
    expect(back.attrs.bgColor).toBe('red')
    // setNodeMarkup-style merges must never drop the id (comment anchors / data
    // bindings resolve by blockId) — the attr survives the round-trip.
    expect(back.attrs.blockId).toBe('blk1')
  })

  it('defaults color/bgColor to null on a pre-color node (old-doc safety)', () => {
    const schema = docSchema()
    const back = PMNode.fromJSON(schema, {
      type: 'paragraph',
      content: [{ type: 'text', text: 'x' }],
    })
    expect(back.attrs.color).toBeNull()
    expect(back.attrs.bgColor).toBeNull()
  })
})

/**
 * [COMP:doc-model/schema] Shared doc schema — node set + markdown triggers.
 *
 * Guards the two contracts this module owns:
 *   1. The derived ProseMirror `Schema` still carries every node/mark the
 *      browser editor and the `apps/doc-sync` server must agree on
 *      byte-for-byte — in particular that moving `blockquote` out of
 *      StarterKit (to remap its input rule) didn't drop the node or register
 *      it twice.
 *   2. The Notion-style markdown-trigger swap: `| ` makes a quote, `> ` makes
 *      a toggle — and NOT the reverse. The triggers are exported regexes so a
 *      regression that re-points `> ` back at the blockquote fails here.
 */

import { describe, expect, it } from 'vitest'
import {
  docSchema,
  BLOCKQUOTE_INPUT_REGEX,
  TOGGLE_INPUT_REGEX,
} from '../schema'

describe('[COMP:doc-model/schema] Doc schema', () => {
  it('builds without throwing — no duplicate blockquote registration', () => {
    expect(() => docSchema()).not.toThrow()
  })

  it('keeps the full node + mark set after moving blockquote out of StarterKit', () => {
    const schema = docSchema()
    const expectedNodes = [
      'doc',
      'paragraph',
      'text',
      'heading',
      'blockquote',
      'codeBlock',
      'bulletList',
      'orderedList',
      'listItem',
      'taskList',
      'taskItem',
      'horizontalRule',
      'callout',
      'toggle',
      'personMention',
      'pageMention',
      'embed',
      'table',
      'tableRow',
      'tableHeader',
      'tableCell',
    ]
    for (const node of expectedNodes) {
      expect(schema.nodes[node], `node ${node}`).toBeDefined()
    }
    expect(schema.marks.comment).toBeDefined()
  })

  it('restricts table cells to paragraph content (Notion simple-table model)', () => {
    const schema = docSchema()
    // Both ends must derive the same cell content model; `paragraph+` keeps
    // nested blocks/lists/tables out of a simple-table cell.
    expect(schema.nodes.tableCell.spec.content).toBe('paragraph+')
    expect(schema.nodes.tableHeader.spec.content).toBe('paragraph+')
  })

  describe('markdown input triggers (Notion-style swap)', () => {
    it('`| ` triggers the quote, not `> `', () => {
      expect(BLOCKQUOTE_INPUT_REGEX.test('| ')).toBe(true)
      expect(BLOCKQUOTE_INPUT_REGEX.test('> ')).toBe(false)
    })

    it('`> ` triggers the toggle, not `| `', () => {
      expect(TOGGLE_INPUT_REGEX.test('> ')).toBe(true)
      expect(TOGGLE_INPUT_REGEX.test('| ')).toBe(false)
    })

    it('allows leading whitespace and requires the trailing space', () => {
      expect(TOGGLE_INPUT_REGEX.test('  > ')).toBe(true)
      expect(BLOCKQUOTE_INPUT_REGEX.test('  | ')).toBe(true)
      // Still typing the marker (no trailing space) → no transform yet.
      expect(TOGGLE_INPUT_REGEX.test('>')).toBe(false)
      expect(BLOCKQUOTE_INPUT_REGEX.test('|')).toBe(false)
    })
  })
})

/**
 * [COMP:doc/child-page-block] child_page block — Zod round-trip.
 *
 * The `child_page` block is the inline pointer to a nested sub-page
 * (page nesting itself lives on `saved_views.nest_parent_id`, migration
 * 210). Verifies the block parses through `blockSchema` / `pageSchema`
 * and that malformed variants are rejected.
 */

import { describe, expect, it } from 'vitest'
import { blockSchema, pageSchema } from '../blocks.js'
import type { ChildPageBlock } from '../blocks.js'

const CHILD_ID = '00000000-0000-0000-0000-0000000000aa'

describe('[COMP:doc/child-page-block] blockSchema accepts child_page', () => {
  it('parses a well-formed child_page block', () => {
    const block: ChildPageBlock = {
      kind: 'child_page',
      id: 'cp1',
      childPageId: CHILD_ID,
    }
    const parsed = blockSchema.safeParse(block)
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect(parsed.data).toEqual(block)
    }
  })

  it('round-trips inside a page', () => {
    const parsed = pageSchema.safeParse({
      blocks: [
        { kind: 'heading', id: 'h1', level: 1, text: 'Parent' },
        { kind: 'child_page', id: 'cp1', childPageId: CHILD_ID },
      ],
    })
    expect(parsed.success).toBe(true)
  })
})

describe('[COMP:doc/child-page-block] blockSchema rejects bad child_page', () => {
  it('rejects a missing childPageId', () => {
    expect(
      blockSchema.safeParse({ kind: 'child_page', id: 'cp1' }).success,
    ).toBe(false)
  })

  it('rejects an empty childPageId', () => {
    expect(
      blockSchema.safeParse({ kind: 'child_page', id: 'cp1', childPageId: '' })
        .success,
    ).toBe(false)
  })

  it('rejects a missing id', () => {
    expect(
      blockSchema.safeParse({ kind: 'child_page', childPageId: CHILD_ID })
        .success,
    ).toBe(false)
  })
})

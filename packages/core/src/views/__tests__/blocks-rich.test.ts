import { describe, it, expect } from 'vitest'
import { blockSchema, pageSchema, type Block } from '../blocks.js'
import { opsSchema } from '../../doc/page-schemas.js'

describe('[COMP:views/blocks] Phase 2.5 rich block kinds', () => {
  const richBlocks: Block[] = [
    { kind: 'callout', id: 'b1', icon: '💡', richText: { type: 'doc', content: [] } },
    { kind: 'code', id: 'b2', language: 'ts', code: 'const x = 1' },
    { kind: 'quote', id: 'b3', richText: { type: 'doc' } },
    { kind: 'bulleted_list_item', id: 'b4', richText: { type: 'doc' } },
    { kind: 'numbered_list_item', id: 'b5', richText: { type: 'doc' } },
    { kind: 'to_do', id: 'b6', checked: true, richText: { type: 'doc' } },
    { kind: 'toggle', id: 'b7', expanded: false, richText: { type: 'doc' } },
  ]

  it('blockSchema parses every rich kind and round-trips', () => {
    for (const block of richBlocks) {
      expect(blockSchema.parse(block)).toEqual(block)
    }
  })

  it('enforces required fields per kind', () => {
    expect(blockSchema.safeParse({ kind: 'callout', id: 'b1' }).success).toBe(false)
    expect(
      blockSchema.safeParse({ kind: 'code', id: 'b2', language: 'ts' }).success,
    ).toBe(false)
    // to_do without `checked`
    expect(
      blockSchema.safeParse({ kind: 'to_do', id: 'b6', richText: {} }).success,
    ).toBe(false)
  })

  it('pageSchema accepts a mixed page with rich blocks', () => {
    const page = {
      blocks: [
        { kind: 'heading', id: 'h', level: 1 as const, text: 'Notes' },
        ...richBlocks,
      ],
    }
    expect(pageSchema.parse(page).blocks).toHaveLength(8)
  })

  it('opsSchema accepts an add op carrying a rich block (tmp id)', () => {
    const ops = [
      { op: 'add', after: 'end', block: { kind: 'callout', id: 'tmp-1', icon: '⚠️' } },
    ]
    expect(opsSchema.parse(ops)).toHaveLength(1)
  })

  describe('simple-table block', () => {
    const validTable: Block = {
      kind: 'table',
      id: 'tb',
      hasHeaderRow: true,
      rows: [
        [{ type: 'doc' }, { type: 'doc' }],
        [{ type: 'doc' }, { type: 'doc' }],
      ],
    }

    it('accepts a rectangular table and round-trips', () => {
      expect(blockSchema.parse(validTable)).toEqual(validTable)
    })

    it('rejects a ragged table (unequal column counts)', () => {
      expect(
        blockSchema.safeParse({
          kind: 'table',
          id: 'tb',
          rows: [[{}, {}], [{}]],
        }).success,
      ).toBe(false)
    })

    it('rejects an over-bounds table (too many columns)', () => {
      expect(
        blockSchema.safeParse({
          kind: 'table',
          id: 'tb',
          rows: [Array.from({ length: 33 }, () => ({}))],
        }).success,
      ).toBe(false)
    })

    it('rejects an empty table (no rows)', () => {
      expect(
        blockSchema.safeParse({ kind: 'table', id: 'tb', rows: [] }).success,
      ).toBe(false)
    })
  })
})

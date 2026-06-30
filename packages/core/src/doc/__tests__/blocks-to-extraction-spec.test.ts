import { describe, it, expect } from 'vitest'
import { blockSchema, type Block } from '../../views/blocks.js'
import { blocksToExtractionSpec } from '../custom-template-types.js'

describe('[COMP:doc/blocks-to-extraction-spec] extraction_slot block + spec deriver', () => {
  it('parses an extraction_slot block via the canonical block schema', () => {
    const parsed = blockSchema.parse({
      kind: 'extraction_slot',
      id: 'b1',
      instruction: 'Pull product / customers / revenue',
      outputType: 'list',
    })
    expect(parsed).toMatchObject({ kind: 'extraction_slot', instruction: 'Pull product / customers / revenue', outputType: 'list' })
  })

  it('derives a spec: each extraction_slot pairs with its nearest preceding heading', () => {
    const blocks: Block[] = [
      { kind: 'heading', id: 'h1', level: 2, text: 'What the business does' },
      { kind: 'extraction_slot', id: 's1', instruction: 'product, customers, revenue', outputType: 'prose' },
      { kind: 'heading', id: 'h2', level: 2, text: 'Open risks' },
      { kind: 'extraction_slot', id: 's2', instruction: 'list the blockers', outputType: 'list' },
    ]
    const spec = blocksToExtractionSpec(blocks, ['company'])
    expect(spec).not.toBeNull()
    expect(spec?.sections).toEqual([
      { heading: 'What the business does', instruction: 'product, customers, revenue', outputType: 'prose' },
      { heading: 'Open risks', instruction: 'list the blockers', outputType: 'list' },
    ])
    expect(spec?.capture).toEqual(['company'])
  })

  it('returns null when there are no extraction slots (a plain template skeleton)', () => {
    const blocks: Block[] = [
      { kind: 'heading', id: 'h1', level: 1, text: 'Notes' },
      { kind: 'text', id: 't1', text: 'just a page' },
    ]
    expect(blocksToExtractionSpec(blocks)).toBeNull()
  })

  it('defaults heading + outputType when an extraction slot has no heading above it', () => {
    const blocks: Block[] = [{ kind: 'extraction_slot', id: 's1', instruction: 'no heading above me' }]
    const spec = blocksToExtractionSpec(blocks)
    expect(spec?.sections[0]).toMatchObject({ heading: 'Section', outputType: 'prose' })
  })
})

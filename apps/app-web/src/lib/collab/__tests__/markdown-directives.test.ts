import { describe, it, expect } from 'vitest'
import {
  serializeEmbedDirective,
  parseEmbedDirective,
  type EmbedBlock,
} from '../markdown-directives.js'

const dataBlock = {
  kind: 'data',
  id: 'd1',
  binding: { entity: 'tasks', viewType: 'table' },
} as unknown as EmbedBlock

describe('[COMP:app-web/markdown] embed directive round-trip', () => {
  it('round-trips a :::data directive with its binding intact', () => {
    const line = serializeEmbedDirective(dataBlock)
    expect(line.startsWith(':::data ')).toBe(true)
    expect(parseEmbedDirective(line)).toEqual(dataBlock)
  })

  it('round-trips every embed kind', () => {
    const blocks = [
      dataBlock,
      { kind: 'chart', id: 'c1', chartType: 'bar', binding: { op: 'count' } },
      { kind: 'child_page', id: 'cp1', childPageId: 'page-xyz' },
      { kind: 'bookmark', id: 'b1', url: 'https://example.com' },
    ] as unknown as EmbedBlock[]
    for (const block of blocks) {
      expect(parseEmbedDirective(serializeEmbedDirective(block))).toEqual(block)
    }
  })

  it('maps child_page to the ::child-page directive name', () => {
    const line = serializeEmbedDirective({
      kind: 'child_page',
      id: 'cp1',
      childPageId: 'p',
    } as unknown as EmbedBlock)
    expect(line.startsWith(':::child-page ')).toBe(true)
  })

  it('returns null for a non-directive line', () => {
    expect(parseEmbedDirective('Just a paragraph.')).toBeNull()
    expect(parseEmbedDirective('# A heading')).toBeNull()
    expect(parseEmbedDirective(':::data not-json')).toBeNull()
  })

  it('returns null when the directive name mismatches the block kind', () => {
    expect(parseEmbedDirective(':::chart {"kind":"data","id":"x"}')).toBeNull()
  })
})

import { describe, it, expect } from 'vitest'
import type { Block } from '@sidanclaw/core/dist/views/blocks.js'
import {
  deriveRunStep,
  deriveRunBlockId,
  type DocOp,
} from '../index.js'

const textBlock = (id: string, text = 'x'): Block =>
  ({ id, kind: 'text', text }) as unknown as Block
const headingBlock = (id: string): Block =>
  ({ id, kind: 'heading', level: 2, text: 'H' }) as unknown as Block

describe('[COMP:doc-model/run-presence] Assistant-run step derivation', () => {
  it('returns undefined for an empty patch', () => {
    expect(deriveRunStep([])).toBeUndefined()
    expect(deriveRunStep(undefined as unknown as DocOp[])).toBeUndefined()
  })

  it('reports the last op kind + patch size', () => {
    const ops: DocOp[] = [
      { op: 'add', after: 'end', block: textBlock('a') },
      { op: 'add', after: 'end', block: headingBlock('b') },
    ]
    expect(deriveRunStep(ops)).toEqual({ op: 'add', blockType: 'heading', count: 2 })
  })

  it('carries the block kind for an add op', () => {
    const ops: DocOp[] = [{ op: 'add', after: 'start', block: textBlock('a') }]
    expect(deriveRunStep(ops)).toEqual({ op: 'add', blockType: 'text', count: 1 })
  })

  it('carries the patch kind for an edit op when present', () => {
    const ops: DocOp[] = [
      { op: 'edit', blockId: 'b1', patch: { kind: 'data' } as Partial<Block> },
    ]
    expect(deriveRunStep(ops)).toEqual({ op: 'edit', blockType: 'data', count: 1 })
  })

  it('omits blockType for ops that carry no block kind', () => {
    expect(deriveRunStep([{ op: 'delete', blockId: 'x' }])).toEqual({ op: 'delete', count: 1 })
    expect(deriveRunStep([{ op: 'setTitle', title: 'T' }])).toEqual({ op: 'setTitle', count: 1 })
    expect(deriveRunStep([{ op: 'move', blockId: 'x', after: 'end' }])).toEqual({
      op: 'move',
      count: 1,
    })
  })
})

describe('[COMP:doc-model/run-presence] Assistant-run block-id derivation', () => {
  it('returns the block id for id-referencing ops', () => {
    expect(deriveRunBlockId([{ op: 'edit', blockId: 'e1', patch: {} }])).toBe('e1')
    expect(deriveRunBlockId([{ op: 'delete', blockId: 'd1' }])).toBe('d1')
    expect(deriveRunBlockId([{ op: 'move', blockId: 'm1', after: 'end' }])).toBe('m1')
  })

  it('returns undefined when the latest op has no concrete block id', () => {
    // add ops get a server-assigned id (unknown here); title/icon target no block.
    expect(deriveRunBlockId([{ op: 'add', after: 'end', block: textBlock('a') }])).toBeUndefined()
    expect(deriveRunBlockId([{ op: 'setTitle', title: 'T' }])).toBeUndefined()
    expect(deriveRunBlockId([])).toBeUndefined()
  })

  it('keys off the last op', () => {
    const ops: DocOp[] = [
      { op: 'edit', blockId: 'first', patch: {} },
      { op: 'delete', blockId: 'last' },
    ]
    expect(deriveRunBlockId(ops)).toBe('last')
  })
})

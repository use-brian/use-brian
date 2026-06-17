import { describe, it, expect } from 'vitest'
import type { Block } from '@sidanclaw/core'
import { labelChildPageBlocks } from '../_public-render.js'
import type { ChildPageLabel } from '../../db/saved-views-store.js'

/** Loose view over the server-attached child_page label fields. */
type LabeledChild = {
  kind: string
  id: string
  childPageId: string
  title?: string
  icon?: string | null
  via?: 'subtree' | 'published'
}

const child = (id: string, childPageId: string): Block =>
  ({ kind: 'child_page', id, childPageId }) as Block

const text = (id: string): Block => ({ kind: 'text', id, text: 'hello' }) as Block

describe('[COMP:doc/public-share-route] Public share — child_page label application', () => {
  it('attaches title/icon/via to a child resolved as inside the share subtree', () => {
    const labels = new Map<string, ChildPageLabel>([
      ['c1', { name: 'M1: SEC Audit Fee Market Summary', icon: '📊', via: 'subtree' }],
    ])
    const [out] = labelChildPageBlocks([child('b1', 'c1')], labels) as unknown as LabeledChild[]
    expect(out).toMatchObject({
      kind: 'child_page',
      id: 'b1',
      childPageId: 'c1',
      title: 'M1: SEC Audit Fee Market Summary',
      icon: '📊',
      via: 'subtree',
    })
  })

  it('attaches via:published to an independently published "Link to page" target', () => {
    const labels = new Map<string, ChildPageLabel>([
      ['other', { name: 'Roadmap', icon: null, via: 'published' }],
    ])
    const [out] = labelChildPageBlocks([child('b1', 'other')], labels) as unknown as LabeledChild[]
    expect(out).toMatchObject({ childPageId: 'other', title: 'Roadmap', via: 'published' })
  })

  it('blanks an unresolved child (neither in subtree nor published): no id, no title', () => {
    const [out] = labelChildPageBlocks(
      [child('b1', 'private-child')],
      new Map(),
    ) as unknown as LabeledChild[]
    // The slot stays (index alignment with the A2UI payload) but leaks nothing.
    expect(out.kind).toBe('child_page')
    expect(out.id).toBe('b1')
    expect(out.childPageId).toBe('')
    expect(out.title).toBeUndefined()
    expect(out.via).toBeUndefined()
  })

  it('preserves block order + index alignment and passes non-child blocks through', () => {
    const labels = new Map<string, ChildPageLabel>([
      ['c1', { name: 'Kept', icon: null, via: 'subtree' }],
    ])
    const blocks = [text('t1'), child('b1', 'hidden'), child('b2', 'c1'), text('t2')]
    const out = labelChildPageBlocks(blocks, labels)
    expect(out).toHaveLength(4)
    expect(out[0]).toBe(blocks[0]) // untouched reference
    expect(out[3]).toBe(blocks[3])
    expect((out[1] as unknown as LabeledChild).childPageId).toBe('')
    expect((out[2] as unknown as LabeledChild).childPageId).toBe('c1')
  })

  it('blanks a child_page block whose childPageId is already empty', () => {
    const [out] = labelChildPageBlocks(
      [child('b1', '')],
      new Map<string, ChildPageLabel>([['', { name: 'nope', icon: null, via: 'subtree' }]]),
    ) as unknown as LabeledChild[]
    expect(out.childPageId).toBe('')
    expect(out.title).toBeUndefined()
  })
})

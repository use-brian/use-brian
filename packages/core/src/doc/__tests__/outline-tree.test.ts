/**
 * [COMP:doc/outline-tree] Hierarchical page projection (Phase 2) — section
 * partitioning + the large-page map render.
 *
 * Spec: docs/plans/doc-turn-context-optimization.md → Phase 2.
 */

import { describe, expect, it } from 'vitest'
import { buildOutlineTree, renderOutlineTree } from '../outline-tree.js'
import type { Block, VersionedPage } from '../page-types.js'

const heading = (id: string, text: string, level: 1 | 2 | 3 = 1): Block =>
  ({ kind: 'heading', id, level, text }) as Block
const text = (id: string, body: string): Block =>
  ({ kind: 'text', id, text: body }) as Block

function page(blocks: Block[]): VersionedPage {
  return { blocks, version: 2, title: 'Doc' }
}

describe('[COMP:doc/outline-tree] buildOutlineTree partitioning', () => {
  it('splits into a preamble + one section per heading', () => {
    const tree = buildOutlineTree(
      page([
        text('p0', 'intro'),
        heading('h1', 'Alpha', 1),
        text('a1', 'a one'),
        text('a2', 'a two'),
        heading('h2', 'Beta', 2),
        text('b1', 'b one'),
      ]),
      { pageId: 'p' },
    )
    expect(tree.sections).toHaveLength(3)
    // Preamble.
    expect(tree.sections[0].headingId).toBeNull()
    expect(tree.sections[0].level).toBe(0)
    expect(tree.sections[0].blocks.map((b) => b.id)).toEqual(['p0'])
    // Alpha.
    expect(tree.sections[1].headingId).toBe('h1')
    expect(tree.sections[1].level).toBe(1)
    expect(tree.sections[1].title).toBe('Alpha')
    expect(tree.sections[1].blocks.map((b) => b.id)).toEqual(['a1', 'a2'])
    // Beta.
    expect(tree.sections[2].headingId).toBe('h2')
    expect(tree.sections[2].level).toBe(2)
    expect(tree.sections[2].blocks.map((b) => b.id)).toEqual(['b1'])
    // Sizes are populated and positive.
    for (const s of tree.sections) expect(s.size).toBeGreaterThan(0)
  })

  it('has no preamble when the page opens with a heading', () => {
    const tree = buildOutlineTree(
      page([heading('h1', 'Top', 1), text('a1', 'body')]),
      { pageId: 'p' },
    )
    expect(tree.sections).toHaveLength(1)
    expect(tree.sections[0].headingId).toBe('h1')
  })

  it('a heading with no body blocks still forms a section', () => {
    const tree = buildOutlineTree(
      page([heading('h1', 'Empty', 1), heading('h2', 'Next', 1), text('x', 'y')]),
      { pageId: 'p' },
    )
    expect(tree.sections.map((s) => s.headingId)).toEqual(['h1', 'h2'])
    expect(tree.sections[0].blocks).toEqual([])
    expect(tree.sections[1].blocks.map((b) => b.id)).toEqual(['x'])
  })
})

describe('[COMP:doc/outline-tree] renderOutlineTree', () => {
  const tree = buildOutlineTree(
    page([
      text('p0', 'intro line'),
      heading('h1', 'Alpha', 1),
      text('a1', 'alpha body one'),
      text('a2', 'alpha body two'),
      heading('h2', 'Beta', 1),
      text('b1', 'beta body one'),
    ]),
    { pageId: 'p' },
  )

  it('renders selected sections in full and collapses the rest', () => {
    const out = renderOutlineTree(tree, new Set(['h2']))
    // Preamble always full.
    expect(out).toContain('p0')
    // Both headings appear (the always-on TOC).
    expect(out).toContain('h1')
    expect(out).toContain('h2')
    // Selected section h2: its body block is shown by id.
    expect(out).toContain('b1')
    // Unselected section h1: body blocks collapsed to a getSection pointer.
    expect(out).not.toContain('a1')
    expect(out).not.toContain('a2')
    expect(out).toContain('getSection("h1")')
    expect(out).toContain('2 blocks')
  })

  it('shows every body block when all sections are selected', () => {
    const out = renderOutlineTree(tree, new Set(['h1', 'h2']))
    for (const id of ['p0', 'a1', 'a2', 'b1']) expect(out).toContain(id)
    expect(out).not.toContain('getSection(')
  })
})

/**
 * [COMP:doc/page-retrieval] Section retrieval (Phase 3) — picks which
 * sections of a large page to inject in full for a given turn message.
 *
 * Spec: docs/plans/doc-turn-context-optimization.md → Phase 3.
 */

import { describe, expect, it } from 'vitest'
import { buildOutline } from '../outline.js'
import { buildOutlineTree, LARGE_PAGE_BLOCK_THRESHOLD } from '../outline-tree.js'
import { renderActivePageOutline, selectRelevantSections } from '../page-retrieval.js'
import type { Block, VersionedPage } from '../page-types.js'

const heading = (id: string, text: string): Block =>
  ({ kind: 'heading', id, level: 1, text }) as Block
const text = (id: string, body: string): Block =>
  ({ kind: 'text', id, text: body }) as Block

// A page with four clearly-distinct headed sections.
const tree = buildOutlineTree(
  {
    blocks: [
      heading('h-pricing', 'Pricing and credits'),
      text('p1', 'credit cap and overage rates per plan'),
      heading('h-roadmap', 'Roadmap'),
      text('r1', 'quarterly milestones and shipping plan'),
      heading('h-hiring', 'Hiring'),
      text('hi1', 'open roles and interview loop'),
      heading('h-legal', 'Legal'),
      text('l1', 'terms of service and privacy policy'),
    ],
    version: 1,
    title: 'Company doc',
  } as VersionedPage,
  { pageId: 'p' },
)

describe('[COMP:doc/page-retrieval] selectRelevantSections', () => {
  it('selects the section whose heading matches the query (heading weight)', () => {
    const sel = selectRelevantSections(tree, 'update the pricing credit overage', {
      minSections: 1,
    })
    expect(sel.has('h-pricing')).toBe(true)
  })

  it('matches on body text, not just the heading', () => {
    const sel = selectRelevantSections(tree, 'what are the interview loop stages', {
      minSections: 1,
    })
    expect(sel.has('h-hiring')).toBe(true)
  })

  it('always returns at least minSections even with an unrelated query', () => {
    const sel = selectRelevantSections(tree, 'zzz totally unrelated qqq', {
      minSections: 2,
    })
    expect(sel.size).toBe(2)
  })

  it('caps at maxSections', () => {
    const sel = selectRelevantSections(tree, 'pricing roadmap hiring legal', {
      minSections: 1,
      maxSections: 2,
    })
    expect(sel.size).toBeLessThanOrEqual(2)
  })

  it('respects the token budget past the minimum (a tiny budget yields exactly minSections)', () => {
    const sel = selectRelevantSections(tree, 'pricing roadmap hiring legal', {
      minSections: 1,
      tokenBudget: 0,
    })
    // With a zero budget, only the guaranteed minimum is included.
    expect(sel.size).toBe(1)
  })

  it('never selects the preamble (only headed sections are selectable)', () => {
    const withPreamble = buildOutlineTree(
      {
        blocks: [text('intro', 'preamble text'), heading('h1', 'Alpha'), text('a', 'body')],
        version: 1,
        title: 't',
      } as VersionedPage,
      { pageId: 'p' },
    )
    const sel = selectRelevantSections(withPreamble, 'alpha', { minSections: 5 })
    // Only h1 is selectable; the preamble (null heading) is rendered full by the
    // renderer, never via this set.
    expect([...sel]).toEqual(['h1'])
  })

  it('cuts the stream mid-way at the token budget (not just at the minSections floor)', () => {
    // All four headings score equally (one heading-word match each) → document
    // order. Budget = exactly the first two sections' size, minSections 1: the
    // 1st is taken free, the 2nd fits the budget, the 3rd would exceed it → 2.
    // This exercises the `used + size > budget` mid-stream cutoff, which the
    // zero-budget floor test does not reach.
    const sec = tree.sections.filter((s) => s.headingId !== null)
    const budget = sec[0].size + sec[1].size
    const selected = selectRelevantSections(tree, 'pricing roadmap hiring legal', {
      minSections: 1,
      tokenBudget: budget,
    })
    expect(selected.size).toBe(2)
    expect(selected.has('h-pricing')).toBe(true)
    expect(selected.has('h-roadmap')).toBe(true)
  })
})

describe('[COMP:doc/page-retrieval] renderActivePageOutline — flat vs folded gate', () => {
  const meta = { pageId: 'p' }
  const para = (n: number) => text(`b${n}`, `paragraph number ${n} body`)

  it('renders the flat outline for a small page (no folding, every block listed)', () => {
    const page = {
      blocks: [heading('h', 'Title'), para(1), para(2)],
      version: 1,
      title: 't',
    } as VersionedPage
    const out = renderActivePageOutline(page, buildOutline(page, meta), 'anything')
    expect(out).not.toContain('getSection(')
    for (const id of ['h', 'b1', 'b2']) expect(out).toContain(id)
  })

  it('folds a large, heading-structured page (collapses irrelevant sections to getSection pointers)', () => {
    // 4 headings × 11 blocks = 44 blocks (> threshold), 4 sections (> 2).
    const blocks: Block[] = []
    for (const [hid, htitle] of [
      ['h-alpha', 'Alpha'],
      ['h-beta', 'Beta'],
      ['h-gamma', 'Gamma'],
      ['h-delta', 'Delta'],
    ] as const) {
      blocks.push(heading(hid, htitle))
      for (let i = 0; i < 10; i++) blocks.push(text(`${hid}-${i}`, `${htitle} body line ${i}`))
    }
    expect(blocks.length).toBeGreaterThan(LARGE_PAGE_BLOCK_THRESHOLD)
    const page = { blocks, version: 1, title: 't' } as VersionedPage
    const out = renderActivePageOutline(page, buildOutline(page, meta), 'tell me about Alpha')
    // It folded: at least one section collapsed to a getSection pointer.
    expect(out).toContain('getSection(')
    // Every heading is still present (the always-on TOC).
    for (const hid of ['h-alpha', 'h-beta', 'h-gamma', 'h-delta']) expect(out).toContain(hid)
  })

  it('falls back to the flat outline for a large HEADING-LESS page (no structure to fold)', () => {
    // 45 text blocks, zero headings → one preamble section (sections.length === 1
    // <= 2) → must render flat, never fold.
    const blocks: Block[] = Array.from({ length: 45 }, (_, i) => para(i))
    const page = { blocks, version: 1, title: 't' } as VersionedPage
    const out = renderActivePageOutline(page, buildOutline(page, meta), 'anything')
    expect(out).not.toContain('getSection(')
    // Every block is addressable (flat render).
    for (let i = 0; i < 45; i++) expect(out).toContain(`b${i}`)
  })
})

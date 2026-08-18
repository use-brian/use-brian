import { describe, it, expect } from 'vitest'
import {
  formatPageTreeContext,
  PAGE_TREE_LIST_CAP,
  type PageTreeNeighborhood,
} from '../page-tree-context.js'

const ACTIVE = { id: 'page-child', title: 'New draft' }
const PARENT = { id: 'page-parent', title: 'Meeting notes 2026-08-17', icon: '📝', state: 'saved' }
const ROOT = { id: 'page-root', title: 'Clients', icon: null, state: 'saved' }

function hood(over: Partial<PageTreeNeighborhood> = {}): PageTreeNeighborhood {
  return { teamspace: { id: 'ts-1', name: 'General' }, ancestors: [], siblings: [], children: [], ...over }
}

describe('[COMP:doc/page-tree-context] formatPageTreeContext', () => {
  it('returns an empty string for a lone root page (byte-identical common case)', () => {
    expect(formatPageTreeContext(ACTIVE, hood())).toBe('')
    // No teamspace at all + nothing else still renders nothing.
    expect(formatPageTreeContext(ACTIVE, hood({ teamspace: null }))).toBe('')
  })

  it('renders the breadcrumb path root → parent → this page, and names the parent by id', () => {
    const out = formatPageTreeContext(ACTIVE, hood({ ancestors: [ROOT, PARENT] }))
    expect(out.startsWith('# Where this page sits (page tree)')).toBe(true)
    expect(out).toContain('Teamspace: "General"')
    expect(out).toContain(
      'Path: "Clients" (id=page-root) › 📝 "Meeting notes 2026-08-17" (id=page-parent) › "New draft" (this page)',
    )
    // The direct parent is called out on its own line - "the parent level" resolves in one read.
    expect(out).toContain('Parent page (one level up): 📝 "Meeting notes 2026-08-17" (id=page-parent)')
    expect(out).toContain('Sibling pages (same level, sidebar order): none')
    expect(out).toContain('Sub-pages under this page: none')
  })

  it('tells the model to READ the referenced page by id, never to ask the user to paste it', () => {
    const out = formatPageTreeContext(ACTIVE, hood({ ancestors: [PARENT] }))
    expect(out).toContain('the parent page')
    expect(out).toContain('the notes at the parent level')
    expect(out).toContain('`exportPage({ pageId })`')
    expect(out).toContain('`findPage({ pageId })`')
    expect(out).toContain('never ask the user to paste')
    // The neighbours are for reading; edits stay pinned to the open page.
    expect(out).toContain('Edits still land on THIS page')
    // Titles only - the block must not promise content it does not carry.
    expect(out).toContain('titles and ids only, never content')
  })

  it('lists siblings and sub-pages with ids, marks drafts, and says so for a top-level page', () => {
    const out = formatPageTreeContext(
      ACTIVE,
      hood({
        siblings: [
          { id: 'sib-1', title: 'Post-Trip Strategic Opportunities', icon: '🎯', state: 'saved' },
          { id: 'sib-2', title: '', state: 'draft' },
        ],
        children: [{ id: 'kid-1', title: 'Action items', state: 'saved' }],
      }),
    )
    expect(out).toContain('Parent page: none (this is a top-level page)')
    expect(out).toContain(
      'Sibling pages (same level, sidebar order): 🎯 "Post-Trip Strategic Opportunities" (id=sib-1), "Untitled" (id=sib-2, draft)',
    )
    expect(out).toContain('Sub-pages under this page: "Action items" (id=kid-1)')
  })

  it('caps long lists at PAGE_TREE_LIST_CAP and reports the exact remainder from the store total', () => {
    const many = Array.from({ length: PAGE_TREE_LIST_CAP + 3 }, (_, i) => ({
      id: `sib-${i}`,
      title: `Page ${i}`,
    }))
    // Store fetched only the cap but knows the true total.
    const out = formatPageTreeContext(
      ACTIVE,
      hood({ siblings: many.slice(0, PAGE_TREE_LIST_CAP), siblingTotal: 40 }),
    )
    expect(out).toContain(`"Page ${PAGE_TREE_LIST_CAP - 1}" (id=sib-${PAGE_TREE_LIST_CAP - 1})`)
    expect(out).not.toContain(`id=sib-${PAGE_TREE_LIST_CAP}`)
    expect(out).toContain(`…and ${40 - PAGE_TREE_LIST_CAP} more (findPage by title)`)
    // Over-long input with no total: the renderer still cuts and counts the rest itself.
    const out2 = formatPageTreeContext(ACTIVE, hood({ children: many }))
    expect(out2).toContain('…and 3 more (findPage by title)')
  })

  it('labels the Private section and truncates a runaway title', () => {
    const long = 'x'.repeat(200)
    const out = formatPageTreeContext(
      { id: 'p', title: long },
      hood({ teamspace: null, ancestors: [{ id: 'a', title: long }] }),
    )
    expect(out).toContain('Teamspace: Private')
    expect(out).not.toContain(long)
    expect(out).toContain('…" (id=a)')
    expect(out).toContain('…" (this page)')
  })
})

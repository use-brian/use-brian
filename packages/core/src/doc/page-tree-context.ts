/**
 * Page-tree visibility - "where this page sits".
 *
 * The `# Active doc page` block gives the model the OPEN page (title +
 * outline). It says nothing about the page's position in the nested page
 * tree, so a user who phrases a reference by POSITION - "the meeting notes
 * at the parent level", "the page above", "the sub-page", "the other page in
 * this folder" - hits a model that can only see one page and asks them to
 * paste content it could have read itself (2026-08-18: a user on a child
 * "New draft" asked for a proposal "according to the meeting notes in parent
 * level"; the assistant replied that it could only see the blank draft and
 * asked for the notes or the parent's title).
 *
 * This block is the fix: a compact, titles-only map of the page's
 * neighbourhood - ancestors (root → parent, the breadcrumb the user sees),
 * siblings under the same parent, and direct sub-pages - each with its
 * `pageId`, plus the instruction to resolve a positional reference from the
 * map and READ the page by id before answering. It carries titles and ids
 * only, never content: the neighbours are one `exportPage({ pageId })` /
 * `findPage({ pageId })` call away, and injecting their bodies on every doc
 * turn would multiply the live-outline cost the doc-context meter watches.
 *
 * Tool-awareness: the block names `exportPage`, a doc tool the chat route
 * injects on every doc-surface turn (`docCtx` ⇒ `docToolsTurn`), and
 * `findPage`, which is always-on - the same gate under which the block itself
 * is built, so it never names a tool the model cannot call.
 *
 * Pure - no I/O. The store half (`getPageTreeNeighborhood` in
 * `packages/api/src/db/saved-views-store.ts`) does the RLS-scoped read; this
 * module only renders. Returns `''` for a lone root page (no ancestors, no
 * siblings, no children) so the common single-page case is byte-identical
 * to before.
 *
 * Spec: docs/architecture/features/doc.md → "Page-tree visibility".
 *
 * [COMP:doc/page-tree-context]
 */

/** One neighbour in the tree map - title + id, plus the two display hints. */
export type PageTreeNeighbor = {
  id: string
  title: string
  icon?: string | null
  /** `'draft'` pages are marked so the model knows they may auto-prune. */
  state?: string | null
}

/** The neighbourhood of one page, as read by the store. */
export type PageTreeNeighborhood = {
  /** Teamspace the page lives in (`null` = the creator's Private section). */
  teamspace?: { id: string; name: string } | null
  /** Ancestor chain ordered ROOT → direct parent. Empty for a root page. */
  ancestors: PageTreeNeighbor[]
  /** Pages under the same parent, sidebar order, the active page excluded. */
  siblings: PageTreeNeighbor[]
  /** Full sibling count when the store capped the list (`>= siblings.length`). */
  siblingTotal?: number
  /** Direct sub-pages, sidebar order. */
  children: PageTreeNeighbor[]
  /** Full child count when the store capped the list (`>= children.length`). */
  childTotal?: number
}

/**
 * How many siblings / children the map lists before it truncates to a
 * "…and N more" line. The store fetches exactly this many (plus the total),
 * so the two halves cannot disagree about where the cut is. Twelve keeps a
 * teamspace root with dozens of pages to a bounded block (~200 tokens worst
 * case) while covering every ordinary parent.
 */
export const PAGE_TREE_LIST_CAP = 12

/** Cap on a rendered title so one pathological page cannot flood the map. */
const TITLE_CAP = 80

function label(n: PageTreeNeighbor): string {
  const raw = n.title.trim() || 'Untitled'
  const title = raw.length > TITLE_CAP ? `${raw.slice(0, TITLE_CAP - 1)}…` : raw
  const icon = n.icon?.trim() ? `${n.icon.trim()} ` : ''
  const draft = n.state === 'draft' ? ', draft' : ''
  return `${icon}${JSON.stringify(title)} (id=${n.id}${draft})`
}

function list(rows: PageTreeNeighbor[], total: number | undefined): string {
  if (rows.length === 0) return 'none'
  const shown = rows.slice(0, PAGE_TREE_LIST_CAP)
  const known = Math.max(total ?? rows.length, rows.length)
  const more = known - shown.length
  return shown.map(label).join(', ') + (more > 0 ? ` …and ${more} more (findPage by title)` : '')
}

/**
 * Render the `# Where this page sits` block for the active page, or `''` when
 * the page is a lone root (nothing to map). Pure; unit-tested.
 */
export function formatPageTreeContext(
  active: { id: string; title: string },
  hood: PageTreeNeighborhood,
): string {
  const { ancestors, siblings, children } = hood
  if (ancestors.length === 0 && siblings.length === 0 && children.length === 0) return ''

  const activeTitle = active.title.trim() || 'Untitled'
  const path = [
    ...ancestors.map(label),
    `${JSON.stringify(activeTitle.length > TITLE_CAP ? `${activeTitle.slice(0, TITLE_CAP - 1)}…` : activeTitle)} (this page)`,
  ].join(' › ')
  const parent = ancestors.length > 0 ? ancestors[ancestors.length - 1] : null

  const lines: string[] = ['# Where this page sits (page tree)']
  if (hood.teamspace) lines.push(`Teamspace: ${JSON.stringify(hood.teamspace.name)}`)
  else if (hood.teamspace === null) lines.push('Teamspace: Private (only its creator sees this section)')
  lines.push(`Path: ${path}`)
  lines.push(
    parent
      ? `Parent page (one level up): ${label(parent)}`
      : 'Parent page: none (this is a top-level page)',
  )
  lines.push(`Sibling pages (same level, sidebar order): ${list(siblings, hood.siblingTotal)}`)
  lines.push(`Sub-pages under this page: ${list(children, hood.childTotal)}`)
  lines.push(
    '',
    'The user may point at one of these by POSITION rather than by name - "the parent page", ' +
      '"the notes at the parent level", "the page above", "the sibling page", "the sub-page". ' +
      'Resolve the reference from this map, then READ that page by id before answering about it ' +
      'or drawing on it: `exportPage({ pageId })` returns it as Markdown (`findPage({ pageId })` ' +
      'does the same). This map carries titles and ids only, never content - do not answer from ' +
      'a title alone, and never ask the user to paste or name a page you can read from here. ' +
      'Edits still land on THIS page (the open one); the neighbours are for reading and reference.',
  )
  return lines.join('\n')
}

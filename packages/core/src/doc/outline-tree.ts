/**
 * Doc v1 — hierarchical page-outline projection (Phase 2 of the doc
 * turn-context optimization).
 *
 * `buildOutlineTree(page)` partitions a page's flat block list into **sections**
 * — each a heading plus the run of blocks under it (up to the next heading) —
 * with a token-size estimate per section. A leading "preamble" section (the
 * blocks before the first heading) has no heading. This turns a 150-block page
 * into a table of contents the model can reason over, and is the structure the
 * large-page map + section retrieval (Phase 3) operate on.
 *
 * `renderOutlineTree(tree, selected)` renders the map injected into the system
 * prompt for a large page: every heading (the always-on TOC) plus the FULL
 * per-block detail for the **selected** sections (and the preamble), while
 * unselected sections collapse to a one-line `getSection(...)` pointer. The
 * model addresses blocks by id exactly as with the flat outline; a collapsed
 * section is expanded on demand via `getSection`.
 *
 * Pure — no DB, no I/O. The flat `buildOutline` / tool-result `Outline` shape is
 * untouched; this is an additive projection used only by the chat route's
 * Layer-13 injection and the retrieval ranker.
 *
 * Spec: `docs/plans/doc-turn-context-optimization.md` → Phase 2.
 *
 * [COMP:doc/outline-tree]
 */

import { estimateStringTokens } from '../compaction/compact.js'
import { buildOutline, renderOutlineEntryLine } from './outline.js'
import type {
  Block,
  BlockId,
  OutlineEntry,
  Page,
  VersionedPage,
} from './page-types.js'

/**
 * A page injected with more than this many blocks is "large" — the chat route
 * switches from the flat outline to the hierarchical map + section retrieval.
 * Below it, the flat outline is byte-identical to before (the common case is
 * unchanged, bounding risk).
 */
export const LARGE_PAGE_BLOCK_THRESHOLD = 40

/** One section of a page: a heading and the blocks under it (or the preamble). */
export type OutlineSection = {
  /** The heading block's id; `null` for the preamble (pre-first-heading run). */
  headingId: BlockId | null
  /** Heading level 1-4; `0` for the preamble. */
  level: 0 | 1 | 2 | 3 | 4
  /** Raw heading text (for relevance ranking); `''` for the preamble. */
  title: string
  /** The heading block's outline entry (`null` for the preamble). */
  headingEntry: OutlineEntry | null
  /** Outline entries for the body blocks under this heading (excludes the heading). */
  blocks: OutlineEntry[]
  /** Estimated tokens of this section's content (heading + body), for budgeting. */
  size: number
}

export type OutlineTree = {
  pageId: string
  pageVersion: number
  title: string
  sections: OutlineSection[]
}

/** Estimated token footprint of a block (uniform JSON proxy — correlates with
 *  what `getSection` would return for it). */
function blockSize(block: Block): number {
  return estimateStringTokens(JSON.stringify(block))
}

/**
 * Project a page into sections. Each heading opens a new section; non-heading
 * blocks attach to the open section (or the preamble before the first heading).
 * Headings nest visually by `level`, but partitioning is flat (one section per
 * heading) — the subtree grouping ("until next same-or-higher heading") is a
 * read-time concern handled by `getSection`.
 */
export function buildOutlineTree(
  page: VersionedPage | Page,
  meta?: { pageId?: string; pageVersion?: number; title?: string },
): OutlineTree {
  const outline = buildOutline(page, meta)
  const entries = outline.blocks
  const blocks = page.blocks

  const sections: OutlineSection[] = []
  // The preamble is created lazily — a page that opens with a heading has none.
  let current: OutlineSection = {
    headingId: null,
    level: 0,
    title: '',
    headingEntry: null,
    blocks: [],
    size: 0,
  }
  let preambleHasContent = false

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i]
    const entry = entries[i]
    if (block.kind === 'heading') {
      // Close the current section if it carried anything.
      if (current.headingEntry || preambleHasContent) sections.push(current)
      current = {
        headingId: block.id,
        level: block.level,
        title: block.text ?? '',
        headingEntry: entry,
        blocks: [],
        size: blockSize(block),
      }
    } else {
      current.blocks.push(entry)
      current.size += blockSize(block)
      if (current.headingEntry === null) preambleHasContent = true
    }
  }
  if (current.headingEntry || preambleHasContent) sections.push(current)

  return {
    pageId: outline.pageId,
    pageVersion: outline.pageVersion,
    title: outline.title,
    sections,
  }
}

/**
 * Render the large-page map. `selected` is the set of heading ids whose body
 * blocks are shown in full (from the retrieval ranker); the preamble is always
 * full; every other section collapses to a one-line `getSection` pointer.
 * Returns the block-listing body (the caller wraps it with the page header +
 * authoring instruction, exactly like the flat path).
 */
export function renderOutlineTree(
  tree: OutlineTree,
  selected: ReadonlySet<string>,
): string {
  const out: string[] = []
  for (const s of tree.sections) {
    if (s.headingEntry) out.push(renderOutlineEntryLine(s.headingEntry))
    const showFull = s.headingId === null || selected.has(s.headingId)
    if (showFull) {
      for (const b of s.blocks) out.push(renderOutlineEntryLine(b, '    '))
    } else if (s.blocks.length > 0) {
      const n = s.blocks.length
      // Count is this heading's DIRECT body; getSection returns the whole
      // subtree (incl. any nested subsections), so the count is a floor — phrase
      // it as such and don't advertise a token size getSection won't match.
      out.push(
        `    (${n} block${n === 1 ? '' : 's'} under this heading — call ` +
          `getSection("${s.headingId}") to read the full section, incl. any subsections, before editing)`,
      )
    }
  }
  return out.join('\n')
}

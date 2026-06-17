/**
 * Doc v1 — section retrieval (Phase 3 of the doc turn-context
 * optimization): "figure out which part of the page is needed."
 *
 * Given a page's section tree (`buildOutlineTree`) and the turn's user message,
 * `selectRelevantSections` ranks sections by lexical relevance to the message
 * and returns the heading ids whose body blocks should be injected in FULL.
 * Everything else collapses to a `getSection(...)` pointer in the map, so a
 * large page injects only the sections this turn is actually about — the
 * "episode map" idea, with page sections as the retrievable episodes.
 *
 * Lexical only (no LLM, no embedding call in the hot path): token overlap on
 * heading text (weighted) + block previews. It mirrors the budget/fallback
 * shape of `memory/episodic-context.ts` — a token budget, a minimum number of
 * sections always included (so the model never gets only headings), and a cap.
 * Quality is "good enough to pick the right neighbourhood"; the model expands
 * anything the ranker missed via `getSection`, so a miss costs one round-trip,
 * never a wrong edit.
 *
 * Pure — no DB, no clock, no I/O. Unit-tested.
 *
 * Spec: `docs/plans/doc-turn-context-optimization.md` → Phase 3.
 *
 * [COMP:doc/page-retrieval]
 */

import { renderOutlineEntryLine } from './outline.js'
import {
  buildOutlineTree,
  renderOutlineTree,
  LARGE_PAGE_BLOCK_THRESHOLD,
  type OutlineTree,
} from './outline-tree.js'
import type { Outline, Page, VersionedPage } from './page-types.js'

/** Total estimated tokens of section *body* detail to inject in full. Headings
 *  (the always-on TOC) are cheap and never counted against this. */
export const SECTION_DETAIL_TOKEN_BUDGET = 3_000
/** Always inject at least this many sections in full, even at zero relevance,
 *  so the model gets real content to work from, not just a heading list. */
export const MIN_SELECTED_SECTIONS = 2
/** Never inject more than this many sections in full (caps a low-signal query
 *  from expanding the whole page). */
export const MAX_SELECTED_SECTIONS = 12
/** Extra weight for a query word that matches the section's heading vs its body. */
const HEADING_MATCH_WEIGHT = 3

const STOPWORDS = new Set([
  'the', 'and', 'for', 'you', 'are', 'but', 'not', 'with', 'this', 'that',
  'have', 'has', 'was', 'were', 'can', 'will', 'your', 'about', 'into', 'from',
  'add', 'make', 'change', 'update', 'edit', 'page', 'section', 'please', 'help',
])

/** Lowercase alphanumeric tokens of length ≥ 3, minus stopwords. */
function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter(
    (w) => w.length >= 3 && !STOPWORDS.has(w),
  )
}

export type SelectRelevantSectionsOptions = {
  tokenBudget?: number
  minSections?: number
  maxSections?: number
}

/**
 * Choose which sections to inject in full. Returns the set of heading ids; the
 * caller renders those in full and collapses the rest. The preamble (heading id
 * `null`) is always rendered full by the renderer, so it is never in this set.
 */
export function selectRelevantSections(
  tree: OutlineTree,
  queryText: string,
  opts: SelectRelevantSectionsOptions = {},
): Set<string> {
  const budget = opts.tokenBudget ?? SECTION_DETAIL_TOKEN_BUDGET
  const minSections = opts.minSections ?? MIN_SELECTED_SECTIONS
  const maxSections = opts.maxSections ?? MAX_SELECTED_SECTIONS

  // Only headed sections are selectable (the preamble is always full).
  const candidates = tree.sections
    .map((s, index) => ({ s, index }))
    .filter((c) => c.s.headingId !== null)

  const queryWords = new Set(tokenize(queryText))

  const scored = candidates.map((c) => {
    let score = 0
    if (queryWords.size > 0) {
      const headingWords = new Set(tokenize(c.s.title))
      for (const w of headingWords) if (queryWords.has(w)) score += HEADING_MATCH_WEIGHT
      const bodyWords = new Set(c.s.blocks.flatMap((b) => tokenize(b.preview)))
      for (const w of bodyWords) if (queryWords.has(w)) score += 1
    }
    return { ...c, score }
  })

  // Highest score first; ties keep document order (stable, earliest wins).
  scored.sort((a, b) => b.score - a.score || a.index - b.index)

  const selected = new Set<string>()
  let used = 0
  for (const c of scored) {
    if (selected.size >= maxSections) break
    const headingId = c.s.headingId as string
    // Always take the first `minSections` (even at score 0) so the model gets
    // content; past that, stop on a zero-relevance section or a blown budget.
    if (selected.size >= minSections) {
      if (c.score === 0) break
      if (used + c.s.size > budget) break
    }
    selected.add(headingId)
    used += c.s.size
  }
  return selected
}

/**
 * The chat route's Layer-13 decision, as a pure function: produce the block
 * listing injected under `# Active doc page`. Small or heading-less pages get
 * the flat outline (byte-identical to the pre-Phase-2 inline render); a large,
 * heading-structured page gets the folded map — every heading + full detail for
 * the sections relevant to `queryText`, the rest collapsed to a `getSection`
 * pointer. `outline` is the already-built flat outline (the caller needs it for
 * the page header anyway), reused here to avoid a second `buildOutline`.
 *
 * Extracting the gate here keeps the compound flat-vs-folded condition (and the
 * heading-less fallback) unit-testable instead of buried in the route.
 */
export function renderActivePageOutline(
  page: VersionedPage | Page,
  outline: Outline,
  queryText: string,
): string {
  if (page.blocks.length > LARGE_PAGE_BLOCK_THRESHOLD) {
    const tree = buildOutlineTree(page, {
      pageId: outline.pageId,
      pageVersion: outline.pageVersion,
      title: outline.title,
    })
    // Need real heading structure to fold (a preamble + one section is just a
    // flat page with a title); otherwise fall through to the flat outline.
    if (tree.sections.length > 2) {
      return renderOutlineTree(tree, selectRelevantSections(tree, queryText))
    }
  }
  return outline.blocks.map((b) => renderOutlineEntryLine(b)).join('\n')
}

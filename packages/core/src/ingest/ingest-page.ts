/**
 * Doc-page → brain distillation — `distillPageToBrain`.
 *
 * Distils an authored doc page into brain facts (entities / edges / memories
 * via Pipeline B, one Episode per section) plus a retrievable page-as-source
 * (the `kb_chunks` shape). This is the canvas-brain-distillation.md pipeline
 * ("canvas" there == today's "doc" surface), with the one user-requested
 * deviation handled in the API/doc-sync layers: the trigger is ALSO automatic
 * on save when a per-page "Sync to brain" toggle is enabled. This module is the
 * trigger-agnostic core — the manual `ingestPage` tool, the manual route, and
 * the auto-on-save path all funnel into it.
 *
 * # What it does (canvas-brain-distillation.md §"The ingestion pipeline")
 *
 *   1. Filter to the AUTHORED layer (Decision 2). Keep text / heading /
 *      callout / quote / list / table — the prose a human wrote. Drop
 *      `data` / `chart` (brain-derived → circular noise) + media/embeds +
 *      trivially short blocks. The skip-set is DERIVED from the block-kind
 *      registry below (`BLOCK_KIND_REGISTRY`), NOT a hardcoded `Set` of kinds —
 *      the root CLAUDE.md "all built-ins" anti-pattern. A new block kind
 *      classified `derived`/`media` is skipped automatically.
 *   2. Group blocks into heading-delimited SECTIONS (Decision: never extract one
 *      line without its section). Reuses the same partitioning as
 *      `buildOutlineTree` (one section per heading; a leading preamble for the
 *      pre-first-heading run).
 *   3. Per section: build a `doc_page` Episode and run Pipeline B (the
 *      `RunSectionEpisode` port). `source_ref = { page_id, section_block_id,
 *      version }` so every derived fact gets a clean `(page_id, block_id)`
 *      back-edge via `source_episode_id`. Pipeline B is reused UNMODIFIED.
 *   4. Chunk + embed the authored page (the `UpsertPageSource` port, keyed by
 *      page + block) into the `kb_chunks` shape so `search` returns the page and
 *      can target a block.
 *
 * # Purity / ports (mirrors other core ingest code)
 *
 * No DB, no HTTP, no embedding call inline. The two side-effecting steps are
 * injected as ports:
 *   - `runSectionEpisode` — the "processEpisode runner": takes a section's
 *     content + back-edge and runs Pipeline B end-to-end (create Episode →
 *     extract → write facts). The API layer wires this over the real Pipeline B
 *     deps; tests pass a fake that records calls.
 *   - `upsertPageSource` — the page-as-source writer: upserts one `kb_chunks`
 *     row per authored block. The API layer wires this over `retrieval-store`;
 *     the embedding itself is computed later by the async embedding worker
 *     (`embedding-store.ts` drains `embedding IS NULL` rows), so this port does
 *     a plain content upsert — no embed call here.
 *
 * # Content-hash dedup
 *
 * `distillPageToBrain` computes a stable hash over the AUTHORED content
 * (`hashAuthoredContent`) and returns it. Callers persist it as
 * `saved_views.brain_last_ingest_hash`; the auto-on-save trigger compares the
 * current authored hash against it (plus a cooldown) before firing, so a
 * debounced save that didn't touch prose never re-ingests. Callers may also
 * pass `skipIfHashUnchanged` to make the function itself a no-op when the page's
 * authored content matches a previously-ingested hash.
 *
 * Spec: docs/plans/canvas-brain-distillation.md (architecture LOCKED).
 *
 * [COMP:ingest/doc-page-distillation]
 */

import { createHash } from 'node:crypto'

import { richTextToPlain } from '../doc/rich-text.js'
import type { Block, Page } from '../views/blocks.js'

// ── Authored-layer block-kind registry (the skip-set source of truth) ─────

/**
 * How a block kind relates to the AUTHORED layer (Decision 2). Derived from
 * one place so the skip-set is never a hardcoded `Set` that drifts when a new
 * block kind lands:
 *
 *   - `authored` — a human wrote prose / structure here. Distil it.
 *   - `derived`  — the block is a live view OVER the brain (`data`, `chart`).
 *     Re-ingesting it is circular noise — skip.
 *   - `media`    — an embed / attachment / pointer with no authored prose
 *     (`image`, `file`, `bookmark`, `video`, `audio`, `divider`, `child_page`,
 *     `diagram` Mermaid source). Nothing for extraction to chew on — skip.
 *
 * A NEW block kind added to the `Block` union becomes a TypeScript error here
 * (the `Record<Block['kind'], …>` is exhaustive), forcing a deliberate
 * classification rather than silently defaulting into the authored layer.
 */
export type BlockLayer = 'authored' | 'derived' | 'media'

export const BLOCK_KIND_REGISTRY: Record<Block['kind'], BlockLayer> = {
  // Authored prose / structure — the genuinely new information.
  text: 'authored',
  heading: 'authored',
  callout: 'authored',
  quote: 'authored',
  bulleted_list_item: 'authored',
  numbered_list_item: 'authored',
  to_do: 'authored',
  toggle: 'authored',
  code: 'authored',
  table: 'authored',
  // Brain-derived live views — re-ingesting them is circular (Decision 2).
  data: 'derived',
  chart: 'derived',
  // Media / embeds / pointers — no authored prose to extract.
  divider: 'media',
  diagram: 'media',
  image: 'media',
  file: 'media',
  bookmark: 'media',
  video: 'media',
  audio: 'media',
  child_page: 'media',
  // Authoring directive (a blueprint section's extraction instruction), not
  // prose — distillation skips it; it only ever lives in a blueprint template.
  extraction_slot: 'media',
}

/** The authored layer = every kind the registry marks `authored`. Derived once
 *  from the registry — adding a new authored kind there flows through here. */
export const AUTHORED_BLOCK_KINDS: ReadonlySet<Block['kind']> = new Set(
  (Object.keys(BLOCK_KIND_REGISTRY) as Block['kind'][]).filter(
    (k) => BLOCK_KIND_REGISTRY[k] === 'authored',
  ),
)

/**
 * Minimum authored-text length (chars, trimmed) for a block to survive the
 * filter. "Trivially short" blocks (an empty paragraph, a one-word heading the
 * model is mid-typing) carry no extractable fact and only add noise — the plan
 * skips them alongside the derived kinds. Deliberately small: a real sentence
 * clears it; a stray word does not.
 */
export const MIN_AUTHORED_BLOCK_CHARS = 12

// ── Authored-text extraction ──────────────────────────────────────────────

/**
 * The authored plain text of a single block, or `''` for a block that carries
 * no authored prose (a derived/media kind, or an empty authored block). Marks
 * are dropped — extraction wants the words, not the formatting.
 *
 * Container kinds (`callout` / `toggle`) contribute their own lead line here;
 * their `children` are flattened into the block list by `flattenBlocks` before
 * the filter runs, so each child is distilled in its own right (and keeps its
 * own block id for the back-edge).
 */
export function authoredTextOf(block: Block): string {
  switch (block.kind) {
    case 'text':
      return block.text.trim()
    case 'heading':
      return block.text.trim()
    case 'code':
      // Code carries authored content; keep it verbatim (no rich-text walk).
      return block.code.trim()
    case 'callout':
    case 'quote':
    case 'bulleted_list_item':
    case 'numbered_list_item':
    case 'to_do':
    case 'toggle':
      return richTextToPlain(block.richText).trim()
    case 'table':
      // Flatten the row-major grid of rich-text cells into a readable block.
      return block.rows
        .map((row) => row.map((cell) => richTextToPlain(cell).trim()).filter(Boolean).join(' | '))
        .filter(Boolean)
        .join('\n')
        .trim()
    default:
      // Derived + media kinds carry no authored prose.
      return ''
  }
}

/**
 * Flatten a page's block tree into a flat list, inlining `callout` / `toggle`
 * children (the only container kinds). Each child keeps its own id so its
 * back-edge stays precise. The container's lead line stays in the list too, so
 * "Note: …" prose isn't lost. Order is document order (depth-first).
 */
export function flattenBlocks(blocks: Block[]): Block[] {
  const out: Block[] = []
  for (const block of blocks) {
    out.push(block)
    if ((block.kind === 'callout' || block.kind === 'toggle') && block.children?.length) {
      out.push(...flattenBlocks(block.children))
    }
  }
  return out
}

/**
 * Keep only the authored, non-trivial blocks (the source gate). A block
 * survives iff (a) its kind is in the authored layer (registry-derived) AND
 * (b) its authored text clears `MIN_AUTHORED_BLOCK_CHARS` — EXCEPT headings,
 * which survive on kind alone (a short heading is the section anchor for the
 * blocks under it, even if it's brief).
 */
export function filterAuthoredBlocks(blocks: Block[]): Block[] {
  return flattenBlocks(blocks).filter((block) => {
    if (!AUTHORED_BLOCK_KINDS.has(block.kind)) return false
    if (block.kind === 'heading') return authoredTextOf(block).length > 0
    return authoredTextOf(block).length >= MIN_AUTHORED_BLOCK_CHARS
  })
}

// ── Sectioning ────────────────────────────────────────────────────────────

/** One distillation section: a heading (or the preamble) + its authored body. */
export type DistillSection = {
  /** The heading block's id; `null` for the preamble (pre-first-heading run). */
  sectionBlockId: string | null
  /** The heading's text; `''` for the preamble. */
  title: string
  /** Authored blocks under this heading (the heading itself excluded). */
  blocks: Block[]
}

/**
 * Partition the AUTHORED block list into heading-delimited sections — the same
 * shape `buildOutlineTree` produces, but over already-filtered authored blocks
 * and carrying the full blocks (not outline entries) so each section's prose is
 * available for extraction. A heading opens a new section; non-heading blocks
 * attach to the open section (or the preamble before the first heading). A
 * section with no body blocks (a lone heading) is dropped — there is nothing to
 * extract.
 */
export function sectionAuthoredBlocks(authored: Block[]): DistillSection[] {
  const sections: DistillSection[] = []
  let current: DistillSection = { sectionBlockId: null, title: '', blocks: [] }

  const flush = () => {
    if (current.blocks.length > 0) sections.push(current)
  }

  for (const block of authored) {
    if (block.kind === 'heading') {
      flush()
      current = { sectionBlockId: block.id, title: block.text.trim(), blocks: [] }
    } else {
      current.blocks.push(block)
    }
  }
  flush()
  return sections
}

/**
 * Render a section's authored blocks into the text Pipeline B extracts from.
 * The section title leads (so a fact is never extracted "without its section"),
 * then each body block on its own line. Pure string assembly.
 */
export function renderSectionContent(section: DistillSection): string {
  const lines: string[] = []
  if (section.title) lines.push(`# ${section.title}`)
  for (const block of section.blocks) {
    const text = authoredTextOf(block)
    if (text) lines.push(text)
  }
  return lines.join('\n\n').trim()
}

// ── Content hashing (dedup) ───────────────────────────────────────────────

/**
 * A stable hash over a page's AUTHORED content — `(kind, id, authored-text)` for
 * every surviving block, in document order. Two pages with identical authored
 * prose (even if their derived/media blocks differ) hash the same, so a
 * re-ingest that only changed a `data` block is a no-op. Whitespace inside a
 * block is preserved (a real edit), but block ordering is captured by the
 * positional concatenation.
 */
export function hashAuthoredContent(blocks: Block[]): string {
  const authored = filterAuthoredBlocks(blocks)
  const h = createHash('sha256')
  for (const block of authored) {
    h.update(block.kind)
    h.update(' ')
    h.update(block.id)
    h.update(' ')
    h.update(authoredTextOf(block))
    h.update('')
  }
  return h.digest('hex')
}

// ── Ports ─────────────────────────────────────────────────────────────────

/** The `(page_id, block_id)` back-edge carried on each section Episode. */
export type SectionBackEdge = {
  pageId: string
  /** The section heading block id, or `null` for the preamble. */
  sectionBlockId: string | null
  version: number
}

/** Input to the per-section Pipeline B runner. */
export type RunSectionEpisodeInput = {
  /** Text the extraction LLM reads (`renderSectionContent`). */
  content: string
  backEdge: SectionBackEdge
}

/**
 * The "processEpisode runner" port (canvas-brain-distillation.md step 3). Builds
 * a `doc_page` Episode with `source_ref = { page_id, section_block_id, version }`
 * and runs Pipeline B end-to-end. The API wiring constructs the real Pipeline B
 * deps; tests pass a fake. Returns the created Episode id (for the page-source
 * `source_episode_id` link) or `null` if Pipeline B short-circuited.
 */
export type RunSectionEpisode = (
  input: RunSectionEpisodeInput,
) => Promise<{ episodeId: string | null }>

/** One authored block to register as a retrievable page-source chunk. */
export type PageSourceChunk = {
  pageId: string
  blockId: string
  /** Best-effort link to the section Episode this block fell under (provenance). */
  sectionEpisodeId: string | null
  /** The block's authored text — the chunk body that gets embedded later. */
  text: string
  /** sha256 of `text` — dedup / change-detection key for the upsert. */
  contentHash: string
}

/**
 * The page-as-source writer port (step 4). Upserts the page's authored blocks
 * into the `kb_chunks` shape (keyed by page + block, `source='doc_page'`). The
 * embedding is NOT computed here — the async embedding worker drains
 * `embedding IS NULL` rows. A single call carries every chunk so the store can
 * upsert + prune removed blocks in one transaction.
 */
export type UpsertPageSource = (args: {
  pageId: string
  chunks: PageSourceChunk[]
}) => Promise<void>

export type DistillPageDeps = {
  runSectionEpisode: RunSectionEpisode
  upsertPageSource: UpsertPageSource
}

export type DistillPageInput = {
  pageId: string
  version: number
  /** The page's authored block tree (from `getVersionedPage`). */
  page: Page
  /**
   * When set and it matches the page's current authored hash, distillation is
   * skipped (the optimisation the plan calls a "content-hash skip"). The
   * caller persists the returned `contentHash`; on the next save it passes the
   * stored value here so an unchanged page short-circuits.
   */
  skipIfHashUnchanged?: string | null
}

export type DistillPageResult = {
  /** The page's authored-content hash — persist as `brain_last_ingest_hash`. */
  contentHash: string
  /** Whether distillation ran (false when skipped on an unchanged hash). */
  ingested: boolean
  /** Sections distilled (one Episode each). */
  sectionsProcessed: number
  /** Episode ids created (Pipeline B may return `null` on short-circuit). */
  episodeIds: (string | null)[]
  /** Authored block chunks registered as the page-as-source. */
  chunksUpserted: number
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

// ── Entry point ───────────────────────────────────────────────────────────

/**
 * Distil an authored doc page into the brain. See the file header for the
 * four-step pipeline. Trigger-agnostic: the manual tool, the manual route, and
 * the auto-on-save path all call this. Pure orchestration over the two injected
 * ports — no DB / HTTP / embedding inline.
 */
export async function distillPageToBrain(
  input: DistillPageInput,
  deps: DistillPageDeps,
): Promise<DistillPageResult> {
  const contentHash = hashAuthoredContent(input.page.blocks)

  // Content-hash skip (optional optimisation). An unchanged authored layer
  // re-ingests nothing — the dedup half of the auto-on-save storm guard, also
  // available to the manual paths.
  if (input.skipIfHashUnchanged && input.skipIfHashUnchanged === contentHash) {
    return {
      contentHash,
      ingested: false,
      sectionsProcessed: 0,
      episodeIds: [],
      chunksUpserted: 0,
    }
  }

  // 1 + 2. Filter to the authored layer, then group into sections.
  const authored = filterAuthoredBlocks(input.page.blocks)
  const sections = sectionAuthoredBlocks(authored)

  // 3. One Episode per section through Pipeline B. Each section's body blocks
  // share the section's Episode id, which becomes their page-source
  // `source_episode_id` (so a chunk points back at the fact-bearing Episode).
  const episodeIds: (string | null)[] = []
  const blockToEpisode = new Map<string, string | null>()
  for (const section of sections) {
    const content = renderSectionContent(section)
    if (!content) {
      episodeIds.push(null)
      continue
    }
    const { episodeId } = await deps.runSectionEpisode({
      content,
      backEdge: {
        pageId: input.pageId,
        sectionBlockId: section.sectionBlockId,
        version: input.version,
      },
    })
    episodeIds.push(episodeId)
    for (const block of section.blocks) blockToEpisode.set(block.id, episodeId)
  }

  // 4. Chunk + embed the authored page (page-as-source). One chunk per surviving
  // authored block, keyed by page + block. The section heading's own Episode id
  // is the block's provenance link.
  const chunks: PageSourceChunk[] = []
  for (const block of authored) {
    const text = authoredTextOf(block)
    if (!text) continue
    chunks.push({
      pageId: input.pageId,
      blockId: block.id,
      sectionEpisodeId: blockToEpisode.get(block.id) ?? null,
      text,
      contentHash: sha256(text),
    })
  }
  await deps.upsertPageSource({ pageId: input.pageId, chunks })

  return {
    contentHash,
    ingested: true,
    sectionsProcessed: sections.length,
    episodeIds,
    chunksUpserted: chunks.length,
  }
}

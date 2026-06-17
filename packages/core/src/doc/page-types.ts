/**
 * Doc v1 — page type surface.
 *
 * Re-exports the existing Notion-redesign `Page` / `Block` discriminated
 * union from `../views/blocks.js` and adds the Phase-0 wire-format types
 * that v1 introduces:
 *
 *   - `BlockId` / `TmpId`   — id discipline (real ids vs within-patch temps)
 *   - `Op` / `Ops`          — the patch vocabulary `patchPage` consumes
 *   - `Outline` / `OutlineEntry` — the compact projection injected into the
 *                              chat envelope so the model addresses blocks
 *                              by id without us streaming the whole page
 *   - `VersionedPage`        — `Page` + the per-patch version counter (Lock #8)
 *
 * The `Op` shape comes from `docs/plans/doc-v1-execution.md` §4.1.
 * The wider plan lives in `docs/plans/doc-v1-execution.md` §3 and the
 * 18 architectural locks in §1.
 *
 * Phase 0 is parallel to `../views/*` — `doc/` imports from `views/`,
 * never the reverse. Phase 5 collapses the rename. See
 * `docs/plans/snuggly-noodling-tiger.md` "decision A".
 *
 * [COMP:doc/page-types]
 */

export {
  type Page,
  type Block,
  type TextBlock,
  type HeadingBlock,
  type DividerBlock,
  type DataBlock,
  type ChartBlock,
  type ChartData,
  type DiagramBlock,
  type CalloutBlock,
  type CodeBlock,
  type QuoteBlock,
  type BulletedListItemBlock,
  type NumberedListItemBlock,
  type TodoBlock,
  type ToggleBlock,
  type TableBlock,
  type ImageBlock,
  type FileBlock,
  type BookmarkBlock,
  type VideoBlock,
  type AudioBlock,
  type MediaRef,
  type ChildPageBlock,
  type RichTextContent,
  emptyPage,
  dataPage,
} from '../views/blocks.js'

export { type BindingConfig } from '../views/types.js'

import type { Block, Page } from '../views/blocks.js'

// ── ID discipline ─────────────────────────────────────────────────────

/**
 * The stable handle for a block on the server. Issued by `randomUUID()`
 * at insert time; clients see it via `getCurrentPage` / `getBlock`
 * responses and the `patchPage` echo. Used by the drag-drop reorder
 * loop and the PATCH route.
 */
export type BlockId = string

/**
 * A within-patch temp id used to reference a block the same patch just
 * created. The server resolves `tmp-*` → real `BlockId` and echoes the
 * mapping back in the `patchPage` response, so a multi-op patch like
 * `[{ op: 'add', block: { id: 'tmp-1', ... } }, { op: 'move', blockId: 'tmp-1', after: 'b3' }]`
 * is legal.
 */
export type TmpId = `tmp-${string}`

// ── Op union ──────────────────────────────────────────────────────────

/**
 * A single surgical edit. `patchPage` takes an array of these and applies
 * them atomically; on success the server bumps `version` by one.
 *
 * The shape is treated as an open union — Phase 1+ may extend it
 * additively (e.g. column-config ops on data blocks) without rewriting
 * the existing variants.
 */
export type Op =
  | {
      op: 'add'
      // Optional anchor. Omit it to append at the end of the page: a run of
      // anchor-less `add` ops applied in order builds a page top-to-bottom in
      // document order — the simplest, least error-prone authoring path (the
      // model never has to chain `after: tmp-*` references, the #1 source of
      // "anchor not found" patch failures). Pass an explicit anchor only to
      // insert at a specific position.
      after?: BlockId | 'start' | 'end'
      block: Block | (Block & { id: TmpId })
    }
  | { op: 'edit'; blockId: BlockId; patch: Partial<Block> }
  | { op: 'delete'; blockId: BlockId }
  | { op: 'move'; blockId: BlockId; after: BlockId | 'start' | 'end' }
  | { op: 'setTitle'; title: string }
  // Page-metadata op: set or clear the page's emoji icon (`saved_views.icon`).
  // Like `setTitle`, it touches no block — `null` clears the icon back to the
  // derived glyph. The icon isn't a Y.Doc concern, so `patchPage` persists it
  // straight to the column and never forwards a `setIcon` op to the sync
  // gateway. See `docs/architecture/features/doc.md` → "Per-page emoji icons".
  | { op: 'setIcon'; icon: string | null }

export type Ops = Op[]

// ── Outline projection ────────────────────────────────────────────────

/**
 * One entry in the compact page outline. The outline is what the chat
 * model sees in its system-prompt envelope when a page is in scope; it's
 * cheap to serialize, addresses every block by id, and carries just
 * enough context for the model to call `getBlock` / `queryDataBlock`
 * when it needs more.
 *
 *   - `positionLabel`  — humane "paragraph #2", "heading #1", "row 12"
 *                        marker so the model can locate the block in prose
 *   - `preview`        — first ~80 chars of text, or "<data> entityType, N rows"
 *                        for non-text blocks
 *   - `dataMeta`       — only present on `kind === 'data'`; lets the model
 *                        decide whether to query rows or just describe shape
 */
export type OutlineEntry = {
  id: BlockId
  kind: Block['kind']
  positionLabel: string
  preview: string
  dataMeta?: {
    entityTypeRef: string
    rowCount?: number
    propertyList?: string[]
  }
}

export type Outline = {
  pageId: string
  pageVersion: number
  title: string
  blocks: OutlineEntry[]
}

// ── Versioned page ────────────────────────────────────────────────────

/**
 * A `Page` extended with the per-patch atomic counter (Lock #8) and a
 * top-level `title`. `patchPage({ pageId, ops, expectedVersion })`
 * rejects on `expectedVersion !== current.version`; on success the
 * server commits the ops + increments `version`.
 *
 * The `version` field lives on the `saved_views.version` column added
 * in migration 200; `title` is `saved_views.name` for now (Phase 1 may
 * split if title-as-block emerges).
 */
export type VersionedPage = Page & {
  version: number
  title: string
}

// ── Tool result shapes (model-history facing) ─────────────────────────

/**
 * An op `patchPage` could not apply (a `delete`/`edit`/`move` whose target
 * block no longer exists). `op` is the op kind; the Yjs-gateway path may omit
 * it (the gateway reports only `{ opIndex, reason }`), so it is optional — one
 * shape across both write paths.
 */
export type SkippedOp = { opIndex: number; op?: string; reason: string }

/**
 * `patchPage` SUCCESS result. Carries a **delta** — only the blocks the patch
 * added/edited (`changed`, as outline entries so the model gets their current
 * preview + position) and the ids it removed — NOT the whole-page outline. The
 * live outline is re-injected into the system prompt every turn, so echoing it
 * here is pure exhaust (the doc token-cost lever — see
 * `docs/plans/doc-turn-context-optimization.md`). Naming this type makes the
 * `outline`-drop compiler-enforced: re-adding an `outline` field is a type error.
 */
export type DocPatchResult = {
  kind: 'doc_patch'
  pageId: string
  version: number
  idMap: Record<string, string>
  changed: OutlineEntry[]
  removed: BlockId[]
  skipped?: SkippedOp[]
}

/**
 * `getCurrentPage` result. Outline + version always; the full `page` JSON is
 * present only when the caller asked for `fields: 'full'` (it is the biggest
 * single tool-result body, so it is opt-in).
 */
export type DocCurrentPageResult = {
  kind: 'doc_current_page'
  pageId: string
  version: number
  outline: Outline
  page?: VersionedPage
}

/**
 * `getSection` result — a heading + its subtree (every block until the next
 * heading of the same or higher level), with full content. The "expand" for a
 * section the large-page map collapsed to a one-line summary. See
 * `docs/plans/doc-turn-context-optimization.md` → Phase 2.
 */
export type DocSectionResult = {
  kind: 'doc_section'
  pageId: string
  version: number
  headingId: BlockId
  blocks: Block[]
}

/**
 * `getBlockRange` result — the contiguous run of blocks from `fromBlockId` to
 * `toBlockId` (inclusive), with full content. The general-form section read.
 */
export type DocBlockRangeResult = {
  kind: 'doc_block_range'
  pageId: string
  version: number
  fromBlockId: BlockId
  toBlockId: BlockId
  blocks: Block[]
}

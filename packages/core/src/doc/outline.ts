/**
 * Doc v1 — page-outline builder.
 *
 * `buildOutline(page)` projects a `VersionedPage` (or anything
 * structurally compatible — a bare `Page` with title/version
 * patched on the side) into the compact `Outline` shape declared in
 * `./page-types.ts`. The outline is what the chat model sees in its
 * system-prompt envelope when a page is in scope:
 *
 *   - Every block addressed by id
 *   - Humane position labels (`text #2`, `heading #1`) so the model can
 *     locate the block in prose without us streaming the whole page
 *   - 80-char previews of text-bearing blocks, kind-specific summaries
 *     for non-text blocks
 *   - `dataMeta` on `data` blocks so the model can decide whether to
 *     query rows or just describe shape
 *
 * Pure — no DB, no I/O. Safe to import from server, client, tests.
 *
 * Spec: `docs/plans/doc-v1-execution.md` §4.1.
 *
 * [COMP:doc/outline]
 */

import type {
  Block,
  BlockId,
  Outline,
  OutlineEntry,
  Page,
  VersionedPage,
} from './page-types.js'

/** Max characters in a preview before truncation + ellipsis. */
const PREVIEW_LIMIT = 80

/**
 * Build a compact outline projection of a page.
 *
 * Accepts either a `VersionedPage` (production shape from `patchPage`
 * responses) or a bare `Page` accompanied by metadata as a separate
 * param. We default `pageId` to `''` and `pageVersion` to `0` when
 * not provided — those defaults make the outline still useful for
 * tests and pre-persistence drafts.
 */
export function buildOutline(
  page: VersionedPage | Page,
  meta?: { pageId?: string; pageVersion?: number; title?: string },
): Outline {
  const versioned = page as Partial<VersionedPage>
  const pageId = meta?.pageId ?? ''
  const pageVersion = meta?.pageVersion ?? versioned.version ?? 0
  const title = meta?.title ?? versioned.title ?? ''

  // Per-kind running counter for position labels.
  const counters: Record<Block['kind'], number> = {
    text: 0,
    heading: 0,
    divider: 0,
    data: 0,
    chart: 0,
    diagram: 0,
    callout: 0,
    code: 0,
    quote: 0,
    bulleted_list_item: 0,
    numbered_list_item: 0,
    to_do: 0,
    toggle: 0,
    table: 0,
    image: 0,
    file: 0,
    bookmark: 0,
    video: 0,
    audio: 0,
    child_page: 0,
  }

  const blocks: OutlineEntry[] = page.blocks.map(block => {
    counters[block.kind] += 1
    const positionLabel = `${block.kind} #${counters[block.kind]}`
    const entry: OutlineEntry = {
      id: block.id,
      kind: block.kind,
      positionLabel,
      preview: previewFor(block),
    }
    if (block.kind === 'data') {
      entry.dataMeta = dataMetaFor(block)
    }
    return entry
  })

  return { pageId, pageVersion, title, blocks }
}

/**
 * Compute the 80-char preview string for a block. Text-bearing blocks
 * use their first line of text; non-text blocks get a kind-specific
 * summary so the model still has *something* to anchor on.
 */
function previewFor(block: Block): string {
  switch (block.kind) {
    case 'text': {
      return truncate(firstLine(block.text))
    }
    case 'heading': {
      return truncate(`H${block.level}: ${firstLine(block.text)}`)
    }
    case 'divider': {
      return ''
    }
    case 'data': {
      // Use a stable shape so the model learns the pattern. Property
      // list is omitted from the preview (it goes into `dataMeta`)
      // but mention it in count form for at-a-glance scanning.
      const binding = block.binding
      const colsCount =
        'columns' in binding && binding.columns ? binding.columns.length : 0
      const colsHint = colsCount > 0 ? `, ${colsCount} cols` : ''
      return truncate(
        `data (entity=${binding.entity}, view=${binding.viewType}${colsHint})`,
      )
    }
    case 'chart': {
      const title = block.title ? ` "${block.title}"` : ''
      // Live (binding) charts surface their entity + op; static (inline
      // data) charts surface `inline` so the model knows the values live
      // on the block, not in a store it must query.
      const src = block.binding
        ? `${block.binding.entity}, ${block.binding.op}`
        : 'inline'
      return truncate(`chart (${block.chartType}, ${src})${title}`)
    }
    case 'diagram': {
      const title = block.title ? ` "${block.title}"` : ''
      return truncate(`diagram (${block.syntax})${title}`)
    }
    case 'image': {
      const name = block.ref?.name ?? '<empty>'
      const caption = block.caption ? `: ${block.caption}` : ''
      return truncate(`image (${name})${caption}`)
    }
    case 'file': {
      const name = block.ref?.name ?? '<empty>'
      return truncate(`file (${name})`)
    }
    case 'bookmark': {
      const title = block.meta?.title ? `: ${block.meta.title}` : ''
      return truncate(`bookmark (${block.url || '<empty>'})${title}`)
    }
    case 'video': {
      const caption = block.caption ? `: ${block.caption}` : ''
      return truncate(`video (${block.url || '<empty>'})${caption}`)
    }
    case 'audio': {
      const caption = block.caption ? `: ${block.caption}` : ''
      return truncate(`audio (${block.url || '<empty>'})${caption}`)
    }
    case 'callout': {
      const lead = richTextLine(block.richText)
      const kids = block.children?.length ? `, ${block.children.length} children` : ''
      return truncate(`callout (${block.icon}${kids})${lead ? `: ${lead}` : ''}`)
    }
    case 'code': {
      return truncate(`code (${block.language || 'plain'})`)
    }
    case 'quote': {
      return 'quote'
    }
    case 'bulleted_list_item': {
      return '• list item'
    }
    case 'numbered_list_item': {
      return '1. list item'
    }
    case 'to_do': {
      return `[${block.checked ? 'x' : ' '}] to-do`
    }
    case 'toggle': {
      const summary = richTextLine(block.richText)
      const meta: string[] = []
      if (block.children?.length) meta.push(`${block.children.length} children`)
      if (block.expanded) meta.push('open')
      const tag = meta.length ? ` (${meta.join(', ')})` : ''
      return truncate(`▸ toggle${tag}${summary ? `: ${summary}` : ''}`)
    }
    case 'table': {
      const rows = block.rows.length
      const cols = block.rows[0]?.length ?? 0
      const header = block.hasHeaderRow ? ', header row' : ''
      return truncate(`table (${rows}×${cols}${header})`)
    }
    case 'child_page': {
      // No child title is available in the pure builder (would require a
      // store read). Surface the linked page id so the model can fetch /
      // navigate it; the renderer resolves the title at display time.
      return truncate(`child page (${block.childPageId || '<unset>'})`)
    }
    default: {
      const _exhaustive: never = block
      return JSON.stringify(_exhaustive)
    }
  }
}

/**
 * Build the `dataMeta` field for a `data` block. `rowCount` is left
 * unset here — the outline builder is pure and has no DB access. A
 * caller with access to the store can fold it in later (see the API
 * route `getCurrentPage` for the production splice).
 */
function dataMetaFor(block: Extract<Block, { kind: 'data' }>): {
  entityTypeRef: string
  rowCount?: number
  propertyList?: string[]
} {
  const binding = block.binding
  const propertyList =
    'columns' in binding && binding.columns && binding.columns.length > 0
      ? [...binding.columns]
      : undefined
  return {
    entityTypeRef: binding.entity,
    ...(propertyList ? { propertyList } : {}),
  }
}

/**
 * First newline-delimited line of a string. Empty string stays empty.
 */
/** First line of plain text inside an opaque richText doc (a toggle's
 *  summary, a callout's lead) — so the outline preview anchors the model on
 *  the block's CONTENT, not just its kind. */
function richTextLine(rt: unknown): string {
  const content = (rt as { content?: unknown[] } | undefined)?.content
  if (!Array.isArray(content)) return ''
  const walk = (nodes: unknown[]): string =>
    nodes
      .map((n) => {
        const node = n as { text?: string; content?: unknown[] }
        if (typeof node.text === 'string') return node.text
        if (Array.isArray(node.content)) return walk(node.content)
        return ''
      })
      .join('')
  return firstLine(walk(content)).trim()
}

function firstLine(s: string): string {
  if (!s) return ''
  const nl = s.indexOf('\n')
  return nl === -1 ? s : s.slice(0, nl)
}

/**
 * Truncate to `PREVIEW_LIMIT` chars, appending `…` if the source
 * exceeded the limit.
 */
function truncate(s: string): string {
  if (s.length <= PREVIEW_LIMIT) return s
  return `${s.slice(0, PREVIEW_LIMIT - 1)}…`
}

/**
 * Render one outline entry as the single line the chat envelope injects:
 * `  - <id> (<positionLabel>): <preview>[ [entity=…, props=…, N rows]]`. The
 * `data`-block meta tail mirrors what `getCurrentPage` splices in. `indent`
 * defaults to two spaces (the flat-outline injection); the hierarchical map
 * passes a deeper indent for blocks nested under a heading. Shared by the flat
 * Layer-13 render and `renderOutlineTree` so the two never drift.
 */
export function renderOutlineEntryLine(entry: OutlineEntry, indent = '  '): string {
  const dm = entry.dataMeta
  const meta = dm
    ? ` [entity=${dm.entityTypeRef}` +
      (dm.propertyList ? `, props=${dm.propertyList.join('/')}` : '') +
      (typeof dm.rowCount === 'number' ? `, ${dm.rowCount} rows` : '') +
      ']'
    : ''
  return `${indent}- ${entry.id} (${entry.positionLabel}): ${entry.preview}${meta}`
}

// ── Patch delta projection ────────────────────────────────────────────

/**
 * The shape `patchPage` returns on success instead of the whole-page outline:
 * only the blocks the patch added or edited (`changed`, as full `OutlineEntry`s
 * so the model gets their current preview + position) and the ids it removed.
 */
export type PatchDelta = {
  changed: OutlineEntry[]
  removed: BlockId[]
}

/**
 * Compute the patch delta — what an applied patch changed and removed — by
 * set-diffing the pre-patch blocks against the committed blocks.
 *
 * This is the load-bearing lever in the doc token-cost work: `patchPage`
 * used to echo the FULL page outline in every success result, which (because
 * the chat route reloads the whole session history each turn) piled up
 * linearly with edit count. Returning only the touched blocks keeps that
 * history flat — the current page is always re-injected fresh into the system
 * prompt, so the model never needs the whole outline echoed back.
 * See `docs/plans/doc-turn-context-optimization.md` → Phase 1.
 *
 * `changed` is filtered out of `committedOutline` rather than rebuilt from a
 * subset of blocks, because `positionLabel` is a per-kind running counter over
 * the WHOLE page (`buildOutline`) — a subset projected in isolation would
 * mislabel. `removed` ids have no surviving block, so they carry no entry.
 *
 * Pure ids/content diff:
 *   - added   = committed block whose id is absent pre-patch
 *   - edited  = block present in both whose content changed (structural compare)
 *   - removed = pre-patch block whose id is absent post-patch
 *   - `changed` = added ∪ edited
 *
 * A pure `move` (same id, same content, new position) and `setTitle`/`setIcon`
 * (page metadata, not blocks) produce no `changed`/`removed` entry — the
 * version bump signals success and the live outline reflects order next turn.
 * Erring toward false positives (a content compare flagging an unchanged block)
 * is safe: it only widens the delta slightly, never drops a real change.
 */
export function computePatchDelta(
  preBlocks: Block[],
  committedBlocks: Block[],
  committedOutline: Outline,
): PatchDelta {
  const preById = new Map<BlockId, Block>(preBlocks.map((b) => [b.id, b]))
  const committedIds = new Set<BlockId>(committedBlocks.map((b) => b.id))

  const changedIds = new Set<BlockId>()
  for (const b of committedBlocks) {
    const prev = preById.get(b.id)
    if (!prev || !blocksEqual(prev, b)) changedIds.add(b.id)
  }

  const removed: BlockId[] = []
  for (const b of preBlocks) {
    if (!committedIds.has(b.id)) removed.push(b.id)
  }

  return {
    changed: committedOutline.blocks.filter((e) => changedIds.has(e.id)),
    removed,
  }
}

/** Structural equality for two blocks (serialization compare — sufficient for
 *  "did this block's content change" since blocks are plain JSON). Assumes
 *  stable key order: a key-order-only difference would over-report a block as
 *  changed (a safe false positive — see computePatchDelta), never miss one. */
function blocksEqual(a: Block, b: Block): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

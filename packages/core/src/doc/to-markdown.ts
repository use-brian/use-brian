/**
 * Doc `Block[]` → Markdown serializer — the export half of the md⇄blocks hub
 * (`blocksFromMarkdown` in `./markdown.ts` is the import half). Covers all 20
 * block kinds per the §4.1 matrix in
 * docs/architecture/features/doc-conversion.md.
 *
 * Design notes:
 *   - **Lossy-aware, round-trip-honest.** The "clean" subset (heading / text /
 *     lists / to_do / quote / code / divider / table / inline marks / links in
 *     rich-text kinds) is a Markdown FIXED POINT after one pass:
 *     `blocksToMarkdown(markdownToBlocks(md))` is stable. Callouts export as an
 *     emoji-prefixed blockquote (re-import → quote), toggles as their summary
 *     paragraph, and live `data`/`chart` snapshot to tables — all documented
 *     one-way reductions.
 *   - **Snapshot, never live.** A `data` block has no rows without the bindings
 *     resolver (which needs a store), so resolution is injected via
 *     `opts.resolveDataBlock` at the API layer; the pure default emits an
 *     italic placeholder. Same for media URLs via `opts.resolveMediaUrl`.
 *   - Inline marks come from the shared `extractInlineSegments` walker
 *     (`./rich-text.ts`), so Markdown and docx emphasis can never disagree.
 *
 * Pure + dependency-light (string in/out) so it unit-tests trivially and runs
 * on any surface. The API export route is the only caller that injects
 * resolvers; everything else gets the placeholder behaviour.
 *
 * Spec: docs/architecture/features/doc-conversion.md.
 *
 * [COMP:doc/markdown-serializer]
 */

import type {
  Block,
  ChartBlock,
  DataBlock,
  MediaRef,
  Page,
  RichTextContent,
  TableBlock,
} from './page-types.js'
import { extractInlineSegments, type InlineSegment } from './rich-text.js'

export interface BlocksToMarkdownOptions {
  /**
   * Resolve a live `data` block to a static Markdown snapshot (typically a GFM
   * table). Injected at the API layer where the bindings resolver + store
   * exist. When omitted, the block renders a one-line italic placeholder.
   */
  resolveDataBlock?: (block: DataBlock) => string | undefined
  /**
   * Resolve a stored media ref (image / file) to a URL for the link / embed.
   * When omitted, media renders by its stored name with no working URL.
   */
  resolveMediaUrl?: (ref: MediaRef) => string | undefined
}

// ── Inline emphasis ───────────────────────────────────────────────────

/** Backslash-escape the inline-significant characters in a plain text run. */
function escapeInline(s: string): string {
  return s.replace(/([\\`*~[])/g, '\\$1')
}

/** Wrap one segment's text in its Markdown markers. Code spans are literal
 *  (no inner emphasis — Markdown can't combine them); a link wraps outermost. */
function segmentToMarkdown(seg: InlineSegment): string {
  if (seg.code) {
    const longest = (seg.text.match(/`+/g) ?? []).reduce(
      (m, run) => Math.max(m, run.length),
      0,
    )
    const fence = '`'.repeat(longest + 1)
    const code = `${fence}${seg.text}${fence}`
    return seg.link ? `[${code}](${seg.link})` : code
  }
  // Don't wrap a whitespace-only run — `** **` is not valid emphasis.
  if (!seg.text.trim()) return escapeInline(seg.text)
  let t = escapeInline(seg.text)
  if (seg.strike) t = `~~${t}~~`
  if (seg.italic) t = `*${t}*`
  if (seg.bold) t = `**${t}**`
  if (seg.link) t = `[${t}](${seg.link})`
  return t
}

function inlineToMarkdown(segs: InlineSegment[]): string {
  return segs.map(segmentToMarkdown).join('')
}

/** A block's opaque richText → one line of inline Markdown. */
function richToMarkdown(rt: RichTextContent | undefined): string {
  return inlineToMarkdown(extractInlineSegments(rt))
}

/** A richText cell for a GFM table — pipes escaped, newlines flattened. */
function richToCell(rt: RichTextContent | undefined): string {
  return richToMarkdown(rt).replace(/\n/g, ' ').replace(/\|/g, '\\|')
}

// ── Block-level rendering ─────────────────────────────────────────────

const LIST_ITEM_KINDS = new Set(['bulleted_list_item', 'numbered_list_item', 'to_do'])

/** Escape a plain `text`-block line so a leading block marker (`#`, `-`, `>`,
 *  `1.`) doesn't reparse as a heading / list / quote on the way back in. */
function escapeTextBlock(text: string): string {
  const escaped = escapeInline(text)
  return escaped.replace(/^(\s*)([#>+-]|\d+[.)])/, '$1\\$2')
}

/** GFM table from a row-major grid of richText cells. GFM has no headerless
 *  table, so row 0 is always the header (re-imports with `hasHeaderRow`). */
function tableToMarkdown(block: TableBlock): string {
  const width = block.rows.reduce((m, row) => Math.max(m, row.length), 0)
  if (width === 0) return ''
  const cellAt = (r: number, c: number): string => richToCell(block.rows[r]?.[c])
  const renderRow = (r: number): string =>
    `| ${Array.from({ length: width }, (_u, c) => cellAt(r, c)).join(' | ')} |`
  const sep = `| ${Array.from({ length: width }, () => '---').join(' | ')} |`
  const lines = [renderRow(0), sep]
  for (let r = 1; r < block.rows.length; r++) lines.push(renderRow(r))
  return lines.join('\n')
}

/** GFM table from an inline-chart's data (snapshot of the model's numbers). */
function chartToMarkdown(block: ChartBlock): string {
  const head: string[] = []
  if (block.title) head.push(`**${escapeInline(block.title)}**`)
  if (!block.data) {
    head.push('_[Live chart]_')
    return head.join('\n\n')
  }
  const d = block.data
  if (block.chartType === 'kpi' && d.value !== undefined) {
    const delta = d.delta !== undefined ? ` (${d.delta >= 0 ? '+' : ''}${d.delta})` : ''
    head.push(`${d.value}${delta}`)
    return head.join('\n\n')
  }
  if ((block.chartType === 'bar' || block.chartType === 'pie') && d.points?.length) {
    const rows = ['| Label | Value |', '| --- | --- |']
    for (const p of d.points) rows.push(`| ${escapeInline(p.label)} | ${p.value} |`)
    return [...head, rows.join('\n')].join('\n\n')
  }
  if (block.chartType === 'line' && d.series?.length) {
    const rows = ['| Series | X | Y |', '| --- | --- | --- |']
    for (const s of d.series)
      for (const pt of s.points) rows.push(`| ${escapeInline(s.name)} | ${pt.x} | ${pt.y} |`)
    return [...head, rows.join('\n')].join('\n\n')
  }
  return head.join('\n\n')
}

function mediaUrl(ref: MediaRef | null, opts: BlocksToMarkdownOptions): string | undefined {
  if (!ref) return undefined
  return opts.resolveMediaUrl?.(ref) ?? ref.path
}

/** Render one non-list block to its Markdown form (may be multi-line). */
function blockToMarkdown(block: Block, opts: BlocksToMarkdownOptions): string {
  switch (block.kind) {
    case 'text':
      return escapeTextBlock(block.text ?? '')
    case 'heading':
      return `${'#'.repeat(block.level)} ${escapeInline(block.text ?? '')}`
    case 'divider':
      return '---'
    case 'code': {
      const longest = ((block.code ?? '').match(/`{3,}/g) ?? []).reduce(
        (m, run) => Math.max(m, run.length),
        2,
      )
      const fence = '`'.repeat(longest + 1)
      return `${fence}${block.language || ''}\n${block.code ?? ''}\n${fence}`
    }
    case 'quote':
      return richToMarkdown(block.richText)
        .split('\n')
        .map((l) => `> ${l}`)
        .join('\n')
    case 'callout': {
      const parts = [`${block.icon} ${richToMarkdown(block.richText)}`.trim()]
      // Children render inside the quote body (still a documented one-way
      // reduction — a callout re-imports as a quote unless it's a GFM alert).
      if (block.children?.length) parts.push(blocksToMarkdown(block.children, opts))
      return parts
        .join('\n\n')
        .split('\n')
        .map((l) => `> ${l}`)
        .join('\n')
    }
    case 'toggle': {
      const summary = richToMarkdown(block.richText).replace(/\n+/g, ' ').trim()
      // A childless toggle keeps the plain-summary reduction. With children it
      // exports as the standard HTML disclosure, which `markdownToBlocks` /
      // `blocksFromMarkdown` parse back into a toggle — a Markdown FIXED POINT
      // (doc-conversion.md §4.2), so nesting survives the round-trip.
      if (!block.children?.length) return summary
      const open = block.expanded ? ' open' : ''
      return [
        `<details${open}>`,
        `<summary>${summary}</summary>`,
        '',
        blocksToMarkdown(block.children, opts),
        '',
        '</details>',
      ].join('\n')
    }
    case 'table':
      return tableToMarkdown(block)
    case 'data':
      return opts.resolveDataBlock?.(block) ?? '_[Live data view]_'
    case 'chart':
      return chartToMarkdown(block)
    case 'diagram':
      return `\`\`\`mermaid\n${block.code}\n\`\`\``
    case 'image': {
      const url = mediaUrl(block.ref, opts)
      const alt = escapeInline(block.alt ?? block.ref?.name ?? 'image')
      const img = url ? `![${alt}](${url})` : `_[Image: ${alt}]_`
      return block.caption ? `${img}\n\n*${escapeInline(block.caption)}*` : img
    }
    case 'file': {
      const url = mediaUrl(block.ref, opts)
      const name = escapeInline(block.ref?.name ?? 'file')
      return url ? `[${name}](${url})` : `_[File: ${name}]_`
    }
    case 'bookmark': {
      const title = escapeInline(block.meta?.title || block.url)
      return block.url ? `[${title}](${block.url})` : ''
    }
    case 'video':
    case 'audio': {
      if (!block.url) return ''
      const label = escapeInline(block.caption || block.url)
      return `[${label}](${block.url})`
    }
    case 'child_page':
      return `[Sub-page](/p/${block.childPageId})`
    default:
      return ''
  }
}

/** A list item's clamped nesting depth (to-dos nest too). */
function rawListDepth(block: Block): number {
  const indent = (block as { indent?: number }).indent
  return typeof indent === 'number' && indent > 0 ? Math.floor(indent) : 0
}

/**
 * Clamp a run's per-item depths so each is at most one level deeper than its
 * predecessor and the first is 0 — the same well-formedness the block↔PM
 * mapping enforces, so `'  '.repeat(depth)` indentation round-trips back to the
 * identical depths on re-import.
 */
function normalizeRunDepths(run: Block[]): number[] {
  const depths: number[] = []
  let maxAllowed = 0
  for (const b of run) {
    const d = Math.min(rawListDepth(b), maxAllowed)
    depths.push(d)
    maxAllowed = d + 1
  }
  return depths
}

/** The bare marker + text for one list item (no indentation). */
function listMarker(block: Block, ordinal: number): string {
  const text = richToMarkdown((block as { richText?: RichTextContent }).richText)
  if (block.kind === 'to_do') return `- [${block.checked ? 'x' : ' '}] ${text}`
  if (block.kind === 'numbered_list_item') return `${ordinal}. ${text}`
  return `- ${text}`
}

/**
 * Render a contiguous list run (one top-level list, with its nested sub-lists)
 * to indented Markdown. Each item is `'  '.repeat(depth)` + its marker; ordered
 * items count per depth + sibling group, restarting when the run descends and
 * returns, or when the kind changes at a depth.
 */
function listRunToMarkdown(run: Block[]): string {
  const depths = normalizeRunDepths(run)
  const ordinal: number[] = []
  const lastKind: (string | undefined)[] = []
  let prevDepth = -1
  const lines: string[] = []
  for (let k = 0; k < run.length; k++) {
    const b = run[k]
    const d = depths[k]
    // Returning to a shallower depth closes every deeper sibling group, so a
    // later descent restarts its ordinals from 1.
    if (d < prevDepth) {
      for (let x = d + 1; x < ordinal.length; x++) {
        ordinal[x] = 0
        lastKind[x] = undefined
      }
    }
    if (lastKind[d] !== b.kind) {
      ordinal[d] = 0
      lastKind[d] = b.kind
    }
    ordinal[d] = (ordinal[d] ?? 0) + 1
    lines.push('  '.repeat(d) + listMarker(b, ordinal[d]))
    prevDepth = d
  }
  return lines.join('\n')
}

/**
 * Serialize a page (or a raw block list) to Markdown. Consecutive list items
 * of the same kind group into one list; every other block is separated by a
 * blank line.
 */
export function blocksToMarkdown(
  page: Page | Block[],
  opts: BlocksToMarkdownOptions = {},
): string {
  const blocks = Array.isArray(page) ? page : page.blocks
  const chunks: string[] = []
  let i = 0
  while (i < blocks.length) {
    const kind = blocks[i].kind
    if (LIST_ITEM_KINDS.has(kind)) {
      // Consume one top-level list with its nested sub-lists. A deeper item
      // (depth > 0) always belongs to the current run; a top-level (depth 0)
      // item of a DIFFERENT kind starts a fresh list → its own blank-line-
      // separated chunk (so a bullet list and an ordered list stay distinct).
      const runKind = kind
      const run: Block[] = []
      while (i < blocks.length && LIST_ITEM_KINDS.has(blocks[i].kind)) {
        const b = blocks[i]
        if (rawListDepth(b) === 0 && b.kind !== runKind) break
        run.push(b)
        i += 1
      }
      chunks.push(listRunToMarkdown(run))
      continue
    }
    const rendered = blockToMarkdown(blocks[i], opts)
    if (rendered !== '') chunks.push(rendered)
    i += 1
  }
  return chunks.join('\n\n')
}

/** A page's Markdown with a leading `# Title` when a title is supplied. */
export function pageToMarkdown(
  page: Page,
  title: string | undefined,
  opts: BlocksToMarkdownOptions = {},
): string {
  const body = blocksToMarkdown(page, opts)
  const heading = title?.trim() ? `# ${escapeInline(title.trim())}` : ''
  return [heading, body].filter(Boolean).join('\n\n')
}

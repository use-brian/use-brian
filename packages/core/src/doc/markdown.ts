/**
 * Doc v1 — Markdown → canonical-block normalizer (tool-input boundary).
 *
 * Why this exists: the chat model is trained to emit Markdown. The doc
 * Block/Op vocabulary stores prose as *plain* `text` on `text` / `heading`
 * blocks (no inline marks) and as opaque Tiptap `richText` on the
 * structured kinds (quote, callout, lists, toggle). When the model crams a
 * whole Markdown document — `### Heading`, `**bold**`, blank-line-separated
 * paragraphs — into one block's `text` field, the renderer paints it
 * verbatim: the user sees literal `###` and `**…**` instead of a Heading 3
 * and bold text. (Real production repro: session 97007562, 2026-05-30.)
 *
 * This module is the safety net. It runs on `renderPage` / `patchPage`
 * input — before validation / application — and converts Markdown that
 * lands in a `text` / `heading` block into the canonical blocks it
 * describes: headings at their level, split paragraphs, bullet / numbered /
 * task lists, blockquotes, fenced code, thematic-break dividers. Inline
 * marks (`**bold**`, `*italic*`, `` `code` ``, `~~strike~~`) become Tiptap
 * `richText` marks on the kinds that can carry them, and are stripped to
 * clean text on the plain kinds (heading / text / code) that structurally
 * cannot. The matching prompt-level prevention — telling the model to emit
 * blocks, not Markdown — lives in `./soul.ts` + the tool descriptions.
 *
 * It is deliberately conservative: only `text` and `heading` blocks are
 * inspected (a `code` block's body is never re-parsed), and a block whose
 * text carries no Markdown structure or paired inline syntax passes through
 * untouched — same object, same id. Single stray `*` / `_` (e.g. `5 * 3`,
 * `a_b_c`) are left literal: only paired, flanked emphasis is treated as a
 * mark.
 *
 * Pure + dependency-light so it unit-tests trivially and runs identically
 * on every write path (Yjs gateway *and* legacy CAS).
 *
 * Spec: docs/architecture/features/doc.md → "Markdown normalization".
 *
 * [COMP:doc/markdown-normalizer]
 */

import type {
  Block,
  BlockId,
  HeadingBlock,
  Op,
  Ops,
  Page,
  RichTextContent,
  TextBlock,
} from './page-types.js'
import { richTextToPlain } from './rich-text.js'

// ── id generator (mirrors ops.ts defaultGenerateId) ───────────────────

function defaultGenerateId(): BlockId {
  const cryptoObj = (globalThis as { crypto?: { randomUUID?: () => string } })
    .crypto
  if (cryptoObj?.randomUUID) return cryptoObj.randomUUID()
  return `md-${Math.random().toString(36).slice(2, 10)}`
}

// ── Inline tokenizer ──────────────────────────────────────────────────

type Mark =
  | { type: 'bold' | 'italic' | 'code' | 'strike' }
  | { type: 'link'; attrs: { href: string } }
type InlineNode = { type: 'text'; text: string; marks?: Mark[] }

/**
 * Inline tokenizer options. `links: 'mark'` keeps a `[label](url)` as a Tiptap
 * `link` mark (the faithful **importer** path — `markdownToBlocks`); the
 * default `'strip'` reduces it to its label, preserving the pre-existing
 * model-write normalizer behaviour (and the `parseInline` unit contract).
 */
export interface ParseInlineOptions {
  links?: 'strip' | 'mark'
}

/**
 * Tokenize a single line of inline Markdown into Tiptap text nodes.
 * Handles `**bold**` / `__bold__`, `*italic*` / `_italic_` (whitespace-
 * flanked only), `` `code` ``, `~~strike~~`, `[label](url)` (→ label, no
 * link mark in the doc schema), and backslash escapes. Marks nest via
 * recursion; code spans are literal (no inner parsing). Unpaired or
 * mid-word delimiters stay literal text.
 */
export function parseInline(src: string, opts: ParseInlineOptions = {}): InlineNode[] {
  return walkInline(src, [], opts)
}

function walkInline(src: string, marks: Mark[], opts: ParseInlineOptions): InlineNode[] {
  const nodes: InlineNode[] = []
  let buf = ''
  let i = 0
  const flush = () => {
    if (!buf) return
    nodes.push(marks.length ? { type: 'text', text: buf, marks: [...marks] } : { type: 'text', text: buf })
    buf = ''
  }
  while (i < src.length) {
    const c = src[i]
    if (c === '\\' && i + 1 < src.length) {
      buf += src[i + 1]
      i += 2
      continue
    }
    // Code span — literal inner, no recursion.
    if (c === '`') {
      const close = src.indexOf('`', i + 1)
      if (close > i) {
        flush()
        nodes.push({ type: 'text', text: src.slice(i + 1, close), marks: [...marks, { type: 'code' }] })
        i = close + 1
        continue
      }
    }
    // Bold — ** or __.
    if ((c === '*' && src[i + 1] === '*') || (c === '_' && src[i + 1] === '_')) {
      const delim = c + c
      const close = src.indexOf(delim, i + 2)
      if (close > i + 1) {
        flush()
        nodes.push(...walkInline(src.slice(i + 2, close), [...marks, { type: 'bold' }], opts))
        i = close + 2
        continue
      }
    }
    // Strike — ~~.
    if (c === '~' && src[i + 1] === '~') {
      const close = src.indexOf('~~', i + 2)
      if (close > i + 1) {
        flush()
        nodes.push(...walkInline(src.slice(i + 2, close), [...marks, { type: 'strike' }], opts))
        i = close + 2
        continue
      }
    }
    // Italic — single * or _, conservatively flanked to dodge `5 * 3`
    // and snake_case.
    if (c === '*' || c === '_') {
      const prev = src[i - 1]
      const next = src[i + 1]
      const leftOk = i === 0 || /[\s([{>—–-]/.test(prev ?? '')
      if (next !== undefined && !/\s/.test(next) && leftOk) {
        let j = i + 1
        let closeAt = -1
        while (j < src.length) {
          if (src[j] === '\\') {
            j += 2
            continue
          }
          if (src[j] === c && !/\s/.test(src[j - 1] ?? ' ')) {
            const after = src[j + 1]
            if (after === undefined || /[\s).,!?;:'"\]}]/.test(after)) {
              closeAt = j
              break
            }
          }
          j++
        }
        if (closeAt > i) {
          flush()
          nodes.push(...walkInline(src.slice(i + 1, closeAt), [...marks, { type: 'italic' }], opts))
          i = closeAt + 1
          continue
        }
      }
    }
    // Link — [label](url). Default drops to the label (doc-history default);
    // the importer (`links: 'mark'`) keeps it as a Tiptap `link` mark.
    if (c === '[') {
      const m = /^\[([^\]]+)\]\(([^)]+)\)/.exec(src.slice(i))
      if (m) {
        flush()
        const linkMarks: Mark[] =
          opts.links === 'mark' ? [...marks, { type: 'link', attrs: { href: m[2] } }] : marks
        nodes.push(...walkInline(m[1], linkMarks, opts))
        i += m[0].length
        continue
      }
    }
    buf += c
    i += 1
  }
  flush()
  return nodes
}

/** Inline Markdown → plain text (marks dropped). For heading / text / code. */
function inlinePlain(src: string): string {
  return parseInline(src)
    .map((n) => n.text)
    .join('')
}

/** A Tiptap paragraph node from one line of inline Markdown. */
function paragraphFrom(line: string, links: 'strip' | 'mark' = 'strip'): Record<string, unknown> {
  const nodes = parseInline(line, { links }).filter((n) => n.text.length > 0)
  return nodes.length > 0 ? { type: 'paragraph', content: nodes } : { type: 'paragraph' }
}

/** Inline Markdown → opaque richText doc (one paragraph). For list / quote. */
function inlineRich(line: string, links: 'strip' | 'mark' = 'strip'): RichTextContent {
  return { type: 'doc', content: [paragraphFrom(line, links)] } as unknown as RichTextContent
}

// ── List-item text lift (tool-input boundary, pre-validation) ──────────

/**
 * The block kinds that store their content as opaque Tiptap `richText` and
 * carry NO plain-`text` field — the rich-text kinds in `views/blocks.ts`.
 */
const RICHTEXT_KINDS = new Set([
  'bulleted_list_item',
  'numbered_list_item',
  'to_do',
  'toggle',
  'quote',
  'callout',
])

/**
 * The inverse set: block kinds that store content as a plain `text` string and
 * structurally CANNOT carry inline marks (see this module's header). A model
 * reaching for an inline-bold lead ("**Verdict:** …") on one of these reaches
 * for the `richText` shape the rich kinds use — the mirror of the slip
 * `RICHTEXT_KINDS` repairs.
 */
const PLAINTEXT_KINDS = new Set(['text', 'heading'])

/**
 * Tool-input boundary repair for the model's most common block-shape slip:
 * authoring a list / quote / callout / toggle block with a plain `text`
 * field — the shape `text` / `heading` blocks use — instead of the opaque
 * Tiptap `richText` those kinds actually store. The block schema declares no
 * `text` key for those kinds, so Zod (`z.object`) silently strips it, leaving
 * a content-less `{ id, kind }` block the editor renders as an empty bullet.
 * (Real production repro: "Intensive LeetCode Mastery Guide", page
 * `a90026ad`, renderPage call_119, 2026-06-01 — every bullet / to_do arrived
 * with a `text` field and persisted empty.)
 *
 * This lifts a stray `text` into the canonical one-paragraph `richText` doc,
 * parsing inline marks exactly like a Markdown-authored bullet. It must run
 * as a `z.preprocess` step (see `page-schemas.ts` → `liftedBlockSchema`) so
 * it sees the `text` key *before* validation drops it. Conservative +
 * idempotent: fires only when `text` is a string and `richText` is absent;
 * every other shape (already-`richText` lists, real `text`/`heading` blocks,
 * non-objects) passes through by reference.
 *
 * Two further repairs, added 2026-06-11, close the cases that trapped the
 * model in a `patchPage` retry loop instead of slipping silently:
 *
 *  1. **The mirror slip** — a `text` / `heading` block authored WITH a
 *     `richText` doc (the model wanting a bold "Verdict:" lead on a plain
 *     paragraph). Those kinds have no `richText` field, so Zod rejects
 *     `…text: Required` rather than stripping it; the model re-sends the same
 *     shape and burns the turn. We flatten the `richText` to plain `text`
 *     (`richTextToPlain` — marks dropped, exactly as this module already does
 *     for inline Markdown on plain kinds). Only fires when there is no usable
 *     `text` already, so a block carrying both is left to the schema.
 *  2. **Nested children** — container kinds (`toggle` / `callout`) validate
 *     their `children` against the RAW `blockSchema`, which never sees this
 *     lift. A stray-shape child therefore reached Zod un-repaired. We recurse
 *     so the whole subtree gets the same treatment in one pre-validation pass.
 *
 * Prod repro for both: session 81a56d8b (2026-06-11) — a `toggle` whose first
 * child was a `{ kind:'text', richText }` verdict line was rejected
 * `ops.15.block.children.0.text: Required`; the turn thrashed and then died on
 * a stream-idle stall with no reply ("it did nothing").
 */
export function liftListItemText(raw: unknown): unknown {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return raw
  const block = raw as Record<string, unknown>
  let next = block

  // text → richText: a rich kind authored with the plain `text` shape.
  if (
    typeof next.kind === 'string' &&
    RICHTEXT_KINDS.has(next.kind) &&
    typeof next.text === 'string' &&
    next.richText === undefined
  ) {
    const { text, ...rest } = next
    next = { ...rest, richText: inlineRich((text as string).trim()) }
  }

  // richText → text: a plain kind authored with the rich shape (repair #1).
  if (
    typeof next.kind === 'string' &&
    PLAINTEXT_KINDS.has(next.kind) &&
    next.richText !== undefined &&
    (next.text === undefined || next.text === null || next.text === '')
  ) {
    const { richText, ...rest } = next
    next = { ...rest, text: richTextToPlain(richText as RichTextContent) }
  }

  // Recurse into container children (repair #2). Preserve the array's
  // referential identity when nothing changed so the common case stays a
  // pure pass-through.
  if (Array.isArray(next.children)) {
    const children = next.children as unknown[]
    const lifted = children.map(liftListItemText)
    if (lifted.some((c, i) => c !== children[i])) {
      next = { ...next, children: lifted }
    }
  }

  return next === block ? raw : next
}

// ── Markdown detection ────────────────────────────────────────────────

const PAIRED_INLINE_RE =
  /(\*\*[^*\n]+\*\*)|(__[^_\n]+__)|(~~[^~\n]+~~)|(`[^`\n]+`)|(\[[^\]\n]+\]\([^)\n]+\))|((?:^|[\s([{>])[*_][^*_\s][^*_\n]*[*_](?=$|[\s).,!?;:]))/

/**
 * Bullet markers: the ASCII Markdown set (`-` / `*` / `+`) plus the Unicode
 * bullet glyphs the chat model frequently substitutes — • (U+2022),
 * ‣ (U+2023), ◦ (U+25E6). The model emits a literal `•`-prefixed line
 * routinely (most often right after CJK content); the canonical block
 * vocabulary has no place for the raw glyph, so unless it's recognised here
 * the line survives as plain prose with a stray `•` instead of becoming a
 * `bulleted_list_item`. (Repro: the "Content Pillars" doc page, 2026-06-01.
 * The sibling chat-render path solves the same model habit in
 * `packages/chat-ui/src/normalize-markdown.ts`.)
 *
 * Shared by `BULLET_RE` (the parser) and `LIST_LINE_RE` (the detection gate)
 * so the two can never disagree on what counts as a bullet — a disagreement
 * would let `hasBlockMarkdown` skip a block the parser would have expanded,
 * leaving the glyph on the page.
 */
const BULLET_CLASS = '[-*+\\u2022\\u2023\\u25E6]'

/** A line that opens a list or quote — bullet, ordered (`1.`/`1)`), or `>`. */
const LIST_LINE_RE = new RegExp(
  `(^|\\n)[ \\t]*(${BULLET_CLASS}[ \\t]+|\\d+[.)][ \\t]+|>[ \\t]?)`,
)

/** True when a string carries paired, flanked inline emphasis worth parsing. */
function hasInlineMarkdown(s: string): boolean {
  return PAIRED_INLINE_RE.test(s)
}

/**
 * True when a `text` block's content carries Markdown worth expanding —
 * block-level structure, a blank-line paragraph split, or paired inline
 * marks. Plain prose (even multi-line soft wraps) returns false so the
 * block passes through untouched.
 */
function hasBlockMarkdown(s: string): boolean {
  if (/(^|\n)[ \t]*#{1,6}[ \t]+\S/.test(s)) return true
  if (LIST_LINE_RE.test(s)) return true
  if (/(^|\n)[ \t]*(-{3,}|\*{3,}|_{3,})[ \t]*(\n|$)/.test(s)) return true
  if (/(^|\n)[ \t]*(```|~~~)/.test(s)) return true
  if (/\n[ \t]*\n/.test(s.trim())) return true
  return hasInlineMarkdown(s)
}

// ── Block parser ──────────────────────────────────────────────────────

const HEADING_RE = /^[ \t]*(#{1,6})[ \t]+(.*?)[ \t]*#*[ \t]*$/
const THEMATIC_RE = /^[ \t]*(-{3,}|\*{3,}|_{3,})[ \t]*$/
const FENCE_RE = /^[ \t]*(```+|~~~+)[ \t]*(\S*)/
const TASK_RE = /^([ \t]*)[-*+][ \t]+\[([ xX])\][ \t]+(.*)$/
// `[1]` captures the leading indentation (→ nesting depth), `[2]` the item text.
const BULLET_RE = new RegExp(`^([ \\t]*)${BULLET_CLASS}[ \\t]+(.*)$`)
const ORDERED_RE = /^([ \t]*)\d+[.)][ \t]+(.*)$/

/**
 * Cap on list nesting depth — mirrors `MAX_LIST_INDENT` in
 * `views/blocks.ts` (kept local so this module takes no value import on the
 * schema). Wide enough for any real outline; bounds pathological input.
 */
const MAX_LIST_DEPTH = 12

/** Expand a leading-whitespace prefix to a column count (tab = 4 columns) for
 *  relative depth comparison. Only the ORDERING of widths matters to the depth
 *  stack, not the absolute unit, so the exact tab size is immaterial. */
function indentWidth(ws: string): number {
  let w = 0
  for (const ch of ws) w += ch === '\t' ? 4 : 1
  return w
}
const QUOTE_RE = /^[ \t]*>[ \t]?(.*)$/

// ── GFM importer-only constructs (gated on `cfg.gfm`) ──────────────────
// These fire on the faithful `markdownToBlocks` path only — never the
// model-write normalizer, whose behaviour stays byte-identical (see the two
// public entry points at the bottom of the block parser).

const IMAGE_RE = /^[ \t]*!\[([^\]]*)\]\(([^)\s]+)(?:[ \t]+"[^"]*")?\)[ \t]*$/
const TABLE_ROW_RE = /^[ \t]*\|.*\|[ \t]*$/
const TABLE_SEP_RE = /^[ \t]*\|?[ \t]*:?-{1,}:?[ \t]*(?:\|[ \t]*:?-{1,}:?[ \t]*)*\|?[ \t]*$/
const ALERT_RE = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][ \t]*$/i

// `<details>` disclosure → toggle (the toggle-with-children Markdown fixed
// point — `blocksToMarkdown` emits this form). Capture 1: the ` open` flag;
// capture 2: any trailing content on the open-tag line (often `<summary>…`).
const DETAILS_OPEN_RE = /^[ \t]*<details(\s+open)?\s*>[ \t]*(.*)$/i
const DETAILS_CLOSE_RE = /^[ \t]*<\/details>[ \t]*$/i
const SUMMARY_RE = /^[ \t]*<summary>(.*?)<\/summary>[ \t]*(.*)$/i

/** GitHub-alert type → a representative emoji for the imported callout icon. */
const ALERT_ICON: Record<string, string> = {
  NOTE: 'ℹ️',
  TIP: '💡',
  IMPORTANT: '❗',
  WARNING: '⚠️',
  CAUTION: '🛑',
}

/** Split a GFM table row into trimmed cell strings, honoring `\|` escapes. */
function splitTableRow(line: string): string[] {
  const inner = line.trim().replace(/^\|/, '').replace(/\|[ \t]*$/, '')
  const cells: string[] = []
  let buf = ''
  for (let k = 0; k < inner.length; k++) {
    const ch = inner[k]
    if (ch === '\\' && inner[k + 1] === '|') {
      buf += '|'
      k += 1
      continue
    }
    if (ch === '|') {
      cells.push(buf.trim())
      buf = ''
      continue
    }
    buf += ch
  }
  cells.push(buf.trim())
  return cells
}

function clampLevel(n: number): 1 | 2 | 3 | 4 {
  return (n < 1 ? 1 : n > 4 ? 4 : n) as 1 | 2 | 3 | 4
}

/** Internal parse config: `links` controls inline-link handling; `gfm`
 *  enables the importer-only constructs (tables, images, alerts, mermaid). */
interface ParseConfig {
  links: 'strip' | 'mark'
  gfm: boolean
}

/**
 * Parse a Markdown string into canonical doc blocks with fresh ids.
 * Each produced block is structurally valid against `blockSchema`.
 */
function blocksFromMarkdownImpl(
  src: string,
  genId: () => string,
  cfg: ParseConfig,
): Block[] {
  const lines = src.replace(/\r\n?/g, '\n').split('\n')
  const out: Block[] = []
  let para: string[] = []

  // Active list nesting context — a stack of leading-whitespace column
  // widths, one per open depth. A list item's depth is its position in this
  // stack; the stack is cleared whenever a non-list block (heading, prose,
  // code, …) ends the current list run (`resetList`). Bulleted, numbered and
  // to-do items share it so any kind of sub-list can nest under any item.
  const listIndentStack: number[] = []
  const resetList = () => {
    listIndentStack.length = 0
  }
  /** Push/pop the stack to `w`'s level and return the resulting 0-based depth. */
  const listDepthFor = (w: number): number => {
    while (listIndentStack.length && w < listIndentStack[listIndentStack.length - 1]) {
      listIndentStack.pop()
    }
    if (listIndentStack.length === 0 || w > listIndentStack[listIndentStack.length - 1]) {
      listIndentStack.push(w)
    }
    return Math.min(listIndentStack.length - 1, MAX_LIST_DEPTH)
  }

  const flushPara = () => {
    if (para.length === 0) return
    const joined = para.join(' ').trim()
    para = []
    if (joined) {
      out.push({ kind: 'text', id: genId(), text: inlinePlain(joined) } as TextBlock)
      resetList() // prose ends the current list run
    }
  }

  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (line.trim() === '') {
      flushPara()
      i += 1
      continue
    }

    const fence = FENCE_RE.exec(line)
    if (fence) {
      flushPara()
      resetList()
      const marker = fence[1][0] // ` or ~
      const lang = fence[2] || ''
      const body: string[] = []
      i += 1
      while (i < lines.length && !new RegExp(`^[ \\t]*${marker === '`' ? '```' : '~~~'}`).test(lines[i])) {
        body.push(lines[i])
        i += 1
      }
      if (i < lines.length) i += 1 // consume closing fence
      const code = body.join('\n')
      // A ```mermaid fence is a diagram, not a code block, so a diagram export
      // round-trips back to a diagram (doc-conversion.md §4.2). Importer-only.
      if (cfg.gfm && lang.toLowerCase() === 'mermaid' && code.trim()) {
        out.push({ kind: 'diagram', id: genId(), syntax: 'mermaid', code } as Block)
      } else {
        out.push({ kind: 'code', id: genId(), language: lang.slice(0, 32), code } as Block)
      }
      continue
    }

    const heading = HEADING_RE.exec(line)
    if (heading) {
      flushPara()
      resetList()
      out.push({
        kind: 'heading',
        id: genId(),
        level: clampLevel(heading[1].length),
        text: inlinePlain(heading[2].trim()),
      } as HeadingBlock)
      i += 1
      continue
    }

    if (THEMATIC_RE.test(line)) {
      flushPara()
      resetList()
      out.push({ kind: 'divider', id: genId() } as Block)
      i += 1
      continue
    }

    // `<details>` disclosure → a toggle with children. This is the toggle's
    // Markdown fixed-point form (`blocksToMarkdown` emits it for a toggle
    // with children), and the one structured way a model can author nested
    // toggle content in Markdown. `<summary>` (same line or a later line)
    // becomes the summary richText; the body parses recursively until the
    // MATCHING `</details>` (nested disclosures stay in the body and recurse).
    // An unclosed tag degrades gracefully: everything to EOF is the body.
    const details = DETAILS_OPEN_RE.exec(line)
    if (details) {
      flushPara()
      resetList()
      const expanded = !!details[1]
      let summaryText = ''
      const bodyLines: string[] = []
      let rest = details[2] ?? ''
      const sInline = SUMMARY_RE.exec(rest)
      if (sInline) {
        summaryText = sInline[1]
        rest = sInline[2] ?? ''
      }
      if (rest.trim()) bodyLines.push(rest)
      i += 1
      let depth = 1
      while (i < lines.length && depth > 0) {
        const l = lines[i]
        if (DETAILS_OPEN_RE.test(l)) depth += 1
        else if (DETAILS_CLOSE_RE.test(l)) {
          depth -= 1
          if (depth === 0) {
            i += 1
            break
          }
        }
        if (!summaryText && depth === 1) {
          const s = SUMMARY_RE.exec(l)
          if (s) {
            summaryText = s[1]
            if (s[2]?.trim()) bodyLines.push(s[2])
            i += 1
            continue
          }
        }
        bodyLines.push(l)
        i += 1
      }
      const children = blocksFromMarkdownImpl(bodyLines.join('\n'), genId, cfg)
      const block: Record<string, unknown> = {
        kind: 'toggle',
        id: genId(),
        richText: inlineRich(summaryText.trim(), cfg.links),
      }
      if (expanded) block.expanded = true
      if (children.length) block.children = children
      out.push(block as Block)
      continue
    }

    // Standalone image line → a bookmark (link card). The doc `image` block
    // requires a stored MediaRef (bucket/mimeType); re-hosting an external URL
    // into one is an API-layer concern (Phase 1), so the pure importer keeps
    // the URL as a clickable card. Importer-only.
    if (cfg.gfm) {
      const image = IMAGE_RE.exec(line)
      if (image) {
        flushPara()
        resetList()
        out.push({
          kind: 'bookmark',
          id: genId(),
          url: image[2],
          ...(image[1] ? { meta: { title: image[1] } } : {}),
        } as Block)
        i += 1
        continue
      }
    }

    // GFM table: a pipe row immediately followed by a `| --- |` separator.
    // Row 0 is the header (GFM has no headerless table). Importer-only.
    if (
      cfg.gfm &&
      TABLE_ROW_RE.test(line) &&
      i + 1 < lines.length &&
      TABLE_SEP_RE.test(lines[i + 1])
    ) {
      flushPara()
      resetList()
      const rowsCells: string[][] = [splitTableRow(line)]
      i += 2 // consume header + separator
      while (i < lines.length && TABLE_ROW_RE.test(lines[i]) && !TABLE_SEP_RE.test(lines[i])) {
        rowsCells.push(splitTableRow(lines[i]))
        i += 1
      }
      const width = rowsCells.reduce((m, r) => Math.max(m, r.length), 0)
      const rows = rowsCells.map((cells) =>
        Array.from({ length: width }, (_u, c) => inlineRich((cells[c] ?? '').trim(), cfg.links)),
      )
      out.push({ kind: 'table', id: genId(), rows, hasHeaderRow: true } as Block)
      continue
    }

    const quote = QUOTE_RE.exec(line)
    if (quote) {
      flushPara()
      resetList()
      const qlines: string[] = [quote[1]]
      i += 1
      while (i < lines.length && QUOTE_RE.test(lines[i])) {
        qlines.push((QUOTE_RE.exec(lines[i]) as RegExpExecArray)[1])
        i += 1
      }
      // A GFM alert (`> [!NOTE]`) imports as a callout; a plain blockquote a
      // quote. Alert detection is importer-only — the normalizer keeps quotes.
      const alert = cfg.gfm ? ALERT_RE.exec(qlines[0].trim()) : null
      const bodyLines = (alert ? qlines.slice(1) : qlines).filter((l) => l.trim() !== '')
      const content = bodyLines.map((l) => paragraphFrom(l.trim(), cfg.links))
      const richText = {
        type: 'doc',
        content: content.length > 0 ? content : [{ type: 'paragraph' }],
      } as unknown as RichTextContent
      if (alert) {
        out.push({ kind: 'callout', id: genId(), icon: ALERT_ICON[alert[1].toUpperCase()], richText } as Block)
      } else {
        out.push({ kind: 'quote', id: genId(), richText } as Block)
      }
      continue
    }

    const task = TASK_RE.exec(line)
    if (task) {
      flushPara()
      const depth = listDepthFor(indentWidth(task[1]))
      const block = {
        kind: 'to_do',
        id: genId(),
        checked: task[2] !== ' ',
        richText: inlineRich(task[3].trim(), cfg.links),
      } as Block
      if (depth > 0) (block as { indent?: number }).indent = depth
      out.push(block)
      i += 1
      continue
    }

    const bullet = BULLET_RE.exec(line)
    if (bullet) {
      flushPara()
      const depth = listDepthFor(indentWidth(bullet[1]))
      const block = {
        kind: 'bulleted_list_item',
        id: genId(),
        richText: inlineRich(bullet[2].trim(), cfg.links),
      } as Block
      if (depth > 0) (block as { indent?: number }).indent = depth
      out.push(block)
      i += 1
      continue
    }

    const ordered = ORDERED_RE.exec(line)
    if (ordered) {
      flushPara()
      const depth = listDepthFor(indentWidth(ordered[1]))
      const block = {
        kind: 'numbered_list_item',
        id: genId(),
        richText: inlineRich(ordered[2].trim(), cfg.links),
      } as Block
      if (depth > 0) (block as { indent?: number }).indent = depth
      out.push(block)
      i += 1
      continue
    }

    resetList() // prose line ends the current list run
    para.push(line.trim())
    i += 1
  }
  flushPara()
  return out
}

/**
 * Model-write normalizer entry point — **unchanged behaviour**: expand
 * Markdown crammed into a `text` / `heading` block into canonical blocks,
 * dropping inline links to their label and skipping the GFM-importer
 * constructs (so the production-tuned write path is byte-identical).
 */
export function blocksFromMarkdown(src: string, genId: () => string = defaultGenerateId): Block[] {
  return blocksFromMarkdownImpl(src, genId, { links: 'strip', gfm: false })
}

export interface MarkdownToBlocksOptions {
  genId?: () => string
  /** Keep inline links as Tiptap link marks on rich-text kinds. Default true
   *  (this is the faithful file importer). Set false to match the normalizer. */
  preserveLinks?: boolean
}

/**
 * The faithful **importer** entry point (journeys A / F): parse a real
 * Markdown (or docx-derived Markdown) document into canonical blocks —
 * covering GFM tables, standalone images, alerts → callouts, mermaid →
 * diagrams, and inline links. Same core as `blocksFromMarkdown`, with the
 * GFM constructs enabled and links preserved by default.
 *
 * Spec: docs/architecture/features/doc-conversion.md §4.2.
 */
export function markdownToBlocks(src: string, opts: MarkdownToBlocksOptions = {}): Block[] {
  return blocksFromMarkdownImpl(src, opts.genId ?? defaultGenerateId, {
    links: opts.preserveLinks === false ? 'strip' : 'mark',
    gfm: true,
  })
}

// ── Block-level expansion ─────────────────────────────────────────────

/**
 * Expand a single `text` / `heading` block whose plain text carries
 * Markdown into the canonical blocks it describes. Non-prose kinds and
 * Markdown-free prose pass through unchanged (returns `[block]`, same id).
 * The first produced block inherits the original block's id; the rest get
 * fresh ids from `genId`.
 */
export function expandTextOrHeadingBlock(
  block: Block,
  genId: () => string = defaultGenerateId,
): Block[] {
  if (block.kind === 'heading') {
    const text = block.text ?? ''
    const nl = text.indexOf('\n')
    const firstLine = nl >= 0 ? text.slice(0, nl) : text
    const rest = nl >= 0 ? text.slice(nl + 1) : ''
    const hm = HEADING_RE.exec(firstLine)
    const headText = inlinePlain((hm ? hm[2] : firstLine).trim())
    const level = hm ? clampLevel(hm[1].length) : block.level
    const restBlocks = rest.trim() ? blocksFromMarkdown(rest, genId) : []
    // Nothing to do: no leading #, no spill, no inline marks → keep as-is.
    if (!hm && restBlocks.length === 0 && headText === text) return [block]
    const head: HeadingBlock = { kind: 'heading', id: block.id, level, text: headText }
    return [head, ...restBlocks]
  }

  if (block.kind === 'text') {
    const text = block.text ?? ''
    if (!hasBlockMarkdown(text)) return [block]
    const segs = blocksFromMarkdown(text, genId)
    if (segs.length === 0) return [block]
    const first: Block = { ...segs[0], id: block.id }
    if (first.kind === 'text' && block.variant) first.variant = block.variant
    return [first, ...segs.slice(1)]
  }

  return [block]
}

/**
 * `renderPage` path: expand every Markdown-bearing `text` / `heading`
 * block in a block list into its canonical blocks.
 */
export function normalizeMarkdownBlocks(
  blocks: Block[],
  genId: () => string = defaultGenerateId,
): Block[] {
  return blocks.flatMap((b) => expandTextOrHeadingBlock(b, genId))
}

// ── Op-level expansion (patchPage) ────────────────────────────────────

/** Expand an `add`'s block; when it splits, give ALL blocks fresh real ids
 *  so the chained `after` anchors resolve on both write paths. */
function expandForAdd(block: Block, genId: () => string): Block[] {
  const segs = expandTextOrHeadingBlock(block, genId)
  if (segs.length <= 1) return segs
  return segs.map((s) => ({ ...s, id: genId() }))
}

/**
 * Expand an `edit` op whose `patch.text` carries Markdown. `edit` cannot
 * re-discriminate a block (ops.ts forces `id` + `kind`), so:
 *   - single segment, same kind  → one in-place `edit` (clean text / level)
 *   - multi-segment / kind change → `delete` + chained `add`s at the
 *     target's prior-neighbour anchor (this is what turns a `### …` blob
 *     into a real Heading 3 + split paragraphs)
 * Falls back to a plain-text strip when the target isn't found or isn't a
 * prose kind.
 */
function expandForEdit(
  op: Extract<Op, { op: 'edit' }>,
  currentPage: Page,
  genId: () => string,
): Op[] {
  const patch = op.patch as Record<string, unknown>
  const text = patch.text as string
  const idx = currentPage.blocks.findIndex((b) => b.id === op.blockId)
  const target = idx >= 0 ? currentPage.blocks[idx] : undefined

  if (!target || (target.kind !== 'text' && target.kind !== 'heading')) {
    // A `text` patch aimed at a list / quote / callout / toggle block: those
    // kinds store content as opaque `richText`, so a literal `text` key would
    // be stripped (or ignored) and the block would render empty — the same
    // failure `liftListItemText` guards on the create path, here on the
    // `patchPage` edit path. Convert it to the canonical `richText` patch
    // (parsing inline marks) and drop the stray `text`.
    if (target && RICHTEXT_KINDS.has(target.kind)) {
      const rest = { ...patch }
      delete rest.text
      return [
        {
          op: 'edit',
          blockId: op.blockId,
          patch: { ...rest, richText: inlineRich(text.trim()) },
        },
      ]
    }
    if (hasInlineMarkdown(text)) {
      return [{ op: 'edit', blockId: op.blockId, patch: { ...patch, text: inlinePlain(text) } }]
    }
    return [op]
  }
  if (target.kind === 'text' && !hasBlockMarkdown(text)) return [op]

  const synthetic: Block =
    target.kind === 'heading'
      ? { kind: 'heading', id: target.id, level: target.level, text }
      : { kind: 'text', id: target.id, text, ...(target.variant ? { variant: target.variant } : {}) }
  const segs = expandTextOrHeadingBlock(synthetic, genId)
  if (segs.length === 0) return [op]

  if (segs.length === 1 && segs[0].kind === target.kind) {
    const seg = segs[0]
    const clean: Record<string, unknown> =
      seg.kind === 'heading' ? { text: seg.text, level: seg.level } : { text: (seg as TextBlock).text }
    return [{ op: 'edit', blockId: op.blockId, patch: { ...patch, ...clean } }]
  }

  const anchorBase: BlockId | 'start' = idx <= 0 ? 'start' : currentPage.blocks[idx - 1].id
  const fresh = segs.map((s) => ({ ...s, id: genId() }))
  const ops: Op[] = [{ op: 'delete', blockId: op.blockId }]
  let anchor: BlockId | 'start' | 'end' = anchorBase
  for (const blk of fresh) {
    ops.push({ op: 'add', after: anchor, block: blk })
    anchor = blk.id
  }
  return ops
}

/**
 * `patchPage` path: rewrite an op list so any Markdown that lands in a
 * `text` / `heading` block (via `add` or `edit`) is expanded into canonical
 * blocks. `currentPage` supplies the target kind / position needed to
 * expand `edit` ops. Non-prose ops pass through verbatim.
 */
export function normalizeMarkdownOps(
  ops: Ops,
  currentPage: Page,
  genId: () => string = defaultGenerateId,
): Ops {
  const out: Op[] = []
  for (const op of ops) {
    if (op.op === 'add' && (op.block.kind === 'text' || op.block.kind === 'heading')) {
      // Always rebuild from the expanded blocks: a single block may have
      // been cleaned in place (inline `**bold**` → `bold`, same id); a
      // multi-block split chains `after` anchors off fresh real ids.
      const expanded = expandForAdd(op.block, genId)
      // An `add` op with no `after` means "append at the end" (identical to
      // `after: 'end'`; see ops.ts insertionIndex). Default it so the first
      // expanded block keeps that semantics and later blocks chain off it.
      let anchor: BlockId | 'start' | 'end' = op.after ?? 'end'
      for (const blk of expanded) {
        out.push({ op: 'add', after: anchor, block: blk })
        anchor = blk.id
      }
      continue
    }
    if (op.op === 'edit' && typeof (op.patch as Record<string, unknown>).text === 'string') {
      out.push(...expandForEdit(op, currentPage, genId))
      continue
    }
    out.push(op)
  }
  return out
}

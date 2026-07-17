/**
 * Pure, dependency-light conversion between the legacy 18-kind doc
 * `Block[]` model and a ProseMirror document JSON. No `prosemirror-model` or
 * Yjs import here — this is plain JSON in/out so it unit-tests trivially and
 * stays usable on both the client and server.
 *
 * Two structural transforms matter:
 *   - **List grouping.** The legacy model is a flat list of `*_list_item`
 *     blocks; ProseMirror nests `listItem`/`taskItem` under a `bulletList` /
 *     `orderedList` / `taskList` parent. `blocksToPMDoc` groups consecutive
 *     same-kind items into one list; `pmDocToBlocks` flattens them back, in
 *     order, with each item's `blockId` preserved.
 *   - **Embeds.** Every non-prose kind (data/chart/image/file/bookmark/
 *     child_page/video/audio/extraction_slot) collapses to one `embed` atom
 *     carrying the original block JSON as a string — a lossless, id-preserving
 *     round-trip.
 *
 * `canonicalizeBlock` is the documented canonical form: it fills the defaults
 * the round-trip applies (empty `richText` → one empty paragraph, `variant`
 * dropped when unset, booleans coerced). `pmDocToBlocks(blocksToPMDoc(b))`
 * equals `b.map(canonicalizeBlock)` — that's the contract the tests assert.
 *
 * [COMP:doc-model/mapping]
 */

import type {
  Block,
  Page,
  RichTextContent,
  TableBlock,
} from '@use-brian/core/dist/views/blocks.js'

// Loose JSON node — we never construct prosemirror-model nodes here.
export type PMNode = {
  type: string
  attrs?: Record<string, unknown>
  content?: PMNode[]
  text?: string
  marks?: unknown[]
}
export type PMDoc = { type: 'doc'; content: PMNode[] }

const LIST_ITEM_KINDS = new Set([
  'bulleted_list_item',
  'numbered_list_item',
  'to_do',
])

const LIST_WRAPPER_TYPES = new Set(['bulletList', 'orderedList', 'taskList'])

/** True for a ProseMirror list-container node. */
function isListNode(n: PMNode): boolean {
  return LIST_WRAPPER_TYPES.has(n.type)
}

/** A block's nesting depth as authored — bulleted/numbered items and to-dos
 *  all carry an optional 0-based `indent` (`TaskItem({ nested: true })`). */
function rawIndent(block: Block): number {
  const indent = (block as { indent?: number }).indent
  return typeof indent === 'number' && indent > 0 ? Math.floor(indent) : 0
}

/**
 * Clamp a list run's per-item depths so the first item is 0 and each is at most
 * one level deeper than its predecessor — the well-formedness a real nested
 * list satisfies. A model that emits an orphan jump (depth 0 then depth 3)
 * lands the deep item one level under the previous, never floating. `pmDoc`
 * recovery reads depth back from structure, so this is also the form
 * `canonicalizeBlock` must mirror per-block for the round-trip contract.
 */
function normalizeRunDepths(run: Block[]): number[] {
  const depths: number[] = []
  let maxAllowed = 0
  for (const b of run) {
    const d = Math.min(rawIndent(b), maxAllowed)
    depths.push(d)
    maxAllowed = d + 1
  }
  return depths
}

const emptyParagraph = (): PMNode => ({ type: 'paragraph' })

function genId(): string {
  return crypto.randomUUID()
}

/** richText is opaque Tiptap JSON: the old per-block editors stored
 *  `editor.getJSON()` = `{ type: 'doc', content: [...] }`. Return its inner
 *  block content, or a single empty paragraph when absent/empty. The result
 *  always starts with a paragraph so it satisfies listItem/taskItem content. */
function richTextToContent(rt: RichTextContent | undefined): PMNode[] {
  const content = (rt as { content?: PMNode[] } | undefined)?.content
  if (Array.isArray(content) && content.length > 0) return content
  return [emptyParagraph()]
}

function contentToRichText(content: PMNode[] | undefined): RichTextContent {
  return { type: 'doc', content: content ?? [emptyParagraph()] } as unknown as RichTextContent
}

/**
 * Render a mention node to its inline text form — mirrors the
 * `renderText` contract on the shared schema's `personMention` /
 * `pageMention` nodes (`@<name>` / `📄 <title>`). Used so that `text` /
 * `heading` blocks — whose storage shape is a flat `text` string, not
 * rich JSON — still carry a mention's label into the server-side
 * snapshot (search, outline, the AI's read) instead of dropping it.
 */
function mentionToText(n: PMNode): string | null {
  if (n.type === 'personMention') {
    const name = (n.attrs?.name as string) || (n.attrs?.id as string) || ''
    return `@${name}`
  }
  if (n.type === 'pageMention') {
    const title = (n.attrs?.title as string) || (n.attrs?.id as string) || ''
    return `📄 ${title}`
  }
  return null
}

function inlineText(content: PMNode[] | undefined): string {
  if (!content) return ''
  let out = ''
  for (const n of content) {
    if (typeof n.text === 'string') out += n.text
    else {
      const mention = mentionToText(n)
      if (mention !== null) out += mention
      else if (n.content) out += inlineText(n.content)
    }
  }
  return out
}

/**
 * Flatten a page's body to readable plaintext — one line per top-level block,
 * mention labels inlined (`@name` / `📄 Title`), blank blocks dropped. Used as
 * the source text for auto-title (the human + AI triggers both summarise this).
 *
 * Goes through `blocksToPMDoc` so every block kind + nested list + mention is
 * handled by the same canonical conversion the editor uses — no per-kind
 * special-casing here. Opaque blocks (data/chart/image/file/bookmark/
 * child_page collapse to an `embed` atom with no text content, divider →
 * `horizontalRule`) naturally contribute nothing, which is what we want: a
 * title should come from prose, not from a table's serialized binding.
 *
 * See docs/architecture/features/doc.md → "Auto-title".
 */
/** Container nodes whose children are block-level (each gets its own line). */
const CONTAINER_NODE_TYPES = new Set(['toggle', 'callout', 'blockquote'])

export function pageToPlaintext(page: Page): string {
  const doc = blocksToPMDoc(page.blocks)
  const lines: string[] = []
  const walkBlock = (node: PMNode): void => {
    // List wrappers (bulletList/orderedList/taskList) hold block-level items —
    // emit each on its own line so consecutive items don't merge into one
    // run-on token ("firstsecond"). Each item's own text excludes its child
    // lists (those become their own lines), so nesting never merges either.
    if (isListNode(node)) {
      for (const item of node.content ?? []) {
        const own = (item.content ?? []).filter((c) => !isListNode(c))
        const itemText = inlineText(own).trim()
        if (itemText) lines.push(itemText)
        for (const child of item.content ?? []) {
          if (isListNode(child)) walkBlock(child)
        }
      }
      return
    }
    if (node.type === 'table') {
      // One line per row; cells joined by a space so a table contributes its
      // text to auto-title + search instead of merging into one run-on token.
      for (const rowNode of node.content ?? []) {
        const cells = (rowNode.content ?? [])
          .map((cell) => inlineText(cell.content).trim())
          .filter(Boolean)
        if (cells.length) lines.push(cells.join(' '))
      }
      return
    }
    // Containers (toggle/callout/blockquote) hold block-level children — one
    // line each (summary first), so a toggle's body never merges into the
    // summary as one run-on token.
    if (CONTAINER_NODE_TYPES.has(node.type)) {
      for (const child of node.content ?? []) walkBlock(child)
      return
    }
    const line = inlineText(node.content).trim()
    if (line) lines.push(line)
  }
  for (const node of doc.content) walkBlock(node)
  return lines.join('\n')
}

// ── Block → ProseMirror node ──────────────────────────────────────────

function listItemNode(block: Block): PMNode {
  if (block.kind === 'to_do') {
    return {
      type: 'taskItem',
      attrs: { blockId: block.id, checked: !!block.checked },
      // Fresh array (`[...]`): `richTextToContent` returns the block's own
      // content array by reference, and `buildListForest` pushes nested list
      // wrappers into an item's content — copying keeps that from mutating the
      // caller's input block.
      content: [...richTextToContent(block.richText)],
    }
  }
  // bulleted_list_item | numbered_list_item
  return {
    type: 'listItem',
    attrs: { blockId: block.id },
    content: [
      ...richTextToContent((block as { richText?: RichTextContent }).richText),
    ],
  }
}

function listWrapper(kind: string, items: PMNode[]): PMNode {
  if (kind === 'bulleted_list_item') return { type: 'bulletList', content: items }
  if (kind === 'numbered_list_item') return { type: 'orderedList', content: items }
  return { type: 'taskList', content: items }
}

// ── Simple table ──────────────────────────────────────────────────────
//
// A `table` block is NOT an embed — its cells are real `paragraph+` nodes so
// they co-edit through y-prosemirror. The block model stores a row-major grid
// of cell rich-text + two header flags; the PM tree stores `tableHeader` vs
// `tableCell` node types. The two are bridged here. A cell is a header iff it
// sits in the header row or the header column:
//   isHeader(r, c) = (hasHeaderRow && r === 0) || (hasHeaderColumn && c === 0)

/**
 * Recover `{ hasHeaderRow, hasHeaderColumn }` from a grid of per-cell
 * header booleans. Exact for any table with ≥2 rows AND ≥2 columns (the
 * normal case). On a single-row or single-column table the two flags are not
 * independently distinguishable from cell types alone; this resolves the tie
 * toward a header ROW. The round-trip CONTRACT holds regardless, because
 * `canonicalizeBlock` runs this same derivation over the same grid.
 */
function deriveHeaderFlags(grid: boolean[][]): {
  hasHeaderRow: boolean
  hasHeaderColumn: boolean
} {
  const rows = grid.length
  const cols = grid[0]?.length ?? 0
  const hasHeaderRow = rows > 0 && cols > 0 && grid[0].every(Boolean)
  const hasHeaderColumn =
    rows > 0 &&
    cols > 0 &&
    grid.every((row) => !!row[0]) &&
    !(hasHeaderRow && rows === 1)
  return { hasHeaderRow, hasHeaderColumn }
}

/** Block → `table > tableRow > (tableHeader|tableCell) > paragraph+`. Rows are
 *  padded to a rectangular width so the emitted PM table is always valid
 *  (`prosemirror-tables` rejects ragged tables). */
function tableToNode(block: TableBlock): PMNode {
  const width = block.rows.reduce((m, row) => Math.max(m, row.length), 0)
  return {
    type: 'table',
    attrs: { blockId: block.id },
    content: block.rows.map((row, r) => ({
      type: 'tableRow',
      content: Array.from({ length: width }, (_unused, c) => ({
        type:
          (block.hasHeaderRow && r === 0) || (block.hasHeaderColumn && c === 0)
            ? 'tableHeader'
            : 'tableCell',
        content: richTextToContent(row[c]),
      })),
    })),
  }
}

/** `table` PM node → `TableBlock`, recovering the header flags from the cell
 *  node types. */
function tableNodeToBlock(node: PMNode, id: string): Block {
  const rowNodes = node.content ?? []
  const grid = rowNodes.map((rowNode) =>
    (rowNode.content ?? []).map((cell) => cell.type === 'tableHeader'),
  )
  const rows = rowNodes.map((rowNode) =>
    (rowNode.content ?? []).map((cell) => contentToRichText(cell.content)),
  )
  return { kind: 'table', id, rows, ...deriveHeaderFlags(grid) } as Block
}

/** Map a single non-list block to its ProseMirror node. */
export function blockToNode(block: Block): PMNode {
  switch (block.kind) {
    case 'text': {
      const attrs: Record<string, unknown> = { blockId: block.id }
      if (block.variant) attrs.variant = block.variant
      return {
        type: 'paragraph',
        attrs,
        ...(block.text ? { content: [{ type: 'text', text: block.text }] } : {}),
      }
    }
    case 'heading':
      return {
        type: 'heading',
        attrs: { blockId: block.id, level: block.level },
        ...(block.text ? { content: [{ type: 'text', text: block.text }] } : {}),
      }
    case 'divider':
      return { type: 'horizontalRule', attrs: { blockId: block.id } }
    case 'code':
      return {
        type: 'codeBlock',
        attrs: { blockId: block.id, language: block.language || null },
        ...(block.code ? { content: [{ type: 'text', text: block.code }] } : {}),
      }
    case 'quote':
      return {
        type: 'blockquote',
        attrs: { blockId: block.id },
        content: richTextToContent(block.richText),
      }
    // Containers: the `richText` line(s) first, then the nested `children`
    // blocks (list runs grouped exactly like the top level). A legacy block
    // whose richText carries the whole body (pre-children shape) renders
    // identically — richTextToContent spreads every node it holds.
    case 'callout':
      return {
        type: 'callout',
        attrs: { blockId: block.id, icon: block.icon },
        content: [
          ...richTextToContent(block.richText),
          ...(block.children?.length ? blocksToNodes(block.children) : []),
        ],
      }
    case 'toggle':
      return {
        type: 'toggle',
        attrs: { blockId: block.id, open: !!block.expanded },
        content: [
          ...richTextToContent(block.richText),
          ...(block.children?.length ? blocksToNodes(block.children) : []),
        ],
      }
    case 'bulleted_list_item':
    case 'numbered_list_item':
    case 'to_do':
      // A lone list item still needs a list wrapper to be schema-valid.
      return listWrapper(block.kind, [listItemNode(block)])
    case 'table':
      return tableToNode(block)
    default:
      // data | chart | image | file | bookmark | child_page | video | audio |
      // extraction_slot → opaque embed. `extraction_slot` is a non-prose
      // authoring directive (a blueprint section's extraction instruction), so
      // it rides the same lossless JSON embed atom as every other non-prose
      // kind — no dedicated ProseMirror node, hence no byte-for-byte Yjs schema
      // change. The app-web embed node-view dispatches it to a richer renderer.
      return {
        type: 'embed',
        attrs: { blockId: block.id, block: JSON.stringify(block) },
      }
  }
}

/**
 * Build the top-level list wrapper(s) for a contiguous run of list-item blocks,
 * nesting bulleted/numbered items by their `indent` depth. A run can interleave
 * kinds: a kind change at depth 0 opens a sibling wrapper (so flat
 * `bullet,bullet,number` still yields a `bulletList` then an `orderedList`), and
 * a deeper item opens a child list inside its parent item (to-dos included —
 * `TaskItem({ nested: true })`).
 */
function buildListForest(run: Block[]): PMNode[] {
  const depths = normalizeRunDepths(run)
  const roots: PMNode[] = []
  // One open frame per depth currently in scope (top = deepest). `lastItem` is
  // where a deeper child list attaches.
  type Frame = { depth: number; kind: string; wrapper: PMNode; lastItem: PMNode | null }
  const stack: Frame[] = []
  for (let k = 0; k < run.length; k++) {
    const block = run[k]
    const d = depths[k]
    const kind = block.kind
    while (stack.length && stack[stack.length - 1].depth > d) stack.pop()
    // Same depth, different kind → close it so a sibling wrapper opens.
    if (stack.length && stack[stack.length - 1].depth === d && stack[stack.length - 1].kind !== kind) {
      stack.pop()
    }
    let top = stack[stack.length - 1] as Frame | undefined
    if (!top || top.depth < d) {
      const wrapper = listWrapper(kind, [])
      if (!top) {
        roots.push(wrapper) // depth 0
      } else if (top.lastItem) {
        ;(top.lastItem.content ??= []).push(wrapper) // nest under the parent item
      } else {
        roots.push(wrapper) // degenerate (no parent item) — keep it visible
      }
      const frame: Frame = { depth: d, kind, wrapper, lastItem: null }
      stack.push(frame)
      top = frame
    }
    const item = listItemNode(block)
    ;(top.wrapper.content ??= []).push(item)
    top.lastItem = item
  }
  return roots
}

/** Blocks → PM nodes with list-run grouping — the body of `blocksToPMDoc`,
 *  reused recursively for a container's `children`. */
function blocksToNodes(blocks: Block[]): PMNode[] {
  const content: PMNode[] = []
  let i = 0
  while (i < blocks.length) {
    if (LIST_ITEM_KINDS.has(blocks[i].kind)) {
      // Consume the whole contiguous list run (any list kinds) and build its
      // nested tree in one pass — grouping + nesting live in `buildListForest`.
      const run: Block[] = []
      while (i < blocks.length && LIST_ITEM_KINDS.has(blocks[i].kind)) {
        run.push(blocks[i])
        i++
      }
      content.push(...buildListForest(run))
      continue
    }
    content.push(blockToNode(blocks[i]))
    i++
  }
  return content
}

export function blocksToPMDoc(blocks: Block[]): PMDoc {
  const content = blocksToNodes(blocks)
  // A ProseMirror doc requires block+ content; an empty page opens with one
  // empty paragraph (exactly the editor's empty state).
  if (content.length === 0) content.push(emptyParagraph())
  return { type: 'doc', content }
}

// ── ProseMirror node → Block ──────────────────────────────────────────

function itemToBlock(item: PMNode, kind: string, depth = 0): Block {
  const id = (item.attrs?.blockId as string) ?? genId()
  // Key order matters: the migration self-test compares JSON.stringify
  // against `canonicalizeBlock`, whose to_do shape is {kind, id, checked,
  // richText, indent?}.
  const block: Record<string, unknown> = { kind, id }
  if (kind === 'to_do') block.checked = !!item.attrs?.checked
  block.richText = contentToRichText(item.content)
  // 0 is the canonical "top level" — omit it so a flat list round-trips to the
  // same shape it had before nesting existed.
  if (depth > 0) block.indent = depth
  return block as Block
}

export function nodeToBlock(node: PMNode): Block {
  const id = (node.attrs?.blockId as string) ?? genId()
  switch (node.type) {
    case 'paragraph': {
      const blk: Record<string, unknown> = {
        kind: 'text',
        id,
        text: inlineText(node.content),
      }
      if (node.attrs?.variant) blk.variant = node.attrs.variant
      return blk as Block
    }
    case 'heading':
      return {
        kind: 'heading',
        id,
        level: (node.attrs?.level as 1 | 2 | 3 | 4) ?? 1,
        text: inlineText(node.content),
      } as Block
    case 'horizontalRule':
      return { kind: 'divider', id } as Block
    case 'codeBlock':
      return {
        kind: 'code',
        id,
        language: (node.attrs?.language as string) || '',
        code: inlineText(node.content),
      } as Block
    case 'blockquote':
      return { kind: 'quote', id, richText: contentToRichText(node.content) } as Block
    // Containers: the FIRST child is the `richText` line (a toggle's summary,
    // a callout's lead line); everything after it recovers as structured
    // `children` blocks — so the AI reads (and can faithfully rewrite) what a
    // user nested in the editor instead of an opaque multi-block richText.
    case 'callout': {
      const content = node.content ?? []
      const blk: Record<string, unknown> = {
        kind: 'callout',
        id,
        icon: (node.attrs?.icon as string) ?? '💡',
        richText: contentToRichText(content.length ? [content[0]] : undefined),
      }
      const rest = content.slice(1)
      if (rest.length) blk.children = nodesToBlocks(rest)
      return blk as Block
    }
    case 'toggle': {
      const content = node.content ?? []
      const blk: Record<string, unknown> = {
        kind: 'toggle',
        id,
        expanded: !!node.attrs?.open,
        richText: contentToRichText(content.length ? [content[0]] : undefined),
      }
      const rest = content.slice(1)
      if (rest.length) blk.children = nodesToBlocks(rest)
      return blk as Block
    }
    case 'table':
      return tableNodeToBlock(node, id)
    case 'embed':
      return JSON.parse(node.attrs?.block as string) as Block
    default:
      return { kind: 'text', id, text: inlineText(node.content) } as Block
  }
}

/** The list-item block kind a wrapper node holds. */
function itemKindFor(listType: string): string {
  return listType === 'bulletList'
    ? 'bulleted_list_item'
    : listType === 'orderedList'
      ? 'numbered_list_item'
      : 'to_do'
}

/**
 * Flatten a (possibly nested) list wrapper into ordered blocks, recovering each
 * item's `indent` from its structural nesting depth. An item's own paragraph
 * content and its child sub-lists are separated: the item becomes one block at
 * `depth`, then each child list flattens at `depth + 1`.
 */
function flattenList(listNode: PMNode, depth: number, out: Block[]): void {
  const kind = itemKindFor(listNode.type)
  for (const item of listNode.content ?? []) {
    const own: PMNode[] = []
    const childLists: PMNode[] = []
    for (const c of item.content ?? []) {
      if (isListNode(c)) childLists.push(c)
      else own.push(c)
    }
    out.push(itemToBlock({ ...item, content: own }, kind, depth))
    for (const child of childLists) flattenList(child, depth + 1, out)
  }
}

/** PM nodes → blocks with list flattening — the body of `pmDocToBlocks`,
 *  reused recursively for a container's trailing children. */
function nodesToBlocks(nodes: PMNode[]): Block[] {
  const out: Block[] = []
  for (const node of nodes) {
    if (isListNode(node)) {
      flattenList(node, 0, out)
      continue
    }
    out.push(nodeToBlock(node))
  }
  return out
}

export function pmDocToBlocks(doc: PMDoc): Block[] {
  return nodesToBlocks(doc.content ?? [])
}

// ── Canonical form (documented round-trip target) ─────────────────────

export function canonicalizeBlock(block: Block): Block {
  switch (block.kind) {
    case 'text': {
      const o: Record<string, unknown> = { kind: 'text', id: block.id, text: block.text }
      if (block.variant) o.variant = block.variant
      return o as Block
    }
    case 'heading':
      return { kind: 'heading', id: block.id, level: block.level, text: block.text } as Block
    case 'divider':
      return { kind: 'divider', id: block.id } as Block
    case 'code':
      return {
        kind: 'code',
        id: block.id,
        language: block.language || '',
        code: block.code,
      } as Block
    case 'quote':
      return {
        kind: 'quote',
        id: block.id,
        richText: contentToRichText(richTextToContent(block.richText)),
      } as Block
    // Containers mirror the nodeToBlock split: richText keeps only its FIRST
    // node (the summary / lead line); any further richText nodes — the legacy
    // pre-children shape — recover as children, ahead of the declared
    // `children` (fresh ids for those derived blocks; the documented
    // round-trip case is a single-line richText, same caveat as list indent).
    case 'callout': {
      const content = richTextToContent(block.richText)
      const o: Record<string, unknown> = {
        kind: 'callout',
        id: block.id,
        icon: block.icon,
        richText: contentToRichText([content[0] ?? emptyParagraph()]),
      }
      const rest = content.slice(1)
      const children = [
        ...(rest.length ? nodesToBlocks(rest) : []),
        ...(block.children ?? []).map(canonicalizeBlock),
      ]
      if (children.length) o.children = children
      return o as Block
    }
    case 'toggle': {
      const content = richTextToContent(block.richText)
      const o: Record<string, unknown> = {
        kind: 'toggle',
        id: block.id,
        expanded: !!block.expanded,
        richText: contentToRichText([content[0] ?? emptyParagraph()]),
      }
      const rest = content.slice(1)
      const children = [
        ...(rest.length ? nodesToBlocks(rest) : []),
        ...(block.children ?? []).map(canonicalizeBlock),
      ]
      if (children.length) o.children = children
      return o as Block
    }
    case 'bulleted_list_item':
    case 'numbered_list_item': {
      const o: Record<string, unknown> = {
        kind: block.kind,
        id: block.id,
        richText: contentToRichText(
          richTextToContent((block as { richText?: RichTextContent }).richText),
        ),
      }
      // Match `pmDocToBlocks` recovery: a positive depth survives, 0 / absent is
      // dropped. (A `blocksToPMDoc` round-trip clamps illegal jumps; the
      // canonical form here assumes a well-formed depth, the documented case.)
      const indent = (block as { indent?: number }).indent
      if (typeof indent === 'number' && indent > 0) o.indent = Math.floor(indent)
      return o as Block
    }
    case 'to_do': {
      const o: Record<string, unknown> = {
        kind: 'to_do',
        id: block.id,
        checked: !!block.checked,
        richText: contentToRichText(richTextToContent(block.richText)),
      }
      const indent = (block as { indent?: number }).indent
      if (typeof indent === 'number' && indent > 0) o.indent = Math.floor(indent)
      return o as Block
    }
    case 'table': {
      // Pad to a rectangular grid, normalize each cell's rich text, and
      // re-derive the header flags from the SAME grid `tableToNode` builds —
      // so `pmDocToBlocks(blocksToPMDoc(b))` equals this by construction.
      const width = block.rows.reduce((m, row) => Math.max(m, row.length), 0)
      const grid = block.rows.map((row, r) =>
        Array.from(
          { length: width },
          (_unused, c) =>
            (!!block.hasHeaderRow && r === 0) ||
            (!!block.hasHeaderColumn && c === 0),
        ),
      )
      const rows = block.rows.map((row) =>
        Array.from({ length: width }, (_unused, c) =>
          contentToRichText(richTextToContent(row[c])),
        ),
      )
      return {
        kind: 'table',
        id: block.id,
        rows,
        ...deriveHeaderFlags(grid),
      } as Block
    }
    default:
      // embeds: lossless, JSON round-trip clone.
      return JSON.parse(JSON.stringify(block)) as Block
  }
}

export function canonicalizePage(page: Page): Page {
  return { blocks: page.blocks.map(canonicalizeBlock) }
}

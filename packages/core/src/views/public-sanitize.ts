/**
 * Public-share neutralizers — strip identity + storage-path leaks from a
 * page before it is served to an anonymous external viewer.
 *
 * The *data* containment for externally shared pages is the pinned
 * `clearance:'public'` access context (`buildPublicAccessContext`), which
 * the access predicate enforces. These neutralizers handle what the
 * predicate does NOT gate:
 *
 *   - `personMention` nodes in rich text  → plaintext `@name` (drop the
 *     member UUID + avatar URL).
 *   - `pageMention` nodes in rich text    → plaintext title (drop the
 *     target page UUID; Phase 1 does not rewrite cross-page links).
 *   - `child_page` blocks                 → kept (the `childPageId` is the
 *     child's universal share URL); the title is resolved server-side and
 *     access is still gated (child public + an ancestor published).
 *   - media refs (image/file)             → blank `bucket`/`path` so the
 *     storage key never leaves the server; the public route serves bytes
 *     via a token-gated `/media/:blockId` endpoint that re-derives the ref
 *     from the live page. video/audio URLs are blanked (Phase 1.x).
 *   - A2UI `person` widgets               → anonymized (no UUID, no name,
 *     no avatar).
 *   - A2UI `relation` widgets             → keep the public-tier label,
 *     drop the entity UUID.
 *
 * Pure functions over their inputs — no I/O. Both return deep copies; the
 * originals are never mutated.
 *
 * [COMP:doc/public-binding-deps]
 */

import type { Block, RichTextContent } from './blocks.js'
import type { ViewPayload } from './a2ui.js'

// ── Rich-text mention scrubbing ───────────────────────────────────────

/**
 * Deep-walk opaque Tiptap rich-text JSON, replacing `personMention` /
 * `pageMention` inline atoms with plain text nodes. Everything else is
 * copied verbatim. Generic over the JSON shape (the server never owns the
 * Tiptap schema).
 */
function scrubRichTextNode(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(scrubRichTextNode)
  if (node && typeof node === 'object') {
    const obj = node as Record<string, unknown>
    if (obj.type === 'personMention') {
      const attrs = (obj.attrs ?? {}) as Record<string, unknown>
      const name = typeof attrs.name === 'string' && attrs.name ? attrs.name : 'member'
      return { type: 'text', text: `@${name}` }
    }
    if (obj.type === 'pageMention') {
      const attrs = (obj.attrs ?? {}) as Record<string, unknown>
      const title = typeof attrs.title === 'string' && attrs.title ? attrs.title : 'page'
      return { type: 'text', text: title }
    }
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(obj)) out[k] = scrubRichTextNode(v)
    return out
  }
  return node
}

function scrubRichText(
  richText: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!richText) return richText
  return scrubRichTextNode(richText) as Record<string, unknown>
}

// ── Block neutralization ──────────────────────────────────────────────

/**
 * Neutralize a page's blocks for anonymous public viewing. Returns a new
 * array; block order (and count) is preserved so the result stays index-
 * aligned with the public A2UI payload from `renderPage`.
 */
export function neutralizeBlocksForPublic(blocks: Block[]): Block[] {
  return blocks.map((block): Block => {
    switch (block.kind) {
      // Containers: scrub the lead richText AND recurse into the structured
      // `children` blocks — a mention or media ref nested inside a toggle's
      // body must neutralize exactly like a top-level one.
      case 'callout':
      case 'toggle':
        return {
          ...block,
          richText: scrubRichText(block.richText),
          ...(block.children?.length
            ? { children: neutralizeBlocksForPublic(block.children) }
            : {}),
        }
      case 'quote':
      case 'bulleted_list_item':
      case 'numbered_list_item':
        return { ...block, richText: scrubRichText(block.richText) }
      case 'to_do':
        return { ...block, richText: scrubRichText(block.richText) }
      case 'table':
        // Scrub `@mentions` inside every cell — a cell is rich text, so it
        // can carry a member/page UUID exactly like a callout body.
        return {
          ...block,
          rows: block.rows.map((row) =>
            row.map((cell) => scrubRichTextNode(cell) as RichTextContent),
          ),
        }
      case 'child_page':
        // Keep the link target: the child page id is part of the published
        // subtree's universal URL (`/share/p/<childPageId>`). The renderer
        // resolves the title server-side; access is still gated (the child must
        // itself be public + an ancestor published).
        return { kind: 'child_page', id: block.id, childPageId: block.childPageId }
      case 'image':
        return {
          ...block,
          ref: block.ref ? { ...block.ref, bucket: '', path: '' } : null,
        }
      case 'file':
        return {
          ...block,
          ref: block.ref ? { ...block.ref, bucket: '', path: '' } : null,
        }
      case 'video':
      case 'audio':
        // Phase 1.x — blank the URL so a storage/signed path never leaks.
        return { ...block, url: '' }
      case 'data':
        // The renderer paints data/chart from the public A2UI payload, NOT
        // from the block's binding — so drop the binding entirely. Its
        // `filters` (and a workflow_runs binding's `workflowId`) can carry
        // entity UUIDs that would otherwise ride along in the public blocks.
        return { kind: 'data', id: block.id } as unknown as Block
      case 'chart':
        return block.binding
          ? ({ kind: 'chart', id: block.id, chartType: block.chartType, title: block.title } as unknown as Block)
          : block // static, model-authored chart values — safe to keep
      default:
        // text / heading / divider / code / diagram / bookmark — no leak.
        return block
    }
  })
}

// ── A2UI payload neutralization ───────────────────────────────────────

/**
 * Deep-walk a resolved A2UI tree, anonymizing entity-identity widgets:
 *   - `person`   → fixed generic chip (no member UUID, name, or avatar).
 *   - `relation` → keep the (public-tier) label, drop the entity UUID.
 * Everything else is copied verbatim.
 */
function scrubWidget(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(scrubWidget)
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>
    if (obj.type === 'person') {
      return { type: 'person', id: '', name: 'Member', initials: '?' }
    }
    if (obj.type === 'relation') {
      return { ...obj, id: '' }
    }
    if (obj.type === 'files') {
      // FileRefs carry GCS `bucket`/`path` storage keys, and public
      // data-widget files have no token-gated serving path in Phase 1 —
      // drop them entirely.
      return { type: 'files', files: [] }
    }
    if (obj.type === 'image') {
      // Blank any storage/signed `src`; A2UI widget images aren't served
      // publicly (page image *blocks* go through the token-gated media route).
      return { type: 'image', src: '' }
    }
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(obj)) out[k] = scrubWidget(v)
    return out
  }
  return value
}

/**
 * Neutralize a rendered ViewPayload for anonymous public viewing. The
 * data values themselves are already public-tier (the render ran under
 * `buildPublicAccessContext`); this only strips residual entity UUIDs
 * from `person` / `relation` cells.
 */
export function neutralizePublicPayload(payload: ViewPayload): ViewPayload {
  return {
    a2ui: payload.a2ui,
    root: scrubWidget(payload.root) as ViewPayload['root'],
  }
}

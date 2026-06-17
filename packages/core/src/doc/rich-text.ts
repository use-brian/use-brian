/**
 * Shared inline walker over the opaque Tiptap `richText` the structured block
 * kinds (quote / callout / list items / toggle / table cells) store. Flattens
 * the `{ type:'doc', content:[paragraph, …] }` tree into a flat list of inline
 * **segments** carrying their marks — the one representation both serializers
 * consume: `blocksToMarkdown` (→ Markdown emphasis) and `blocksToDocx`
 * (→ docx `TextRun` flags).
 *
 * It mirrors `@sidanclaw/doc-model`'s `block-mapping.ts` mention contract
 * (`@name` / `📄 Title`) so a mention survives serialization as its label
 * instead of vanishing — but it lives in `core` (not `doc-model`) because the
 * docx writer is node-only and `core` is the import-safe base both serializers
 * share. `doc-model` keeps `pageToPlaintext` (a *plaintext* walker that drops
 * marks); this one is the *marked* walker.
 *
 * Pure + dependency-light: plain JSON in, plain segments out. No
 * prosemirror-model, no docx, no Yjs.
 *
 * [COMP:doc/rich-text]
 */

import type { RichTextContent } from './page-types.js'

/** A run of text with its (flat, non-nested) inline marks. */
export interface InlineSegment {
  text: string
  bold?: boolean
  italic?: boolean
  code?: boolean
  strike?: boolean
  /** Link href when the run carries a Tiptap `link` mark. */
  link?: string
}

/** Loose inline-node shape — we never build prosemirror-model nodes here. */
type Node = {
  type?: string
  text?: string
  marks?: { type?: string; attrs?: Record<string, unknown> }[]
  attrs?: Record<string, unknown>
  content?: Node[]
}

/** A mention node → its inline label, mirroring `block-mapping.ts`. */
function mentionLabel(n: Node): string | null {
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

/** Read a text node's marks into segment flags + an optional link href. */
function segmentFromText(n: Node): InlineSegment {
  const seg: InlineSegment = { text: n.text ?? '' }
  for (const mark of n.marks ?? []) {
    switch (mark.type) {
      case 'bold':
        seg.bold = true
        break
      case 'italic':
        seg.italic = true
        break
      case 'code':
        seg.code = true
        break
      case 'strike':
        seg.strike = true
        break
      case 'link': {
        const href = mark.attrs?.href
        if (typeof href === 'string' && href) seg.link = href
        break
      }
    }
  }
  return seg
}

/**
 * Walk one inline content array (a paragraph's children) into segments.
 * Mentions inline as a label segment; a `hardBreak` becomes a space (Phase 0
 * single-line simplification — see docs/architecture/features/doc-conversion.md).
 * Nested content (defensive) recurses.
 */
function walkInline(content: Node[] | undefined, out: InlineSegment[]): void {
  if (!content) return
  for (const n of content) {
    if (typeof n.text === 'string') {
      out.push(segmentFromText(n))
      continue
    }
    if (n.type === 'hardBreak') {
      out.push({ text: ' ' })
      continue
    }
    const label = mentionLabel(n)
    if (label !== null) {
      out.push({ text: label })
      continue
    }
    if (n.content) walkInline(n.content, out)
  }
}

/**
 * Flatten a block's opaque `richText` into inline segments. Paragraph
 * boundaries are joined with a single space (the structured kinds that store
 * `richText` render as one inline run in both Markdown and docx). Returns an
 * empty array for absent / empty rich text.
 */
export function extractInlineSegments(
  rt: RichTextContent | undefined,
): InlineSegment[] {
  const doc = rt as { content?: Node[] } | undefined
  const blocks = doc?.content
  if (!Array.isArray(blocks) || blocks.length === 0) return []
  const out: InlineSegment[] = []
  blocks.forEach((para, idx) => {
    if (idx > 0) out.push({ text: ' ' })
    // A paragraph's inline children live in `.content`; a bare text leaf
    // (defensive) is handled by treating the node itself as inline.
    walkInline(para.content ?? [para], out)
  })
  return out
}

/** The plain concatenation of a rich text's visible characters (marks dropped). */
export function richTextToPlain(rt: RichTextContent | undefined): string {
  return extractInlineSegments(rt)
    .map((s) => s.text)
    .join('')
}

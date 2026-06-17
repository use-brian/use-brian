/**
 * Markdown directive codec for the non-prose embed blocks. The AI authors a
 * page as markdown; prose maps to standard markdown (handled by tiptap-markdown
 * in the editor), and each embed block round-trips through a CommonMark-style
 * directive carrying its block JSON — losslessly, so the binding/config and id
 * survive. The browser node-views + the server AI client share this grammar.
 *
 * `:::data {json}` / `:::chart {json}` / `::child-page {json}` / `::image …`
 * / `::file …` / `::bookmark …`.
 *
 * [COMP:app-web/markdown]
 */

import type { Block } from '@/lib/api/views'

export type EmbedBlock = Extract<
  Block,
  { kind: 'data' | 'chart' | 'child_page' | 'image' | 'file' | 'bookmark' }
>

const DIRECTIVE_BY_KIND: Record<EmbedBlock['kind'], string> = {
  data: 'data',
  chart: 'chart',
  child_page: 'child-page',
  image: 'image',
  file: 'file',
  bookmark: 'bookmark',
}

const KIND_BY_DIRECTIVE: Record<string, EmbedBlock['kind']> = {
  data: 'data',
  chart: 'chart',
  'child-page': 'child_page',
  image: 'image',
  file: 'file',
  bookmark: 'bookmark',
}

const DIRECTIVE_RE = /^:::(data|chart|child-page|image|file|bookmark)\s+(\{.*\})$/

/** Serialize an embed block to a single-line directive carrying its JSON. */
export function serializeEmbedDirective(block: EmbedBlock): string {
  const name = DIRECTIVE_BY_KIND[block.kind]
  return `:::${name} ${JSON.stringify(block)}`
}

/** Parse a directive line back to the exact embed block, or null if it isn't one. */
export function parseEmbedDirective(line: string): EmbedBlock | null {
  const m = DIRECTIVE_RE.exec(line.trim())
  if (!m) return null
  const expectedKind = KIND_BY_DIRECTIVE[m[1]]
  try {
    const block = JSON.parse(m[2]) as EmbedBlock
    if (block.kind !== expectedKind) return null
    return block
  } catch {
    return null
  }
}

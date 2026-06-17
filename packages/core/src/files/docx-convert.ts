/**
 * `.docx` → doc `Block[]` — the faithful import spoke of the conversion hub
 * (docs/architecture/features/doc-conversion.md §3). Import is
 * **Markdown-mediated**: `.docx → HTML (mammoth) → Markdown (turndown+GFM) →
 * Block[] (markdownToBlocks)`, reusing the parsers already in this package and
 * the GFM importer in `../doc/markdown.ts`. Word docs are overwhelmingly
 * headings / paragraphs / lists / tables / images — exactly what Markdown +
 * GFM covers — so the extra hop costs little fidelity and adds zero new import
 * dependencies.
 *
 * Node-only (mammoth). Re-hosting embedded images into `workspace_files` is an
 * API-layer concern (see the §7 non-goals); the pure converter keeps external
 * URLs as bookmark cards.
 *
 * [COMP:files/docx-convert]
 */

import type { Block } from '../doc/page-types.js'
import { markdownToBlocks, type MarkdownToBlocksOptions } from '../doc/markdown.js'
import { parseDocxToMarkdown } from './parsers.js'

/**
 * Convert a `.docx` byte buffer into canonical doc blocks. Throws on a corrupt
 * / non-OOXML buffer (mammoth) so the caller can surface a clean error.
 */
export async function docxToBlocks(
  buffer: Buffer,
  opts: MarkdownToBlocksOptions = {},
): Promise<Block[]> {
  const markdown = await parseDocxToMarkdown(buffer)
  return markdownToBlocks(markdown, opts)
}

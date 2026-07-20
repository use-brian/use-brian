/**
 * Markdown knowledge file parser — now lives in @use-brian/brian-kb and
 * shared with the public CLI and sync worker. This file is a thin re-export
 * to keep existing internal imports working.
 *
 * See packages/brian-kb/src/lib/parser.ts.
 */

export { parseMarkdownFile, normalisePath } from '@use-brian/brian-kb'
export type { ParsedEntry } from '@use-brian/brian-kb'

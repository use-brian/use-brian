/**
 * Markdown knowledge file parser — now lives in @use-brian/sidanclaw-kb and
 * shared with the public CLI and sync worker. This file is a thin re-export
 * to keep existing internal imports working.
 *
 * See packages/sidanclaw-kb/src/lib/parser.ts.
 */

export { parseMarkdownFile, normalisePath } from '@use-brian/sidanclaw-kb'
export type { ParsedEntry } from '@use-brian/sidanclaw-kb'

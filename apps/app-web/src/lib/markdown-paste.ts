/**
 * In-editor Markdown paste (journey E of the doc-format-conversion feature).
 *
 * When a user pastes block-structured Markdown into the doc editor (a heading,
 * a list, a fenced block, a table, or blank-line-separated paragraphs), we
 * convert it to real blocks instead of dropping it in as literal `###` / `- `
 * text. Single-line / inline pastes are left to the editor's default handler.
 *
 * The conversion reuses the canonical hub, both from `@sidanclaw/doc-model`:
 * `markdownToBlocks` (the faithful importer — re-exported by doc-model from
 * core's fs-free `dist/doc/markdown.js` leaf, so the core barrel's
 * `skills/loader`/`fs` never enters the browser bundle) → `blocksToPMDoc` (the
 * shared `Block[] ↔` ProseMirror mapping the editor's own content uses).
 *
 * Pure (string in, PM-doc JSON out) so it unit-tests without a browser; the
 * editor glue in `collab-page-editor.tsx` is a thin, defensive `handlePaste`.
 *
 * Spec: docs/architecture/features/doc-conversion.md → "app-web UI".
 *
 * [COMP:app-web/markdown-paste]
 */

import { blocksToPMDoc, markdownToBlocks, type PMDoc } from "@sidanclaw/doc-model";

/**
 * True when pasted text is worth converting to blocks: it spans multiple lines
 * AND carries block-level Markdown (heading / list / to-do / quote / fence /
 * table) or a blank-line paragraph split. A single line is an inline paste and
 * returns false (the editor's default + its typed-shortcut input rules handle
 * it). Deliberately conservative — mirrors the importer's `hasBlockMarkdown`.
 */
export function looksLikeBlockMarkdown(text: string): boolean {
  if (!text.includes("\n")) return false;
  if (/\n[ \t]*\n/.test(text.trim())) return true;
  return /(^|\n)[ \t]*(#{1,6}[ \t]|[-*+][ \t]|\d+[.)][ \t]|>[ \t]?|```|~~~|\|.+\|)/.test(
    text,
  );
}

/**
 * Convert pasted Markdown into a ProseMirror doc JSON for insertion, or `null`
 * when the text isn't block-structured Markdown (let the default inline paste
 * run). The returned JSON's node types are the shared `@sidanclaw/doc-model`
 * schema's, so the editor can `schema.nodeFromJSON` it directly.
 */
export function markdownPasteToPMDoc(text: string): PMDoc | null {
  if (!looksLikeBlockMarkdown(text)) return null;
  const blocks = markdownToBlocks(text);
  if (blocks.length === 0) return null;
  return blocksToPMDoc(blocks);
}

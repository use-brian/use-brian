// [COMP:app-web/comment-composer]
/**
 * Pure text helpers for the mention-aware `CommentComposer`. Kept as a
 * separate, IO-free module (same shape as `lib/doc-page-url.ts`) so the
 * node-only vitest runner can exercise the mention-tracking contract without
 * React, the DOM, or the API client. The composer (`comment-composer.tsx`)
 * imports these; its live textarea/popup flows need a future jsdom suite.
 */

/** A mention inserted into the draft: the picked member's id + display name. */
export type InsertedMention = { id: string; name: string };

/** Escape a display name for use inside a RegExp. */
export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The ids of `tracked` mentions whose `@name` token is still present in
 * `text`. A trailing word-character boundary keeps `@Jane` from matching
 * inside `@Janet`. Dedup so a name typed twice yields one id.
 */
export function presentMentionIds(text: string, tracked: InsertedMention[]): string[] {
  const ids = new Set<string>();
  for (const m of tracked) {
    const re = new RegExp(`@${escapeRegExp(m.name)}(?![\\p{L}\\p{N}_])`, "u");
    if (re.test(text)) ids.add(m.id);
  }
  return [...ids];
}

/**
 * Match a trailing `@query` immediately before the caret (no spaces in the
 * query — typing `@jane` substring-matches "Jane Smith" server-side). Returns
 * the query text and the index of the `@`, or null when the caret isn't in a
 * mention.
 */
export function activeMentionQuery(
  textBeforeCaret: string,
): { query: string; at: number } | null {
  const m = /(?:^|\s)@([^\s@]*)$/.exec(textBeforeCaret);
  if (!m) return null;
  return { query: m[1], at: textBeforeCaret.length - m[1].length - 1 };
}

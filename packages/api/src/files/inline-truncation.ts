// [COMP:files/inline-truncation] — the last-resort inline truncation notice a
// turn carries when a large attachment can be neither promoted to an artifact
// nor cached for readFileContent.
//
// Sibling of artifact-manifest.ts: same job (render the block that stands in
// for content the model cannot see), opposite outcome. The manifest says "here
// is where the rest lives"; this says "the rest is gone, do not pretend
// otherwise". Kept dependency-free so it is unit-testable without the
// workspace dist chain.
//
// No em dash anywhere (transcript text can surface in user-facing renders).
//
// Why it is this loud: see docs/plans/channel-attachment-truncation.md. On
// 2026-08-02 a 4,159-row workout CSV reached a Telegram assistant as its first
// 331 rows carrying a bare `... [truncated]`. The model read that marker as a
// formatting artifact, summarized the fragment as the whole file, and told the
// user their training log ran "June 2023 to February 2024" when it ran to July
// 2026. A quantitative notice is the difference between a confidently wrong
// answer and an honest one.

/** Chars kept by the last-resort inline truncation branch. */
export const INLINE_TRUNCATION_CHAR_LIMIT = 20000

/** Deterministic thousands separator (no locale dependence in prompt text). */
function groupDigits(n: number): string {
  return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

function countNewlines(s: string): number {
  let n = 0
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) n++
  return n
}

/**
 * Lines in `s`, counted the way `wc -l` and a spreadsheet do: a trailing
 * newline terminates the last line rather than starting an empty one. Most
 * real exports (CSV included) end in a newline, so the naive
 * `newlines + 1` overstates every one of them by a row.
 */
function lineCount(s: string): number {
  if (s.length === 0) return 0
  const newlines = countNewlines(s)
  return s.charCodeAt(s.length - 1) === 10 ? newlines : newlines + 1
}

/**
 * Cut `text` to the inline limit, appending a notice that quantifies the loss.
 * Text at or under the limit is returned unchanged.
 */
export function truncateForInline(text: string): string {
  if (text.length <= INLINE_TRUNCATION_CHAR_LIMIT) return text

  const shown = text.slice(0, INLINE_TRUNCATION_CHAR_LIMIT)
  const shownPct = Math.max(1, Math.round((INLINE_TRUNCATION_CHAR_LIMIT / text.length) * 100))
  const totalLines = lineCount(text)
  // Line counts are meaningless for a single-line blob (minified JSON, one long
  // paragraph); only claim them when the text is actually line-oriented.
  const lineClause =
    totalLines > 1
      ? ` (roughly the first ${groupDigits(lineCount(shown))} of ${groupDigits(totalLines)} lines)`
      : ''

  return (
    shown +
    `\n... [TRUNCATED. You have received the first ${groupDigits(INLINE_TRUNCATION_CHAR_LIMIT)} of ` +
    `${groupDigits(text.length)} characters, about ${shownPct}% of this file${lineClause}. ` +
    `The other ${100 - shownPct}% is NOT in this message and you cannot see it. ` +
    `Do NOT state this file's date range, totals, row counts, maximums or trends from what is above: ` +
    `those describe only the opening fragment, not the file. ` +
    `Tell the user the file arrived truncated and only part of it could be read.]`
  )
}

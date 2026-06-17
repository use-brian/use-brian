// [COMP:app-web/comment-quote]
/**
 * Pure helpers for **quote-reply** inside a comment thread — selecting text in
 * an existing comment and replying to that selection (Notion / Slack / GitHub's
 * "quote reply"). Shared by the floating selection button
 * (`comment-quote-reply.tsx`) and the thread renderer (`comment-thread-body.tsx`
 * + the rail preview in `comment-rail.tsx`).
 *
 * **Wire representation: a leading Markdown blockquote.** A comment is stored as
 * a plain `session_messages` row (no per-message quote column), so a quoted
 * reply carries its quote as a leading `> …` blockquote prefixed to the body:
 *
 *   > the selected text
 *   > (one `> ` line per source line)
 *
 *   the reply body
 *
 * This needs **no schema change**, reads naturally to the AI when the reply runs
 * through `/api/chat` (the model sees a quote it's replying to), and is parsed
 * back out on render into the same amber quote bar the page-anchor `thread.quote`
 * uses. Only **human** rows are parsed — the assistant authors its own replies
 * and never carries a user-prepended quote, so its organic Markdown blockquotes
 * are left untouched (rendered by `ChatMarkdown`).
 *
 * All three functions are pure (no DOM, no React) so the show/place/round-trip
 * matrix is unit-tested directly — see `__tests__/comment-quote.test.ts`.
 */

/** A line is a blockquote line when it's `>` optionally followed by a space.
 *  `>text` (no space) is intentionally NOT a quote — `composeQuotedBody` always
 *  emits `> `, so requiring the space keeps a user's literal ">5" out of the
 *  amber bar. */
const QUOTE_LINE = /^>(\s|$)/;

/**
 * Build a reply body that prefixes `quote` as a Markdown blockquote above
 * `body`. Each source line becomes its own `> ` line (a blank line stays a bare
 * `>`), so a multi-line selection round-trips through {@link parseLeadingQuote}.
 * A blank quote (or blank body) degrades gracefully — never emits a dangling
 * separator.
 */
export function composeQuotedBody(quote: string, body: string): string {
  const q = quote.trim();
  const b = body.trim();
  if (!q) return b;
  const quoted = q
    .split("\n")
    .map((line) => `> ${line}`.trimEnd())
    .join("\n");
  return b ? `${quoted}\n\n${b}` : quoted;
}

/**
 * Split a stored comment body into its leading blockquote (the quoted text) and
 * the reply body below it. Returns `{ quote: null, body: <input> }` when there's
 * no leading quote, or when the leading quote has **no** reply body after it (a
 * bare `> …` the user typed themselves) — in that case the raw text is preserved
 * so a one-line `> note` shows literally rather than as an empty-bodied bar.
 */
export function parseLeadingQuote(text: string): { quote: string | null; body: string } {
  const lines = text.split("\n");
  let i = 0;
  const quoteLines: string[] = [];
  while (i < lines.length && QUOTE_LINE.test(lines[i])) {
    quoteLines.push(lines[i].replace(/^>\s?/, ""));
    i++;
  }
  if (quoteLines.length === 0) return { quote: null, body: text };
  // Skip exactly one blank separator line between the quote and the body — the
  // shape `composeQuotedBody` emits.
  if (i < lines.length && lines[i].trim() === "") i++;
  const body = lines.slice(i).join("\n");
  // A quote with no reply body: keep the raw text (don't render an empty bar).
  if (!body.trim()) return { quote: null, body: text };
  const quote = quoteLines.join("\n").trim();
  return { quote: quote || null, body };
}

/** Convenience for renderers: parse a quote only for human rows. Assistant rows
 *  never carry a user-prepended quote (the model authors its own text), so a
 *  leading `>` there is the assistant's own Markdown blockquote — left intact. */
export function quoteForRow(
  text: string,
  isAssistant: boolean | undefined,
): { quote: string | null; body: string } {
  if (isAssistant) return { quote: null, body: text };
  return parseLeadingQuote(text);
}

/** Default floating-button box, kept here so the placement math + the component
 *  agree on the size. */
export const QUOTE_BUTTON = { width: 84, height: 30 };

/** The viewport rect this placement reads (the subset of a selection's
 *  `getBoundingClientRect`). */
export type SelRect = { top: number; bottom: number; left: number; width: number };

/**
 * Place the floating "Reply" button for a text selection. Centered horizontally
 * over the selection and clamped inside the viewport; sits just **above** the
 * selection, flipping **below** when there isn't room above (a selection near the
 * top of the thread / under the page chrome). Pure — viewport-relative coords for
 * a `position:fixed` button.
 */
export function placeQuoteButton(
  rect: SelRect,
  vw: number,
  vh: number,
  btn = QUOTE_BUTTON,
  gap = 8,
  margin = 8,
): { left: number; top: number } {
  const left = Math.max(
    margin,
    Math.min(rect.left + rect.width / 2 - btn.width / 2, vw - btn.width - margin),
  );
  const above = rect.top - btn.height - gap;
  const top =
    above >= margin ? above : Math.min(rect.bottom + gap, vh - btn.height - margin);
  return { left, top };
}

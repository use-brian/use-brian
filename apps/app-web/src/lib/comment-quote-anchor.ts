/**
 * Quote re-anchoring for comment threads that carry NO `comment` mark in the
 * document — the pure half of "a comment anchored by (anchorBlockId, quote)".
 *
 * Two kinds of thread arrive at a renderer without an inline mark to paint:
 *   - a **guest** range comment from the public share surface (the guest can't
 *     write the Yjs doc, so the thread persists only `anchor_block_id` + the
 *     selected `quote`);
 *   - a member's `human_range` thread on a `heading` / `text` block in the
 *     public render, where block-mapping flattened the rich text (and its
 *     mark) to a plain string.
 *
 * Both re-anchor the same way: find the quote inside the block's text and
 * paint exactly that range; if the quote no longer occurs (the text was
 * edited since), fall back to the whole block. These helpers are DOM-free so
 * the read-only renderer (SSR) and the editor's decoration layer share them.
 *
 * [COMP:app-web/comment-quote-anchor]
 */

/** A minimal Tiptap-JSON node (the shape `richText` carries). */
export type QuoteTipNode = {
  type?: string;
  text?: string;
  attrs?: Record<string, unknown>;
  marks?: Array<{ type: string; attrs?: Record<string, unknown> }>;
  content?: QuoteTipNode[];
};

/** Half-open character range `[start, end)` within a block's plain text. */
export type QuoteRange = { start: number; end: number };

/** Collapse runs of whitespace to one space — what a DOM `Range.toString()`
 *  of the rendered block and the JSON text disagree on most (a `<br>` or
 *  nested paragraph yields a newline in one and nothing in the other). */
function normalizeWs(s: string): string {
  return s.replace(/\s+/g, " ");
}

/**
 * Locate `quote` inside `text`. Exact substring first; then a
 * whitespace-insensitive match (both sides collapsed, the quote trimmed),
 * mapped back to offsets in the ORIGINAL text. Returns null when the quote is
 * empty or absent — the caller falls back to the whole block.
 */
export function findQuoteRange(text: string, quote: string | null | undefined): QuoteRange | null {
  if (!quote) return null;
  const q = quote.trim();
  if (!q || !text) return null;
  const exact = text.indexOf(q);
  if (exact >= 0) return { start: exact, end: exact + q.length };

  // Whitespace-insensitive: build the collapsed text alongside a map from each
  // collapsed index back to the original index, then search the collapsed form.
  const nq = normalizeWs(q);
  const map: number[] = [];
  let collapsed = "";
  let lastWasSpace = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (/\s/.test(ch)) {
      if (lastWasSpace) continue;
      lastWasSpace = true;
      collapsed += " ";
      map.push(i);
    } else {
      lastWasSpace = false;
      collapsed += ch;
      map.push(i);
    }
  }
  const at = collapsed.indexOf(nq);
  if (at < 0) return null;
  const start = map[at];
  const endIdx = at + nq.length - 1;
  const end = map[endIdx] + 1;
  return { start, end };
}

/** The plain text of a node list (text nodes concatenated, document order) —
 *  the coordinate space `QuoteRange` lives in. */
export function plainTextOf(nodes: ReadonlyArray<QuoteTipNode> | undefined): string {
  let out = "";
  for (const n of nodes ?? []) {
    if (typeof n.text === "string") out += n.text;
    else if (n.content) out += plainTextOf(n.content);
  }
  return out;
}

/** Whether any text node in the tree already carries a `comment` mark for
 *  `threadId` — then the mark is the anchor and nothing needs rebuilding. */
export function richTextHasThreadMark(
  nodes: ReadonlyArray<QuoteTipNode> | undefined,
  threadId: string,
): boolean {
  for (const n of nodes ?? []) {
    if (n.marks?.some((m) => m.type === "comment" && m.attrs?.threadId === threadId)) return true;
    if (n.content && richTextHasThreadMark(n.content, threadId)) return true;
  }
  return false;
}

/**
 * Return a copy of `nodes` where the text inside `range` (plain-text offsets)
 * carries an extra `comment` mark for `threadId`. Text nodes straddling a
 * boundary are split so only the in-range part is marked; everything else is
 * shared by reference. A range that covers nothing returns the input as-is.
 */
export function markQuoteRange(
  nodes: ReadonlyArray<QuoteTipNode>,
  range: QuoteRange,
  threadId: string,
): QuoteTipNode[] {
  if (range.end <= range.start) return nodes.slice();
  const mark = { type: "comment", attrs: { threadId } };
  let offset = 0;

  const walk = (list: ReadonlyArray<QuoteTipNode>): QuoteTipNode[] =>
    list.map((n) => {
      if (typeof n.text === "string") {
        const start = offset;
        const end = offset + n.text.length;
        offset = end;
        const s = Math.max(range.start, start);
        const e = Math.min(range.end, end);
        if (e <= s) return n; // no overlap
        const before = n.text.slice(0, s - start);
        const mid = n.text.slice(s - start, e - start);
        const after = n.text.slice(e - start);
        const out: QuoteTipNode[] = [];
        if (before) out.push({ ...n, text: before });
        out.push({ ...n, text: mid, marks: [...(n.marks ?? []), mark] });
        if (after) out.push({ ...n, text: after });
        // A single text node maps to 1–3 nodes; flatten via a marker type the
        // caller's `flat` below unwraps.
        return out.length === 1 ? out[0] : { type: "__split__", content: out };
      }
      if (n.content) return { ...n, content: walk(n.content) };
      return n;
    });

  const unwrap = (list: QuoteTipNode[]): QuoteTipNode[] =>
    list.flatMap((n) => {
      if (n.type === "__split__") return n.content ?? [];
      if (n.content) return [{ ...n, content: unwrap(n.content) }];
      return [n];
    });

  return unwrap(walk(nodes));
}

/** Per-thread anchor the renderers receive for one block. */
export type BlockAnchor = { threadId: string; quote: string | null };

/**
 * Anchor a set of threads into a rich-text node list: threads whose mark is
 * already present are left alone; threads whose quote is found get a mark
 * injected over exactly that range; the rest are returned as `unplaced` for
 * the caller's whole-block fallback. Pure.
 */
export function anchorThreadsInRichText(
  nodes: ReadonlyArray<QuoteTipNode> | undefined,
  anchors: ReadonlyArray<BlockAnchor>,
): { nodes: QuoteTipNode[]; unplaced: BlockAnchor[] } {
  let out: QuoteTipNode[] = (nodes ?? []).slice();
  const unplaced: BlockAnchor[] = [];
  if (anchors.length === 0) return { nodes: out, unplaced };
  // Offsets are stable under marking (only marks change, never text), so each
  // thread can search the ORIGINAL text and mark the evolving tree.
  const text = plainTextOf(out);
  for (const a of anchors) {
    if (richTextHasThreadMark(out, a.threadId)) continue;
    const range = findQuoteRange(text, a.quote);
    if (range) out = markQuoteRange(out, range, a.threadId);
    else unplaced.push(a);
  }
  return { nodes: out, unplaced };
}

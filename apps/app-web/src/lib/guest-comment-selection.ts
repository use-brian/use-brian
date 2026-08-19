/**
 * Guest comment selection — turn a DOM text selection on the public share
 * page into a comment draft the guest endpoints understand.
 *
 * The read-only renderer (`read-only-page-blocks.tsx`) tags every block root
 * with `data-block-id` (`block.id` ↔ the page's block id), so a selection maps
 * to a block by walking up from its start container. A guest can't write the
 * Yjs doc, so the draft is only `{ anchorBlockId, quote }` — the same two
 * fields a member's thread carries — and the quote is **clipped to the start
 * block**: the renderers re-anchor by searching the quote inside THAT block's
 * text (`comment-quote-anchor.ts`), so a quote spanning two blocks would never
 * be found and would fall back to a whole-block tint.
 *
 * Everything here is a pure function of the nodes it's handed (no globals),
 * so it unit-tests under jsdom without a page.
 *
 * [COMP:app-web/guest-comment-selection]
 */

/** Longest quote persisted for a thread — matches the server's slice. */
export const GUEST_QUOTE_MAX_CHARS = 280;

export type GuestCommentDraft = {
  /** The block the selection starts in. */
  anchorBlockId: string;
  /** Selected text, clipped to the start block + `GUEST_QUOTE_MAX_CHARS`. */
  quote: string;
  /** The (clipped) range — the caller paints the draft highlight from its rects. */
  range: Range;
};

/** The nearest `[data-block-id]` ancestor of `node` (inclusive), or null. */
export function blockElementAt(node: Node | null): HTMLElement | null {
  if (!node) return null;
  const el = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
  const hit = el?.closest<HTMLElement>("[data-block-id]") ?? null;
  const id = hit?.getAttribute("data-block-id");
  return id && id.length > 0 ? hit : null;
}

/**
 * Build a comment draft from the live selection, or null when there is nothing
 * to comment on: a collapsed selection, a selection that starts outside `root`
 * (the page's block container), one whose start isn't inside a block, or one
 * whose clipped text is empty / whitespace.
 */
export function draftFromSelection(selection: Selection | null, root: Element): GuestCommentDraft | null {
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null;
  const live = selection.getRangeAt(0);
  if (!root.contains(live.startContainer)) return null;
  const blockEl = blockElementAt(live.startContainer);
  if (!blockEl) return null;
  const anchorBlockId = blockEl.getAttribute("data-block-id") ?? "";
  if (!anchorBlockId) return null;

  // Clip to the start block: a selection running past the block's end is cut
  // at the block's last child so the quote lives in one block's text.
  const range = live.cloneRange();
  if (!blockEl.contains(range.endContainer)) {
    range.setEnd(blockEl, blockEl.childNodes.length);
  }
  const quote = range.toString().trim().slice(0, GUEST_QUOTE_MAX_CHARS);
  if (!quote) return null;
  return { anchorBlockId, quote, range };
}

export type DraftRect = { top: number; left: number; width: number; height: number };

/**
 * The draft range's client rects, translated into `container`'s coordinate
 * space (the `position:relative` block wrapper), merged per line so a
 * multi-line selection paints one swatch per line rather than one per text
 * node. Zero-area rects are dropped.
 */
export function draftRects(range: Range, container: Element): DraftRect[] {
  const base = container.getBoundingClientRect();
  const out: DraftRect[] = [];
  for (const r of Array.from(range.getClientRects())) {
    if (r.width <= 0 || r.height <= 0) continue;
    const rect = { top: r.top - base.top, left: r.left - base.left, width: r.width, height: r.height };
    const last = out[out.length - 1];
    // Same line (tops within a couple px) → extend the previous swatch.
    if (last && Math.abs(last.top - rect.top) < 2) {
      const right = Math.max(last.left + last.width, rect.left + rect.width);
      last.left = Math.min(last.left, rect.left);
      last.width = right - last.left;
      last.height = Math.max(last.height, rect.height);
    } else {
      out.push(rect);
    }
  }
  return out;
}

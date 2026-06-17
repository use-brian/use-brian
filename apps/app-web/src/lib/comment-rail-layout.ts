/**
 * Pure layout math for the read-only share view's right-margin comment rail
 * (`public-page-view.tsx`'s `CommentsRail`).
 *
 * Each card wants to sit at its anchored text's vertical position, but cards
 * must never overlap: we walk top-to-bottom and push any card down so it
 * clears the one above. The push-down needs each card's *height* — and the
 * original bug was estimating that height (`44 + messages * 26`), which is far
 * too short for long comments, so tall cards got covered by the next card and
 * their text looked clipped. Heights are now measured from the rendered DOM and
 * passed in here; the estimate only seeds the first paint before measurement.
 *
 * [COMP:app-web/comment-rail-layout]
 */

/** One card to place: its thread id, anchored top (px from the content top, or
 *  `null` for an un-anchored page-level thread), and a pre-measure height
 *  estimate. The caller passes anchored cards first (sorted by anchor), then
 *  un-anchored ones. */
export type RailCardInput = {
  threadId: string;
  /** px offset of the anchored text from the content top; `null` if unanchored. */
  anchor: number | null;
  /** fallback height used until the real measured height is known. */
  estimatedHeight: number;
};

/** Gap between stacked cards, in px. */
export const RAIL_CARD_GAP = 12;

/**
 * Stack cards down the rail without overlap. An anchored card sits at its
 * anchor unless the running cursor (bottom of the previous card + gap) has
 * already passed it, in which case it's pushed to the cursor. Un-anchored cards
 * (anchor `null`) just continue from the cursor. Returns each card's resolved
 * `top`, in input order.
 *
 * `heights[threadId]` is the real measured card height when known; otherwise the
 * card's `estimatedHeight` seeds the layout. Pure and side-effect free.
 */
export function placeRailCards(
  cards: RailCardInput[],
  heights: Record<string, number>,
  gap: number = RAIL_CARD_GAP,
): { threadId: string; top: number }[] {
  let cursor = 0;
  const placed: { threadId: string; top: number }[] = [];
  for (const card of cards) {
    const top = card.anchor != null ? Math.max(card.anchor, cursor) : cursor;
    placed.push({ threadId: card.threadId, top });
    const height = heights[card.threadId] ?? card.estimatedHeight;
    cursor = top + height + gap;
  }
  return placed;
}

/**
 * Caret-anchored popup placement for the responsive contract (M5).
 *
 * The slash menu, the `@` mention popup, the "Link to page" picker and the
 * comment composer's mention list all open at the caret. Before this helper
 * each of them wrote `top = rect.bottom + 4; left = rect.left` and nothing
 * else, so on a 360px phone a caret past ~72px from the left edge pushed a
 * 288-320px menu off the right edge, and with the keyboard up a caret in the
 * lower half opened the menu DOWNWARD under the keyboard (the "Table" row was
 * the one hidden). Every caller now routes through `clampPopupRect`:
 *
 *   - `left` is clamped so the popup's right edge stays `margin` inside the
 *     visible viewport (and never left of `margin`).
 *   - the popup opens below the anchor when it fits; when it does not and the
 *     space above is enough it FLIPS above; when neither fits it pins to the
 *     bottom margin so at least the top rows are reachable.
 *
 * "Visible viewport" is the `visualViewport` when the browser exposes one:
 * that is the only thing that shrinks when the on-screen keyboard rises, so
 * measuring it is what keeps the menu above the keys. `measureViewport` and
 * `onViewportChange` wrap the API (SSR-safe, `window`-less callers get a
 * zero viewport and a no-op unsubscribe).
 *
 * Pure math is separated from DOM so the clamp + flip rule is unit-tested.
 *
 * [COMP:app-web/popup-clamp]
 */

/** The anchor the popup hangs off: a caret / token rect in viewport coords. */
export type PopupAnchor = Pick<DOMRect, "top" | "bottom" | "left">;

/** The popup's rendered box (measure it after mount; estimate before). */
export type PopupSize = { width: number; height: number };

/**
 * The region the popup may occupy, in layout-viewport coordinates. With the
 * keyboard up on a phone `top` / `height` come from `visualViewport`.
 */
export type PopupViewport = {
  top: number;
  left: number;
  width: number;
  height: number;
};

export type PopupPlacement = {
  top: number;
  left: number;
  /** True when the popup opened above the anchor because below did not fit. */
  flipped: boolean;
};

/** Distance kept between the popup and the viewport edge. */
export const POPUP_MARGIN = 8;
/** Gap between the caret rect and the popup. */
export const POPUP_GAP = 4;

/**
 * Place a popup of `size` against `anchor` inside `viewport`.
 *
 * Below wins whenever it fits; above is taken only when below does not fit
 * AND above does. When neither fits the popup is pinned to the bottom margin
 * (so it overlaps the anchor rather than the keyboard), never above the top
 * margin.
 */
export function clampPopupRect(
  anchor: PopupAnchor,
  size: PopupSize,
  viewport: PopupViewport,
  opts: { margin?: number; gap?: number } = {},
): PopupPlacement {
  const margin = opts.margin ?? POPUP_MARGIN;
  const gap = opts.gap ?? POPUP_GAP;
  const minLeft = viewport.left + margin;
  const maxLeft = viewport.left + viewport.width - size.width - margin;
  const left = Math.max(minLeft, Math.min(anchor.left, maxLeft));

  const ceiling = viewport.top + margin;
  const floor = viewport.top + viewport.height - margin;
  const belowTop = anchor.bottom + gap;
  const fitsBelow = belowTop + size.height <= floor;
  const aboveTop = anchor.top - gap - size.height;
  const fitsAbove = aboveTop >= ceiling;

  if (fitsBelow) return { top: belowTop, left, flipped: false };
  if (fitsAbove) return { top: aboveTop, left, flipped: true };
  return { top: Math.max(ceiling, floor - size.height), left, flipped: false };
}

/**
 * The visible viewport in layout coordinates: `visualViewport` when present
 * (its `offsetTop` / `height` track the on-screen keyboard), else the window.
 * Zero-sized without a `window`, so a server render never throws.
 */
export function measureViewport(): PopupViewport {
  if (typeof window === "undefined") return { top: 0, left: 0, width: 0, height: 0 };
  const vv = window.visualViewport;
  if (vv) {
    return { top: vv.offsetTop, left: vv.offsetLeft, width: vv.width, height: vv.height };
  }
  return { top: 0, left: 0, width: window.innerWidth, height: window.innerHeight };
}

/**
 * Subscribe to the visible viewport changing (the keyboard rising, a rotate,
 * a resize). Returns the unsubscribe; a no-op without a `window`.
 */
export function onViewportChange(cb: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  const vv = window.visualViewport;
  window.addEventListener("resize", cb);
  vv?.addEventListener("resize", cb);
  vv?.addEventListener("scroll", cb);
  return () => {
    window.removeEventListener("resize", cb);
    vv?.removeEventListener("resize", cb);
    vv?.removeEventListener("scroll", cb);
  };
}

/**
 * Position a body-appended, `position:absolute` popup (the tiptap Suggestion
 * popups) against a caret rect: clamp + flip in viewport space, then convert
 * to document space with the scroll offsets. Measures the element's own box,
 * falling back to `fallback` before its first layout.
 */
export function positionSuggestionPopup(
  el: HTMLElement,
  anchor: PopupAnchor,
  fallback: PopupSize = { width: 288, height: 320 },
): PopupPlacement {
  // ReactRenderer gives us a plain block-level wrapper. While it is still in
  // normal flow, `offsetWidth` is the viewport width rather than the width of
  // the popup rendered inside it, which makes the first clamp pin the popup to
  // the far-left margin. Absolutely position it first so CSS shrink-to-fit
  // sizing is in effect before we measure.
  el.style.position = "absolute";
  const size = {
    width: el.offsetWidth || fallback.width,
    height: el.offsetHeight || fallback.height,
  };
  const placed = clampPopupRect(anchor, size, measureViewport());
  el.style.top = `${placed.top + window.scrollY}px`;
  el.style.left = `${placed.left + window.scrollX}px`;
  return placed;
}

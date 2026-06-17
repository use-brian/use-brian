/**
 * Pure stick-to-bottom predicate for the comment / chat thread message list.
 *
 * The thread should auto-follow new content (a sent reply, each streamed
 * token, the final persisted rows) only while the reader is parked at the
 * bottom — once they scroll up to read history we must not yank them back
 * down. That decision is a pure function of the scroll container's geometry,
 * extracted here so it's testable in app-web's node-only (no-jsdom) vitest;
 * the effect wiring lives in `comment-thread-body.tsx`.
 */

/** The slice of a scroll element's geometry the pin decision needs. */
export type ScrollMetrics = {
  scrollHeight: number;
  scrollTop: number;
  clientHeight: number;
};

/**
 * Distance in px the reader can sit above the bottom and still count as
 * "pinned". One or two lines of slack absorbs sub-pixel rounding and the
 * container's bottom padding so resting at the end reliably reads as pinned.
 */
export const PIN_THRESHOLD_PX = 40;

/** Remaining scrollable distance below the current viewport, never negative. */
export function distanceFromBottom(m: ScrollMetrics): number {
  return Math.max(0, m.scrollHeight - m.scrollTop - m.clientHeight);
}

/**
 * True when the reader is at (or within `threshold` of) the bottom — i.e. the
 * thread should keep following new messages. A content-shorter-than-viewport
 * thread (`scrollHeight <= clientHeight`) is trivially pinned.
 */
export function pinnedToBottom(m: ScrollMetrics, threshold = PIN_THRESHOLD_PX): boolean {
  return distanceFromBottom(m) <= threshold;
}

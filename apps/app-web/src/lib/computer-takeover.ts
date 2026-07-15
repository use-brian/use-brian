/**
 * Take-Over live-view input geometry ([COMP:app-web/sandbox-takeover]).
 *
 * The live frame renders `object-contain` inside a flex-sized box, so the
 * <img> element includes letterbox bars whenever its aspect ratio differs
 * from the frame's. Click forwarding must map through the fitted content
 * rect — a linear map across the whole element lands clicks offset from
 * where the user aimed (the pre-fix take-over bug).
 * Spec: docs/architecture/engine/computer-use.md §4.8.
 */

/**
 * Map a client-space click to frame coordinates through the `object-contain`
 * fit. Returns null for clicks in the letterbox bars (nothing under them).
 */
export function mapClickToFrame(
  rect: { left: number; top: number; width: number; height: number },
  natural: { w: number; h: number },
  clientX: number,
  clientY: number,
): { x: number; y: number } | null {
  if (rect.width <= 0 || rect.height <= 0 || natural.w <= 0 || natural.h <= 0) return null;
  const scale = Math.min(rect.width / natural.w, rect.height / natural.h);
  const contentW = natural.w * scale;
  const contentH = natural.h * scale;
  const offsetX = (rect.width - contentW) / 2;
  const offsetY = (rect.height - contentH) / 2;
  const x = (clientX - rect.left - offsetX) / scale;
  const y = (clientY - rect.top - offsetY) / scale;
  if (x < 0 || y < 0 || x > natural.w || y > natural.h) return null;
  return { x, y };
}

/** Keys that carry no input on their own — never worth a relay round-trip. */
export const LOCAL_ONLY_KEYS = new Set([
  "Shift",
  "Control",
  "Alt",
  "Meta",
  "CapsLock",
  "NumLock",
  "ScrollLock",
  "Dead",
  "Process",
  "Unidentified",
]);

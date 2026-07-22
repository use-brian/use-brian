/**
 * Take-Over live-view input geometry and frame pacing
 * ([COMP:app-web/sandbox-takeover]).
 *
 * The live frame renders `object-contain` inside a flex-sized box, so the
 * <img> element includes letterbox bars whenever its aspect ratio differs
 * from the frame's. Click forwarding must map through the fitted content
 * rect — a linear map across the whole element lands clicks offset from
 * where the user aimed (the pre-fix take-over bug).
 *
 * `createFrameGate` owns the other half: what reaches that <img> and when.
 * Swapping an image element's `src` discards what it has already painted, so
 * committing a frame the moment it arrives cost one blank frame per arrival —
 * the take-over flicker. Frames now decode before they commit.
 * Spec: docs/architecture/engine/computer-use.md §4.8, §5.
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

/**
 * Wheel relay pacing: the first event of a scroll gesture forwards
 * IMMEDIATELY (leading edge - the old trailing-only accumulator added a
 * fixed 160 ms before anything moved), then further deltas accumulate into
 * one relayed scroll per flush window so a fling never turns into dozens of
 * round-trips.
 */
export function createWheelForwarder(
  send: (deltaY: number) => void,
  flushMs = 160,
): { add: (deltaY: number) => void; dispose: () => void } {
  let acc = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const flush = () => {
    timer = null;
    const delta = Math.round(acc);
    acc = 0;
    if (delta !== 0) {
      send(delta);
      timer = setTimeout(flush, flushMs); // keep windows spaced while the fling lasts
    }
  };
  return {
    add(deltaY: number) {
      if (timer === null) {
        const lead = Math.round(deltaY);
        if (lead !== 0) send(lead);
        timer = setTimeout(flush, flushMs);
      } else {
        acc += deltaY;
      }
    },
    dispose() {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      acc = 0;
    },
  };
}

/**
 * Normalize an address-bar entry for a take-over `goto` (§5). A bare host gets
 * `https://`; only http(s) survives — a `file:`/`chrome:`/`javascript:` target
 * returns null so the toolbar never forwards it (the seam re-checks too).
 */
export function normalizeNavigateUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const u = new URL(withScheme);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.toString();
  } catch {
    return null;
  }
}

/**
 * Frame commit gate (§5). Swapping an <img>'s `src` clears what it has already
 * painted and repaints nothing until the new JPEG decodes — one blank frame per
 * arrival, which reads as flicker on a damage-driven stream. The gate decodes
 * each frame off-screen first and only then advances the committed src, so the
 * element always holds a fully-decoded picture.
 */
export function createFrameGate(opts: {
  decode: (src: string) => Promise<void>;
  commit: (src: string) => void;
  /** Frees a frame's backing object url. Never called on the on-screen frame. */
  release?: (src: string) => void;
}): { push: (src: string) => void; dispose: () => void } {
  let disposed = false;
  let issued = 0;
  let committedSeq = 0;
  let onScreen: string | null = null;
  return {
    push(src: string) {
      issued += 1;
      const seq = issued;
      void opts
        .decode(src)
        .then(() => {
          // A slower decode can land after a newer frame is already up;
          // committing it would rewind the picture. It never reached the
          // screen, so it frees immediately.
          if (disposed || seq <= committedSeq) {
            opts.release?.(src);
            return;
          }
          committedSeq = seq;
          const previous = onScreen;
          onScreen = src;
          opts.commit(src);
          // Only now is the old frame off screen and safe to free.
          if (previous !== null) opts.release?.(previous);
        })
        .catch(() => {
          // Undecodable frame — keep the last good one on screen, but the
          // url still has to go back or the socket path leaks one per frame.
          opts.release?.(src);
        });
    },
    dispose() {
      disposed = true;
      if (onScreen !== null) opts.release?.(onScreen);
      onScreen = null;
    },
  };
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

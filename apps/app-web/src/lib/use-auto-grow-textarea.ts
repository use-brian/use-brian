"use client";

// [COMP:app-web/auto-grow-textarea]
/**
 * Auto-grow a `<textarea>` to fit its content — the Notion composer feel where
 * the box expands line-by-line as you type (Shift+Enter for a newline), instead
 * of scrolling the earlier lines out of a fixed one-line box (the "past line
 * disappeared" bug). The growth is capped by the element's own `max-height`
 * (e.g. `max-h-32`); once content passes that, the overflow scrolls.
 *
 * The mechanism mirrors `page-title.tsx`'s title auto-grow: on every value
 * change reset the height to `0` so `scrollHeight` reports the true content
 * height free of the previous measurement, then snap `height` to it. A
 * width-only `ResizeObserver` re-fits when the column re-wraps (the chat panel
 * opens, the sidebar toggles, the viewport resizes) so the last wrapped line is
 * never clipped — guarded against the feedback loop our own height writes would
 * otherwise trigger.
 *
 * Controlled-input only: pass the same `value` string the textarea renders so
 * the fit runs in lockstep with what the user sees.
 */

import * as React from "react";

export function useAutoGrowTextarea(
  ref: React.RefObject<HTMLTextAreaElement | null>,
  value: string,
) {
  // Re-fit on every content change, before paint (no flicker).
  React.useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${el.scrollHeight}px`;
  }, [ref, value]);

  // Re-fit on WIDTH changes — a re-wrap changes the line count without a value
  // change. React only to width deltas to avoid reacting to our own height writes.
  React.useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    let lastWidth = el.clientWidth;
    const ro = new ResizeObserver(() => {
      const w = el.clientWidth;
      if (Math.abs(w - lastWidth) < 0.5) return;
      lastWidth = w;
      el.style.height = "0px";
      el.style.height = `${el.scrollHeight}px`;
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
}

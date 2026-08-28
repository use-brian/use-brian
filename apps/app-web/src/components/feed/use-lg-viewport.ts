"use client";

/**
 * Tracks whether the viewport is at Tailwind's `lg` breakpoint or wider —
 * the boundary the Plan surface uses to decide which chat host is live
 * (docs/plans/feed-plan-chat-first.md P4): at `lg`+ the Plan index mounts
 * the docked chat rail and the floating Feed dock stands down; below it the
 * rail is hidden, so the floating dock stays. Mount-gating (not CSS hiding)
 * is the point — two mounted `TuningChatPanel`s against the same plan
 * session would double-subscribe its stream.
 *
 * SSR renders `false` (no window), so the floating dock is the hydration
 * default and the swap happens on first client paint — the same direction
 * the masonry column trackers in `feed-insights.tsx` resolve.
 */

import { useEffect, useState } from "react";

const LG_QUERY = "(min-width: 1024px)";

export function useLgViewport(): boolean {
  const [isLg, setIsLg] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia(LG_QUERY);
    const update = () => setIsLg(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);

  return isLg;
}

"use client";

/**
 * Chunk sentinel - the "fetch the next page when the user nears the end"
 * marker for chunked lists.
 *
 * Sits at the bottom of an accumulating list. When it scrolls into view it
 * calls `onVisible`, and while the next chunk is in flight it renders skeleton
 * rows in the list's own rhythm - so the list visibly continues past the last
 * real row instead of just stopping, and the arriving rows replace a
 * placeholder rather than appearing out of nowhere.
 *
 * `rootMargin` fires it a screenful early. Loading only once the sentinel is
 * literally visible means the user always meets the bottom of the list before
 * the next chunk starts, which reads as a stall no matter how fast the request
 * is.
 *
 * **Not an infinite-scroll trap.** A visible `Load more` button is always
 * rendered underneath, and it is the only affordance when
 * `IntersectionObserver` is unavailable. Auto-load is the convenience; the
 * button is the contract.
 *
 * Spec: docs/architecture/features/perceived-performance.md → "Chunked lists"
 * [COMP:app-web/chunk-sentinel]
 */

import { useEffect, useRef } from "react";
import { Skeleton } from "@/components/skeleton";
import { useT } from "@/lib/i18n/client";

/** Start the next chunk this far before the sentinel is actually on screen. */
const PRELOAD_MARGIN = "600px";

export function ChunkSentinel({
  hasMore,
  loading,
  onVisible,
  skeletonRows = 3,
}: {
  /** The server has more. When false this renders nothing at all. */
  hasMore: boolean;
  /** A chunk is in flight - swaps the button for skeleton rows. */
  loading: boolean;
  onVisible: () => void;
  skeletonRows?: number;
}) {
  const t = useT().brainPage.topbar;
  const ref = useRef<HTMLDivElement>(null);
  // Held in a ref so re-creating the callback each render does not tear down
  // and re-attach the observer (which can re-fire it immediately).
  const onVisibleRef = useRef(onVisible);
  onVisibleRef.current = onVisible;

  useEffect(() => {
    const element = ref.current;
    if (!hasMore || !element) return;
    if (typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          onVisibleRef.current();
        }
      },
      { rootMargin: PRELOAD_MARGIN },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [hasMore]);

  if (!hasMore) return null;

  return (
    <div ref={ref} className="flex flex-col gap-1 pt-1">
      {loading ? (
        <div role="status" aria-label={t.loadingMore} className="flex flex-col gap-1">
          {Array.from({ length: skeletonRows }).map((_, i) => (
            <div
              key={i}
              className="flex items-center gap-3 rounded-md border border-border bg-card px-3 py-2"
            >
              <Skeleton className="size-2.5 shrink-0 rounded-full" />
              <Skeleton
                className="h-3.5"
                style={{ width: `${38 + ((i * 17) % 34)}%` }}
              />
            </div>
          ))}
        </div>
      ) : (
        <button
          type="button"
          onClick={onVisible}
          className="self-center rounded-md px-3 py-1.5 text-[12.5px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          {t.loadMore}
        </button>
      )}
    </div>
  );
}

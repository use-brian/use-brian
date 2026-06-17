"use client";

import { useRef, useState, useEffect, useCallback } from "react";

/**
 * Horizontal scrollable container with left/right arrow indicators.
 * Arrows appear when there's more content in that direction,
 * and hide when scrolled to the edge.
 *
 * Ported verbatim from `apps/web/src/components/scrollable-nav.tsx` for the
 * studio sub-nav's mobile rail (docs/plans/doc-web-app-consolidation.md
 * §9 #5). No app-local deps, so it's a clean lift.
 */
export function ScrollableNav({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [showLeft, setShowLeft] = useState(false);
  const [showRight, setShowRight] = useState(false);

  const updateArrows = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    setShowLeft(el.scrollLeft > 2);
    setShowRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 2);
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    updateArrows();
    el.addEventListener("scroll", updateArrows, { passive: true });
    const ro = new ResizeObserver(updateArrows);
    ro.observe(el);
    return () => {
      el.removeEventListener("scroll", updateArrows);
      ro.disconnect();
    };
  }, [updateArrows]);

  const scroll = (dir: "left" | "right") => {
    scrollRef.current?.scrollBy({
      left: dir === "left" ? -120 : 120,
      behavior: "smooth",
    });
  };

  return (
    <div className="relative">
      {/* Left arrow */}
      {showLeft && (
        <button
          onClick={() => scroll("left")}
          className="absolute left-0 top-0 bottom-0 z-10 flex items-center pl-1 pr-3 bg-gradient-to-r from-background from-40% to-transparent"
          aria-label="Scroll left"
        >
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="text-muted-foreground">
            <path d="M10 12L6 8l4-4" />
          </svg>
        </button>
      )}

      {/* Scrollable content */}
      <div
        ref={scrollRef}
        className={`overflow-x-auto scrollbar-none ${className}`}
        style={{ touchAction: "pan-x", overscrollBehaviorY: "none" }}
      >
        {children}
      </div>

      {/* Right arrow */}
      {showRight && (
        <button
          onClick={() => scroll("right")}
          className="absolute right-0 top-0 bottom-0 z-10 flex items-center pr-1 pl-3 bg-gradient-to-l from-background from-40% to-transparent"
          aria-label="Scroll right"
        >
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="text-muted-foreground">
            <path d="M6 12l4-4-4-4" />
          </svg>
        </button>
      )}
    </div>
  );
}

"use client";

/**
 * Resizable right-hand peek/drawer chrome — the shared width behavior for
 * the record panels (the Tasks/CRM operator peeks and the Brain entry
 * drawer):
 *
 *   - DEFAULT width is the Brain drawer's Notion side-peek proportion
 *     (`w-full sm:w-[480px] lg:w-[640px] xl:w-[760px]`) so every record
 *     panel opens at the same familiar size;
 *   - a **drag handle on the left edge** lets the user resize (clamped to
 *     [360px, 90vw]); the chosen width persists per storage key in
 *     localStorage and is shared by every panel using that key;
 *   - **double-click** the handle to reset to the default proportion.
 *
 * `usePeekResize` is the behavior (width state + handle props) for shells
 * that own their own `<aside>` (the Brain drawer); `ResizablePeek` is the
 * ready-made absolute-overlay aside the operator peeks render.
 *
 * [COMP:app-web/operator-filter-bar] (shared operator chrome)
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n/client";

const MIN_WIDTH = 360;
const MAX_VW = 0.9;

/** The Brain drawer's default proportion. */
const PEEK_DEFAULT_WIDTH_CLASS =
  "w-full sm:w-[480px] lg:w-[640px] xl:w-[760px]";

function readStoredWidth(storageKey: string): number | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(storageKey);
    const n = raw === null ? NaN : Number(raw);
    return Number.isFinite(n) && n >= MIN_WIDTH ? n : null;
  } catch {
    return null;
  }
}

function clampWidth(px: number): number {
  const max = Math.max(MIN_WIDTH, Math.floor(window.innerWidth * MAX_VW));
  return Math.min(Math.max(px, MIN_WIDTH), max);
}

export function usePeekResize(storageKey: string): {
  /** Explicit width in px, or null → render the default width classes. */
  width: number | null;
  /** True while the user is dragging (disable transitions/selection). */
  resizing: boolean;
  /** Spread onto the drag-handle element. */
  handleProps: {
    onPointerDown: (e: React.PointerEvent<HTMLElement>) => void;
    onDoubleClick: () => void;
  };
} {
  const [width, setWidth] = useState<number | null>(() =>
    readStoredWidth(storageKey),
  );
  const [resizing, setResizing] = useState(false);
  const frame = useRef<number | null>(null);

  // Another panel on the same key may have changed it while we were closed.
  useEffect(() => {
    setWidth(readStoredWidth(storageKey));
  }, [storageKey]);

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      e.preventDefault();
      const handle = e.currentTarget;
      try {
        handle.setPointerCapture(e.pointerId);
      } catch {
        // No active pointer (synthetic events, exotic devices) — the
        // handle-scoped listeners below still track the drag.
      }
      setResizing(true);
      let latest: number | null = null;

      const onMove = (ev: PointerEvent) => {
        latest = clampWidth(window.innerWidth - ev.clientX);
        if (frame.current === null) {
          frame.current = requestAnimationFrame(() => {
            frame.current = null;
            if (latest !== null) setWidth(latest);
          });
        }
      };
      const onUp = () => {
        handle.removeEventListener("pointermove", onMove);
        handle.removeEventListener("pointerup", onUp);
        handle.removeEventListener("pointercancel", onUp);
        setResizing(false);
        if (latest !== null) {
          try {
            window.localStorage.setItem(storageKey, String(latest));
          } catch {
            // Non-fatal — the width is a convenience.
          }
        }
      };
      handle.addEventListener("pointermove", onMove);
      handle.addEventListener("pointerup", onUp);
      handle.addEventListener("pointercancel", onUp);
    },
    [storageKey],
  );

  const onDoubleClick = useCallback(() => {
    setWidth(null);
    try {
      window.localStorage.removeItem(storageKey);
    } catch {
      // Non-fatal.
    }
  }, [storageKey]);

  return { width, resizing, handleProps: { onPointerDown, onDoubleClick } };
}

/** The left-edge drag handle: an invisible 6px hit strip whose center line
 *  tints on hover and while dragging. */
export function PeekResizeHandle({
  resizing,
  ...handleProps
}: {
  resizing: boolean;
  onPointerDown: (e: React.PointerEvent<HTMLElement>) => void;
  onDoubleClick: () => void;
}) {
  const t = useT().filterBar;
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={t.resize}
      {...handleProps}
      className="group/resize absolute inset-y-0 left-0 z-10 w-1.5 -translate-x-1/2 cursor-col-resize touch-none select-none"
    >
      <div
        className={cn(
          "mx-auto h-full w-px bg-transparent transition-colors group-hover/resize:bg-primary/40",
          resizing && "bg-primary/60 group-hover/resize:bg-primary/60",
        )}
      />
    </div>
  );
}

/**
 * The operator peeks' shell: an absolute overlay aside (floats over the
 * surface, never reflows it) at the Brain default width, resizable from
 * its left edge.
 */
export function ResizablePeek({
  storageKey,
  ariaLabel,
  onDismiss,
  children,
}: {
  storageKey: string;
  ariaLabel: string;
  /** Close on outside click / Escape — the Brain drawer's dismiss
   *  contract: a dimmed backdrop covers the surface behind the panel and
   *  a click on it (or Escape anywhere an editor hasn't claimed it)
   *  collapses the peek. */
  onDismiss?: () => void;
  children: React.ReactNode;
}) {
  const { width, resizing, handleProps } = usePeekResize(storageKey);

  // Escape closes (editors stopPropagation their own Escape first).
  useEffect(() => {
    if (!onDismiss) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onDismiss();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onDismiss]);

  return (
    <>
      {onDismiss && (
        <div
          className="absolute inset-0 z-10 bg-background/40 backdrop-blur-[2px] animate-in fade-in-0 duration-200"
          onClick={onDismiss}
          aria-hidden
        />
      )}
      <aside
        aria-label={ariaLabel}
        style={width !== null ? { width } : undefined}
        className={cn(
          "absolute inset-y-0 right-0 z-20 flex max-w-[100vw] flex-col border-l border-border/60 bg-background shadow-2xl",
          width === null && PEEK_DEFAULT_WIDTH_CLASS,
          // The slide-in is skipped mid-resize so the panel tracks the pointer.
          !resizing && "animate-in slide-in-from-right-4 fade-in duration-200",
          resizing && "select-none",
        )}
      >
        <PeekResizeHandle resizing={resizing} {...handleProps} />
        {children}
      </aside>
    </>
  );
}

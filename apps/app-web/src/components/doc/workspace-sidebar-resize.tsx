"use client";

/** Desktop shell sizing; independent from right-side overlay peek geometry.
 * Spec: workspace-navigation.md → "Resizable contextual sidebar".
 * [COMP:app-web/workspace-sidebar-resize] */
import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { useT } from "@/lib/i18n/client";

const DEFAULT_WIDTH = 224;
const MIN_WIDTH = 200;
const MAX_WIDTH = 420;
const STORAGE_KEY = "workspace:sidebar-width:v1";

function storedWidth(raw: string | null): number {
  const value = raw === null ? NaN : Number(raw);
  return Number.isFinite(value) && value > 0
    ? Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, value))
    : DEFAULT_WIDTH;
}

export function useWorkspaceSidebarResize() {
  const containerRef = useRef<HTMLDivElement>(null);
  // Match the server on first render; browser preferences load after hydration.
  const [preferred, setPreferred] = useState(DEFAULT_WIDTH);
  const [maxWidth, setMaxWidth] = useState(MAX_WIDTH);
  const [resizing, setResizing] = useState(false);
  const cleanupDrag = useRef<(() => void) | null>(null);
  const cancelDrag = useRef<(() => void) | null>(null);
  const maximum = useRef(maxWidth);
  maximum.current = maxWidth;
  const width = Math.min(preferred, maxWidth);

  useEffect(() => {
    try { setPreferred(storedWidth(window.localStorage.getItem(STORAGE_KEY))); } catch { /* Optional browser preference. */ }
    const measure = () => {
      const available = containerRef.current?.getBoundingClientRect().width || window.innerWidth;
      setMaxWidth(Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, Math.floor(available - 56 - 360 - 8))));
    };
    const onStorage = (event: StorageEvent) => {
      if (event.key === STORAGE_KEY || event.key === null) {
        cancelDrag.current?.();
        setPreferred(storedWidth(event.newValue));
      }
    };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    if (containerRef.current) observer?.observe(containerRef.current);
    window.addEventListener("resize", measure);
    window.addEventListener("storage", onStorage);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
      window.removeEventListener("storage", onStorage);
      cleanupDrag.current?.();
    };
  }, []);

  const persist = (value: number, reset = false) => {
    setPreferred(value);
    try {
      if (reset) window.localStorage.removeItem(STORAGE_KEY);
      else window.localStorage.setItem(STORAGE_KEY, String(value));
    } catch { /* Resizing still works when storage is unavailable. */ }
  };
  const reset = () => {
    cancelDrag.current?.();
    persist(DEFAULT_WIDTH, true);
  };
  const onPointerDown = (event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0 || event.isPrimary === false || window.innerWidth < 768) return;
    event.preventDefault();
    cancelDrag.current?.();
    const handle = event.currentTarget;
    handle.focus();
    const pointerId = event.pointerId;
    const startX = event.clientX;
    const startPreferred = preferred;
    const startWidth = width;
    let latest = width;
    let moved = false;
    let frame: number | null = null;
    const previousCursor = document.documentElement.style.cursor;
    const previousSelection = document.documentElement.style.userSelect;
    document.documentElement.style.cursor = "col-resize";
    document.documentElement.style.userSelect = "none";
    setResizing(true);
    try { handle.setPointerCapture(pointerId); } catch { /* Window listeners cover synthetic/unsupported capture. */ }
    const matches = (next: PointerEvent) => next.pointerId === pointerId;
    const onMove = (next: PointerEvent) => {
      if (!matches(next)) return;
      latest = Math.min(maximum.current, Math.max(MIN_WIDTH, startWidth + next.clientX - startX));
      moved = true;
      if (frame === null) frame = requestAnimationFrame(() => { frame = null; setPreferred(latest); });
    };
    const cleanup = () => {
      if (frame !== null) cancelAnimationFrame(frame);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      window.removeEventListener("keydown", onKey);
      handle.removeEventListener("lostpointercapture", onCancel);
      document.documentElement.style.cursor = previousCursor;
      document.documentElement.style.userSelect = previousSelection;
      cleanupDrag.current = null;
      cancelDrag.current = null;
      try { if (handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId); } catch { /* Already released. */ }
    };
    const finish = (commit: boolean) => {
      cleanup();
      setResizing(false);
      if (commit && moved) persist(Math.min(latest, maximum.current));
      else setPreferred(startPreferred);
    };
    const onUp = (next: PointerEvent) => { if (matches(next)) finish(true); };
    const onCancel = (next: PointerEvent) => { if (matches(next)) finish(false); };
    const onKey = (next: globalThis.KeyboardEvent) => {
      if (next.key === "Escape") { next.preventDefault(); finish(false); }
    };
    cleanupDrag.current = cleanup;
    cancelDrag.current = () => finish(false);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    window.addEventListener("keydown", onKey);
    handle.addEventListener("lostpointercapture", onCancel);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    const step = event.shiftKey ? 40 : 10;
    const next = event.key === "ArrowLeft" ? width - step
      : event.key === "ArrowRight" ? width + step
      : event.key === "Home" ? MIN_WIDTH
      : event.key === "End" ? maxWidth : null;
    if (event.key === "Enter") { event.preventDefault(); reset(); }
    else if (next !== null) {
      event.preventDefault();
      cancelDrag.current?.();
      persist(Math.max(MIN_WIDTH, Math.min(maxWidth, next)));
    }
  };
  return {
    containerRef, resizing,
    style: { "--workspace-sidebar-width": `${width}px` } as CSSProperties,
    handleProps: { width, maxWidth, resizing, onPointerDown, onKeyDown, onDoubleClick: reset },
  };
}

export function WorkspaceSidebarResizeHandle({ width, maxWidth, resizing, ...events }: {
  width: number;
  maxWidth: number;
  resizing: boolean;
  onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
  onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
  onDoubleClick: () => void;
}) {
  const t = useT().docPage;
  return <div
    data-workspace-sidebar-resize data-resizing={resizing || undefined} data-no-drag role="separator" tabIndex={0}
    aria-label={t.sidebarResizeAria} aria-description={t.sidebarResizeHint}
    aria-orientation="vertical" aria-controls="workspace-context-sidebar"
    aria-valuemin={MIN_WIDTH} aria-valuemax={maxWidth} aria-valuenow={width}
    title={t.sidebarResizeHint} {...events}
    style={{ left: "calc(3.5rem + var(--workspace-sidebar-width, 14rem) - 4px)", WebkitAppRegion: "no-drag" } as CSSProperties}
    className="group/sidebar-resize absolute bottom-2 top-3 z-40 hidden w-2 cursor-col-resize touch-none select-none outline-none md:block"
  >
    <div data-sidebar-resize-track aria-hidden className={`mx-auto h-full w-px transition-colors group-hover/sidebar-resize:bg-foreground/15 group-focus-visible/sidebar-resize:bg-foreground/25 ${resizing ? "bg-foreground/20" : "bg-transparent"}`} />
    <span data-sidebar-resize-grip aria-hidden className={`absolute inset-x-0 top-[calc(50%-1rem)] mx-auto h-8 w-1 rounded-full group-hover/sidebar-resize:bg-foreground/30 ${resizing ? "bg-foreground/40" : "bg-transparent group-focus-visible/sidebar-resize:bg-ring"}`} />
  </div>;
}

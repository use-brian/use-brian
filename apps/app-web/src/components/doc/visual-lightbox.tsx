"use client";

/**
 * Full-screen zoomable preview for an embedded visual block (diagram / chart) —
 * the Notion "open the image in a lightbox" gesture, adapted for model-authored
 * visuals that get squished inside the ~720px editor column.
 *
 * `<ZoomableVisual>` wraps a rendered visual inline and adds two ways in: a
 * hover-revealed **expand** button (discoverable) and **double-click** anywhere
 * on the visual (the Notion gesture; the cursor is `zoom-in` to hint it). The
 * preview itself (`VisualLightbox`) is a base-ui `Dialog` portaled to the body —
 * a **translucent dimming scrim** (the page stays visible behind it, Notion-style)
 * with a **centered board** floating on top: a solid `bg-background` surface
 * (square corners, no border, just a soft shadow) that HUGS the visual with a
 * slight uniform margin on all four sides — sized to its content, NOT
 * full-screen, so the dimmed page shows around it. Inside: the SAME widget
 * re-rendered unconstrained, **pan-by-drag**, **wheel + button zoom**, and a
 * floating `− / % / +` toolbar. Dismissed by Esc, a click on the scrim outside
 * the board, or the close button.
 *
 * Why re-render `children` instead of scaling the inline node: the inline node
 * lives in ProseMirror's editor flow (clipped to the page column + its own
 * stacking context); the preview needs the visual free of both. base-ui only
 * mounts the `Popup` subtree while open, so mermaid / recharts render a second
 * time only when the preview is actually open — no idle cost.
 *
 * [COMP:app-web/visual-lightbox]
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { Dialog } from "@base-ui/react/dialog";
import { Expand, Minus, Plus, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n/client";
import {
  canZoomIn,
  canZoomOut,
  formatZoomPercent,
  zoomByDelta,
  zoomIn,
  zoomOut,
} from "@/lib/visual-zoom";

/**
 * Wrap a rendered visual to make it open in the full-screen preview. `label`
 * names the dialog for assistive tech (falls back to the generic preview copy).
 */
export function ZoomableVisual({
  children,
  label,
}: {
  children: ReactNode;
  label?: string;
}) {
  const t = useT().docPage.lightbox;
  const [open, setOpen] = useState(false);

  return (
    <div className="group/zoom relative">
      <div
        onDoubleClick={() => setOpen(true)}
        className="cursor-zoom-in"
      >
        {children}
      </div>
      <button
        type="button"
        aria-label={t.open}
        title={t.open}
        onClick={() => setOpen(true)}
        className="absolute right-2 top-2 z-10 rounded-md border border-border bg-background/80 p-1.5 text-muted-foreground opacity-0 shadow-sm backdrop-blur transition-opacity hover:bg-muted hover:text-foreground focus-visible:opacity-100 group-hover/zoom:opacity-100 motion-reduce:transition-none"
      >
        <Expand className="size-4" aria-hidden />
      </button>
      <VisualLightbox open={open} onOpenChange={setOpen} label={label ?? t.preview}>
        {children}
      </VisualLightbox>
    </div>
  );
}

function VisualLightbox({
  open,
  onOpenChange,
  label,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  label: string;
  children: ReactNode;
}) {
  const t = useT().docPage.lightbox;
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [panning, setPanning] = useState(false);
  // Drag anchor: pointer start + the offset at grab time. Ref (not state) so a
  // move doesn't re-run the handler closure mid-drag.
  const drag = useRef<{ px: number; py: number; ox: number; oy: number } | null>(null);
  const stageRef = useRef<HTMLDivElement>(null);

  const reset = useCallback(() => {
    setScale(1);
    setOffset({ x: 0, y: 0 });
  }, []);

  // Fresh view every time the preview opens — re-opening shouldn't inherit the
  // last session's pan/zoom.
  useEffect(() => {
    if (open) reset();
  }, [open, reset]);

  // Wheel zoom via a NON-passive native listener: React registers `onWheel` as
  // passive, so `preventDefault()` there is a no-op (+ a console warning) and
  // the trackpad would scroll the page instead of zooming. The stage only
  // exists while the dialog is open, so bind on open and clean up on close.
  useEffect(() => {
    const el = stageRef.current;
    if (!open || !el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      setScale((s) => zoomByDelta(s, e.deltaY));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [open]);

  const onPointerDown = (e: ReactPointerEvent) => {
    if (e.button !== 0) return; // primary button only; let menus/links be
    drag.current = { px: e.clientX, py: e.clientY, ox: offset.x, oy: offset.y };
    setPanning(true);
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* capture can reject a stale/invalid pointer id; pan still works without it */
    }
  };
  const onPointerMove = (e: ReactPointerEvent) => {
    const d = drag.current;
    if (!d) return;
    setOffset({ x: d.ox + (e.clientX - d.px), y: d.oy + (e.clientY - d.py) });
  };
  const endPan = (e: ReactPointerEvent) => {
    if (!drag.current) return;
    drag.current = null;
    setPanning(false);
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* capture may already be gone (pointercancel) */
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        {/* Translucent dimming scrim — the page stays visible behind it
            (Notion-style), so the preview reads as "focus this visual", not "a
            new opaque screen". No blur: the ask is to see THROUGH it. */}
        <Dialog.Backdrop
          className={cn(
            "fixed inset-0 z-50 bg-background/65 transition-opacity duration-150",
            "data-[starting-style]:opacity-0 data-[ending-style]:opacity-0",
          )}
        />
        {/* The board — a solid `bg-background` surface that HUGS the visual with a
            slight, uniform margin (the stage's `p-4`) on all four sides, so the
            preview sits on a board instead of bleeding onto the page. Sized to its
            content and centered via translate — NOT full-screen: capped at
            `92vw`/`92vh`, square corners, no border (only a soft shadow lifts it
            off the dimmed scrim). The page stays dimmed-but-visible around it; a
            click on that scrim dismisses via base-ui outside-press. The content
            below carries a concrete width so recharts (`width="100%"`) has a
            definite box to fill instead of collapsing. */}
        <Dialog.Popup
          className={cn(
            "fixed left-1/2 top-1/2 z-50 flex max-h-[92vh] max-w-[92vw] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden bg-background shadow-xl",
            "transition-all duration-150",
            "data-[starting-style]:scale-[0.98] data-[starting-style]:opacity-0",
            "data-[ending-style]:scale-[0.98] data-[ending-style]:opacity-0",
          )}
        >
          <Dialog.Title className="sr-only">{label}</Dialog.Title>
          <Dialog.Close
            aria-label={t.close}
            className="absolute right-3 top-3 z-10 rounded-md border border-border bg-background/80 p-1.5 text-muted-foreground shadow-sm backdrop-blur hover:bg-muted hover:text-foreground"
          >
            <X className="size-4" aria-hidden />
          </Dialog.Close>

          {/* Pan/zoom stage — also the board's content box, so its `p-4` is the
              slight uniform margin around the visual. `touch-none` so a touch-drag
              pans instead of scrolling the page underneath; `overflow-hidden`
              clips the visual to the board once it's zoomed past 100%. */}
          <div
            ref={stageRef}
            className="relative touch-none overflow-hidden p-4"
            style={{ cursor: panning ? "grabbing" : "grab" }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={endPan}
            onPointerCancel={endPan}
          >
            <div
              className="w-[min(1100px,86vw)] max-w-full"
              style={{
                transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})`,
                transformOrigin: "center center",
                transition: panning ? "none" : "transform 120ms ease-out",
              }}
            >
              {children}
            </div>
          </div>

          {/* Floating zoom toolbar — bottom-center, Notion-style. Clicking the
              percentage resets to fit. */}
          <div className="pointer-events-none absolute inset-x-0 bottom-4 flex justify-center">
            <div className="pointer-events-auto flex items-center gap-1 rounded-full border border-border bg-background/90 px-1.5 py-1 shadow-md backdrop-blur">
              <ToolbarButton
                aria-label={t.zoomOut}
                disabled={!canZoomOut(scale)}
                onClick={() => setScale(zoomOut)}
              >
                <Minus className="size-4" aria-hidden />
              </ToolbarButton>
              <button
                type="button"
                onClick={reset}
                aria-label={t.reset}
                className="min-w-[3.5rem] rounded-md px-2 py-1 text-center text-xs font-medium tabular-nums text-foreground hover:bg-muted"
              >
                {formatZoomPercent(scale)}
              </button>
              <ToolbarButton
                aria-label={t.zoomIn}
                disabled={!canZoomIn(scale)}
                onClick={() => setScale(zoomIn)}
              >
                <Plus className="size-4" aria-hidden />
              </ToolbarButton>
            </div>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function ToolbarButton({ children, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      {...props}
      className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
    >
      {children}
    </button>
  );
}

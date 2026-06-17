"use client";

/**
 * Comment thread popover — the **on-content overlay** shell for a thread.
 *
 * Used when there isn't room for the margin rail (`comment-rail.tsx`) — narrow
 * viewports, or a thread with no in-doc anchor (unanchored page threads,
 * orphaned threads opened from the index). Self-positioned (portal +
 * `position:fixed` coords from the anchor's rect) rather than base-ui's
 * trigger-based popover: the thread is opened by clicking a gutter badge /
 * highlight that lives OUTSIDE any React trigger, so base-ui treated the
 * opening click as an outside-press and dismissed immediately. We own
 * positioning + outside-click here so the box holds.
 *
 * `placeAnchoredPanel` flips the box above/below by available space and caps
 * `maxHeight` so a long thread compresses to an internal scroll instead of
 * spilling off-screen. The thread content itself is the shared
 * `<CommentThreadBody>`.
 *
 * Placement recomputes on scroll via a **capture-phase** window listener (the
 * only way a window listener sees the anchor's own non-bubbling scroll). That
 * same capture, though, also catches scrolls from *inside* the panel — the
 * thread list auto-following a streaming reply sets its `scrollTop` on every
 * token — which made the box flip below↔above ~3x/sec (the SSE cadence): a
 * flicker. `scrollMovesAnchor` + the `panelRef` now filter those out, and
 * recomputes are rAF-coalesced + dropped when the placement is unchanged.
 *
 * [COMP:app-web/comment-thread-popover]
 */

import * as React from "react";
import { createPortal } from "react-dom";
import { type CommentThread } from "@/lib/api/comments";
import { type AssistantIdentity } from "@/lib/api/views";
import { isInsideComposerPopup } from "@/lib/comment-dismiss";
import { CommentThreadBody, type CommentSeed } from "./comment-thread-body";

const PANEL_WIDTH = 420;
/** Distance kept between the panel and the viewport edge / the anchor. */
const MARGIN = 8;
const GAP = 8;
/** Below this much headroom we consider flipping the panel above the anchor. */
const COMFORTABLE_HEIGHT = 340;
/** Floor so an extreme-short window still yields a usable (scrollable) box. */
const MIN_HEIGHT = 160;

type Props = {
  thread: CommentThread | null;
  anchorEl: HTMLElement | null;
  pageId: string;
  workspaceId: string;
  assistantId: string;
  currentUser?: { id: string; name: string; avatarUrl?: string | null };
  /** The doc assistant's real name + icon, for AI comment rows. */
  assistant?: AssistantIdentity | null;
  /** A page-composer hand-off forwarded to the body — auto-sends the first
   *  message on open. Set only for a freshly-posted page comment (which, being
   *  unanchored, always opens in this overlay rather than the margin rail). */
  seed?: CommentSeed;
  onClose: () => void;
  onChanged: () => void;
};

export type AnchoredPos = {
  left: number;
  /** Pin to the anchor's bottom (panel grows DOWN). */
  top?: number;
  /** Pin to the anchor's top (panel grows UP). */
  bottom?: number;
  /** Hard ceiling — the panel compresses (inner scroll) instead of overflowing. */
  maxHeight: number;
};

/** A viewport rect — the subset of DOMRect this math reads. */
type AnchorRect = Pick<DOMRect, "top" | "bottom" | "left">;

/**
 * Choose a placement for the fixed panel that is always confined to the
 * **band** between the page chrome and the viewport's bottom margin.
 *
 * Pure (no DOM) so the placement rules are unit-testable. The band is
 * `[ceiling, vh - MARGIN]`, where `ceiling = max(MARGIN, topInset)`. `topInset`
 * is the bottom edge (viewport y) of the page chrome — the doc top bar +
 * breadcrumb navbar that sit fixed above the scrolling content. The panel is
 * `position:fixed` and portaled to `<body>`, so the band is the only region it
 * may occupy; outside it lies the chrome (above) or the viewport edge (below).
 *
 * The panel pins to whichever side of the anchor can host it — `top` for below,
 * `bottom` for above (pinning the bottom edge lets the box grow upward without
 * measuring its height) — and caps `maxHeight` to the room on that side **so the
 * box can never cross the band edges**. Crucially the `MIN_HEIGHT` floor is
 * applied only when a side actually has at least that much room; it is never
 * allowed to push the box past the ceiling (which would tuck the panel under —
 * or above — the top bar). When neither side can host `MIN_HEIGHT` (an anchor
 * taller than the viewport, e.g. an unanchored thread anchored to the whole
 * editor element, or an extreme-short window) the anchor relationship is
 * dropped and the panel fills the band, pinned just under the chrome.
 */
export function placeAnchoredPanel(
  r: AnchorRect,
  vw: number,
  vh: number,
  topInset = 0,
): AnchoredPos {
  const left = Math.max(MARGIN, Math.min(r.left, vw - PANEL_WIDTH - MARGIN));

  const ceiling = Math.max(MARGIN, topInset); // highest the top edge may reach
  const floorY = vh - MARGIN; // lowest the bottom edge may reach
  const band = Math.max(0, floorY - ceiling);

  // Room for the box on each side of the anchor, already confined to the band.
  const belowTop = Math.max(r.bottom + GAP, ceiling);
  const roomBelow = floorY - belowTop;
  const aboveBottom = Math.min(r.top - GAP, floorY);
  const roomAbove = aboveBottom - ceiling;

  const fitsBelow = roomBelow >= MIN_HEIGHT;
  const fitsAbove = roomAbove >= MIN_HEIGHT;

  // Neither side can host a usable box (anchor fills the viewport, or the
  // window is tiny): ignore the anchor and fill the band under the chrome.
  if (!fitsBelow && !fitsAbove) {
    return { left, top: ceiling, maxHeight: Math.max(MIN_HEIGHT, band) };
  }

  // Prefer below; flip above only when below can't host it, or below is cramped
  // AND above is roomier.
  const placeBelow = fitsBelow && (!fitsAbove || roomBelow >= COMFORTABLE_HEIGHT || roomBelow >= roomAbove);

  if (placeBelow) {
    // maxHeight = roomBelow keeps the bottom edge at/above `floorY`.
    return { left, top: belowTop, maxHeight: roomBelow };
  }
  // Above: pin the bottom edge just over the anchor; maxHeight = roomAbove keeps
  // the top edge at/below `ceiling` (no floor allowed to cross it).
  return { left, bottom: vh - aboveBottom, maxHeight: roomAbove };
}

/**
 * The viewport-y bottom edge of the doc page chrome — the top bar
 * (`doc-topbar.tsx`) + breadcrumb/action navbar (`page-header.tsx`), each
 * tagged `data-doc-chrome`. This is the ceiling the fixed, body-portaled
 * comment surfaces — this popover **and** the margin rail (`comment-rail.tsx`)
 * — must stay below so they never overlap the bars. Measured straight from the
 * live chrome rows (their real rendered `bottom`, summing both rows + any
 * banner between them) — *not* by walking the anchor's ancestor chain, which
 * could match an inner horizontal scroller (a code block's `overflow-x:auto`
 * makes its computed `overflow-y` `auto` too) and yield a bogus inset. Returns
 * 0 when no chrome is mounted → the panel falls back to the plain margin.
 */
export function chromeBottom(): number {
  if (typeof document === "undefined") return 0;
  let bottom = 0;
  for (const el of document.querySelectorAll("[data-doc-chrome]")) {
    bottom = Math.max(bottom, el.getBoundingClientRect().bottom);
  }
  return bottom;
}

/** Shared panel width, so a sibling composer (the new-comment draft) can size
 *  itself identically to the thread popover. */
export const COMMENT_PANEL_WIDTH = PANEL_WIDTH;

/**
 * Should a scroll event reposition the panel? Only a scroll of an **ancestor**
 * scroll container moves the anchor (and therefore the panel). A scroll that
 * originates **inside** the panel must be ignored.
 *
 * This is the fix for the streaming flicker: the thread body's own message list
 * (`overflow-y-auto`) auto-follows a streaming reply by setting its `scrollTop`
 * on every token, which fires a `scroll` event the panel's **capture-phase**
 * listener would otherwise catch (capture is how a window listener sees a
 * non-bubbling scroll from a descendant). Recomputing placement on each of those
 * — while the anchor's rect was momentarily mid-reflow — flipped the box
 * below↔above ~3x/sec (the SSE token cadence), reading as a flicker. Pure (the
 * `panel.contains` call is the only DOM touch), so the rule is unit-testable.
 */
export function scrollMovesAnchor(
  target: Node | null,
  panel: HTMLElement | null,
): boolean {
  // No panel mounted yet, or a scroll with no target (the window/document
  // itself) → treat it as a page scroll and reposition.
  if (!panel || !target) return true;
  return !panel.contains(target);
}

/** Two placements are interchangeable when every pinned edge + the cap match —
 *  used to drop a no-op `setPos` so a burst of scroll/resize events that don't
 *  actually move the anchor never churns a render. */
function samePos(a: AnchoredPos, b: AnchoredPos): boolean {
  return (
    a.left === b.left &&
    a.top === b.top &&
    a.bottom === b.bottom &&
    a.maxHeight === b.maxHeight
  );
}

/**
 * Track the anchor's viewport rect so the fixed panel follows it on
 * scroll/resize, recomputing placement via {@link placeAnchoredPanel}.
 * Exported so the new-comment draft composer reuses the exact placement.
 *
 * `panelRef` (the rendered panel element) lets the recompute distinguish an
 * ancestor/page scroll — which moves the anchor — from a scroll **inside** the
 * panel (its message list auto-following a streaming reply), which doesn't; see
 * {@link scrollMovesAnchor}. Recomputes are coalesced into one placement per
 * frame and skipped when the result is unchanged, so a burst of events can't
 * thrash the box.
 */
export function useAnchoredPosition(
  anchorEl: HTMLElement | null,
  open: boolean,
  panelRef?: React.RefObject<HTMLElement | null>,
) {
  const [pos, setPos] = React.useState<AnchoredPos | null>(null);
  React.useEffect(() => {
    if (!open || !anchorEl || typeof window === "undefined") return;
    let raf = 0;
    let last: AnchoredPos | null = null;
    const compute = () => {
      raf = 0;
      const next = placeAnchoredPanel(
        anchorEl.getBoundingClientRect(),
        window.innerWidth,
        window.innerHeight,
        chromeBottom(),
      );
      if (last && samePos(last, next)) return;
      last = next;
      setPos(next);
    };
    // Coalesce a burst of scroll/resize callbacks into one placement per frame.
    const schedule = () => {
      if (raf) return;
      raf = window.requestAnimationFrame(compute);
    };
    const onScroll = (e: Event) => {
      if (!scrollMovesAnchor(e.target as Node | null, panelRef?.current ?? null)) return;
      schedule();
    };
    compute();
    window.addEventListener("resize", schedule);
    // Capture phase so a scroll from the anchor's own (non-bubbling) scroll
    // parent is seen; `onScroll` filters out the panel's internal scroll.
    window.addEventListener("scroll", onScroll, true);
    return () => {
      if (raf) window.cancelAnimationFrame(raf);
      window.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [anchorEl, open, panelRef]);
  return pos;
}

export function CommentThreadPopover({
  thread,
  anchorEl,
  pageId,
  workspaceId,
  assistantId,
  currentUser,
  assistant,
  seed,
  onClose,
  onChanged,
}: Props) {
  const open = !!thread && !!anchorEl;
  const panelRef = React.useRef<HTMLDivElement>(null);
  // Pass the panel element so a scroll INSIDE it (the thread list auto-following
  // a streaming reply) doesn't trigger a reposition — see `scrollMovesAnchor`.
  const pos = useAnchoredPosition(anchorEl, open, panelRef);

  // Outside-click + Escape. The listener is attached on the next tick so the
  // click that opened the panel can't immediately close it.
  React.useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const tgt = e.target as Node;
      if (panelRef.current?.contains(tgt)) return;
      if (anchorEl?.contains(tgt)) return;
      // Clicking another comment badge/highlight/rail card re-opens that thread
      // — let the editor's handler drive it instead of closing here (no flicker).
      if ((tgt as HTMLElement)?.closest?.("[data-thread-id],[data-comment-badge]")) return;
      // The composer portals the @-mention list and the base-ui model-tier
      // Select to <body>, so a pick lands "outside" the panel; dismissing here
      // would tear the popup down before the choice commits.
      if (isInsideComposerPopup(tgt)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const id = window.setTimeout(() => {
      document.addEventListener("mousedown", onDown);
      document.addEventListener("keydown", onKey);
    }, 0);
    return () => {
      window.clearTimeout(id);
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, anchorEl, onClose]);

  if (!open || !thread || !pos || typeof document === "undefined") return null;

  const panel = (
    <div
      ref={panelRef}
      role="dialog"
      style={{
        position: "fixed",
        left: pos.left,
        top: pos.top,
        bottom: pos.bottom,
        width: PANEL_WIDTH,
        maxHeight: pos.maxHeight,
      }}
      className="z-40 flex max-w-[92vw] flex-col overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-lg"
    >
      <CommentThreadBody
        key={thread.id}
        thread={thread}
        pageId={pageId}
        workspaceId={workspaceId}
        assistantId={assistantId}
        currentUser={currentUser}
        assistant={assistant}
        seed={seed}
        onChanged={onChanged}
        onResolved={onClose}
      />
    </div>
  );

  return createPortal(panel, document.body);
}

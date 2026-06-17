"use client";

/**
 * Comment rail — the always-on **margin** surface for anchored threads.
 *
 * When the page column leaves room beside it (wide viewports), every open
 * anchored thread shows a **collapsed preview card** parked in the right
 * margin, vertically tracking its commented line (first comment + "Show N
 * replies" + latest, mirroring Notion's margin comments). Clicking a card
 * expands THAT thread in place to the full `<CommentThreadBody>` (thread +
 * composer); clicking elsewhere collapses it. Cards stack to avoid overlap.
 *
 * This is the wide-screen alternative to the on-content overlay
 * (`comment-thread-popover.tsx`). The parent decides which is live: the rail
 * needs margin room AND an in-doc anchor; otherwise the overlay handles the
 * active thread. Geometry (`useRailGeometry`) is lifted to the parent so both
 * agree on whether there's room.
 *
 * Positioning is `position:fixed`, recomputed from each anchor's viewport rect
 * on scroll/resize (consistent with the overlay), so collapsed and expanded
 * cards follow their lines together. A collapsed card whose line scrolls up
 * into the page chrome is CLIPPED at the chrome's bottom edge (`chromeBottom()`
 * → `clipUnderChrome`), so it slides UNDER the top bar — the opaque bars cover
 * the hidden slice — instead of a body-portaled card painting over them; it's
 * dropped only once fully behind the chrome. The expanded card is the exception
 * — it pins just below the chrome (never clipped) so the open thread stays
 * fully visible.
 *
 * [COMP:app-web/comment-rail]
 */

import * as React from "react";
import { createPortal } from "react-dom";
import { useT } from "@/lib/i18n/client";
import { format } from "@/lib/i18n/format";
import {
  fetchSessionMessages,
  extractMessageText,
  type DocSessionMessage,
} from "@/lib/api/sessions";
import { type CommentThread } from "@/lib/api/comments";
import { type AssistantIdentity } from "@/lib/api/views";
import { isInsideComposerPopup } from "@/lib/comment-dismiss";
import {
  ThreadGutter,
  relativeTime,
  visibleComments,
  CommentThreadBody,
  resolveCommentAuthor,
  type CommentAuthor,
  type CommentSeed,
} from "./comment-thread-body";
import { chromeBottom, scrollMovesAnchor } from "./comment-thread-popover";
import { PreviewMarkdown } from "./preview-markdown";
import { quoteForRow } from "./comment-quote";

/** Minimum card width (the rail-room gate is checked against this). */
export const RAIL_WIDTH = 300;
/** Cards grow up to this when the gutter allows ("use more space"). */
export const RAIL_MAX_WIDTH = 480;
/** Gap between the page column's right edge and the rail card. */
export const RAIL_GAP = 32;
/** Vertical inset keeping an expanded card clear of the viewport bottom — and
 *  the top only when no page chrome is measured (otherwise the chrome ceiling,
 *  `chromeBottom()`, is the top bound). */
export const RAIL_MARGIN = 16;
/** Inset between the rail card's right edge and the viewport edge. Mirrors the
 *  page body's left gutter (`lg:px-16` = 64px in doc-shell) so the rail reads
 *  as "contained in the page" — its right margin matches the content's left. */
export const RAIL_EDGE_MARGIN = 64;

/** The right gutter `doc-shell` reserves (content shifts left by this) when
 *  a page has inline comments — scales with the viewport so wide screens give
 *  the cards more room, narrow ones stay modest. Returns 0 below the threshold
 *  where a gutter would crush the reading column (→ overlay instead). */
export function commentGutterWidth(viewportWidth: number): number {
  if (viewportWidth < 1180) return 0;
  return Math.round(Math.max(400, Math.min(viewportWidth * 0.32, 540)));
}
/** Vertical gap between stacked cards. */
const CARD_GAP = 12;
/** Estimated heights used for stacking until a card has been measured. */
const COLLAPSED_EST = 104;
const EXPANDED_EST = 380;
/** An expanded card never gets shorter than this (it scrolls internally). */
const MIN_EXPANDED = 200;
/** Height jump (px) below which a card resize is applied instantly, not tweened
 *  — keeps typing in the composer (a line ≈ 22px) snappy while expand / collapse
 *  / message-load (all far larger) animate. See RailCard. */
const TWEEN_MIN_DELTA = 28;

/** Is there room for the rail just to the right of the page column? Pure.
 *  The shell reserves a right gutter — shifting the page content left — when a
 *  page has inline comments, so on a wide screen this clears once that gutter
 *  opens; on narrow screens it stays false and the overlay takes over. */
export function railHasRoom(editorRight: number, viewportWidth: number): boolean {
  return editorRight + RAIL_GAP + RAIL_WIDTH + RAIL_EDGE_MARGIN <= viewportWidth;
}

/**
 * Stack cards downward so none overlaps the one above. Each card sits at its
 * anchor's top unless that would collide with the previous card's bottom, in
 * which case it's pushed down. Pure + order-stable (sorted by anchor top).
 */
export function stackCards(
  items: { threadId: string; anchorTop: number; height: number }[],
  gap = CARD_GAP,
): Map<string, number> {
  const sorted = [...items].sort((a, b) => a.anchorTop - b.anchorTop);
  const out = new Map<string, number>();
  let cursor = -Infinity;
  for (const it of sorted) {
    const top = Math.max(it.anchorTop, cursor);
    out.set(it.threadId, top);
    cursor = top + it.height + gap;
  }
  return out;
}

/**
 * How many pixels of a collapsed card's TOP are hidden behind the page chrome
 * (`safeTop` = `chromeBottom()`) — the amount to clip so the card slides UNDER
 * the top bar (Notion-style) instead of a fixed, body-portaled card painting
 * over it. `0` once the card sits fully below the chrome. Pure.
 */
export function clipUnderChrome(top: number, safeTop: number): number {
  return Math.max(0, safeTop - top);
}

/** Geometry shared with the parent: the rail's left X (viewport) + room flag. */
export function useRailGeometry(editorWrapEl: HTMLElement | null): {
  hasRoom: boolean;
  railLeft: number;
} {
  const [geo, setGeo] = React.useState({ hasRoom: false, railLeft: 0 });
  React.useEffect(() => {
    if (!editorWrapEl || typeof window === "undefined") return;
    const compute = () => {
      const r = editorWrapEl.getBoundingClientRect();
      setGeo({
        hasRoom: railHasRoom(r.right, window.innerWidth),
        railLeft: r.right + RAIL_GAP,
      });
    };
    compute();
    window.addEventListener("resize", compute);
    // The column keeps a fixed width but RE-CENTERS when the pane resizes
    // (sidebar collapse) — its size doesn't change, so observe a scrollable
    // ancestor whose width does.
    const scrollParent = findScrollParent(editorWrapEl);
    const ro = new ResizeObserver(compute);
    ro.observe(editorWrapEl);
    if (scrollParent) ro.observe(scrollParent);
    return () => {
      window.removeEventListener("resize", compute);
      ro.disconnect();
    };
  }, [editorWrapEl]);
  return geo;
}

function findScrollParent(el: HTMLElement): HTMLElement | null {
  let node: HTMLElement | null = el.parentElement;
  while (node) {
    const oy = getComputedStyle(node).overflowY;
    if (oy === "auto" || oy === "scroll") return node;
    node = node.parentElement;
  }
  return null;
}

type PreviewMsg = { author: CommentAuthor; time: string; body: string };
type RailPreview = { first: PreviewMsg; last: PreviewMsg | null; hiddenCount: number };

type Props = {
  /** Open threads for the page; the rail renders only those with an in-doc anchor. */
  threads: CommentThread[];
  /** The page column element — cards park just to its right. */
  railLeft: number;
  hasRoom: boolean;
  /** Bumped when threads change, to re-hydrate previews + re-measure anchors. */
  refreshKey: number;
  /** The expanded thread id (null = all collapsed). */
  activeThreadId: string | null;
  /** A page-composer hand-off for the active thread (a freshly-minted thread
   *  whose first message must auto-send + stream in place). The rail forwards it
   *  to the expanded body so a brand-new comment opened into the rail still
   *  sends — without it the seed only survives when the thread happens to render
   *  in the on-content popover, and a rail-routed comment silently never sends. */
  activeSeed?: CommentSeed;
  onExpand: (thread: CommentThread) => void;
  onCollapse: () => void;
  pageId: string;
  workspaceId: string;
  assistantId: string;
  currentUser?: { id: string; name: string; avatarUrl?: string | null };
  /** The doc assistant's real name + icon, for AI comment rows. */
  assistant?: AssistantIdentity | null;
  onChanged: () => void;
};

export function CommentRail({
  threads,
  railLeft,
  hasRoom,
  refreshKey,
  activeThreadId,
  activeSeed,
  onExpand,
  onCollapse,
  pageId,
  workspaceId,
  assistantId,
  currentUser,
  assistant,
  onChanged,
}: Props) {
  const t = useT().comments;
  const [frame, setFrame] = React.useState<{
    items: { threadId: string; anchorTop: number }[];
    vh: number;
    vw: number;
    /** Viewport-y bottom edge of the fixed page chrome — the rail's top bound. */
    safeTop: number;
  }>({ items: [], vh: 0, vw: 0, safeTop: RAIL_MARGIN });
  const [previews, setPreviews] = React.useState<Record<string, RailPreview>>({});
  // Full message rows kept from the SAME fetch that builds the previews, handed
  // to `<CommentThreadBody>` on expand so the thread opens with content already
  // in place — no fetch-on-mount loader flash, so the open is a single motion.
  const [threadMessages, setThreadMessages] = React.useState<
    Record<string, DocSessionMessage[]>
  >({});
  const [heights, setHeights] = React.useState<Record<string, number>>({});
  // The body-portaled card container. The scroll-tracking effect reads it to
  // ignore scrolls that originate INSIDE a card (an expanded card's list
  // auto-following a streaming reply) — those don't move the doc anchors the
  // cards track, so recomputing on them is pure churn. See `scrollMovesAnchor`.
  const railRef = React.useRef<HTMLDivElement>(null);

  const openIds = threads.map((th) => th.id).join(",");

  // ── Track each anchor's viewport position (scroll/resize/content reflow). ──
  React.useEffect(() => {
    if (!hasRoom || typeof window === "undefined") return;
    const compute = () => {
      const items: { threadId: string; anchorTop: number }[] = [];
      // Only IN-DOC anchors (comment marks / AI block tints) count — they live
      // inside the editor's ProseMirror root. Scoping the query here keeps the
      // rail to genuinely anchored threads: the page-comments band renders the
      // unanchored running thread with its own `[data-thread-id]` OUTSIDE the
      // doc, and a global query would mistake that for an anchor and park a
      // duplicate rail card on it. Unanchored threads belong inline in the band.
      const pmRoot = document.querySelector(".doc-collab-editor .ProseMirror");
      for (const th of threads) {
        // Anchor to the highlighted text / block tint, NOT the gutter badge
        // (which sits in the same right-of-content zone as the rail and may be
        // hidden in gutter mode — its rect would be 0).
        const el = pmRoot?.querySelector(
          `[data-thread-id="${CSS.escape(th.id)}"]:not([data-comment-badge])`,
        ) as HTMLElement | null;
        if (!el) continue;
        items.push({ threadId: th.id, anchorTop: el.getBoundingClientRect().top });
      }
      setFrame({
        items,
        vh: window.innerHeight,
        vw: window.innerWidth,
        // The rail is fixed + body-portaled, so a card whose line scrolls up
        // behind the top bar would otherwise paint OVER it. This is the chrome's
        // bottom edge (same ceiling the overlay honours) — cards clip against it
        // so they slide UNDER the bars; the expanded card pins below it.
        safeTop: Math.max(RAIL_MARGIN, chromeBottom()),
      });
    };
    compute();
    // The comment highlights paint as ProseMirror decorations that may land
    // AFTER this child effect runs (a highlight adds no layout, so the
    // ResizeObserver below won't fire for it) — re-query next frame so the
    // anchors are found on first load instead of waiting for a scroll.
    const raf = window.requestAnimationFrame(compute);
    window.addEventListener("resize", compute);
    // Capture phase to see the anchor's own non-bubbling scroll — but skip a
    // scroll that originates inside a card (an expanded card auto-following a
    // streaming reply), which doesn't move the lines the cards track.
    const onScroll = (e: Event) => {
      if (scrollMovesAnchor(e.target as Node | null, railRef.current)) compute();
    };
    window.addEventListener("scroll", onScroll, true);
    // Content edits change anchor positions without a scroll/resize.
    const pm = document.querySelector(".doc-collab-editor .ProseMirror");
    const ro = pm ? new ResizeObserver(compute) : null;
    if (pm && ro) ro.observe(pm);
    return () => {
      window.cancelAnimationFrame(raf);
      window.removeEventListener("resize", compute);
      window.removeEventListener("scroll", onScroll, true);
      ro?.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasRoom, openIds, refreshKey]);

  // ── Lazily hydrate the collapsed previews (first + latest + hidden count). ──
  React.useEffect(() => {
    if (!hasRoom || !openIds) return;
    let cancelled = false;
    const assistantAuthor: CommentAuthor = {
      id: assistant?.id ?? "assistant",
      name: assistant?.name ?? t.assistantName,
      isAssistant: true,
      iconSeed: assistant?.iconSeed ?? null,
    };
    const resolveMsg = (m: DocSessionMessage): PreviewMsg => {
      const author = resolveCommentAuthor(m, { currentUser, assistant: assistantAuthor });
      // Strip a human quoted-reply's leading `>` block so the preview shows the
      // reply body, not the quote (assistant rows pass through untouched).
      return {
        author,
        time: relativeTime(m.timestamp, t.justNow),
        body: quoteForRow(extractMessageText(m.content), author.isAssistant).body,
      };
    };
    void Promise.all(
      threads.map(
        async (th): Promise<[string, RailPreview, DocSessionMessage[]] | null> => {
          try {
            const rows = await fetchSessionMessages(th.sessionId);
            const visible = visibleComments(rows);
            const first = visible[0];
            if (!first) return null;
            const last = visible.length > 1 ? visible[visible.length - 1] : null;
            return [
              th.id,
              {
                first: resolveMsg(first),
                last: last ? resolveMsg(last) : null,
                hiddenCount: Math.max(0, visible.length - 2),
              },
              // Keep the raw (unfiltered) rows — `CommentThreadBody` does its own
              // `visibleComments()` pass, so it gets exactly what it would fetch.
              rows,
            ];
          } catch {
            return null;
          }
        },
      ),
    ).then((entries) => {
      if (cancelled) return;
      const ok = entries.filter(Boolean) as [string, RailPreview, DocSessionMessage[]][];
      setPreviews(Object.fromEntries(ok.map(([id, preview]) => [id, preview])));
      setThreadMessages(Object.fromEntries(ok.map(([id, , rows]) => [id, rows])));
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    hasRoom,
    openIds,
    refreshKey,
    currentUser?.id,
    currentUser?.name,
    currentUser?.avatarUrl,
    assistant?.id,
    assistant?.name,
    assistant?.iconSeed,
    t.assistantName,
    t.justNow,
  ]);

  // Each card reports its own rendered height up (driven by RailCard's
  // ResizeObserver) so the stack math can position the others. RailCard reports
  // its true (auto / `maxHeight`-capped) height even mid-tween, so neighbours
  // settle into the final layout instead of chasing the animation.
  const reportHeight = React.useCallback((threadId: string, h: number) => {
    setHeights((prev) => (Math.abs((prev[threadId] ?? 0) - h) > 1 ? { ...prev, [threadId]: h } : prev));
  }, []);

  // Stack every anchored card by its line position. Collapsed cards keep their
  // true line top so they track the line and slide UNDER the chrome (clipped) as
  // it scrolls up. The active (expanded) card is the exception — it PINS below
  // the chrome, so feed the stack its clamped top (`max(anchorTop, safeTop)`),
  // which keeps the cards after it from overlapping its pinned body.
  const stacked = React.useMemo(
    () =>
      stackCards(
        frame.items.map((it) => ({
          threadId: it.threadId,
          anchorTop:
            it.threadId === activeThreadId
              ? Math.max(it.anchorTop, frame.safeTop)
              : it.anchorTop,
          height:
            heights[it.threadId] ??
            (it.threadId === activeThreadId ? EXPANDED_EST : COLLAPSED_EST),
        })),
      ),
    [frame.items, heights, activeThreadId, frame.safeTop],
  );

  // Collapse when clicking outside any card / anchor (mirrors the overlay).
  // Only while THIS surface is hosting the expanded thread — when the active
  // thread is unanchored the overlay owns it and runs its own handler, so the
  // rail must stay out of the way (else it would close the overlay).
  const railExpanding =
    !!activeThreadId && frame.items.some((it) => it.threadId === activeThreadId);
  React.useEffect(() => {
    if (!railExpanding) return;
    const onDown = (e: MouseEvent) => {
      const tgt = e.target as HTMLElement | null;
      if (tgt?.closest?.("[data-thread-id],[data-comment-badge]")) return;
      // The composer portals the @-mention list and the base-ui model-tier
      // Select to <body>, so a pick lands "outside" the expanded card;
      // collapsing here would tear the popup down before the choice commits.
      if (isInsideComposerPopup(tgt)) return;
      onCollapse();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCollapse();
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
  }, [railExpanding, onCollapse]);

  if (!hasRoom || frame.items.length === 0 || typeof document === "undefined") return null;

  const byId = new Map(threads.map((th) => [th.id, th]));

  // Card width grows to fill the reserved gutter (Notion uses the space when it
  // has it), clamped between the minimum and a comfortable max.
  const cardWidth = Math.round(
    Math.max(RAIL_WIDTH, Math.min(frame.vw - railLeft - RAIL_EDGE_MARGIN, RAIL_MAX_WIDTH)),
  );
  // Card chrome (flat 2px border, resting grey → brand-blue on focus) lives in
  // `.doc-rail-card` (globals.css); the focus colour is CSS `:focus-within`,
  // NOT JS state, so it clears the instant focus leaves the card — including
  // across the collapsed↔expanded swap, where the old JS flag stuck blue.
  const cards = frame.items.map(({ threadId, anchorTop }) => {
    const thread = byId.get(threadId);
    if (!thread) return null;
    const top = stacked.get(threadId) ?? anchorTop;
    const expanded = threadId === activeThreadId;
    const cardHeight = heights[threadId] ?? (expanded ? EXPANDED_EST : COLLAPSED_EST);
    // Drop a collapsed card once it's slid FULLY behind the chrome (its bottom
    // crossed `safeTop`) or been pushed past the viewport floor. The expanded
    // card always stays — its `clampedTop` keeps it pinned even off-line.
    if (!expanded && (top + cardHeight <= frame.safeTop || top > frame.vh + 40))
      return null;

    // Expanded: pin between the chrome floor and the viewport bottom + cap the
    // height (the body compresses to an internal scroll). Collapsed: sit at the
    // stacked line top and clip the slice that has slid up behind the chrome, so
    // the card goes UNDER the top bar instead of painting over it.
    const clampedTop = expanded
      ? Math.min(Math.max(top, frame.safeTop), frame.vh - MIN_EXPANDED - RAIL_MARGIN)
      : top;
    const clipTop = expanded ? 0 : clipUnderChrome(top, frame.safeTop);
    const maxHeight = expanded
      ? Math.min(frame.vh - clampedTop - RAIL_MARGIN, Math.round(frame.vh * 0.7))
      : undefined;
    const preview = previews[threadId];

    return (
      <RailCard
        key={threadId}
        threadId={threadId}
        expanded={expanded}
        left={railLeft}
        top={clampedTop}
        width={cardWidth}
        maxHeight={maxHeight}
        clipTop={clipTop}
        ariaLabel={t.railAria}
        onExpand={() => onExpand(thread)}
        onHeight={reportHeight}
      >
        {expanded ? (
          <CommentThreadBody
            thread={thread}
            pageId={pageId}
            workspaceId={workspaceId}
            assistantId={assistantId}
            currentUser={currentUser}
            assistant={assistant}
            seed={activeSeed}
            onChanged={onChanged}
            onResolved={onCollapse}
            initialMessages={threadMessages[threadId]}
            scrollToEnd
          />
        ) : preview ? (
          <>
            <PreviewRow
              msg={preview.first}
              thread={thread}
              connect={preview.hiddenCount > 0 || !!preview.last}
            />
            {preview.hiddenCount > 0 ? (
              <div className="flex gap-2.5">
                <ThreadGutter connect />
                <span className="pb-2.5 text-[12.5px] font-medium text-muted-foreground">
                  {preview.hiddenCount === 1
                    ? t.showRepliesOne
                    : format(t.showRepliesMany, { count: preview.hiddenCount })}
                </span>
              </div>
            ) : null}
            {preview.last ? <PreviewRow msg={preview.last} /> : null}
            {thread.sessionStatus === "running" ? (
              // At-a-glance signal that this thread's assistant is still working
              // (a turn that survived a page refresh). Expanding the card
              // reconnects to the live reply; this is just the collapsed cue.
              <div className="flex items-center gap-1.5 pl-[34px] pt-0.5 text-[12px] text-muted-foreground">
                <span className="inline-block size-1.5 animate-pulse rounded-full bg-amber-500" />
                <span>{t.working}</span>
              </div>
            ) : null}
          </>
        ) : (
          <div className="flex items-center gap-2.5">
            <span className="size-7 shrink-0 animate-pulse rounded-full bg-muted" />
            <span className="h-3 w-32 animate-pulse rounded bg-muted" />
          </div>
        )}
      </RailCard>
    );
  });

  // `display:contents` so the wrapper adds no box (the cards stay
  // `position:fixed` exactly as before) while still being a DOM ancestor the
  // scroll filter can test card-internal scrolls against (`railRef`).
  return createPortal(
    <div ref={railRef} style={{ display: "contents" }}>
      {cards}
    </div>,
    document.body,
  );
}

/** Honour the OS "reduce motion" setting — skip the height tween when set. */
function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

type RailCardProps = {
  threadId: string;
  expanded: boolean;
  left: number;
  top: number;
  width: number;
  /** Hard height cap for the expanded card (it compresses to an inner scroll). */
  maxHeight?: number;
  /** Pixels of the card's TOP hidden behind the page chrome — clips it so a
   *  collapsed card slides UNDER the top bar rather than over it. 0 = no clip. */
  clipTop?: number;
  ariaLabel: string;
  onExpand: () => void;
  /** Report the card's true rendered height up for the stack math. */
  onHeight: (threadId: string, h: number) => void;
  children: React.ReactNode;
};

/**
 * One rail card — the SAME element in both states (collapsed preview AND
 * expanded thread), so its size can actually tween instead of hard-swapping a
 * `<button>` for a `<div>`. A `ResizeObserver` watches the card's box and,
 * whenever its natural height changes — expand, collapse, OR the async
 * message-load that grows an expanding thread — animates `height` from the old
 * box to the new via the Web Animations API. The card is `flex-col` with the
 * body's message list `flex-1 min-h-0` and the composer `shrink-0`, so the
 * composer stays pinned + visible at every in-between height, and
 * `overflow:hidden` clips the reveal. Resting height stays `auto` (capped by
 * `maxHeight` when expanded) — the tween only borrows it transiently — so the
 * reported height is always the true one.
 */
function RailCard({
  threadId,
  expanded,
  left,
  top,
  width,
  maxHeight,
  clipTop = 0,
  ariaLabel,
  onExpand,
  onHeight,
  children,
}: RailCardProps) {
  const ref = React.useRef<HTMLDivElement>(null);
  const prevHeight = React.useRef<number | null>(null);
  const tweening = React.useRef(false);

  React.useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const sync = () => {
      // Ignore the observer ticks the tween itself fires (it transiently drives
      // `height`) — else it would chase its own tail — and any tick after the
      // card has been unmounted (a finish/cancel callback racing teardown).
      if (tweening.current || !el.isConnected) return;
      const to = el.offsetHeight;
      const from = prevHeight.current;
      prevHeight.current = to;
      onHeight(threadId, to);
      // Tween only sizable, structural resizes — expand / collapse and the
      // async message-load that grows an opening thread (all ≫ TWEEN_MIN_DELTA).
      // First measure (from === null), scroll repositions (height unchanged), and
      // incremental composer growth as you type (a line ≈ 22px) stay instant.
      if (
        from === null ||
        Math.abs(from - to) < TWEEN_MIN_DELTA ||
        prefersReducedMotion()
      ) {
        return;
      }
      tweening.current = true;
      const anim = el.animate(
        [{ height: `${from}px` }, { height: `${to}px` }],
        { duration: 200, easing: "cubic-bezier(0.22, 1, 0.36, 1)" },
      );
      const done = () => {
        tweening.current = false;
        // Catch any resize (e.g. messages that landed mid-tween) we skipped.
        sync();
      };
      anim.onfinish = done;
      anim.oncancel = done;
    };
    sync();
    const ro = new ResizeObserver(sync);
    ro.observe(el);
    return () => ro.disconnect();
  }, [threadId, onHeight]);

  return (
    <div
      ref={ref}
      data-thread-id={threadId}
      role={expanded ? "dialog" : "button"}
      aria-label={ariaLabel}
      tabIndex={expanded ? undefined : 0}
      // Don't let a mouse-down on the collapsed card steal focus — otherwise the
      // card keeps `:focus-within` (blue) after it expands without the composer
      // ever being focused. Keyboard focus (Tab) still works.
      onMouseDown={expanded ? undefined : (e) => e.preventDefault()}
      onClick={expanded ? undefined : onExpand}
      onKeyDown={
        expanded
          ? undefined
          : (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onExpand();
              }
            }
      }
      style={{
        position: "fixed",
        left,
        top,
        width,
        maxHeight: expanded ? maxHeight : undefined,
        // Roomier inset for the collapsed preview; the expanded body owns its own.
        padding: expanded ? undefined : "14px 20px",
        // Comment surfaces sit one band below the floating chat dock (z-50) so
        // an open chat panel always covers them; the expanded card still lifts
        // above its sibling collapsed cards (40 > 30).
        zIndex: expanded ? 40 : 30,
        // Hide the slice that has slid up behind the chrome so the card goes
        // UNDER the top bar (the bars paint over the hidden part). Square the
        // clipped top corners; keep the bottom rounded to `rounded-2xl` (16px).
        clipPath:
          clipTop > 0 ? `inset(${clipTop}px 0 0 0 round 0 0 16px 16px)` : undefined,
      }}
      className={`doc-rail-card flex flex-col overflow-hidden rounded-2xl text-foreground${
        expanded ? "" : " cursor-pointer text-left"
      }`}
    >
      {children}
    </div>
  );
}

/** One author row inside a collapsed card. The first row may show the
 *  yellow-bar quote of the anchored text (Notion-style). `connect` draws the
 *  thread line below the avatar down toward the next row. */
function PreviewRow({
  msg,
  thread,
  connect = false,
}: {
  msg: PreviewMsg;
  thread?: CommentThread;
  connect?: boolean;
}) {
  const t = useT().comments;
  return (
    <div className="flex gap-2.5">
      <ThreadGutter author={msg.author} connect={connect} />
      <div className={connect ? "min-w-0 flex-1 pb-2.5" : "min-w-0 flex-1"}>
        <div className="flex items-baseline gap-2">
          {msg.author.name ? (
            <span className="truncate text-[13.5px] font-semibold text-foreground">
              {msg.author.name}
            </span>
          ) : null}
          <span className="shrink-0 text-[11.5px] text-muted-foreground">{msg.time}</span>
        </div>
        {thread?.quote ? (
          <div className="mt-0.5 border-l-2 border-amber-400 pl-2 text-[12px] leading-snug text-muted-foreground">
            <span className="line-clamp-1">{thread.quote}</span>
          </div>
        ) : null}
        <p className="mt-0.5 line-clamp-2 text-[13.5px] leading-snug text-foreground/90">
          {msg.body ? <PreviewMarkdown text={msg.body} /> : t.popoverTitle}
        </p>
      </div>
    </div>
  );
}

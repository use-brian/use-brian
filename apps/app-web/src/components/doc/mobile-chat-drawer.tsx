"use client";

/**
 * Phase 4 — Mobile drawer chat.
 *
 * On viewports below the `lg:` breakpoint the desktop `<DocSidePanel>`
 * is hidden (Phase 0 Lock #10). This component fills that gap: a small
 * floating action button sits in the bottom-right corner; tapping it
 * slides a **bottom sheet** up from the bottom edge that hosts the same
 * `<FloatingChat mode="side-panel" />` the desktop column uses.
 *
 *   ┌──────────────┐            ┌──────────────────┐
 *   │ doc page  │            │ doc (dimmed)  │
 *   │              │  tap FAB → │ ╭──────────────╮ │
 *   │           ●  │  ← FAB     │ │  ▁ grab bar  │ │  ▼ swipe-down /
 *   └──────────────┘            │ │  <FloatingChat│ │    backdrop / Esc
 *                               │ │   mode=…   │  │ │    to dismiss
 *                               │ ╰──────────────╯ │
 *                               └──────────────────┘
 *
 * Behaviour:
 *   • Open/close: React state. Native CSS transition (`translate-y`).
 *   • Dismiss on: backdrop tap, ESC keypress, down-swipe (touch).
 *   • ARIA: `role="dialog"` + `aria-modal="true"` on the panel, plus
 *     `aria-label`. The button is `aria-expanded` + `aria-controls`.
 *   • Visibility: the wrapper renders nothing at `lg:` and above — the
 *     desktop side panel takes over there. Mounted at `lg:hidden` from
 *     the shell to keep the breakpoint logic in one place.
 *
 * No animation library — the transform/transition is pure Tailwind/CSS
 * and the swipe handler is a tiny touchstart/touchmove/touchend trio.
 *
 * Spec:
 *   • Phase 0 Lock #10 (side panel + minimize to corner; mobile drawer
 *     deferred to Phase 4).
 *   • `docs/architecture/features/doc.md`.
 *
 * [COMP:app-web/mobile-chat-drawer]
 */

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type TouchEvent as ReactTouchEvent,
} from "react";
import { MessageSquare, Sparkles, X } from "lucide-react";
import { FloatingChat } from "../chrome/floating-chat";
import { AssistantAvatar } from "../assistant-avatar";
import { getAssistantIdentity, type AssistantIdentity } from "@/lib/api/views";
import type { ChatTargetPage } from "@/lib/chat-target";
import type { ModelTier } from "@/lib/chat-model";
import type { AssistantRunState } from "@sidanclaw/doc-model";
import { useT } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";

type Props = {
  workspaceId: string;
  assistantId: string;
  /**
   * Optional className appended to the floating wrapper. Default
   * `lg:hidden` (matches `<DocSidePanel>`'s `hidden lg:flex`); pass
   * a different breakpoint if mounting under a different layout
   * (apps/app-web only uses one).
   */
  className?: string;
  /** The page open on the doc — forwarded to the chat's context chip. */
  activePage?: ChatTargetPage | null;
  /**
   * A chat seed routed to the mobile surface by the shell (the
   * default-viewer landing's chatter). When its nonce changes we make the
   * chat engine available and forward the seed. For the `autoSend` build
   * flow we mount it **closed** (the construction streams onto the page
   * body, so the drawer stays out of the way); otherwise we open the
   * drawer with the prompt prefilled. See `lib/chat-seed.ts`.
   */
  seed?: {
    prefill: string;
    autoSend?: boolean;
    docViewId?: string;
    model?: ModelTier;
    researchMode?: boolean;
    /** Ready attachment ids staged on the landing — forwarded to
     *  `<FloatingChat>` with the seed and sent as `/api/chat` `fileIds`. */
    fileIds?: string[];
    /** Empty-line "Space for AI" anchor — rides the autoSend turn as
     *  `docAnchorBlockId` (forwarded to `<FloatingChat>` with the seed). */
    anchorBlockId?: string;
    nonce: number;
  };
  /** Soft double-text guard — forwarded to the inner `<FloatingChat>`. */
  othersRun?: AssistantRunState | null;
};

/** Vertical pixel threshold (downward swipe) that dismisses the bottom sheet. */
export const SWIPE_DISMISS_THRESHOLD_PX = 60;

export function MobileChatDrawer({
  workspaceId,
  assistantId,
  className,
  activePage = null,
  seed,
  othersRun = null,
}: Props) {
  const t = useT().docPage;
  const [open, setOpen] = useState(false);
  // Mount the chat the first time the drawer opens, then keep it
  // mounted so session/history survive close/reopen cycles. Lazy mount
  // avoids paying `<FloatingChat>`'s history-fetch + SSE-subscribe cost
  // on every page load.
  const [mounted, setMounted] = useState(false);
  // Assistant display identity — drives the FAB's avatar (its creature icon).
  const [assistant, setAssistant] = useState<AssistantIdentity | null>(null);
  const panelId = useId();
  const panelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!assistantId) return;
    let cancelled = false;
    getAssistantIdentity(assistantId).then((identity) => {
      if (!cancelled) setAssistant(identity);
    });
    return () => {
      cancelled = true;
    };
  }, [assistantId]);

  const close = useCallback(() => setOpen(false), []);
  const openDrawer = useCallback(() => {
    setMounted(true);
    setOpen(true);
  }, []);

  // Chat-seed: when the shell routes a seed to this (mobile) surface, make
  // `<FloatingChat>` available and forward the seed to it (as `seedRequest`)
  // — its own nonce-gated effect applies it. For the `autoSend` build flow
  // we only mount (drawer stays closed) so the page body is the surface; a
  // plain prefill opens the drawer. Gated on the nonce so it fires once per
  // dispatch, not on every re-render.
  const seedNonceRef = useRef(0);
  useEffect(() => {
    if (!seed) return;
    if (seed.nonce === seedNonceRef.current) return;
    seedNonceRef.current = seed.nonce;
    if (seed.autoSend) {
      setMounted(true);
    } else {
      openDrawer();
    }
  }, [seed, openDrawer]);

  // ESC dismisses. Bound at the window level so the drawer doesn't need
  // focus to respond.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation();
        close();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, close]);

  // Body-scroll lock while the drawer is open — the doc page sits
  // behind a backdrop and shouldn't scroll underneath the chat.
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  // Swipe-down-to-dismiss handlers (bottom sheet). Tracks the touch's vertical
  // delta; releasing past the threshold closes the sheet. Bound to the grab
  // handle / header zone only (below), so it never fights the chat scroll.
  const swipeStartYRef = useRef<number | null>(null);
  const swipeDeltaYRef = useRef<number>(0);
  const onTouchStart = useCallback((e: ReactTouchEvent<HTMLDivElement>) => {
    const t0 = e.touches[0];
    if (!t0) return;
    swipeStartYRef.current = t0.clientY;
    swipeDeltaYRef.current = 0;
  }, []);
  const onTouchMove = useCallback((e: ReactTouchEvent<HTMLDivElement>) => {
    if (swipeStartYRef.current === null) return;
    const t0 = e.touches[0];
    if (!t0) return;
    const dy = t0.clientY - swipeStartYRef.current;
    // Only track downward swipes (positive dy). Upward does nothing.
    swipeDeltaYRef.current = Math.max(0, dy);
  }, []);
  const onTouchEnd = useCallback(() => {
    if (swipeDeltaYRef.current >= SWIPE_DISMISS_THRESHOLD_PX) {
      close();
    }
    swipeStartYRef.current = null;
    swipeDeltaYRef.current = 0;
  }, [close]);

  return (
    <div className={cn("contents", className)}>
      {/* Floating action button — bottom-right corner. */}
      <button
        type="button"
        onClick={openDrawer}
        aria-label={t.mobileChatOpen}
        aria-expanded={open}
        aria-controls={panelId}
        className={cn(
          "fixed bottom-4 right-4 z-30",
          "inline-flex h-14 w-14 items-center justify-center rounded-full shadow-lg",
          "transition-[opacity,transform] duration-150 ease-out hover:scale-105",
          open
            ? "pointer-events-none scale-90 opacity-0"
            : "pointer-events-auto scale-100 opacity-100",
        )}
      >
        {assistant ? (
          <span
            aria-hidden
            className="inline-flex h-14 w-14 overflow-hidden rounded-full ring-1 ring-black/10 dark:ring-white/15"
          >
            <AssistantAvatar
              id={assistant.id}
              name={assistant.name}
              iconSeed={assistant.iconSeed ?? undefined}
              size="lg"
            />
          </span>
        ) : (
          <span className="inline-flex h-14 w-14 items-center justify-center rounded-full bg-primary text-primary-foreground">
            <MessageSquare className="size-5" aria-hidden />
          </span>
        )}
      </button>

      {/* Backdrop — tap-anywhere-outside dismisses. Stays mounted while
          open so the transition can fade it in. */}
      <button
        type="button"
        aria-label={t.mobileChatClose}
        tabIndex={open ? 0 : -1}
        onClick={close}
        className={cn(
          "fixed inset-0 z-40 bg-foreground/40 backdrop-blur-[2px]",
          "transition-opacity duration-300 ease-out",
          open ? "opacity-100" : "pointer-events-none opacity-0",
        )}
      />

      {/* Bottom sheet — full-width, slides UP from the bottom via translate-y.
          A grab handle + header host the swipe-down-to-dismiss gesture. */}
      <div
        ref={panelRef}
        id={panelId}
        role="dialog"
        aria-modal="true"
        aria-label={t.mobileChatTitle}
        aria-hidden={!open}
        className={cn(
          "fixed inset-x-0 bottom-0 z-40 flex h-[88dvh] max-h-[88dvh] flex-col",
          "rounded-t-2xl border-t border-border bg-background shadow-2xl",
          "transition-transform duration-300 ease-out will-change-transform",
          open ? "translate-y-0" : "translate-y-full",
        )}
      >
        {/* Grab handle + title — the swipe-down dismiss is scoped here so it
            never competes with the chat scroll below. `touch-none` lets us own
            the vertical gesture instead of the page trying to scroll. */}
        <div
          onTouchStart={onTouchStart}
          onTouchMove={onTouchMove}
          onTouchEnd={onTouchEnd}
          className="shrink-0 cursor-grab touch-none select-none"
        >
          <div className="flex justify-center pb-1 pt-2.5">
            <span
              aria-hidden
              className="h-1.5 w-10 rounded-full bg-muted-foreground/25"
            />
          </div>
          <header className="flex items-center justify-between px-4 pb-2 pt-1">
            <span className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
              <Sparkles className="size-4 text-primary" aria-hidden />
              {t.mobileChatTitle}
            </span>
            <button
              type="button"
              onClick={close}
              aria-label={t.mobileChatClose}
              className="inline-flex h-8 w-8 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <X className="size-4" aria-hidden />
            </button>
          </header>
        </div>
        <div className="min-h-0 flex-1 border-t border-border">
          {/* Only mount the chat once the sheet has been opened —
              `<FloatingChat>` boots a session, fetches history, and
              subscribes to events. Lazily mounting avoids paying that
              cost on every page load. Once mounted it stays mounted so
              state survives subsequent open/close cycles. `hideHeader`
              drops its internal header — this sheet supplies its own. */}
          {mounted ? (
            <FloatingChat
              workspaceId={workspaceId}
              assistantId={assistantId}
              mode="side-panel"
              hideHeader
              activePage={activePage}
              seedRequest={seed}
              othersRun={othersRun}
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}


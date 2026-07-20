"use client";

/**
 * Client wrapper for a shared page: renders the read-only blocks and keeps
 * them live via SSE (Phase 3) — no Yjs, no auth. The stream pushes a `change`
 * signal on grant changes (e.g. a revoke → the page goes unavailable live) and
 * a periodic `tick` the client treats as "re-fetch" (content lives in the
 * doc-sync process). Replaces the Phase-1 polling loop.
 *
 * Comments render in a right margin rail (Notion-style, xl+): each thread card
 * is vertically aligned to its anchored text (the `data-comment-thread` span in
 * `read-only-page-blocks.tsx`), always visible, no click. Below `xl` the rail
 * can't fit, so it's hidden and tapping a highlighted comment in the text opens
 * a bottom-sheet drawer (Notion mobile style) showing that one thread —
 * `MobileCommentDrawer`, which slides up from the bottom edge.
 *
 * [COMP:app-web/share-dialog]
 */

import {
  useEffect,
  useRef,
  useState,
  type RefObject,
  type MouseEvent as ReactMouseEvent,
  type TouchEvent as ReactTouchEvent,
} from "react";
import { MessageSquare, X } from "lucide-react";
import { isImageIcon } from "@use-brian/shared/page-icon";
import {
  fetchPublicPageFor,
  publicStreamUrlFor,
  type PublicComment,
  type PublicPage,
  type PublicSource,
} from "@/lib/api/public-share";
import { ReadOnlyPageBlocks } from "@/components/doc/read-only-page-blocks";
import { GuestComments } from "@/components/doc/guest-comments";
import { useCommentThreadHover } from "@/components/doc/comment-hover";
import {
  ThreadGutter,
  relativeTime,
  type CommentAuthor,
} from "@/components/doc/comment-primitives";
import { placeRailCards, RAIL_CARD_GAP } from "@/lib/comment-rail-layout";
import { webAppUrl } from "@/lib/primary-auth";
import { useT } from "@/lib/i18n/client";

/**
 * One read-only comment thread on the shared page. The chrome (`.doc-rail-card`),
 * avatar gutter with the connecting thread line (`ThreadGutter`), amber anchor-
 * quote bar, and name / time / body typography are the SAME primitives the live
 * editor's margin rail uses (`comment-thread-body.tsx` → `./comment-primitives`),
 * so a shared page's comments look pixel-identical to the editor's — just without
 * the composer / resolve affordances, since a public viewer can't reply. The
 * `data-thread-id` keeps it wired into the Notion-style linked hover.
 */
function CommentCard({ thread }: { thread: PublicComment }) {
  const t = useT().comments;
  const msgs = thread.messages;
  return (
    <div
      data-thread-id={thread.threadId}
      className="doc-rail-card doc-share-comment-card overflow-hidden rounded-2xl"
    >
      <div className="px-4 pb-1 pt-4">
        {msgs.map((m, i) => {
          // Public data flattens the author to a display name + optional photo
          // (no assistant flag), so every row uses the human colored-initials
          // avatar via the shared gutter. Name doubles as the avatar's color seed.
          const author: CommentAuthor = { id: m.author, name: m.author, avatarUrl: m.avatar };
          return (
            <div key={i} className="flex gap-2.5">
              <ThreadGutter author={author} connect={i < msgs.length - 1} />
              <div className="min-w-0 flex-1 pb-4">
                <div className="flex items-baseline gap-2">
                  <span className="truncate text-[14px] font-semibold text-foreground">{m.author}</span>
                  <span className="shrink-0 text-[12px] text-muted-foreground" suppressHydrationWarning>
                    {relativeTime(m.createdAt, t.justNow)}
                  </span>
                </div>
                {i === 0 && thread.quote ? (
                  <div className="mt-1 border-l-2 border-amber-400 pl-2.5 text-[13px] leading-snug text-muted-foreground">
                    <span className="line-clamp-1">{thread.quote}</span>
                  </div>
                ) : null}
                <div className="mt-1 whitespace-pre-wrap text-[14px] leading-relaxed text-foreground">
                  {m.body}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Pre-measure height estimate for a card (seeds the first paint only; real
 *  heights are measured from the DOM right after). Tuned to the editor-style
 *  rows the card now renders: card padding (~24px) + per-message header + a
 *  couple of body lines (~64px). */
function estimateCardHeight(c: PublicComment): number {
  return 32 + c.messages.length * 64;
}

/** Right margin rail: anchors each thread card to its commented text's vertical
 *  position (measured against the content wrapper), shifting cards down to avoid
 *  overlap when comments cluster. Card heights are measured from the rendered
 *  DOM (a `ResizeObserver`) so a tall comment reserves real vertical space and
 *  can't be covered by the next card. Shown only where there's gutter room (xl+). */
function CommentsRail({
  comments,
  containerRef,
}: {
  comments: PublicComment[];
  containerRef: RefObject<HTMLDivElement | null>;
}) {
  const [tops, setTops] = useState<Record<string, number>>({});
  const [heights, setHeights] = useState<Record<string, number>>({});
  const cardRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  useEffect(() => {
    const measure = () => {
      const c = containerRef.current;
      if (!c) return;
      const cTop = c.getBoundingClientRect().top;
      const next: Record<string, number> = {};
      for (const cm of comments) {
        const el = c.querySelector<HTMLElement>(`[data-comment-thread="${cm.threadId}"]`);
        if (el) next[cm.threadId] = el.getBoundingClientRect().top - cTop;
      }
      setTops(next);
    };
    measure();
    // Re-measure once layout/fonts settle, and on resize/reflow.
    const id = window.setTimeout(measure, 350);
    window.addEventListener("resize", measure);
    return () => {
      window.clearTimeout(id);
      window.removeEventListener("resize", measure);
    };
  }, [comments, containerRef]);

  // Measure each card's real rendered height so the push-down stacking reserves
  // true vertical space. Card width is fixed (`w-96`), so height is independent
  // of `top` — no layout feedback loop.
  useEffect(() => {
    const ro = new ResizeObserver(() => {
      const next: Record<string, number> = {};
      for (const [id, el] of cardRefs.current) next[id] = el.offsetHeight;
      setHeights((prev) => {
        const keys = Object.keys(next);
        if (keys.length === Object.keys(prev).length && keys.every((k) => prev[k] === next[k])) {
          return prev;
        }
        return next;
      });
    });
    for (const el of cardRefs.current.values()) ro.observe(el);
    return () => ro.disconnect();
  }, [comments]);

  const anchored = comments
    .filter((c) => tops[c.threadId] != null)
    .map((c) => ({ c, anchor: tops[c.threadId] }))
    .sort((a, b) => a.anchor - b.anchor);
  const unanchored = comments.filter((c) => tops[c.threadId] == null);
  const byId = new Map(comments.map((c) => [c.threadId, c]));

  const placed = placeRailCards(
    [
      ...anchored.map(({ c, anchor }) => ({
        threadId: c.threadId,
        anchor,
        estimatedHeight: estimateCardHeight(c),
      })),
      ...unanchored.map((c) => ({
        threadId: c.threadId,
        anchor: null,
        estimatedHeight: estimateCardHeight(c),
      })),
    ],
    heights,
    RAIL_CARD_GAP,
  );

  return (
    <div className="absolute right-0 top-0 hidden w-96 xl:block">
      {placed.map(({ threadId, top }) => {
        const c = byId.get(threadId);
        if (!c) return null;
        return (
          <div
            key={threadId}
            ref={(el) => {
              if (el) cardRefs.current.set(threadId, el);
              else cardRefs.current.delete(threadId);
            }}
            style={{ position: "absolute", top }}
            className="w-96"
          >
            <CommentCard thread={c} />
          </div>
        );
      })}
    </div>
  );
}

/** The comment thread id of the highlighted run a tap landed in — the nearest
 *  `[data-comment-thread]` ancestor of the event target — or `null` if the tap
 *  missed a highlight. The read-only blocks tag every commented span / atom with
 *  that attribute (`read-only-page-blocks.tsx`), so this is the mobile
 *  tap-to-open lookup. Pure DOM walk; exported for the unit test. */
export function commentThreadIdAt(target: EventTarget | null): string | null {
  if (!(target instanceof Element)) return null;
  const el = target.closest("[data-comment-thread]");
  const id = el?.getAttribute("data-comment-thread");
  return id && id.length > 0 ? id : null;
}

/** Vertical pixel threshold (downward swipe) that dismisses the bottom sheet —
 *  matches the chat drawer's `SWIPE_DISMISS_THRESHOLD_PX`. */
const SWIPE_DISMISS_THRESHOLD_PX = 60;

/**
 * Mobile comment drawer — a bottom sheet that slides up from the bottom edge
 * when a viewer taps a highlighted comment in the text (Notion's mobile
 * pattern). Shows the single tapped thread. Rendered only below `xl` (the
 * margin rail covers wider screens). Mirrors the chat drawer's mechanics
 * (`mobile-chat-drawer.tsx`): a `position:fixed` backdrop + the sheet sliding
 * via `translate-y`, a grab handle owning the swipe-down-to-dismiss gesture,
 * Escape, and a body-scroll lock. ~62dvh tall (between half and two-thirds of
 * the viewport, per the Notion drawer feel).
 */
export function MobileCommentDrawer({
  thread,
  onClose,
}: {
  thread: PublicComment | null;
  onClose: () => void;
}) {
  const t = useT().sharedPage;
  const open = thread !== null;
  // Keep the last opened thread mounted through the close transition so the card
  // doesn't blank out mid-slide-down.
  const [shown, setShown] = useState<PublicComment | null>(thread);
  useEffect(() => {
    if (thread) setShown(thread);
  }, [thread]);

  // Escape dismiss — bound at the window so the sheet needn't hold focus.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // Body-scroll lock while open — the page behind the backdrop shouldn't scroll.
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  // Swipe-down-to-dismiss, scoped to the grab handle so it never fights the
  // card's own scroll.
  const startY = useRef<number | null>(null);
  const deltaY = useRef(0);
  const onTouchStart = (e: ReactTouchEvent<HTMLDivElement>) => {
    startY.current = e.touches[0]?.clientY ?? null;
    deltaY.current = 0;
  };
  const onTouchMove = (e: ReactTouchEvent<HTMLDivElement>) => {
    if (startY.current === null) return;
    deltaY.current = Math.max(0, (e.touches[0]?.clientY ?? 0) - startY.current);
  };
  const onTouchEnd = () => {
    if (deltaY.current >= SWIPE_DISMISS_THRESHOLD_PX) onClose();
    startY.current = null;
    deltaY.current = 0;
  };

  return (
    <div className="xl:hidden" aria-hidden={!open}>
      {/* Backdrop — tap-anywhere-outside dismisses; fades with the sheet. */}
      <button
        type="button"
        aria-label={t.commentDrawerClose}
        tabIndex={open ? 0 : -1}
        onClick={onClose}
        className={`fixed inset-0 z-40 bg-foreground/40 backdrop-blur-[2px] transition-opacity duration-300 ease-out ${
          open ? "opacity-100" : "pointer-events-none opacity-0"
        }`}
      />
      {/* Bottom sheet — full-width, slides UP from the bottom via translate-y. */}
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t.commentDrawerTitle}
        className={`fixed inset-x-0 bottom-0 z-40 flex h-[62dvh] max-h-[62dvh] flex-col rounded-t-2xl border-t border-border bg-background shadow-2xl transition-transform duration-300 ease-out will-change-transform ${
          open ? "translate-y-0" : "translate-y-full"
        }`}
      >
        {/* Grab handle + title — owns the swipe-down dismiss (`touch-none` so the
            vertical gesture is ours, not a page scroll). */}
        <div
          onTouchStart={onTouchStart}
          onTouchMove={onTouchMove}
          onTouchEnd={onTouchEnd}
          className="shrink-0 cursor-grab touch-none select-none"
        >
          <div className="flex justify-center pb-1 pt-2.5">
            <span aria-hidden className="h-1.5 w-10 rounded-full bg-muted-foreground/25" />
          </div>
          <header className="flex items-center justify-between px-4 pb-2 pt-1">
            <span className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
              <MessageSquare className="size-4 text-muted-foreground" aria-hidden />
              {t.commentDrawerTitle}
            </span>
            <button
              type="button"
              onClick={onClose}
              aria-label={t.commentDrawerClose}
              className="inline-flex h-8 w-8 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <X className="size-4" aria-hidden />
            </button>
          </header>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto border-t border-border px-3 py-3">
          {shown ? <CommentCard thread={shown} /> : null}
        </div>
      </div>
    </div>
  );
}

export function PublicPageView({ source, initial }: { source: PublicSource; initial: PublicPage }) {
  const t = useT().sharedPage;
  const [page, setPage] = useState<PublicPage>(initial);
  const [unavailable, setUnavailable] = useState(false);
  // The thread shown in the mobile comment drawer (below `xl`), opened by
  // tapping its highlighted text. `null` → the drawer is closed.
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const streamKey =
    source.kind === "link"
      ? `${source.token}:${source.pageId ?? ""}`
      : source.kind === "site"
        ? `${source.host}:${source.path}`
        : source.pageId;
  // Breadcrumb href shape: a token sub-page view stays inside the token
  // context (`/share/<token>`, `/share/<token>/p/<id>`); a custom-domain
  // view uses the server-provided site paths (`/`, `/<slug>`, `/p/<id>`);
  // everything else (published view, or a token root inside a published
  // subtree) uses the universal `/share/p/<id>` URLs the server's chain
  // guarantees resolvable.
  const tokenScoped = source.kind === "link" && Boolean(source.pageId);
  const crumbHref = (crumbPageId: string, index: number): string => {
    if (source.kind === "site") {
      return page.paths?.[crumbPageId] ?? `/p/${encodeURIComponent(crumbPageId)}`;
    }
    if (tokenScoped && source.kind === "link") {
      return index === 0
        ? `/share/${encodeURIComponent(source.token)}`
        : `/share/${encodeURIComponent(source.token)}/p/${encodeURIComponent(crumbPageId)}`;
    }
    return `/share/p/${encodeURIComponent(crumbPageId)}`;
  };
  // Notion-style linked hover: hovering a comment card brightens its text runs
  // (and vice-versa) — same controller as the editor (see comment-hover.ts).
  useCommentThreadHover();

  useEffect(() => {
    let cancelled = false;
    const refetch = async () => {
      const next = await fetchPublicPageFor(source);
      if (cancelled) return;
      if (next) setPage(next);
      else setUnavailable(true); // revoked / expired / unshared / unpublished
    };
    const es = new EventSource(publicStreamUrlFor(source));
    es.addEventListener("change", () => void refetch());
    es.addEventListener("tick", () => void refetch());
    return () => {
      cancelled = true;
      es.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [streamKey]);

  if (unavailable) {
    return (
      <main className="mx-auto w-full max-w-3xl px-6 py-24 text-center text-sm text-muted-foreground">
        {t.unavailable}
      </main>
    );
  }

  const comments = page.comments ?? [];
  const activeThread = comments.find((c) => c.threadId === activeThreadId) ?? null;

  // Mobile tap-to-open: tapping a highlighted comment in the text opens the
  // bottom-sheet drawer for that thread. No-op at `xl+` — the always-on margin
  // rail covers wide screens, so a tap there shouldn't pop a drawer.
  const onContentClick = (e: ReactMouseEvent) => {
    if (typeof window !== "undefined" && window.matchMedia("(min-width: 80rem)").matches) return;
    const id = commentThreadIdAt(e.target);
    if (id && comments.some((c) => c.threadId === id)) setActiveThreadId(id);
  };

  return (
    <div className="min-h-screen">
      {/* Top bar — breadcrumb (root → current, clickable) + acquisition CTA. */}
      <header className="sticky top-0 z-20 flex items-center justify-between gap-3 border-b border-border bg-background/85 px-4 py-2 backdrop-blur">
        <nav className="flex min-w-0 items-center gap-1 text-sm" aria-label="Breadcrumb">
          {page.breadcrumb && page.breadcrumb.length > 0 ? (
            page.breadcrumb.map((c, i) => (
              <span key={c.pageId} className="flex min-w-0 items-center gap-1">
                {i > 0 ? <span className="px-0.5 text-muted-foreground/60">/</span> : null}
                <a
                  href={crumbHref(c.pageId, i)}
                  className="flex min-w-0 items-center gap-1 rounded px-1 py-0.5 hover:bg-muted"
                >
                  {c.icon && !isImageIcon(c.icon) ? <span className="text-base leading-none">{c.icon}</span> : null}
                  <span className="truncate font-medium">{c.title}</span>
                </a>
              </span>
            ))
          ) : (
            <span className="flex min-w-0 items-center gap-1.5 px-1">
              {page.icon && !isImageIcon(page.icon) ? <span className="text-base leading-none">{page.icon}</span> : null}
              <span className="truncate font-medium">{page.title}</span>
            </span>
          )}
        </nav>
        <a
          // On a customer domain "/" is the customer's root page — the
          // acquisition CTA must point at the product site instead
          // (config-derived, same source as every app→marketing deep-link).
          href={source.kind === "site" ? webAppUrl() : "/"}
          target="_blank"
          rel="noopener noreferrer"
          className="shrink-0 rounded-md bg-foreground px-3 py-1.5 text-xs font-semibold text-background transition-opacity hover:opacity-90"
        >
          {t.poweredByCta}
        </a>
      </header>

      {/* Wider shell so the comment rail has gutter room to the right of the
          fixed-width reading column. The reading column stays `max-w-3xl`; the
          extra width is gutter for the (now `w-96`) rail. Generous bottom padding
          so the last block isn't flush to the viewport edge (matches the editor). */}
      <main className="mx-auto w-full max-w-7xl px-6 pt-10 pb-40">
        <div ref={wrapRef} className="relative">
          {/* At `xl+` with comments the reading column hugs the left so the
              margin rail can sit in the right gutter; otherwise (no comments, or
              below `xl` where the rail is hidden in favour of the tap-to-open
              drawer) it centers. `onClick` opens the mobile drawer when a tap
              lands on a highlighted comment (no-op at `xl+`). */}
          <div
            onClick={onContentClick}
            className={`${page.fullWidth ? "max-w-none" : "max-w-3xl"}${
              comments.length > 0 ? " mx-auto xl:mx-0" : " mx-auto"
            }`}
          >
            <header className="mb-8">
              <div className="flex items-center gap-3">
                {page.icon && !isImageIcon(page.icon) ? <span className="text-3xl leading-none">{page.icon}</span> : null}
                <h1 className="text-3xl font-bold tracking-tight">{page.title}</h1>
              </div>
            </header>
            <ReadOnlyPageBlocks
              blocks={page.blocks}
              payload={page.payload}
              source={source}
              comments={comments}
              paths={page.paths}
            />
            {source.kind === "link" && page.role !== "view" ? (
              <GuestComments token={source.token} pageId={source.pageId} />
            ) : null}
          </div>

          {comments.length > 0 ? (
            // `xl+`: the always-on margin rail. Below `xl`: no gutter, so the
            // rail is hidden (it carries `xl:block`) and tapping a highlighted
            // comment opens this bottom-sheet drawer instead (Notion mobile).
            <CommentsRail comments={comments} containerRef={wrapRef} />
          ) : null}
        </div>
      </main>

      {comments.length > 0 ? (
        <MobileCommentDrawer thread={activeThread} onClose={() => setActiveThreadId(null)} />
      ) : null}
    </div>
  );
}

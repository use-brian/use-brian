"use client";

/**
 * Selection-anchored guest comments on the public share surfaces — the
 * in-app "select text → Comment" flow for a visitor with no account.
 *
 * Flow (mirrors the editor's `onComment` → `NewCommentPopover` →
 * `commitDraftComment`, minus the Yjs write a guest cannot make):
 *   1. The guest selects text in the read-only blocks. On pointer/key release a
 *      small floating **Comment** pill appears above the selection (the
 *      editor's floating-toolbar button). `draftFromSelection` resolves the
 *      selection to the block it starts in (`data-block-id`) + the selected
 *      text clipped to that block — the thread's `anchorBlockId` + `quote`.
 *   2. Clicking the pill opens a **draft**: the native selection collapses and a
 *      LOCAL amber highlight (absolutely-positioned swatches from the range's
 *      client rects, painted behind the text) marks the run, and a composer
 *      card sits just below it. Nothing is persisted yet — dismissing (Escape,
 *      outside click, Cancel) leaves no trace.
 *   3. Sending posts the thread through the family's guest endpoint with
 *      `anchorBlockId` + `quote`. The page view re-fetches; the thread now
 *      arrives in the public payload and BOTH renderers re-anchor it from the
 *      quote (`comment-quote-anchor.ts`) — the public page highlights exactly
 *      that run with a rail card beside it, and a member sees the same in the
 *      editor (`comment-decorations.ts`).
 *
 * Identity (name + session token) is shared with the page-level composer via
 * `useGuestIdentity`, so the guest is asked for a name once per share.
 *
 * [COMP:app-web/guest-selection-comment]
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefObject,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { ArrowUp, MessageSquare } from "lucide-react";
import { useT } from "@/lib/i18n/client";
import { postGuestComment, type PublicSource } from "@/lib/api/public-share";
import {
  draftFromSelection,
  draftRects,
  type DraftRect,
  type GuestCommentDraft,
} from "@/lib/guest-comment-selection";
import { useGuestIdentity } from "@/components/doc/guest-comments";

/** Composer card width — the editor's comment panel is 420; the public reading
 *  column is narrower, so this stays inside it on a laptop and shrinks on
 *  phones via `max-width`. */
const COMPOSER_WIDTH = 360;
/** Gap between the last highlighted line and the composer / the pill. */
const GAP = 8;
/** The pill's height, for placing it above the selection. */
const PILL_HEIGHT = 32;

type Bubble = { top: number; left: number };
type Draft = GuestCommentDraft & { rects: DraftRect[] };

/**
 * Where the Comment pill goes for a selection: above the FIRST highlighted
 * line, left-aligned to it, clamped inside the container. Pure; exported for
 * the unit test.
 */
export function bubblePositionFor(rects: DraftRect[], containerWidth: number): Bubble | null {
  const first = rects[0];
  if (!first) return null;
  const top = Math.max(0, first.top - PILL_HEIGHT - GAP);
  const left = Math.max(0, Math.min(first.left, Math.max(0, containerWidth - 120)));
  return { top, left };
}

/**
 * Where the composer card goes for a draft: just below the LAST highlighted
 * line, left-aligned to the first, clamped so it stays inside the container.
 * Pure; exported for the unit test.
 */
export function composerPositionFor(
  rects: DraftRect[],
  containerWidth: number,
): { top: number; left: number; width: number } | null {
  const first = rects[0];
  const last = rects[rects.length - 1];
  if (!first || !last) return null;
  const width = Math.min(COMPOSER_WIDTH, Math.max(200, containerWidth));
  const left = Math.max(0, Math.min(first.left, containerWidth - width));
  return { top: last.top + last.height + GAP, left, width };
}

export function GuestSelectionComment({
  source,
  identityKey,
  containerRef,
  onPosted,
}: {
  source: PublicSource;
  identityKey: string;
  /** The `position:relative` wrapper around the page blocks (+ rail). The pill,
   *  the draft swatches and the composer are positioned inside it. */
  containerRef: RefObject<HTMLDivElement | null>;
  /** Fired after the thread lands — the page view re-fetches so the new
   *  thread's highlight + rail card appear. */
  onPosted?: () => void;
}) {
  const t = useT().sharedPage.comments;
  const { guestToken, adopt, name, setName } = useGuestIdentity(identityKey);
  const [bubble, setBubble] = useState<Bubble | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [body, setBody] = useState("");
  const [posting, setPosting] = useState(false);
  const composerRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // The draft's live Range — re-measured on resize so the swatches follow a
  // reflow (a rotated phone, a resized window).
  const draftRangeRef = useRef<Range | null>(null);

  const containerWidth = () => containerRef.current?.clientWidth ?? 0;

  // ── 1. Selection → the floating Comment pill ───────────────────────────
  useEffect(() => {
    const root = containerRef.current;
    if (!root) return;
    let raf = 0;
    const show = () => {
      raf = 0;
      // While a draft is open the selection is ours (collapsed) — no pill.
      if (draftRangeRef.current) return;
      const d = draftFromSelection(window.getSelection(), root);
      if (!d) {
        setBubble(null);
        return;
      }
      setBubble(bubblePositionFor(draftRects(d.range, root), containerWidth()));
    };
    const schedule = () => {
      if (raf) return;
      raf = window.requestAnimationFrame(show);
    };
    // Collapsing the selection hides the pill at once; a new selection shows it
    // only once the gesture ends (pointer / key release), so it never chases a
    // drag in progress.
    const onSelectionChange = () => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed) setBubble(null);
    };
    document.addEventListener("selectionchange", onSelectionChange);
    document.addEventListener("pointerup", schedule);
    document.addEventListener("keyup", schedule);
    return () => {
      if (raf) window.cancelAnimationFrame(raf);
      document.removeEventListener("selectionchange", onSelectionChange);
      document.removeEventListener("pointerup", schedule);
      document.removeEventListener("keyup", schedule);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [containerRef]);

  // ── 2. Open the draft from the current selection ───────────────────────
  const openDraft = useCallback(() => {
    const root = containerRef.current;
    if (!root) return;
    const d = draftFromSelection(window.getSelection(), root);
    if (!d) return;
    const rects = draftRects(d.range, root);
    if (rects.length === 0) return;
    draftRangeRef.current = d.range;
    setDraft({ ...d, rects });
    setBubble(null);
    // Collapse the native selection — the local swatches carry the highlight
    // from here (the editor collapses its selection the same way so the
    // floating toolbar hides and the composer takes over).
    window.getSelection()?.removeAllRanges();
    window.requestAnimationFrame(() => textareaRef.current?.focus());
  }, [containerRef]);

  const dismiss = useCallback(() => {
    draftRangeRef.current = null;
    setDraft(null);
    setBody("");
  }, []);

  // Outside-click + Escape dismiss the draft (no backend write, no trace).
  useEffect(() => {
    if (!draft) return;
    const onDown = (e: MouseEvent) => {
      const tgt = e.target as Node | null;
      if (composerRef.current?.contains(tgt)) return;
      dismiss();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") dismiss();
    };
    const onResize = () => {
      const root = containerRef.current;
      const range = draftRangeRef.current;
      if (!root || !range) return;
      setDraft((d) => (d ? { ...d, rects: draftRects(range, root) } : d));
    };
    const id = window.setTimeout(() => {
      document.addEventListener("mousedown", onDown);
      document.addEventListener("keydown", onKey);
    }, 0);
    window.addEventListener("resize", onResize);
    return () => {
      window.clearTimeout(id);
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onResize);
    };
  }, [draft, dismiss, containerRef]);

  // ── 3. Send ─────────────────────────────────────────────────────────────
  async function send() {
    if (!draft) return;
    const text = body.trim();
    if (!text || posting) return;
    if (!guestToken && !name.trim()) return;
    setPosting(true);
    try {
      const result = await postGuestComment(source, {
        guestName: name.trim() || "Guest",
        guestSessionToken: guestToken ?? undefined,
        body: text,
        anchorBlockId: draft.anchorBlockId,
        quote: draft.quote,
      });
      if (result) {
        if (!guestToken) adopt(result.guestSessionToken);
        dismiss();
        onPosted?.();
      }
    } finally {
      setPosting(false);
    }
  }

  const canSend = !!body.trim() && (!!guestToken || !!name.trim());
  const composerPos = draft ? composerPositionFor(draft.rects, containerWidth()) : null;

  // Keep the selection alive through the pill click (a mousedown on a button
  // would otherwise collapse it before `openDraft` can read it).
  const keepSelection = (e: ReactMouseEvent) => e.preventDefault();

  return (
    <>
      {bubble && !draft ? (
        <button
          type="button"
          data-guest-comment-pill
          aria-label={t.selectionAria}
          onMouseDown={keepSelection}
          onClick={openDraft}
          style={{ position: "absolute", top: bubble.top, left: bubble.left, height: PILL_HEIGHT }}
          className="z-30 inline-flex items-center gap-1.5 rounded-lg border border-border bg-popover px-2.5 text-[13px] font-medium text-popover-foreground shadow-md transition-colors hover:bg-accent"
        >
          <MessageSquare className="size-4 text-muted-foreground" aria-hidden />
          {t.selectionAction}
        </button>
      ) : null}

      {draft
        ? draft.rects.map((r, i) => (
            // The local draft highlight: the same warm swatch as a real comment
            // (`.doc-comment-hl`), painted BEHIND the text (`z-[-1]` inside the
            // container's isolated stacking context) so the words stay crisp.
            <span
              key={i}
              data-comment-draft=""
              aria-hidden
              style={{ position: "absolute", top: r.top, left: r.left, width: r.width, height: r.height }}
              className="pointer-events-none z-[-1] doc-comment-hl is-active-thread"
            />
          ))
        : null}

      {draft && composerPos ? (
        <div
          ref={composerRef}
          role="dialog"
          aria-label={t.composerAria}
          style={{ position: "absolute", top: composerPos.top, left: composerPos.left, width: composerPos.width }}
          className="z-30 flex max-w-[92vw] flex-col gap-2 rounded-xl border border-border bg-popover p-3 text-popover-foreground shadow-lg"
        >
          <div className="border-l-2 border-amber-400 pl-2.5 text-[13px] leading-snug text-muted-foreground">
            <span className="line-clamp-2">{draft.quote}</span>
          </div>
          {!guestToken ? (
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t.namePlaceholder}
              maxLength={80}
              className="w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm"
            />
          ) : null}
          <div className="flex flex-col gap-1 rounded-2xl border border-foreground/[0.18] bg-background px-3 py-2">
            <textarea
              ref={textareaRef}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  void send();
                }
              }}
              placeholder={t.placeholder}
              rows={2}
              className="max-h-32 min-h-[24px] w-full resize-none border-0 bg-transparent p-0 text-[14px] leading-relaxed outline-none placeholder:text-muted-foreground/70 focus-visible:shadow-none"
            />
            <div className="mt-1 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={dismiss}
                className="rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                {t.cancel}
              </button>
              <button
                type="button"
                onClick={() => void send()}
                disabled={posting || !canSend}
                aria-label={t.post}
                className="inline-flex size-7 shrink-0 items-center justify-center rounded-full bg-action text-action-foreground transition-colors hover:bg-action/90 disabled:bg-foreground/10 disabled:text-muted-foreground"
              >
                <ArrowUp className="size-4" />
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

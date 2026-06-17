"use client";

/**
 * Floating **"Reply" button** for quote-reply inside a comment thread.
 *
 * Watches the live text selection; when the user selects text **inside the
 * thread's message list** (the `containerRef` element), it pops a small
 * `position:fixed` button anchored just above the selection (Notion / Slack's
 * quote-reply affordance). Clicking it hands the selected text up via `onQuote`
 * — the host (`comment-thread-body.tsx`) shows it as a quote chip above the
 * composer and prefixes it onto the sent reply (`composeQuotedBody`).
 *
 * Mounted once inside `CommentThreadBody`, so it covers **every** thread shell
 * at once: the margin **rail** (side), the page-comments **band** (top), and the
 * on-content overlay popover — all render their message list through the same
 * body.
 *
 * Why `mouseup`/`keyup` to show but `selectionchange` only to hide: showing on
 * every `selectionchange` would make the button flicker as the user drags the
 * selection. So we settle the button on pointer/keyboard release, reposition it
 * on scroll, and only *hide* reactively when the selection collapses. The button
 * `preventDefault`s its own `mousedown` so clicking it doesn't clear the
 * selection before `onClick` runs.
 *
 * The selection geometry + placement is the pure `placeQuoteButton`
 * (`comment-quote.ts`, unit-tested); this component is the thin DOM-wiring shell
 * around it.
 *
 * [COMP:app-web/comment-quote-reply]
 */

import * as React from "react";
import { createPortal } from "react-dom";
import { MessageSquareQuote } from "lucide-react";
import { useT } from "@/lib/i18n/client";
import { placeQuoteButton } from "./comment-quote";

type Props = {
  /** The thread's scrollable message-list element. A selection counts only when
   *  it's fully inside this — selecting the composer draft never arms the
   *  button (the composer lives outside the list). */
  containerRef: React.RefObject<HTMLElement | null>;
  /** Hand the selected text to the host to quote into the reply. */
  onQuote: (text: string) => void;
  /** Suppress the button (e.g. read-only). */
  disabled?: boolean;
};

type Placed = { text: string; left: number; top: number };

export function CommentQuoteReply({ containerRef, onQuote, disabled }: Props) {
  const t = useT().comments;
  const [placed, setPlaced] = React.useState<Placed | null>(null);

  React.useEffect(() => {
    if (disabled || typeof window === "undefined") {
      setPlaced(null);
      return;
    }
    // Read the current selection IF it's a non-empty range inside the message
    // list, returning the button placement or null.
    const read = (): Placed | null => {
      const container = containerRef.current;
      if (!container) return null;
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
      const range = sel.getRangeAt(0);
      if (!container.contains(range.commonAncestorContainer)) return null;
      const text = sel.toString().trim();
      if (!text) return null;
      const r = range.getBoundingClientRect();
      if (!r || (r.width === 0 && r.height === 0)) return null;
      const { left, top } = placeQuoteButton(r, window.innerWidth, window.innerHeight);
      return { text, left, top };
    };

    // Settle / reposition the button. Called on release + scroll; a collapsed or
    // out-of-list selection resolves to null and hides it.
    const sync = () => setPlaced(read());
    // Hide the instant the selection collapses (a plain click), without waiting
    // for a release event.
    const onSelChange = () => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed) setPlaced(null);
    };

    document.addEventListener("mouseup", sync);
    document.addEventListener("keyup", sync);
    document.addEventListener("scroll", sync, true);
    document.addEventListener("selectionchange", onSelChange);
    return () => {
      document.removeEventListener("mouseup", sync);
      document.removeEventListener("keyup", sync);
      document.removeEventListener("scroll", sync, true);
      document.removeEventListener("selectionchange", onSelChange);
    };
  }, [containerRef, disabled]);

  if (!placed || typeof document === "undefined") return null;

  return createPortal(
    <button
      type="button"
      // Keep the selection alive across the click so `onQuote` reads real text.
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => {
        onQuote(placed.text);
        setPlaced(null);
        window.getSelection()?.removeAllRanges();
      }}
      aria-label={t.quoteSelectionAria}
      style={{ position: "fixed", left: placed.left, top: placed.top, zIndex: 50 }}
      className="inline-flex items-center gap-1 rounded-md border border-border bg-background px-2 py-1 text-[12.5px] font-medium text-foreground shadow-md transition-colors hover:bg-accent"
    >
      <MessageSquareQuote size={13} />
      {t.reply}
    </button>,
    document.body,
  );
}

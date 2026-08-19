"use client";

/**
 * The find-on-page bar — the UI half of `find-in-page.ts`.
 *
 * Mounted once per doc editor (always, editable or not: searching a page is a
 * READ, so a viewer with no edit rights still gets it). It renders nothing
 * until ⌘F / Ctrl+F, and owns three things:
 *
 *  1. **The chord.** A window-level keydown, so ⌘F works wherever focus is
 *     while a page is open - in the doc, in the chat composer, on a button.
 *     `preventDefault()` suppresses the browser's own find bar, which cannot
 *     see collapsed toggles or node-view atoms (and, in the desktop shell,
 *     does not exist).
 *  2. **The query,** pushed into the plugin as a meta-only transaction so a
 *     search writes nothing to Yjs.
 *  3. **Scrolling the active hit into view,** off the decoration's own DOM
 *     node rather than a selection move - moving the selection would yank
 *     focus out of the search input on every keystroke.
 *
 * It floats over the top-right of the doc's SCROLL CONTAINER, measured off
 * that element (plus a `ResizeObserver`) rather than hard-coded viewport
 * offsets: the pane's top edge moves when chrome rows come and go, and its
 * right edge moves when the sidebar collapses, neither of which fires a
 * window `resize`.
 *
 * [COMP:app-web/doc-find]
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { Editor } from "@tiptap/core";
import { ChevronDown, ChevronUp, X } from "lucide-react";
import { useT } from "@/lib/i18n/client";
import { format } from "@/lib/i18n/format";
import { findShortcutPressed, readFind, setFindQuery, stepFindMatch } from "./find-in-page";

/** Longest selection we will seed the query with on open. */
const SEED_MAX_CHARS = 120;

/** The nearest scrollable ancestor — the doc pane the bar floats over. */
function scrollParentOf(el: HTMLElement): HTMLElement | null {
  let node = el.parentElement;
  while (node) {
    const overflowY = getComputedStyle(node).overflowY;
    if (overflowY === "auto" || overflowY === "scroll") return node;
    node = node.parentElement;
  }
  return null;
}

export function DocFindBar({ editor }: { editor: Editor | null }) {
  const t = useT().docPage.find;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState({ total: 0, index: 0 });
  const [box, setBox] = useState<{ top: number; right: number } | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // A page switch rebuilds the editor (the Yjs doc is a dependency of
  // `useEditor`), so a new editor identity means a different document - close
  // rather than carry one page's search onto the next.
  useEffect(() => {
    setOpen(false);
    setQuery("");
  }, [editor]);

  // Mirror the plugin's match count + active index into React. Driven off
  // `transaction` so a live edit (yours or a collaborator's) re-counts too.
  useEffect(() => {
    if (!editor) return;
    const sync = () => {
      const state = readFind(editor.state);
      setStatus({ total: state.matches.length, index: state.activeIndex });
    };
    sync();
    editor.on("transaction", sync);
    return () => {
      editor.off("transaction", sync);
    };
  }, [editor]);

  // Push the query down. Closing sends `""`, which drops every highlight.
  useEffect(() => {
    if (!editor) return;
    setFindQuery(editor.view, open ? query : "");
  }, [editor, open, query]);

  const openBar = useCallback(() => {
    if (!editor) return;
    // Seed from a short single-line selection, the way every native find bar
    // does. A long or multi-block selection is not a search term, so it is
    // left alone and the previous query (if any) stays.
    const { from, to, empty } = editor.state.selection;
    if (!empty) {
      const selected = editor.state.doc.textBetween(from, to, "\n", " ").trim();
      if (selected && selected.length <= SEED_MAX_CHARS && !selected.includes("\n")) {
        setQuery(selected);
      }
    }
    setOpen(true);
    // After paint: the input does not exist yet on the frame that opens it.
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
  }, [editor]);

  const close = useCallback(() => {
    setOpen(false);
    setQuery("");
    // Hand the caret back where the user left it, so typing resumes in the doc.
    editor?.commands.focus();
  }, [editor]);

  const step = useCallback(
    (delta: number) => {
      if (editor) stepFindMatch(editor.view, delta);
    },
    [editor],
  );

  // The chord. Escape is deliberately NOT handled here - it is bound on the
  // input instead, so it never steals a dismiss from an open popover or menu.
  useEffect(() => {
    if (!editor) return;
    const onKey = (e: KeyboardEvent) => {
      if (!findShortcutPressed(e)) return;
      e.preventDefault();
      openBar();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [editor, openBar]);

  // Keep the active hit on screen. Read off the decoration's DOM node, scoped
  // to this editor; `query` is in the deps because a new search can land on
  // the same index and count as the old one and still be somewhere else.
  useEffect(() => {
    if (!editor || !open || status.total === 0) return;
    const el = editor.view.dom.querySelector(".doc-find-match-active");
    el?.scrollIntoView({ block: "center", inline: "nearest" });
  }, [editor, open, query, status.index, status.total]);

  // Measure the pane the bar floats over.
  useEffect(() => {
    if (!editor || !open) return;
    const pane = scrollParentOf(editor.view.dom);
    if (!pane) return;
    const measure = () => {
      const r = pane.getBoundingClientRect();
      setBox({
        top: r.top + 8,
        right: Math.max(8, window.innerWidth - r.right + 16),
      });
    };
    measure();
    window.addEventListener("resize", measure);
    const ro =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    ro?.observe(pane);
    return () => {
      window.removeEventListener("resize", measure);
      ro?.disconnect();
    };
  }, [editor, open]);

  if (!editor || !open) return null;

  const counter = status.total
    ? format(t.count, { index: status.index + 1, total: status.total })
    : query
      ? t.noResults
      : "";

  return (
    <div
      role="search"
      aria-label={t.label}
      style={box ?? { top: "6rem", right: "1rem" }}
      className="fixed z-40 flex items-center gap-1 rounded-lg border border-border bg-popover/95 px-1.5 py-1 shadow-lg backdrop-blur"
    >
      <input
        ref={inputRef}
        type="text"
        value={query}
        aria-label={t.placeholder}
        placeholder={t.placeholder}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            close();
            return;
          }
          if (e.key === "Enter") {
            e.preventDefault();
            step(e.shiftKey ? -1 : 1);
          }
        }}
        className="h-7 w-44 bg-transparent px-1.5 text-sm text-foreground outline-none placeholder:text-muted-foreground sm:w-56"
      />
      <span
        aria-live="polite"
        className="min-w-14 shrink-0 text-right text-xs tabular-nums text-muted-foreground"
      >
        {counter}
      </span>
      <span aria-hidden className="mx-0.5 h-5 w-px bg-border" />
      <button
        type="button"
        aria-label={t.previous}
        disabled={status.total === 0}
        onClick={() => step(-1)}
        className="inline-flex size-7 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
      >
        <ChevronUp size={14} aria-hidden />
      </button>
      <button
        type="button"
        aria-label={t.next}
        disabled={status.total === 0}
        onClick={() => step(1)}
        className="inline-flex size-7 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
      >
        <ChevronDown size={14} aria-hidden />
      </button>
      <button
        type="button"
        aria-label={t.close}
        onClick={close}
        className="inline-flex size-7 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        <X size={14} aria-hidden />
      </button>
    </div>
  );
}

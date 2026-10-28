"use client";

/**
 * The find-on-page bar — the UI half of `find-in-page.ts`.
 *
 * Mounted once per doc editor (always, editable or not: searching a page is a
 * READ, so a viewer with no edit rights still gets it). It renders nothing
 * until ⌘F / Ctrl+F or a scoped Page header request, and owns three things:
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
import { docPagePath } from "@/lib/doc-page-url";
import { findShortcutPressed, readFind, setFindQuery, stepFindMatch } from "./find-in-page";

/** Longest selection we will seed the query with on open. */
const SEED_MAX_CHARS = 120;

export const DOC_FIND_OPEN_EVENT = "doc:find-open";
export type DocFindRequestScope = { ownerId: string; workspaceId: string; pageId: string };

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

export function DocFindBar({ editor, requestScope }: { editor: Editor | null; requestScope?: DocFindRequestScope }) {
  const t = useT().docPage.find;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState({ total: 0, index: 0 });
  const [box, setBox] = useState<{ top: number; right: number } | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const ownerId = requestScope?.ownerId;
  const workspaceId = requestScope?.workspaceId;
  const pageId = requestScope?.pageId;

  // A page switch rebuilds the editor (the Yjs doc is a dependency of
  // `useEditor`). The page scope can change before that rebuild finishes;
  // close then too, rather than carry one page's search onto the next.
  useEffect(() => {
    setOpen(false);
    setQuery("");
  }, [editor, ownerId, workspaceId, pageId]);

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

  // A header targets one mounted full-page editor, even when Chat or a cached
  // surface has another editor for the same page. The chord remains unchanged.
  useEffect(() => {
    if (!editor || !ownerId || !workspaceId || !pageId) return;
    const onRequest = (event: Event) => {
      const request = (event as CustomEvent<Partial<DocFindRequestScope> | null>).detail;
      if (request?.ownerId !== ownerId || request.workspaceId !== workspaceId || request.pageId !== pageId) return;
      if (window.location.pathname !== docPagePath(workspaceId, pageId)) return;
      const dom = editor.view.dom;
      if (!dom.isConnected || dom.closest("[hidden], [inert]") || dom.checkVisibility?.({ visibilityProperty: true }) === false) return;
      openBar();
    };
    window.addEventListener(DOC_FIND_OPEN_EVENT, onRequest);
    return () => window.removeEventListener(DOC_FIND_OPEN_EVENT, onRequest);
  }, [editor, ownerId, workspaceId, pageId, openBar]);

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
      // Composite-field focus (globals.css → ":focus-visible" convention): the
      // pill's existing border turns blue while the input has focus. The
      // nav/close buttons keep their own rounded halo so a keyboard user can
      // still see which one they are on.
      className="fixed z-40 flex items-center gap-1 rounded-lg border border-border bg-popover/95 px-1.5 py-1 shadow-lg backdrop-blur transition-[border-color,box-shadow] has-[input:focus-visible]:border-ring max-md:left-2 max-md:flex-wrap"
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
        className="h-11 min-w-0 w-full basis-full bg-transparent px-1.5 text-[16px] text-foreground outline-none focus-visible:shadow-none placeholder:text-muted-foreground md:h-7 md:w-56 md:basis-auto md:text-sm"
      />
      <span
        aria-live="polite"
        className="min-w-0 flex-1 text-xs tabular-nums text-muted-foreground md:min-w-14 md:flex-none md:text-right"
      >
        {counter}
      </span>
      <span aria-hidden className="mx-0.5 hidden h-5 w-px bg-border md:block" />
      <button
        type="button"
        aria-label={t.previous}
        disabled={status.total === 0}
        onClick={() => step(-1)}
        className="inline-flex size-11 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-40 md:size-7"
      >
        <ChevronUp size={14} aria-hidden />
      </button>
      <button
        type="button"
        aria-label={t.next}
        disabled={status.total === 0}
        onClick={() => step(1)}
        className="inline-flex size-11 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-40 md:size-7"
      >
        <ChevronDown size={14} aria-hidden />
      </button>
      <button
        type="button"
        aria-label={t.close}
        onClick={close}
        className="inline-flex size-11 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground md:size-7"
      >
        <X size={14} aria-hidden />
      </button>
    </div>
  );
}

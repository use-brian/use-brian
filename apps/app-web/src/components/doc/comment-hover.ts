/**
 * Notion-style **linked hover** for comments. Hovering ANY element tagged with
 * a `data-thread-id` — a highlighted text run, the gutter badge, or a margin
 * comment card — brightens EVERY element sharing that thread id at once, by
 * toggling the `is-thread-hover` class (the bright amber swatch in globals.css).
 * Moving onto blank page (or any element not in the thread) clears it.
 *
 * One delegated `mouseover` listener drives the whole thing: every pointer move
 * recomputes the nearest `[data-thread-id]` ancestor and diffs it against the
 * currently-lit thread. That makes it:
 *   - **self-healing** — it re-applies on the next move, so a ProseMirror
 *     decoration rebuild (which throws away the class) costs at most a frame;
 *   - **wiring-free** — no per-element handlers, so it works identically over
 *     the live editor's decoration spans + rail cards AND the read-only share
 *     view's highlight spans + cards, both of which tag with `data-thread-id`.
 *
 * `isThreadLit` is the pure toggle rule (unit-tested — app-web's vitest is
 * node-only, so the DOM glue around it isn't); `installCommentThreadHover` is
 * the imperative controller; `useCommentThreadHover` is the React wrapper that
 * runs it on `document` for a surface's lifetime.
 *
 * [COMP:app-web/comment-hover]
 */

import { useEffect, type RefObject } from "react";

/** The class added to every element of the hovered thread. */
export const THREAD_HOVER_CLASS = "is-thread-hover";

/**
 * Whether an element tagged with `elementThreadId` should show the hover swatch
 * while `hoveredThreadId` is the thread under the pointer. Nothing lights when
 * no thread is hovered (`hoveredThreadId == null`), including untagged elements.
 */
export function isThreadLit(
  elementThreadId: string | null,
  hoveredThreadId: string | null,
): boolean {
  return hoveredThreadId != null && elementThreadId === hoveredThreadId;
}

/**
 * Wire the delegated linked-hover listener onto `root` and return a cleanup
 * that removes it and un-lights anything currently lit. `root` is both the
 * event scope and the query scope, so a detached element can host an isolated
 * instance; in the app it's `document`.
 */
export function installCommentThreadHover(root: Document | HTMLElement): () => void {
  let lit: string | null = null;

  const paint = (id: string | null): void => {
    if (id === lit) return;
    lit = id;
    // One pass over every tagged element: add the class to the hovered thread's
    // members, strip it from the rest. Querying by attribute (not an
    // interpolated id selector) sidesteps escaping + selector injection.
    (root as ParentNode)
      .querySelectorAll<HTMLElement>("[data-thread-id]")
      .forEach((e) =>
        e.classList.toggle(THREAD_HOVER_CLASS, isThreadLit(e.getAttribute("data-thread-id"), id)),
      );
  };

  const onOver = (e: Event): void => {
    const target = e.target as Element | null;
    const el = target?.closest?.("[data-thread-id]") as HTMLElement | null;
    paint(el?.getAttribute("data-thread-id") ?? null);
  };

  root.addEventListener("mouseover", onOver);
  return () => {
    root.removeEventListener("mouseover", onOver);
    paint(null);
  };
}

/**
 * Run the linked-hover controller for the lifetime of a comment surface. Pass
 * nothing to scope it to the whole `document` (the editor + share view both do
 * this — only one renders at a time, so there's no cross-talk), or a ref to
 * confine it to a subtree.
 */
export function useCommentThreadHover(rootRef?: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const root: Document | HTMLElement = rootRef?.current ?? document;
    return installCommentThreadHover(root);
  }, [rootRef]);
}

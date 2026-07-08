"use client";

// [COMP:app-web/block-area-select]
/**
 * Notion-style multi-block AREA SELECT by drag — pane-scoped + geometry-driven.
 *
 * Two structural problems sank the earlier versions:
 *   1. **Can't start from the side white space.** The page renders in a centered
 *      ~720px column (`.doc-page-content`); the left/right white space is that
 *      column's *outer margin*, which lives OUTSIDE the `.ProseMirror` element.
 *      A `handleDOMEvents`/`view.dom` listener never fires there. → we attach to
 *      the **scroll pane** (the editor's scrollable ancestor — full width, spans
 *      the margins) instead.
 *   2. **Unstable selection.** Setting a block selection per move while the
 *      browser grows a *native text selection* makes the two fight. → once the
 *      drag engages we suppress the native selection (`user-select: none` +
 *      clear the DOM selection) and pick blocks by **vertical geometry** (which
 *      top-level blocks the drag's Y-band covers) — stable and independent of
 *      the horizontal position, so it works from any margin.
 *
 * A drag that starts on text and stays inside one block is left to the native
 * text selection (`crossesBlocks`); a drag starting in the margin, over **empty
 * space** (no block on the press row — the tail padding or a blank page), or
 * crossing a block boundary, becomes an area select — a live `NodeRangeSelection`
 * over whatever blocks it covers (none, over pure emptiness), updated every move.
 * The engage decision is the pure `isAreaSelectDrag`. The gesture also paints a
 * **live marquee** (`.doc-area-select-rect`, a fixed-position box swept from
 * the drag origin to the cursor) so the area being selected is visible WHILE
 * dragging — including over empty space, where there are no blocks to tint, so the
 * blank doc rubber-bands like sweeping a selection on the desktop.
 *
 * Pairs with `NodeRange` (kept for the `NodeRangeSelection` class, the
 * `.ProseMirror-selectednoderange` highlight, and the Shift-↑/↓ / Mod-A keyboard)
 * and the drag handle (its grip drags the whole selection). Selection +
 * interaction only — no schema change, so Yjs parity holds; the drag-move edit
 * is gated by `editable`.
 */

import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import type { Node as PMNode } from "@tiptap/pm/model";
import { NodeRangeSelection } from "@tiptap/extension-node-range";

/** True when two positions sit in DIFFERENT blocks — i.e. a drag between them is
 *  a multi-block area select, not an in-block text selection. Pure/testable. */
export function crossesBlocks(doc: PMNode, a: number, h: number): boolean {
  const size = doc.content.size;
  const $a = doc.resolve(Math.max(0, Math.min(a, size)));
  const $h = doc.resolve(Math.max(0, Math.min(h, size)));
  return !$a.sameParent($h);
}

const DRAG_THRESHOLD = 6; // px before a press counts as a drag (vs a click)
const blockAreaSelectKey = new PluginKey("blockAreaSelect");

/** Decide whether a past-threshold drag is an AREA select (engage + marquee) vs a
 *  native in-block text selection. Pure/testable. The ONLY case left to the
 *  browser is a drag that began on a block's own text and is still inside that
 *  same block — everything else is an area select, INCLUDING a drag over empty
 *  space (no block on the press row), so sweeping the blank doc rubber-bands
 *  like the desktop instead of doing nothing. */
export function isAreaSelectDrag(opts: {
  startOnBlockRow: boolean;
  startInEditor: boolean;
  startPos: number | null;
  crossedBlocks: boolean;
}): boolean {
  const { startOnBlockRow, startInEditor, startPos, crossedBlocks } = opts;
  if (!startOnBlockRow) return true; // empty space → always an area select
  if (!startInEditor || startPos == null) return true; // margin beside a block
  return crossedBlocks; // on text: area select only once it leaves the block
}

/** Normalised viewport rectangle spanning two drag corners — the geometry of the
 *  live marquee the gesture paints while dragging. Corner order is irrelevant
 *  (drag up-left and down-right give the same box). Pure/testable. */
export function dragRect(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): { left: number; top: number; width: number; height: number } {
  return {
    left: Math.min(x1, x2),
    top: Math.min(y1, y2),
    width: Math.abs(x1 - x2),
    height: Math.abs(y1 - y2),
  };
}

/** The editor's scroll container — the nearest ancestor that scrolls vertically.
 *  It's full width, so it spans the column's outer margins where the area-select
 *  must be able to start; just as importantly it SCOPES the gesture to the editor.
 *  Sibling overlays that float over the page (the bottom-right chat panel, the
 *  mobile chat drawer) live OUTSIDE this element, so the capture-phase listener
 *  attached here never fires for a drag inside them — a drag in the chat selects
 *  its own text instead of rubber-banding the page beneath it.
 *
 *  Match on the overflow STYLE alone — NOT on whether the pane currently overflows.
 *  The plugin's `view()` runs at editor-init, BEFORE the Yjs content + async React
 *  node-views have grown the doc past one viewport; a `scrollHeight > clientHeight`
 *  gate there found nothing yet, fell through to `document.scrollingElement`, and
 *  pinned the listener to the WHOLE document for the page's lifetime. A drag
 *  anywhere a document descendant — INCLUDING inside the floating chat — then
 *  started a page area-select. Falls back to the editor itself (still scoped),
 *  never the document. */
export function findScrollPane(el: HTMLElement): HTMLElement {
  let node: HTMLElement | null = el.parentElement;
  while (node) {
    const oy = getComputedStyle(node).overflowY;
    if (oy === "auto" || oy === "scroll") return node;
    node = node.parentElement;
  }
  return el;
}

/** Presses on these never start an area select — either they own their own
 *  gesture (form controls, the drag handle, an embed) or they belong to a region
 *  whose own text is what a drag selects, not the page: the chat panel/drawer and
 *  the comment-thread body (both tagged `data-area-select-ignore`), or a portaled
 *  menu/dialog/listbox. A drag there is that region's own text selection, not a
 *  page rubber-band — the comment body matters because the page-comments band
 *  hosts it inline in a `role="region"` wrapper, so it has no dialog ancestor to
 *  bail on. The `closest` match is also the scoping safety net for the degenerate
 *  layout where `findScrollPane` finds no scroll ancestor and the listener lands
 *  wide. */
export function isInteractiveTarget(target: EventTarget | null): boolean {
  const el = target instanceof Element ? target : null;
  return !!el?.closest(
    "button, a, input, textarea, select, label, .doc-drag-handle, .doc-embed, [data-area-select-ignore], [role='dialog'], [role='menu'], [role='listbox']",
  );
}

/** Top-level blocks whose vertical extent intersects the drag's Y-band; returns
 *  the position before the first and after the last covered block. */
function blockRangeInBand(
  view: EditorView,
  yMin: number,
  yMax: number,
): { from: number; to: number } | null {
  const doc = view.state.doc;
  let from = -1;
  let to = -1;
  doc.forEach((node, offset) => {
    const dom = view.nodeDOM(offset);
    if (!(dom instanceof HTMLElement)) return;
    const r = dom.getBoundingClientRect();
    if (r.height === 0) return;
    if (r.bottom >= yMin && r.top <= yMax) {
      if (from < 0) from = offset;
      to = offset + node.nodeSize;
    }
  });
  return from < 0 ? null : { from, to };
}

export const BlockAreaSelect = Extension.create({
  name: "blockAreaSelect",
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: blockAreaSelectKey,
        view(view) {
          const pane = findScrollPane(view.dom as HTMLElement);
          const doc = () => view.state.doc;
          let pending = false;
          let engaged = false;
          let startX = 0;
          let startY = 0;
          let startInEditor = false;
          let startPos: number | null = null;
          let startOnBlockRow = false;
          let lastFrom = -1;
          let lastTo = -1;
          // The live marquee — a fixed-position box swept from the drag origin to
          // the cursor. The NodeRange decorations only tint blocks the band lands
          // on; the marquee gives the gesture an immediate, continuous outline
          // (and the only feedback over empty space, where there are no blocks).
          let marquee: HTMLDivElement | null = null;

          const restoreSelectStyle = () => {
            (view.dom as HTMLElement).style.userSelect = "";
          };

          /** Paint the marquee at the current drag extent, creating it on first
           *  use. Coords are viewport (client) space → `position: fixed`. */
          const paintMarquee = (curX: number, curY: number) => {
            if (!marquee) {
              marquee = view.dom.ownerDocument.createElement("div");
              marquee.className = "doc-area-select-rect";
              marquee.setAttribute("aria-hidden", "true");
              view.dom.ownerDocument.body.appendChild(marquee);
            }
            const r = dragRect(startX, startY, curX, curY);
            marquee.style.left = `${r.left}px`;
            marquee.style.top = `${r.top}px`;
            marquee.style.width = `${r.width}px`;
            marquee.style.height = `${r.height}px`;
          };

          const clearMarquee = () => {
            marquee?.remove();
            marquee = null;
          };

          const finish = () => {
            pending = false;
            engaged = false;
            lastFrom = -1;
            lastTo = -1;
            clearMarquee();
            restoreSelectStyle();
            const d = view.dom.ownerDocument;
            d.removeEventListener("mousemove", onMove, true);
            d.removeEventListener("mouseup", onUp, true);
          };

          function onMove(e: MouseEvent) {
            if (!pending) return;
            if ((e.buttons & 1) === 0) {
              finish();
              return;
            }
            if (!engaged) {
              if (Math.hypot(e.clientX - startX, e.clientY - startY) < DRAG_THRESHOLD) return;
              // `crossedBlocks` only matters when the press landed on a block's
              // own text; over empty space / the margin there's nothing to read.
              let crossedBlocks = false;
              if (startOnBlockRow && startInEditor && startPos != null) {
                const cur = view.posAtCoords({ left: e.clientX, top: e.clientY });
                crossedBlocks = !!cur && crossesBlocks(doc(), startPos, cur.pos);
              }
              // In-block text drag → leave it to the native selection.
              if (!isAreaSelectDrag({ startOnBlockRow, startInEditor, startPos, crossedBlocks }))
                return;
              engaged = true;
              (view.dom as HTMLElement).style.userSelect = "none";
              view.dom.ownerDocument.getSelection()?.removeAllRanges();
              // Focus the editor so the resulting selection can be acted on by
              // the keyboard (Delete / Backspace). An area-select routinely
              // STARTS in the margin (the whole point of the gesture), where the
              // press lands on the scroll pane — NOT the contenteditable — so
              // `.ProseMirror` never took focus. And a `NodeRangeSelection` is
              // `visible:false`, so dispatching it doesn't focus the editor
              // either. Without this, a key press after a margin-started select
              // went to `<body>` and the selected blocks couldn't be deleted at
              // all (`view.focus()` is preventScroll, so it won't jump the page).
              view.focus();
            }
            const band = blockRangeInBand(
              view,
              Math.min(startY, e.clientY),
              Math.max(startY, e.clientY),
            );
            if (band && (band.from !== lastFrom || band.to !== lastTo)) {
              lastFrom = band.from;
              lastTo = band.to;
              try {
                const sel = NodeRangeSelection.create(doc(), band.from + 1, band.to - 1);
                view.dispatch(view.state.tr.setSelection(sel));
              } catch {
                /* range momentarily invalid mid-doc-change — ignore */
              }
            }
            // Paint AFTER the selection dispatch (which can blur the marquee for a
            // frame) so the box reads as the live, top-most drag outline.
            paintMarquee(e.clientX, e.clientY);
            e.preventDefault();
          }

          function onUp() {
            finish();
          }

          function onDown(e: MouseEvent) {
            if (e.button !== 0 || !view.editable || isInteractiveTarget(e.target)) return;
            startX = e.clientX;
            startY = e.clientY;
            startInEditor = view.dom.contains(e.target as Node);
            startPos = startInEditor
              ? (view.posAtCoords({ left: e.clientX, top: e.clientY })?.pos ?? null)
              : null;
            // Whether a block actually sits on the press row. When none does — the
            // empty tail padding (`.ProseMirror`'s 30vh `padding-bottom`), a blank
            // page, the white space beside an empty region — the drag is a pure
            // AREA select over emptiness: it still engages and paints the marquee,
            // so sweeping the blank doc rubber-bands like the desktop. (Was: a
            // press off any block row bailed here, so empty space did nothing.)
            startOnBlockRow = !!blockRangeInBand(view, startY, startY);
            pending = true;
            engaged = false;
            lastFrom = -1;
            lastTo = -1;
            const d = view.dom.ownerDocument;
            d.addEventListener("mousemove", onMove, true);
            d.addEventListener("mouseup", onUp, true);
          }

          pane.addEventListener("mousedown", onDown, true);
          return {
            destroy() {
              clearMarquee();
              pane.removeEventListener("mousedown", onDown, true);
              const d = view.dom.ownerDocument;
              d.removeEventListener("mousemove", onMove, true);
              d.removeEventListener("mouseup", onUp, true);
            },
          };
        },
      }),
    ];
  },
});

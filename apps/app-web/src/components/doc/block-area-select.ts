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
 *      clear the DOM selection **every move**) and pick blocks by **vertical
 *      geometry** (which top-level blocks the drag's Y-band covers) — stable and
 *      independent of the horizontal position, so it works from any margin.
 *
 * Suppressing that native selection has to happen on EVERY move, not once at
 * engage. All three of the obvious one-shot levers are no-ops against a
 * selection gesture the browser has already begun: `user-select: none` is
 * consulted when a selection *starts*, so flipping it mid-drag doesn't abort the
 * live one; a single `removeAllRanges()` is undone by the very next mousemove;
 * and `preventDefault()` on **mousemove** doesn't cancel selection extension
 * (only `mousedown` / `selectstart` do). `view.focus()` made it actively worse —
 * prosemirror-view's `focus()` runs `selectionToDOM()`, writing a DOM selection
 * back for the still-live gesture to extend from — so we focus `view.dom`
 * directly instead and keep the keyboard-delete prerequisite without re-seeding a
 * range. Left unfixed the two selections rendered at once (a `::selection`
 * highlight racing the marquee) and, worse, ProseMirror's DOM observer re-derived
 * a `TextSelection` from the live DOM selection every frame and clobbered each
 * dispatched `NodeRangeSelection` — so the block bands never rendered, the
 * inline toolbar popped up mid-area-drag, and a drag across six blocks gave no
 * selection feedback at all beyond the rubber band. The band dispatch is
 * therefore also **self-healing** (`needsBandResync`): it re-asserts the range
 * whenever the state selection is no longer a `NodeRangeSelection`, not only when
 * the covered band changes.
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
 *
 * **Shape: pure reducer + thin adapter.** Every decision the gesture makes — the
 * drag threshold, whether to engage, whether to clear the DOM selection, whether
 * to re-dispatch the band, the marquee's geometry — lives in `areaSelectReducer`,
 * a pure function over (state, event, probe). The plugin below is the adapter: it
 * registers listeners, answers the reducer's environment questions through the
 * `probe` (position under the cursor, blocks in a Y-band, is the selection still a
 * node range), and applies the effects it asks for. That's what makes the whole
 * gesture testable as data — the effect ORDER is the reducer's contract, not the
 * adapter's: focus → clear → dispatch band → paint marquee. The probe is pulled,
 * never pushed, so an in-block text drag (which must stay a native selection)
 * pays the per-block `getBoundingClientRect` sweep once, at the press, and never
 * again per move.
 */

import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import type { Node as PMNode } from "@tiptap/pm/model";
import { NodeRangeSelection, isNodeRangeSelection } from "@tiptap/extension-node-range";

/** True when two positions sit in DIFFERENT blocks — i.e. a drag between them is
 *  a multi-block area select, not an in-block text selection. Pure/testable. */
export function crossesBlocks(doc: PMNode, a: number, h: number): boolean {
  const size = doc.content.size;
  const $a = doc.resolve(Math.max(0, Math.min(a, size)));
  const $h = doc.resolve(Math.max(0, Math.min(h, size)));
  return !$a.sameParent($h);
}

/** A run of top-level blocks, as the position before the first and after the
 *  last — what a `NodeRangeSelection` is built from. */
type BlockBand = { from: number; to: number };

/** A rectangle in viewport (client) space — what the marquee is painted at. */
type ViewportRect = { left: number; top: number; width: number; height: number };

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
export function dragRect(x1: number, y1: number, x2: number, y2: number): ViewportRect {
  return {
    left: Math.min(x1, x2),
    top: Math.min(y1, y2),
    width: Math.abs(x1 - x2),
    height: Math.abs(y1 - y2),
  };
}

/** Whether the covered band must be (re-)dispatched this move. True when the band
 *  moved to different blocks, OR — the self-healing half — when the state
 *  selection is no longer a `NodeRangeSelection` at all: ProseMirror's DOM
 *  observer re-derives a `TextSelection` from any native selection the browser
 *  manages to grow mid-drag and overwrites ours, so re-asserting the same band is
 *  what keeps the block bands painted for the whole gesture. Pure/testable. */
export function needsBandResync(opts: {
  band: BlockBand;
  lastFrom: number;
  lastTo: number;
  selectionIsNodeRange: boolean;
}): boolean {
  const { band, lastFrom, lastTo, selectionIsNodeRange } = opts;
  if (band.from !== lastFrom || band.to !== lastTo) return true;
  return !selectionIsNodeRange;
}

/** Where the gesture is between two events. `pending` = a press is armed but the
 *  pointer hasn't travelled far enough (or hasn't left its block) to take over
 *  from the browser; `engaged` = we own the selection. */
export type AreaSelectState = {
  phase: "idle" | "pending" | "engaged";
  startX: number;
  startY: number;
  startInEditor: boolean;
  startPos: number | null;
  startOnBlockRow: boolean;
  lastFrom: number;
  lastTo: number;
};

export const AREA_SELECT_IDLE: AreaSelectState = Object.freeze({
  phase: "idle",
  startX: 0,
  startY: 0,
  startInEditor: false,
  startPos: null,
  startOnBlockRow: false,
  lastFrom: -1,
  lastTo: -1,
});

/** The gesture's three inputs. `inEditor` is the press target's relationship to
 *  the editable (the drag routinely starts in the margin, which is outside it);
 *  `primaryButton` catches a mouseup delivered outside the window, where the next
 *  move is the only signal the drag is over. */
export type AreaSelectEvent =
  | { type: "press"; x: number; y: number; inEditor: boolean }
  | { type: "move"; x: number; y: number; primaryButton: boolean }
  | { type: "release" };

/** Everything the decisions need to know about the editor, as pure queries the
 *  reducer PULLS. Pulled rather than pushed so the expensive one (`bandInY`, a
 *  `getBoundingClientRect` per top-level block) runs once at the press and then
 *  only while engaged — never per move on a drag that stays a native text
 *  selection. */
export type AreaSelectProbe = {
  /** Document position under a viewport point, or null if there is none. */
  posAt: (x: number, y: number) => number | null;
  /** Top-level blocks whose vertical extent intersects the band, or null. */
  bandInY: (yMin: number, yMax: number) => BlockBand | null;
  /** Whether two document positions sit in different blocks. */
  crossesBlocks: (a: number, b: number) => boolean;
  /** Whether the editor's current selection is still a `NodeRangeSelection`. */
  selectionIsNodeRange: () => boolean;
};

/** The next state, plus the effects the adapter must apply this tick — in order:
 *  focus, clear, dispatch band, paint marquee. `band` is non-null only on the
 *  ticks where it actually needs (re-)dispatching; `marquee` non-null means paint
 *  it there, null means take it down. */
export type AreaSelectResult = {
  state: AreaSelectState;
  engaged: boolean;
  clearSelection: boolean;
  focusEditor: boolean;
  band: BlockBand | null;
  marquee: ViewportRect | null;
};

const NO_EFFECTS: Omit<AreaSelectResult, "state"> = {
  engaged: false,
  clearSelection: false,
  focusEditor: false,
  band: null,
  marquee: null,
};

/** The whole gesture as a pure state machine. Composes the predicates above:
 *  `isAreaSelectDrag` decides engagement, `needsBandResync` decides re-dispatch,
 *  `dragRect` gives the marquee. Pure/testable — a drag replays as a list of
 *  events, so the behaviour is asserted without a browser.
 *
 *  Two rules here are load-bearing and easy to "simplify" back into the bug:
 *  `clearSelection` is emitted on EVERY engaged move (a one-shot clear is undone
 *  by the very next mousemove), and `focusEditor` on the engage tick ONLY
 *  (re-focusing every move is another repeated view write). See the module note. */
export function areaSelectReducer(
  state: AreaSelectState,
  event: AreaSelectEvent,
  probe: AreaSelectProbe,
): AreaSelectResult {
  if (event.type === "press") {
    return {
      state: {
        phase: "pending",
        startX: event.x,
        startY: event.y,
        startInEditor: event.inEditor,
        startPos: event.inEditor ? probe.posAt(event.x, event.y) : null,
        // Whether a block actually sits on the press row. When none does — the
        // empty tail padding, a blank page, the white space beside an empty
        // region — the drag is a pure area select over emptiness: it still
        // engages and rubber-bands like a desktop sweep.
        startOnBlockRow: probe.bandInY(event.y, event.y) !== null,
        lastFrom: -1,
        lastTo: -1,
      },
      ...NO_EFFECTS,
    };
  }

  // Release, and a move that finds the button already up, both end the gesture.
  // Only an engaged drag may discard the DOM selection on the way out — a plain
  // in-block text drag never engaged and must keep the selection it just made.
  const end = (): AreaSelectResult => ({
    state: AREA_SELECT_IDLE,
    ...NO_EFFECTS,
    clearSelection: state.phase === "engaged",
  });
  if (event.type === "release") return end();
  if (state.phase === "idle") return { state, ...NO_EFFECTS };
  if (!event.primaryButton) return end();

  let next = state;
  let focusEditor = false;
  if (state.phase === "pending") {
    if (Math.hypot(event.x - state.startX, event.y - state.startY) < DRAG_THRESHOLD)
      return { state, ...NO_EFFECTS };
    // `crossedBlocks` only matters when the press landed on a block's own text;
    // over empty space / the margin there's nothing to read, so don't look.
    let crossedBlocks = false;
    if (state.startOnBlockRow && state.startInEditor && state.startPos != null) {
      const cur = probe.posAt(event.x, event.y);
      crossedBlocks = cur != null && probe.crossesBlocks(state.startPos, cur);
    }
    // In-block text drag → leave it to the native selection, but stay pending:
    // a later move can still cross out of the block and engage.
    if (
      !isAreaSelectDrag({
        startOnBlockRow: state.startOnBlockRow,
        startInEditor: state.startInEditor,
        startPos: state.startPos,
        crossedBlocks,
      })
    )
      return { state, ...NO_EFFECTS };
    next = { ...state, phase: "engaged" };
    focusEditor = true;
  }

  const band = probe.bandInY(
    Math.min(next.startY, event.y),
    Math.max(next.startY, event.y),
  );
  let dispatch: BlockBand | null = null;
  if (
    band &&
    needsBandResync({
      band,
      lastFrom: next.lastFrom,
      lastTo: next.lastTo,
      selectionIsNodeRange: probe.selectionIsNodeRange(),
    })
  ) {
    dispatch = band;
    next = { ...next, lastFrom: band.from, lastTo: band.to };
  }
  return {
    state: next,
    engaged: true,
    clearSelection: true,
    focusEditor,
    band: dispatch,
    marquee: dragRect(next.startX, next.startY, event.x, event.y),
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
function blockRangeInBand(view: EditorView, yMin: number, yMax: number): BlockBand | null {
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
          const dom = view.dom as HTMLElement;
          let state: AreaSelectState = AREA_SELECT_IDLE;
          // The live marquee — a fixed-position box swept from the drag origin to
          // the cursor. The NodeRange decorations only tint blocks the band lands
          // on; the marquee gives the gesture an immediate, continuous outline
          // (and the only feedback over empty space, where there are no blocks).
          let marquee: HTMLDivElement | null = null;

          /** The reducer's window onto the editor. All read-only. */
          const probe: AreaSelectProbe = {
            posAt: (x, y) => view.posAtCoords({ left: x, top: y })?.pos ?? null,
            bandInY: (yMin, yMax) => blockRangeInBand(view, yMin, yMax),
            crossesBlocks: (a, b) => crossesBlocks(view.state.doc, a, b),
            selectionIsNodeRange: () => isNodeRangeSelection(view.state.selection),
          };

          /** Drop whatever native selection the browser has grown. The reducer
           *  asks for this on EVERY engaged move (see the module note): the press
           *  already started a selection gesture that `user-select: none` can't
           *  abort, so the only reliable suppression is to keep emptying it.
           *  `removeAllRanges` (not a collapse) so `rangeCount === 0` and
           *  ProseMirror's observer has nothing to derive a `TextSelection` from. */
          const clearNativeSelection = () => {
            const sel = view.dom.ownerDocument.getSelection();
            if (sel && sel.rangeCount > 0) sel.removeAllRanges();
          };

          /** Focus the editor so the resulting selection can be acted on by the
           *  keyboard (Delete / Backspace). An area select routinely STARTS in the
           *  margin (the whole point of the gesture), where the press lands on the
           *  scroll pane — NOT the contenteditable — so `.ProseMirror` never took
           *  focus; and a `NodeRangeSelection` is `visible:false`, so dispatching
           *  it doesn't focus the editor either. Without this a key press after a
           *  margin-started select went to `<body>` and nothing got deleted.
           *
           *  Focus `view.dom` DIRECTLY, never `view.focus()`: the latter runs
           *  `selectionToDOM()`, which writes a DOM selection back that the
           *  still-live browser drag then extends — the phantom `::selection`
           *  highlight that raced the marquee and let ProseMirror's observer
           *  clobber every dispatched `NodeRangeSelection`. `preventScroll` keeps
           *  it from jumping the page, same as `view.focus()` did. */
          const focusEditorElement = () => {
            dom.focus({ preventScroll: true });
          };

          /** Belt to the clear's braces: stops the browser starting a *fresh*
           *  selection while we own the gesture. Inert against the one already in
           *  flight (see the module note), which is why it is not the whole fix. */
          const setSuppressed = (on: boolean) => {
            dom.style.userSelect = on ? "none" : "";
          };

          const dispatchBand = (band: BlockBand) => {
            try {
              const sel = NodeRangeSelection.create(view.state.doc, band.from + 1, band.to - 1);
              view.dispatch(view.state.tr.setSelection(sel));
            } catch {
              /* range momentarily invalid mid-doc-change — ignore */
            }
          };

          /** Paint the marquee at the reducer's rect, creating it on first use.
           *  Coords are viewport (client) space → `position: fixed`. */
          const paintMarquee = (r: ViewportRect) => {
            if (!marquee) {
              marquee = view.dom.ownerDocument.createElement("div");
              marquee.className = "doc-area-select-rect";
              marquee.setAttribute("aria-hidden", "true");
              view.dom.ownerDocument.body.appendChild(marquee);
            }
            marquee.style.left = `${r.left}px`;
            marquee.style.top = `${r.top}px`;
            marquee.style.width = `${r.width}px`;
            marquee.style.height = `${r.height}px`;
          };

          const clearMarquee = () => {
            marquee?.remove();
            marquee = null;
          };

          /** Block the browser from STARTING a fresh selection mid-gesture (each
           *  `clearNativeSelection` is an invitation to re-anchor one).
           *  `selectstart` is the only cancellable point once a press is live. */
          function onSelectStart(e: Event) {
            if (state.phase === "engaged") e.preventDefault();
          }

          const trackPointer = () => {
            const d = view.dom.ownerDocument;
            d.addEventListener("mousemove", onMove, true);
            d.addEventListener("mouseup", onUp, true);
            d.addEventListener("selectstart", onSelectStart, true);
          };

          const untrackPointer = () => {
            const d = view.dom.ownerDocument;
            d.removeEventListener("mousemove", onMove, true);
            d.removeEventListener("mouseup", onUp, true);
            d.removeEventListener("selectstart", onSelectStart, true);
          };

          /** Run one gesture event through the reducer and apply what it asks for.
           *  The effect ORDER is the reducer's contract: focus → clear the DOM
           *  selection → dispatch the band → paint the marquee (last, because the
           *  dispatch can blur it for a frame, and the box must read as the live,
           *  top-most drag outline). */
          const apply = (event: AreaSelectEvent): AreaSelectResult => {
            const wasEngaged = state.phase === "engaged";
            const r = areaSelectReducer(state, event, probe);
            state = r.state;
            if (r.focusEditor) {
              setSuppressed(true);
              focusEditorElement();
            }
            if (r.clearSelection) clearNativeSelection();
            if (r.band) dispatchBand(r.band);
            if (r.marquee) paintMarquee(r.marquee);
            else clearMarquee();
            if (wasEngaged && !r.engaged) setSuppressed(false);
            if (state.phase === "idle") untrackPointer();
            return r;
          };

          function onMove(e: MouseEvent) {
            const r = apply({
              type: "move",
              x: e.clientX,
              y: e.clientY,
              primaryButton: (e.buttons & 1) !== 0,
            });
            if (r.engaged) e.preventDefault();
          }

          function onUp() {
            apply({ type: "release" });
          }

          function onDown(e: MouseEvent) {
            if (e.button !== 0 || !view.editable || isInteractiveTarget(e.target)) return;
            apply({
              type: "press",
              x: e.clientX,
              y: e.clientY,
              inEditor: view.dom.contains(e.target as Node),
            });
            trackPointer();
          }

          pane.addEventListener("mousedown", onDown, true);
          return {
            destroy() {
              clearMarquee();
              pane.removeEventListener("mousedown", onDown, true);
              untrackPointer();
            },
          };
        },
      }),
    ];
  },
});

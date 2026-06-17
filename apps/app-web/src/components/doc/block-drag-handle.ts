"use client";

// [COMP:app-web/block-drag-handle]
/**
 * Nested-aware block drag handle for the collaborative editor.
 *
 * `@tiptap/extension-drag-handle` only ever targets the **outermost** block
 * (its `getOuterDomNode`/`getOuterNode` walk up to `view.dom`'s direct child),
 * so a block nested inside a `toggle`/`callout`/`blockquote` had no handle of
 * its own — Tab-ing a block into a toggle made its `⋮⋮` grip vanish.
 *
 * This is a faithful **vendored fork** of that upstream plugin: it keeps the
 * proven mechanics verbatim — `tippy` positioning, the `NodeRangeSelection`
 * drag with a cloned drag-image (so ProseMirror's native drop moves the block
 * and the browser ghosts only that block, not the whole editor), the Yjs
 * relative-position remap, and the `lockDragHandle`/`hideDragHandle` metas — and
 * changes **only** the target resolution to the actual hovered block at its real
 * depth (`blockTargetAtPos`). Re-implementing positioning/drag from scratch (an
 * earlier attempt) mis-placed the grip and ghosted the entire doc on drag; this
 * sticks to the battle-tested upstream paths.
 *
 * One behavioural addition over the fork: the grip is **visibility-gated** — it
 * starts `visibility:hidden` and only becomes visible while tippy is actively
 * showing it against a hovered, laid-out block. This gate is enforced at BOTH
 * the points that touch the anchor: the `mousemove` SHOW path refuses to reveal
 * the grip against a block with no layout box yet (a `hasLayoutBox` check before
 * `popup.show()`), and the doc-change `update` path hides it if the anchor's DOM
 * is later replaced or removed by a collab / node-view re-render (or initial-sync
 * churn). Without the show-path gate, a first hover landing on a node-view that's
 * mid-(re)mount right after an AI generation latched a zero-box anchor, so
 * `forceUpdate()` stuck the grip at the wrapper origin — on the `PageComments`
 * composer at the top of the editor — instead of beside the block.
 *
 * The grip element + the `BlockDragHandle` React wrapper (in `drag-handle.tsx`)
 * mirror `@tiptap/extension-drag-handle-react`, so the lock + `BlockActionMenu`
 * integration is unchanged.
 */

import tippy, { type Instance as TippyInstance } from "tippy.js";
import { Plugin, PluginKey, TextSelection, type EditorState } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import type { Node as PMNode } from "@tiptap/pm/model";
import type { Editor } from "@tiptap/core";
import { NodeRangeSelection, isNodeRangeSelection } from "@tiptap/extension-node-range";
import { sinkListItemOrJoin } from "./block-indent";
import { isChangeOrigin } from "@tiptap/extension-collaboration";
import {
  ySyncPluginKey,
  absolutePositionToRelativePosition,
  relativePositionToAbsolutePosition,
} from "y-prosemirror";

/** Container nodes whose first child is a "summary" line, not an independent
 *  block — a cursor on the summary targets the whole container (mirrors the
 *  same set in `block-indent.ts`). */
export const DRAG_CONTAINER_NODES = new Set(["toggle", "callout", "blockquote"]);

/** List ROW nodes — the unit the grip grabs inside a list (one bullet / number /
 *  task line, with its own nested sub-items). A list hover targets the row, not
 *  the inner paragraph (dragging a bare paragraph out of a list is broken) nor
 *  the whole list container (which gave every sub-bullet one shared grip anchored
 *  to the list top — the flicker). */
export const LIST_ITEM_NODES = new Set(["listItem", "taskItem"]);

/** List CONTAINER nodes — the `<ul>`/`<ol>` wrappers. The rightward DOM scan
 *  lands on these (not the row) over a list's marker column / gutter, so they're
 *  treated as "ambiguous" like `DRAG_CONTAINER_NODES`: `posAtCoords` (the real
 *  pointer position) is consulted to recover the hovered row. */
export const LIST_CONTAINER_NODES = new Set(["bulletList", "orderedList", "taskList"]);

/**
 * Node types where the rightward DOM hit-test (`findElementNextToCoords`) is
 * unreliable, so a `posAtCoords` refinement should override it: a toggle/callout/
 * blockquote's chevron gutter, and a list's marker column — both resolve the scan
 * to the container (or the list's first item) beside the actual hovered child row.
 * A plain leaf (paragraph / heading) scan is authoritative and never refined.
 */
function isAmbiguousScanTarget(typeName: string): boolean {
  return (
    DRAG_CONTAINER_NODES.has(typeName) ||
    LIST_ITEM_NODES.has(typeName) ||
    LIST_CONTAINER_NODES.has(typeName)
  );
}

/**
 * After a grip block-move drops, ProseMirror leaves a `TextSelection` spanning
 * the moved content (`from`..`to`) — which renders as an inner-text highlight,
 * NOT the block band. Re-cast that span as a `NodeRangeSelection` over the same
 * blocks so the dropped blocks stay BLOCK-selected (the
 * `.ProseMirror-selectednoderange` band), matching the pre-drag area selection —
 * Notion keeps the moved blocks selected. Returns `null` when there's no real
 * span to re-select (a collapsed cursor, or a range the class rejects). Pure, so
 * it unit-tests against a constructed doc.
 */
export function blockRangeAfterDrop(
  doc: PMNode,
  from: number,
  to: number,
): NodeRangeSelection | null {
  if (from >= to) return null;
  try {
    return NodeRangeSelection.create(doc, from, to);
  } catch {
    return null;
  }
}

/**
 * Build the `NodeRangeSelection` the grip drags, pinned to the dragged block's
 * OWN parent depth. Pure, so it unit-tests against a constructed doc.
 *
 * The depth pin is the fix for "drag one bullet, all three move". With
 * `NodeRangeSelection.create(doc, from, to)`'s `depth` left undefined, the class
 * auto-computes it from the from/to *boundary* positions
 * (`max(0, $from.sharedDepth($to.pos) − 1)`). For a TOP-LEVEL block that's 0 —
 * the doc is the parent, so the range spans just that block. But for a block
 * whose parent is a list / toggle / callout (not the doc), the boundary
 * positions resolve INSIDE that container (depth ≥ 1), so the auto-depth
 * collapses to 0 anyway and the `NodeRange`'s parent becomes the DOC — selecting
 * the whole `<ul>`/`<ol>` (every sibling bullet) or the whole container, not the
 * one grabbed row. `doc.resolve(from).depth` is the block's real parent depth (0
 * top-level — unchanged — the container depth nested), so the range spans
 * exactly the grabbed block (or, in the area-drag branch, the already
 * block-aligned span). Returns `null` when the span can't form a range (the
 * caller then aborts the drag).
 */
export function blockDragSelection(
  doc: PMNode,
  from: number,
  to: number,
): NodeRangeSelection | null {
  try {
    return NodeRangeSelection.create(doc, from, to, doc.resolve(from).depth);
  } catch {
    return null;
  }
}

/**
 * Resolve which block a hover position belongs to — the block the drag handle
 * should grab. Pure, so it unit-tests against a constructed doc.
 *
 * The target is the block directly containing the position, with two exceptions:
 *
 *   - **Container summary** — when the block is the first child (summary) of a
 *     toggle/callout/blockquote, we walk UP to the container (so hovering a
 *     toggle's title drags the whole toggle, not just its summary out of it).
 *   - **List row** — a position inside a list targets the enclosing
 *     `listItem`/`taskItem` (the ROW the marker belongs to), NOT the inner
 *     paragraph (dragging a bare paragraph out of a list is broken) and NOT the
 *     whole list container. A sub-bullet keeps its own row handle. When the
 *     rightward scan lands directly on the list CONTAINER boundary (its `<ul>`/
 *     `<ol>`), we descend to the item at that index so the target is still a row,
 *     never the bare container (which would anchor the grip to the whole list's
 *     box — the flicker). The exact hovered row is then recovered by the
 *     `posAtCoords` refinement in the hover handler (the scan only knows the
 *     column, not which row).
 *
 * Body children and plain nested blocks resolve to themselves. Returns
 * `{ node, pos }` where `pos` is the position *before* the block.
 */
export function blockTargetAtPos(
  doc: PMNode,
  hoverPos: number,
): { node: PMNode; pos: number } | null {
  const pos = Math.max(0, Math.min(hoverPos, doc.content.size));
  const $pos = doc.resolve(pos);
  let depth = $pos.depth;
  if (depth === 0) {
    const node = doc.nodeAt(pos);
    return node ? { node, pos } : null;
  }
  while (
    depth > 1 &&
    DRAG_CONTAINER_NODES.has($pos.node(depth - 1).type.name) &&
    $pos.index(depth - 1) === 0
  ) {
    depth -= 1;
  }
  const nodeAtDepth = $pos.node(depth);
  // Scan landed directly on a list container boundary (before/between items) →
  // resolve to the adjacent ROW, never the bare container. `nodeAfter` is the
  // item about to start (its before-pos is `pos`); at the list's tail `nodeBefore`
  // is the last item.
  if (LIST_CONTAINER_NODES.has(nodeAtDepth.type.name)) {
    const after = $pos.nodeAfter;
    if (after && LIST_ITEM_NODES.has(after.type.name)) return { node: after, pos };
    const before = $pos.nodeBefore;
    if (before && LIST_ITEM_NODES.has(before.type.name)) {
      return { node: before, pos: pos - before.nodeSize };
    }
  }
  // Inside a list row → the deepest enclosing listItem/taskItem (the row owns the
  // grip, so a nested sub-bullet keeps its own handle at its real depth).
  for (let d = depth; d >= 1; d -= 1) {
    if (LIST_ITEM_NODES.has($pos.node(d).type.name)) {
      return { node: $pos.node(d), pos: $pos.before(d) };
    }
  }
  return { node: nodeAtDepth, pos: $pos.before(depth) };
}

// ── Drag-to-nest (Notion-style: drop a bullet rightward → sub-bullet) ───────
/**
 * Half the list's per-level indent (`padding-left: 3rem` = 48px in `globals.css`).
 * A grip-dropped list row whose drop-cursor X is at least this far right of the
 * row's own text-start is read as "indent one level" — nest it under the row
 * above; a drop straight down (same indent) keeps it a sibling. Tunable: lower =
 * easier to nest. See `dropIndentsDeeper`.
 */
export const NEST_DROP_INDENT_PX = 24;

/**
 * True when a drop at `clientX` is indented far enough past a row's `contentLeftX`
 * (its text-start) to mean "nest under the row above" rather than "drop as a
 * sibling". Pure, so the threshold is unit-tested without a mounted editor.
 */
export function dropIndentsDeeper(
  clientX: number,
  contentLeftX: number,
  thresholdPx: number = NEST_DROP_INDENT_PX,
): boolean {
  return clientX - contentLeftX >= thresholdPx;
}

/**
 * Resolve the list-item row (`listItem` or `taskItem` — to-dos nest too) at
 * or around a document position — the dropped row whose nesting we may
 * deepen. Returns its before-position + the node, or null when `pos` isn't in
 * a list item. Pure, so it unit-tests on a constructed doc.
 */
const NESTABLE_ROW_TYPES = new Set(["listItem", "taskItem"]);

export function listRowAround(
  doc: PMNode,
  pos: number,
): { node: PMNode; pos: number } | null {
  const clamped = Math.max(0, Math.min(pos, doc.content.size));
  const at = doc.nodeAt(clamped);
  if (at && NESTABLE_ROW_TYPES.has(at.type.name)) return { node: at, pos: clamped };
  const $pos = doc.resolve(clamped);
  for (let d = $pos.depth; d >= 1; d -= 1) {
    if (NESTABLE_ROW_TYPES.has($pos.node(d).type.name)) {
      return { node: $pos.node(d), pos: $pos.before(d) };
    }
  }
  return null;
}

export type DragTarget = { node: PMNode; pos: number };

/**
 * Pick between the rightward DOM-scan target and a `posAtCoords` refinement.
 *
 * The scan finds the first editor element on the cursor's row. Over an
 * **ambiguous** column — a container's empty chevron gutter beside a toggle
 * child's row, OR a list's marker column beside a bullet's row — it resolves to
 * the container (or the list's first item), so the grip snaps to the wrong row
 * the instant you reach leftward for the real grip (the child looks
 * undraggable). `posAtCoords` maps the pointer to the real position on that row
 * and recovers the hovered child.
 *
 * Override ONLY for an ambiguous scan target (`isAmbiguousScanTarget`): a plain
 * leaf scan (already on a paragraph/heading) is authoritative, and a null
 * refinement (pointer in the far gutter, off any line) keeps the scan. Pure, so
 * it unit-tests without a mounted editor.
 */
export function refineContainerTarget(
  scanTarget: DragTarget | null,
  coordsTarget: DragTarget | null,
): DragTarget | null {
  if (
    scanTarget &&
    coordsTarget &&
    isAmbiguousScanTarget(scanTarget.node.type.name)
  ) {
    return coordsTarget;
  }
  return scanTarget;
}

// ── DOM hit-test (ported from @tiptap/extension-drag-handle) ───────────────
/** Scan rightward from the cursor for the innermost editor element on that row,
 *  so a hover anywhere in the left gutter still finds its block. */
function findElementNextToCoords(opts: { x: number; y: number; editor: Editor }): {
  element: Element | null;
  pos: number | null;
} {
  const { x, y, editor } = opts;
  let element: Element | null = null;
  let pos: number | null = null;
  let currentX = x;
  while (element === null && currentX < window.innerWidth && currentX > 0) {
    const all = document.elementsFromPoint(currentX, y);
    const pmIndex = all.findIndex((el) => el.classList.contains("ProseMirror"));
    const before = pmIndex >= 0 ? all.slice(0, pmIndex) : [];
    if (before.length > 0) {
      const target = before[0];
      const at = editor.view.posAtDOM(target, 0);
      if (at >= 0) {
        element = target;
        pos = at;
        break;
      }
    }
    currentX += 1;
  }
  return { element, pos };
}

/** Step (px) for the rightward `posAtCoords` row-probe. Coarse on purpose — only
 *  WHICH row the cursor's Y falls on matters, not the exact column — so a handful
 *  of probes cover the gutter→text span without pixel-walking it. */
export const ROW_PROBE_STEP_PX = 6;

/**
 * Resolve the row under a LEFT-GUTTER hover by probing `posAtCoords` rightward
 * along the cursor's Y.
 *
 * In the gutter `posAtCoords` is null (no text there), so the leftward DOM scan
 * (`findElementNextToCoords`) resolves to whatever box fills the gutter at this Y
 * — for a sub-bullet that's the ENCLOSING toggle / parent row (its empty chevron
 * or marker column), whose left edge sits one indent further OUT. Anchoring the
 * grip there drops it at the page's far left, detached from the bullet (the
 * reported "sub-bullet drag icon sits too far to the page's left"). Stepping
 * `posAtCoords` rightward to the first real text position lands on the bullet's
 * OWN row, so the grip anchors beside it at its real depth. Capped at the editor's
 * right edge; returns null when the Y holds no text rightward (a genuine
 * inter-block gap), leaving the `mousemove` gutter-stickiness to keep the current
 * row. Reads layout, so it's exercised via a stubbed `view` in the tests.
 */
export function deepestRowCoordsRight(
  view: EditorView,
  startX: number,
  clientY: number,
): { pos: number; inside: number } | null {
  const right = view.dom.getBoundingClientRect().right;
  for (let x = startX; x <= right; x += ROW_PROBE_STEP_PX) {
    const at = view.posAtCoords({ left: x, top: clientY });
    if (at) return at;
  }
  return null;
}

// ── Grip anchor (list-aware, first-line vertical band) ─────────────────────
/**
 * Resolve a computed `line-height` string to pixels. `getComputedStyle` returns
 * a px value ("36.4px"), the `normal` keyword, an empty string (an unstyled
 * element, e.g. in jsdom), or — on some engines — a bare unitless ratio ("1.3");
 * each maps to a pixel height (`normal`/unknown → 1.2 × font-size). Pure, so it
 * unit-tests without the DOM.
 */
export function resolveLineHeight(lineHeight: string, fontSize: number): number {
  if (lineHeight === "" || lineHeight === "normal") return fontSize * 1.2;
  const n = parseFloat(lineHeight);
  if (!Number.isFinite(n)) return fontSize * 1.2;
  return lineHeight.trimEnd().endsWith("px") ? n : n * fontSize;
}

/** A block's first-line height + top padding, read from computed style. */
function firstLineMetrics(dom: HTMLElement): { lineHeight: number; padTop: number } {
  const cs = getComputedStyle(dom);
  const fontSize = parseFloat(cs.fontSize) || 16;
  return {
    lineHeight: resolveLineHeight(cs.lineHeight, fontSize),
    padTop: parseFloat(cs.paddingTop) || 0,
  };
}

/** The grip is `h-6` = 24px tall. tippy.css is NOT imported, so the popup box has
 *  no padding/border — the grip fills it and the popup's top edge IS the grip's
 *  top edge, which the vertical-centring offset relies on. */
export const GRIP_HEIGHT = 24;

/**
 * Height ceiling (px) under which a node-view `embed` is treated as a single-row
 * block and the grip is centred on its whole box rather than its (non-existent)
 * first text line. Covers the one-row embeds — the `child_page` link, the media
 * URL stub, a bookmark card — while a taller embed (a data/chart table, a video
 * player) stays above it and keeps the grip near the top via the text-line
 * metric, where a centred grip would float in the middle of the widget.
 */
export const EMBED_BOX_CENTER_MAX = 64;

/**
 * The class on the node DOM `view.nodeDOM()` returns for an `embed` node. Tiptap's
 * `ReactNodeViewRenderer` wraps every node view in an OUTER element it stamps with
 * `node-<type.name>` (here `node-embed`); the component's own `<NodeViewWrapper
 * className="doc-embed">` is that wrapper's CHILD, NOT the node DOM. So the
 * grip's vertical-centre test must key off `node-embed`, not `doc-embed` — the
 * earlier `doc-embed` check never matched, which is why the grip stayed pinned
 * to the row top. Container node views (`node-toggle` / `node-callout`) are
 * deliberately excluded: they DO have a first-line summary the text metric centres
 * on, so only the atom `embed` gets box-centring.
 */
const EMBED_NODE_DOM_CLASS = "node-embed";

/**
 * The class on the node DOM `view.nodeDOM()` returns for a `callout` node, plus
 * the class on its INNER padded box. Like the embed (see `EMBED_NODE_DOM_CLASS`),
 * Tiptap wraps the callout's `<NodeViewWrapper className="doc-callout … p-3">` in
 * an OUTER `node-callout` element — and THAT outer wrapper is the node DOM. The
 * outer wrapper carries no padding and no text line of its own (the `p-3` + the
 * emoji + the editable body all live on the inner `.doc-callout`), so reading the
 * first-line metric off it yields padding-top 0 → the grip pins to the box TOP,
 * ~12px above the callout's first content line (the reported "drag icon not
 * vertically middle"). The fix reads the metric off the inner box instead.
 */
const CALLOUT_NODE_DOM_CLASS = "node-callout";
const CALLOUT_INNER_CLASS = "doc-callout";

/**
 * The client rect tippy anchors the grip to. A bulleted/numbered list item's
 * marker (and a task list's checkbox) lives in the parent list's leading column,
 * LEFT of the block's text box — so anchoring to the block's own rect drops the
 * `⠿` grip right on top of the marker. For a block inside a list, anchor to the
 * parent `<ul>`/`<ol>`'s left edge instead (left of that whole marker column).
 * Every other block anchors to its own box.
 *
 * **Geometry only** — deliberately a bare `getBoundingClientRect`, because tippy
 * calls this on every scroll / resize / raf while the grip is shown. The vertical
 * first-line centring lives OUTSIDE this hot path, in tippy's `offset` (computed
 * once per hovered block by `gripVerticalOffset`). An earlier attempt that read
 * `getComputedStyle` here and returned a shifted/short band parked the grip at the
 * page top — keep this function cheap and the returned rect the block's real box.
 */
export function gripReferenceRect(dom: HTMLElement): DOMRect {
  const rect = dom.getBoundingClientRect();
  const list = dom.closest("ul, ol");
  const left = list ? list.getBoundingClientRect().left : rect.left;
  // Plain literal (not the raw rect / `new DOMRect`) — normalises `x`/`y` and, for
  // a list item, moves only the left edge to the list's marker column. Values are
  // otherwise the block's real box; tippy reads these fields and the DOMRect
  // constructor isn't guaranteed in every test env.
  return {
    left,
    x: left,
    top: rect.top,
    y: rect.top,
    right: rect.right,
    bottom: rect.bottom,
    width: Math.max(0, rect.right - left),
    height: rect.height,
    toJSON() {},
  } as DOMRect;
}

/**
 * True when `dom` is actually laid out — a connected element with a non-empty
 * box. A node just (re)mounted by a React node-view swap (embed / toggle /
 * callout) or a collab re-render can be momentarily present-but-un-laid-out (a
 * zero-size rect); `getBoundingClientRect()` then resolves the grip's reference
 * to viewport `(0,0)`, which parks the popup at the wrapper origin — the
 * top-left of `.doc-collab-editor`, which since the page-comment composer
 * (`PageComments`) was added sits ON that composer (the reported "drag grip on
 * the comment box, not beside the block"). The handle treats an un-laid-out
 * anchor as no anchor and hides. Reads layout; unit-tested via a stubbed rect.
 */
export function hasLayoutBox(dom: HTMLElement): boolean {
  const rect = dom.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

/**
 * True when a pointer LEAVING `view.dom` is still travelling toward the grip and
 * the handle should stay shown.
 *
 * The grip sits in the white margin LEFT of the editor column, outside `view.dom`,
 * so a straight move from a block toward its grip crosses a gap where
 * `relatedTarget` is neither the editor nor the grip — the bare leave would hide
 * the handle just as it's reached. Keep it shown while the pointer is in the
 * corridor between the block's left edge and the grip. The vertical band spans the
 * UNION of the grip's box and the hovered block's FULL extent (not just the grip's
 * own ~24px band): a block can be taller than its first line, and `gripVerticalOffset`
 * can land the grip a few px off a heading's optical centre, so a reach made from a
 * wrapped line or slightly above/below the grip must not drop it (the reported
 * "drag icon disappears when I move the cursor to it"). Pure, so it unit-tests
 * against plain rects.
 */
export function pointerInGripCorridor(
  pointer: { x: number; y: number },
  grip: { left: number; right: number; top: number; bottom: number },
  block: { left: number; top: number; bottom: number } | null,
): boolean {
  const rightBound = (block ? block.left : grip.right) + 8;
  const top = Math.min(grip.top, block ? block.top : grip.top) - 6;
  const bottom = Math.max(grip.bottom, block ? block.bottom : grip.bottom) + 6;
  return (
    pointer.x >= grip.left - 8 &&
    pointer.x <= rightBound &&
    pointer.y >= top &&
    pointer.y <= bottom
  );
}

/**
 * Vertical skidding (px, downward) for tippy's `offset` so the grip's centre
 * lands on the block's FIRST text line. `left-start` pins the popup's top to the
 * block top and the grip is `GRIP_HEIGHT` tall, so it must drop by
 * `padding-top + lineHeight/2 − GRIP_HEIGHT/2` — small on a paragraph (~3px),
 * larger on an H1 (~9px, line-height 1.3 × 28px ≈ 36px). A divider (`<hr>`) has no
 * text line, so centre on its padded box instead — and there alone allow a
 * NEGATIVE nudge, since a 1px rule shorter than the 24px grip must pull the grip
 * UP to sit on it. A `callout`'s node DOM is an outer wrapper with no padding, so
 * its metric is read off the inner padded box (`.doc-callout`) — else the grip
 * pins to the box top, above the first content line. Text blocks clamp ≥0 so the
 * grip never rides above the block top. Read once per hovered block (NOT in the
 * popper hot path) so
 * `getComputedStyle` stays off every reposition. Reads layout; the line-height
 * parse is unit-tested via `resolveLineHeight`.
 */
export function gripVerticalOffset(dom: HTMLElement): number {
  if (dom.tagName === "HR") {
    const rect = dom.getBoundingClientRect();
    return rect.height / 2 - GRIP_HEIGHT / 2;
  }
  // A node-view embed (the `child_page` link row, the media URL stub, a bookmark
  // card) carries no inline text line — its content is vertically centred inside
  // the box — so the first-line metric below pins the grip to the box TOP, off
  // the row's centre (the reported "drag icon not vertically middle"). For a
  // SHORT embed centre the grip on the box like an <hr>; a tall embed (data
  // table / video) falls through to the text-line metric and keeps the grip near
  // the top, where box-centring would strand it in the widget's middle. Keyed on
  // `node-embed` (Tiptap's outer wrapper class — see EMBED_NODE_DOM_CLASS), the
  // class the node DOM actually carries.
  if (dom.classList.contains(EMBED_NODE_DOM_CLASS)) {
    const rect = dom.getBoundingClientRect();
    if (rect.height <= EMBED_BOX_CENTER_MAX) return rect.height / 2 - GRIP_HEIGHT / 2;
  }
  // A callout nests its first content line inside a padded inner box beside the
  // emoji; the outer node DOM has no padding, so read the metric off that inner
  // box (`.doc-callout`) and add the inner box's top offset within the wrapper
  // (≈0 when the inner margin collapses through, but measured so a future border/
  // padding on the wrapper can't strand the grip). See `CALLOUT_NODE_DOM_CLASS`.
  if (dom.classList.contains(CALLOUT_NODE_DOM_CLASS)) {
    const inner = dom.querySelector<HTMLElement>(`.${CALLOUT_INNER_CLASS}`);
    if (inner) {
      const { lineHeight, padTop } = firstLineMetrics(inner);
      const innerTopDelta =
        inner.getBoundingClientRect().top - dom.getBoundingClientRect().top;
      return Math.max(0, innerTopDelta + padTop + lineHeight / 2 - GRIP_HEIGHT / 2);
    }
  }
  const { lineHeight, padTop } = firstLineMetrics(dom);
  return Math.max(0, padTop + lineHeight / 2 - GRIP_HEIGHT / 2);
}

// ── Drag-image clone (ported) ──────────────────────────────────────────────
function getCSSText(element: Element): string {
  const style = getComputedStyle(element);
  let value = "";
  for (let i = 0; i < style.length; i += 1) {
    value += `${style[i]}:${style.getPropertyValue(style[i])};`;
  }
  return value;
}
function cloneElement(node: HTMLElement): HTMLElement {
  const clone = node.cloneNode(true) as HTMLElement;
  const src = [node, ...Array.from(node.getElementsByTagName("*"))];
  const dst = [clone, ...Array.from(clone.getElementsByTagName("*"))];
  src.forEach((el, i) => {
    (dst[i] as HTMLElement).style.cssText = getCSSText(el);
  });
  return clone;
}
function removeNode(node: Node) {
  node.parentNode?.removeChild(node);
}

// ── Yjs absolute↔relative position (ported — keeps the target valid across
//    remote edits, which renumber the whole doc) ─────────────────────────────
function getRelativePos(state: EditorState, absolutePos: number): unknown {
  const ystate = ySyncPluginKey.getState(state);
  if (!ystate) return null;
  return absolutePositionToRelativePosition(absolutePos, ystate.type, ystate.binding.mapping);
}
function getAbsolutePos(state: EditorState, relativePos: unknown): number {
  const ystate = ySyncPluginKey.getState(state);
  if (!ystate || !relativePos) return -1;
  const abs = relativePositionToAbsolutePosition(
    ystate.doc,
    ystate.type,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    relativePos as any,
    ystate.binding.mapping,
  );
  // `null` = the anchored item was DELETED + GC'd by a remote/AI edit, so its
  // relative position no longer resolves — return the `-1` "lost" sentinel, NOT
  // `0`. The earlier `|| 0` collapsed a lost anchor onto doc-START, silently
  // retargeting the grip to position 0 (and a stale reference then parked the
  // popup at the wrapper origin — see `hasLayoutBox`). A genuine position 0
  // (a real anchor at doc start) stays 0; only an unresolvable position is lost.
  return abs == null ? -1 : abs;
}

export const blockDragHandleKey = new PluginKey("docBlockDragHandle");

const TIPPY_PROPS = {
  getReferenceClientRect: null,
  interactive: true,
  trigger: "manual" as const,
  // `left-start` (top-aligned), NOT `left` (centre-aligned): centred placement
  // positions by the popup's measured height, which `interactive: true` inflates
  // with an invisible mouse-bridge region, flinging the grip far above the block.
  // First-line centring rides the `offset` SKIDDING instead (per-block, via
  // `gripVerticalOffset`) — a fixed downward nudge that moves the popup AND its
  // bridge together, so the grip stays inside the interactive region.
  placement: "left-start" as const,
  hideOnClick: false,
  duration: 100,
  // `offset[0]` (vertical skidding) is overridden per hovered block; `offset[1]`
  // (8px horizontal gap) is constant. See `gripVerticalOffset`.
  offset: [0, 8] as [number, number],
  popperOptions: {
    modifiers: [
      { name: "flip", enabled: false },
      { name: "preventOverflow", options: { rootBoundary: "document", mainAxis: false } },
    ],
  },
};

export type BlockDragHandleOptions = {
  editor: Editor;
  /** The grip element — built in **vanilla DOM** by `drag-handle.tsx` (NOT a
   *  React node: the plugin parents it in tippy's popup, and relocating a
   *  React-owned node desyncs React's reconciliation → `insertBefore` crash). */
  element: HTMLElement;
  onNodeChange?: (args: { editor: Editor; node: PMNode | null; pos: number }) => void;
};

/**
 * Build the ProseMirror plugin. Lifecycle mirrors the upstream: tippy holds the
 * grip; hover positions it against the target block; `lockDragHandle` pins it
 * (menu open); `hideDragHandle` clears it; doc changes remap the tracked pos.
 */
export function createBlockDragHandlePlugin({
  editor,
  element,
  onNodeChange,
}: BlockDragHandleOptions): Plugin {
  const wrapper = document.createElement("div");
  let popup: TippyInstance | null = null;
  let locked = false;
  let currentNode: PMNode | null = null;
  let currentNodePos = -1;
  let currentNodeRelPos: unknown = null;
  // True from the grip's `dragstart` until the matching drop/`dragend`. Gates the
  // post-drop selection rescue (`appendTransaction`) so it only fires for a grip
  // block-move — a plain text drag-drop the user makes is left untouched.
  let blockDragActive = false;
  // True only while a SINGLE `listItem` row is being grip-dragged — gates the
  // drop-to-nest pass (a dropped bullet whose drop X is indented past the row
  // above becomes its sub-bullet). A multi-block area drag or a non-list block
  // never nests.
  let draggedSingleListRow = false;

  /**
   * Notion-style drop-to-nest: after the native drop has placed the dragged
   * bullet (as a sibling) and settled, deepen it to a sub-bullet of the row above
   * IF the drop landed indented (drop X ≥ the row's text-start + `NEST_DROP_INDENT_PX`).
   * Reuses the exact nest the Tab key runs (`sinkListItemOrJoin`: native sink, or
   * join the previous same-kind sibling list + sink), so a separate one-item `<ul>`
   * (AI write path) nests just like a real list item. Runs deferred (after PM's
   * drop transaction + the selection rescue), as its own local edit the CRDT syncs.
   */
  const maybeNestDroppedRow = (clientX: number) => {
    if (editor.isDestroyed || !editor.isEditable) return;
    const { state, view } = editor;
    const row = listRowAround(state.doc, state.selection.from);
    if (!row) return;
    const dom = view.nodeDOM(row.pos);
    if (!(dom instanceof HTMLElement)) return;
    // Compare against the row's TEXT start (its `<p>`), not the `<li>` marker
    // column — so "straight down under the bullet" stays a sibling and only a
    // clear rightward drag nests.
    const textEl = (dom.querySelector(":scope > p") as HTMLElement | null) ?? dom;
    const contentLeft = textEl.getBoundingClientRect().left;
    if (!dropIndentsDeeper(clientX, contentLeft)) return;
    const inside = TextSelection.near(state.doc.resolve(row.pos + 1));
    view.dispatch(state.tr.setSelection(inside));
    sinkListItemOrJoin(editor);
  };

  /**
   * Return the tippy popup, creating it — or RE-creating it if a prior instance
   * was destroyed — against `referenceDom` (the live `view.dom`).
   *
   * A recreated `EditorView` (Tiptap re-mounting its content host, an editor
   * re-init, or a dev strict-mode double-invoke) re-runs this plugin's `view()`
   * against the SAME plugin closure. The previous view's `destroy()` ran
   * `popup.destroy()` but left `popup` pointing at that DESTROYED instance, not
   * null — so a `!popup` check reads "already have one" and `setProps()`/`show()`
   * then no-op on it (tippy warns "called on a destroyed instance"). No popup
   * mounts, and the grip — never relocated into a tippy box — is revealed in
   * place at the `wrapper` origin (`top:0,left:0`), which lands on the
   * `PageComments` composer at the editor top: the reported "drag icon bugged at
   * the top-left of the comment box". Gating recreation on `isDestroyed` (not
   * just `!popup`) is what heals it. Cheap on the hot path: a live instance is a
   * single boolean check.
   */
  const ensurePopup = (referenceDom: Element): TippyInstance => {
    if (!popup || popup.state.isDestroyed) {
      popup = tippy(referenceDom, { ...TIPPY_PROPS, appendTo: wrapper, content: element });
    }
    return popup;
  };

  const dragHandler = (event: DragEvent) => {
    const { view } = editor;
    if (!event.dataTransfer || currentNodePos < 0) return;
    const node = view.state.doc.nodeAt(currentNodePos);
    if (!node) return;
    let from = currentNodePos;
    let to = currentNodePos + node.nodeSize;
    // When a multi-block area selection (NodeRangeSelection) is active and the
    // grabbed block sits inside it, drag the WHOLE selection (Notion area-drag),
    // not just the one block under the grip.
    const sel = view.state.selection;
    if (isNodeRangeSelection(sel) && sel.from <= currentNodePos && currentNodePos < sel.to) {
      from = sel.from;
      to = sel.to;
    }
    // Pin the range to the block's own parent depth — an undefined depth
    // collapses a nested block's range to the doc level and drags the whole
    // parent container (one bullet → the entire <ul>). See `blockDragSelection`.
    const selection = blockDragSelection(view.state.doc, from, to);
    if (!selection) return;
    const slice = selection.content();
    const dom = view.nodeDOM(from);
    const dragImage = document.createElement("div");
    if (dom instanceof HTMLElement) {
      dragImage.append(cloneElement(dom));
      dragImage.style.position = "absolute";
      dragImage.style.top = "-10000px";
      document.body.append(dragImage);
      event.dataTransfer.clearData();
      event.dataTransfer.setDragImage(dragImage, 0, 0);
      document.addEventListener("drop", () => removeNode(dragImage), { once: true });
    }
    // A single `listItem` row (not an area-multi-block drag, not a non-list
    // block) is eligible for drop-to-nest. `node` is the grabbed row; `from/to`
    // still equal its own span unless an area selection widened them above.
    draggedSingleListRow =
      node.type.name === "listItem" &&
      from === currentNodePos &&
      to === currentNodePos + node.nodeSize;
    // ProseMirror's native drop moves the slice (deleting the source) and the
    // StarterKit Dropcursor shows the target — works across nesting levels.
    view.dragging = { slice, move: true };
    blockDragActive = true;
    view.dispatch(view.state.tr.setSelection(selection));
  };

  element.addEventListener("dragstart", (event) => {
    dragHandler(event as DragEvent);
    // Defer so PM reads the right drag pos even with the popup wrapper.
    setTimeout(() => {
      element.style.pointerEvents = "none";
    }, 0);
  });
  element.addEventListener("dragend", () => {
    element.style.pointerEvents = "auto";
    // Drop already ran its rescue (or there was none — dropped outside / cancelled).
    // Clear the gate so a later text drag-drop can't trip the rescue.
    blockDragActive = false;
    draggedSingleListRow = false;
  });

  return new Plugin({
    key: blockDragHandleKey,
    state: {
      init: () => ({}),
      apply(tr, value, _oldState, state) {
        const lock = tr.getMeta("lockDragHandle");
        const wantHide = tr.getMeta("hideDragHandle");
        if (lock !== undefined) locked = lock;
        if (wantHide && popup) {
          popup.hide();
          element.style.visibility = "hidden";
          locked = false;
          currentNode = null;
          currentNodePos = -1;
          onNodeChange?.({ editor, node: null, pos: -1 });
          return value;
        }
        // Keep the tracked position valid as the doc changes underfoot.
        if (tr.docChanged && currentNodePos !== -1) {
          if (isChangeOrigin(tr)) {
            const mapped = getAbsolutePos(state, currentNodeRelPos);
            if (mapped < 0) {
              // The hovered block's Yjs anchor was destroyed by this remote/AI
              // edit (its item deleted + GC'd — common on a fresh page's FIRST
              // AI edit, which replaces the whole initial fragment), so its
              // relative position no longer resolves. DROP the grip instead of
              // letting `getAbsolutePos`'s old `|| 0` collapse it onto doc-start
              // and strand it at the wrapper origin over the comment composer —
              // where a now-stale `currentNodePos` also blocked re-hover
              // (`mousemove`'s `target.pos === currentNodePos` short-circuit).
              // Keep the target while the block-action menu is pinned
              // (`locked`): it's restored once the re-render lands.
              if (!locked) {
                popup?.hide();
                element.style.visibility = "hidden";
                currentNode = null;
                currentNodePos = -1;
                onNodeChange?.({ editor, node: null, pos: -1 });
              }
            } else if (mapped !== currentNodePos) {
              currentNodePos = mapped;
            }
          } else {
            const mapped = tr.mapping.map(currentNodePos);
            if (mapped !== currentNodePos) {
              currentNodePos = mapped;
              currentNodeRelPos = getRelativePos(state, currentNodePos);
            }
          }
        }
        return value;
      },
    },
    // Keep the dropped blocks BLOCK-selected. The native drop ends on a
    // `TextSelection` across the moved content (an inner-text highlight); when the
    // move came from the grip (`blockDragActive`), recast it as a
    // `NodeRangeSelection` over the same blocks so the band persists — like the
    // pre-drag area selection. Gated + one-shot, so it never loops or touches a
    // plain text drag-drop.
    appendTransaction(transactions, _oldState, newState) {
      if (!blockDragActive) return null;
      if (!transactions.some((t) => t.getMeta("uiEvent") === "drop")) return null;
      blockDragActive = false;
      const { from, to } = newState.selection;
      const sel = blockRangeAfterDrop(newState.doc, from, to);
      return sel ? newState.tr.setSelection(sel) : null;
    },
    view: (view) => {
      element.draggable = true;
      element.style.pointerEvents = "auto";
      // The grip is visible ONLY while tippy is actively showing it against a
      // hovered block. Start it hidden so a parked/detached grip — before tippy
      // adopts it, or after its anchor block's DOM is replaced by a collab /
      // node-view re-render — never lingers at the container's top-left near
      // the page title with a dead (stale-target) click.
      element.style.visibility = "hidden";
      view.dom.parentElement?.appendChild(wrapper);
      wrapper.appendChild(element);
      wrapper.style.pointerEvents = "none";
      wrapper.style.position = "absolute";
      wrapper.style.top = "0";
      wrapper.style.left = "0";
      return {
        update(innerView, oldState) {
          if (!element) return;
          if (!editor.isEditable) {
            popup?.destroy();
            popup = null;
            element.style.visibility = "hidden";
            return;
          }
          // Create the popup, or recreate it if a recreated EditorView left the
          // prior instance destroyed (see `ensurePopup`).
          ensurePopup(innerView.dom);
          if (!popup) return; // ensurePopup guarantees it; this only narrows the type
          element.draggable = !locked;
          if (innerView.state.doc.eq(oldState.doc) || currentNodePos === -1) return;
          // Reposition after a doc change (the position was already remapped in
          // `apply`). If the tracked block's DOM is gone — deleted, or replaced
          // mid-flight by a collab / node-view re-render — a still-shown grip
          // would otherwise linger at a stale (often top-left, by the title)
          // position with a dead target. Hide it and drop the target. While the
          // menu is pinned (`locked`) keep the target: it's remapped across
          // remote edits and the DOM returns after the re-render.
          const dom = innerView.nodeDOM(currentNodePos);
          // Hide on a gone OR un-laid-out anchor: a detached node (deleted), or
          // one present but with no box yet (a React node-view mid-swap). Either
          // resolves the reference to the wrapper origin and parks the grip on
          // the comment composer at the top — see `hasLayoutBox`. Dropping the
          // target (currentNodePos = -1) also frees re-hover. The pinned menu
          // (`locked`) keeps its target across the churn.
          if (
            !(dom instanceof HTMLElement) ||
            !innerView.dom.contains(dom) ||
            !hasLayoutBox(dom)
          ) {
            if (!locked) {
              popup.hide();
              element.style.visibility = "hidden";
              currentNode = null;
              currentNodePos = -1;
              onNodeChange?.({ editor, node: null, pos: -1 });
            }
            return;
          }
          currentNode = innerView.state.doc.nodeAt(currentNodePos);
          currentNodeRelPos = getRelativePos(innerView.state, currentNodePos);
          onNodeChange?.({ editor, node: currentNode, pos: currentNodePos });
          popup.setProps({
            getReferenceClientRect: () => gripReferenceRect(dom),
            offset: [gripVerticalOffset(dom), 8],
          });
        },
        destroy() {
          popup?.destroy();
          // Null it (not just destroy): if this teardown is a view RECREATION
          // (same plugin closure, new EditorView), the next `ensurePopup` must
          // build a fresh instance rather than reuse this destroyed one. Without
          // this, the grip surfaces at the wrapper origin on the comment composer.
          popup = null;
          removeNode(wrapper);
        },
      };
    },
    props: {
      handleDOMEvents: {
        keydown(view) {
          if (popup && popup.state.isVisible && view.hasFocus()) {
            popup.hide();
            element.style.visibility = "hidden";
          }
          return false;
        },
        drop(_view, event) {
          // A grip-dragged single bullet: capture the drop X now (the DOM event
          // fires before PM's native drop), then — once that drop + the selection
          // rescue settle — nest it under the row above if it landed indented.
          // Return false so ProseMirror still performs the move itself. The nest
          // runs in a microtask — after PM's drop transaction + the list
          // normalizer settle, but BEFORE the browser paints — so the row never
          // flashes flat-then-nested.
          if (blockDragActive && draggedSingleListRow) {
            const clientX = (event as DragEvent).clientX;
            queueMicrotask(() => maybeNestDroppedRow(clientX));
          }
          return false;
        },
        mouseleave(view, event) {
          if (locked) return false;
          const e = event as MouseEvent;
          const related = e.relatedTarget as Node | null;
          if (related && wrapper.contains(related)) return false;
          // The grip sits in the white margin LEFT of the editor column, OUTSIDE
          // `view.dom` — so moving straight from a block toward its grip crosses
          // a gap where `relatedTarget` is neither the editor nor the grip, and
          // the bare check above would hide it just as you reach for it (worst on
          // a short embed row, where the grip is offset from the pointer). Keep
          // it shown while the pointer is in the corridor between the hovered
          // block's left edge and the grip — over the block's FULL vertical
          // extent, so a reach from a wrapped line (or one a few px off the grip's
          // centre) doesn't drop it. See `pointerInGripCorridor`.
          if (element.style.visibility === "visible" && currentNodePos >= 0) {
            const grip = element.getBoundingClientRect();
            const curDom = view.nodeDOM(currentNodePos);
            const block =
              curDom instanceof HTMLElement ? curDom.getBoundingClientRect() : null;
            if (pointerInGripCorridor({ x: e.clientX, y: e.clientY }, grip, block)) {
              return false;
            }
          }
          popup?.hide();
          element.style.visibility = "hidden";
          currentNode = null;
          currentNodePos = -1;
          onNodeChange?.({ editor, node: null, pos: -1 });
          return false;
        },
        mousemove(view, event) {
          if (!element || locked) return false;
          // Ensure a LIVE popup. The old guard bailed only on `!popup`, which a
          // destroyed-but-non-null instance (left by a recreated EditorView)
          // passed — so `show()` below no-op'd and the grip surfaced at the
          // wrapper origin on the comment composer. `ensurePopup` recreates it.
          ensurePopup(view.dom);
          if (!popup) return false; // ensurePopup guarantees it; this only narrows the type
          const e = event as MouseEvent;
          const hit = findElementNextToCoords({ x: e.clientX, y: e.clientY, editor });
          if (hit.pos === null) return false;
          const scanTarget = blockTargetAtPos(view.state.doc, hit.pos);
          // The rightward scan resolves an ambiguous column (a toggle/callout/
          // blockquote chevron gutter, OR a list's marker column) to the
          // container / list's first item rather than the hovered child row, so
          // reaching left for the child's grip would snap it to the wrong block.
          // posAtCoords recovers the real row; refine only the ambiguous case (a
          // plain leaf scan is authoritative). `coords` is also the gutter-stick
          // signal below — null means the pointer is off every text line.
          let coordsTarget: DragTarget | null = null;
          let coords: { pos: number; inside: number } | null = null;
          if (scanTarget && isAmbiguousScanTarget(scanTarget.node.type.name)) {
            coords = view.posAtCoords({ left: e.clientX, top: e.clientY });
            // Gutter hover: `posAtCoords` is null left of the text column, so the
            // leftward scan above resolved the ENCLOSING toggle / parent row that
            // fills the gutter at this Y, not the hovered sub-bullet — anchoring
            // the grip at the page's far left, detached from the bullet. Probe
            // rightward to the row's own text so the grip tracks the sub-bullet at
            // its real depth. When this ALSO finds nothing (a true inter-block
            // gap), `coords` stays null and the gutter-stickiness below keeps the
            // current row. See `deepestRowCoordsRight`.
            if (!coords) coords = deepestRowCoordsRight(view, e.clientX, e.clientY);
            if (coords) coordsTarget = blockTargetAtPos(view.state.doc, coords.pos);
          }
          // Gutter stickiness — keep the current row while the pointer sits in
          // the FAR-LEFT gutter with NO row resolvable rightward (`coords` null:
          // both `posAtCoords` and the `deepestRowCoordsRight` probe came back
          // empty, so the Y is a true inter-block gap) and the cursor is within
          // the current block's vertical band. Reaching for a list row's grip
          // crosses the marker column into that gutter, where the rightward scan
          // re-resolves to the list CONTAINER (its top row / the page top) — so
          // without this the grip ran away upward as you reached for it (the
          // reported flicker / unreachable sub-bullet). The probe now resolves the
          // hovered row in the common case, so this only fires off any line — it
          // never sticks across rows, even though a parent list item's / toggle's
          // DOM band spans its children.
          if (
            scanTarget &&
            isAmbiguousScanTarget(scanTarget.node.type.name) &&
            !coords &&
            currentNodePos >= 0
          ) {
            const curDom = view.nodeDOM(currentNodePos);
            if (curDom instanceof HTMLElement && view.dom.contains(curDom)) {
              const r = curDom.getBoundingClientRect();
              if (r.height > 0 && e.clientY >= r.top && e.clientY <= r.bottom) return false;
            }
          }
          const target = refineContainerTarget(scanTarget, coordsTarget);
          if (!target || target.pos === currentNodePos) return false;
          // Resolve + LAYOUT-GATE the anchor BEFORE latching the target. A React
          // node-view (callout / toggle / data / image) mid-(re)mount — common on
          // the first hover right after an AI generation — is present in the DOM
          // but not yet laid out (a zero-size box). `gripReferenceRect` then
          // resolves to ~(0,0) and the `show()` + `forceUpdate()` below would STICK
          // the grip at the wrapper origin (top:0,left:0) — which, since the
          // `PageComments` composer sits at the top of `.doc-collab-editor`,
          // lands the grip ON that comment box (the reported "drag icon bugged at
          // the top-left of the comment box"). Unlike the geometry-only flash this
          // sticks, because nothing re-positions it afterward: the doc-change
          // `update` path (which already applies this same `hasLayoutBox` gate)
          // never runs without a following edit. Leaving the target UNLATCHED
          // (currentNodePos un-advanced) lets the next mousemove re-resolve once
          // the block has a box, instead of short-circuiting on a committed-but-
          // unshowable position.
          const dom = view.nodeDOM(target.pos);
          if (!(dom instanceof HTMLElement) || !hasLayoutBox(dom)) return false;
          currentNode = target.node;
          currentNodePos = target.pos;
          currentNodeRelPos = getRelativePos(view.state, currentNodePos);
          onNodeChange?.({ editor, node: currentNode, pos: currentNodePos });
          popup.setProps({
            getReferenceClientRect: () => gripReferenceRect(dom),
            offset: [gripVerticalOffset(dom), 8],
          });
          popup.show();
          // tippy.css is NOT imported, so the popup has no opacity-fade to
          // mask the frame between show() and popper's FIRST layout pass —
          // and that pass is ASYNC (popper schedules it off a microtask/raf).
          // The line below flips the grip to visible synchronously, so without
          // forcing the layout the grip paints at the wrapper origin (top:0,
          // left:0 → the page's top-left, by the title) for that frame and only
          // then snaps onto the block. That is the "drag handle appears at the
          // top of the page, not beside the hovered block" symptom — on EVERY
          // first hover, since the reference is only set per-block here. (Tuning
          // gripReferenceRect / gripVerticalOffset never fixed it because the
          // geometry was already right; the grip was just revealed pre-layout.)
          // forceUpdate runs popper's modifiers synchronously against the
          // reference we just set, so the grip is anchored to the block the
          // instant it becomes visible. popperInstance is set by the synchronous
          // mount inside show(); the `?.` is a no-op guard if a future tippy
          // ever defers mounting (popper's own async pass still lands then).
          popup.popperInstance?.forceUpdate();
          element.style.visibility = "visible";
          return false;
        },
      },
    },
  });
}

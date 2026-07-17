// @vitest-environment jsdom
/**
 * [COMP:app-web/block-drag-handle] Nested-aware drag-handle target resolver.
 *
 * `blockTargetAtPos` is a pure ProseMirror-position function (no DOM, no editor
 * mount), so it runs against a constructed doc over the shared `docSchema()`.
 * It decides which block the `⋮⋮` grip grabs: a block at any nesting depth keeps
 * its own handle, and a cursor on a container's summary line targets the whole
 * container (so you drag the toggle, not lift its title out). `gripReferenceRect`
 * is DOM-geometry (jsdom env) — it anchors the grip left of a list's marker.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { docSchema } from "@use-brian/doc-model";
import type { Node as PMNode } from "@tiptap/pm/model";
import { isNodeRangeSelection } from "@tiptap/extension-node-range";
import {
  blockTargetAtPos,
  blockDragSelection,
  refineContainerTarget,
  gripReferenceRect,
  gripVerticalOffset,
  resolveLineHeight,
  blockRangeAfterDrop,
  hasLayoutBox,
  pointerInGripCorridor,
  deepestRowCoordsRight,
  ROW_PROBE_STEP_PX,
  dropIndentsDeeper,
  listRowAround,
  NEST_DROP_INDENT_PX,
} from "../block-drag-handle";
import type { EditorView } from "@tiptap/pm/view";

const schema = docSchema();
const toggle = (...children: PMNode[]): PMNode =>
  schema.nodes.toggle.create({ open: true }, children);
const para = (text?: string): PMNode =>
  schema.nodes.paragraph.create(null, text ? schema.text(text) : undefined);
const li = (...children: PMNode[]): PMNode => schema.nodes.listItem.create(null, children);
const bulletList = (...items: PMNode[]): PMNode =>
  schema.nodes.bulletList.create(null, items);

/** Position inside the textblock that contains `needle`. */
function posInText(doc: PMNode, needle: string): number {
  let pos = -1;
  doc.descendants((node, p) => {
    if (pos < 0 && node.isText && node.text?.includes(needle)) pos = p;
    return pos < 0;
  });
  return pos;
}

describe("[COMP:app-web/block-drag-handle] blockTargetAtPos", () => {
  it("targets a top-level paragraph by itself", () => {
    const doc = schema.nodes.doc.create(null, [para("hello")]);
    const t = blockTargetAtPos(doc, posInText(doc, "hello"))!;
    expect(t.node.type.name).toBe("paragraph");
    expect(t.pos).toBe(0);
  });

  it("targets the whole toggle from a top-level toggle summary", () => {
    const doc = schema.nodes.doc.create(null, [toggle(para("title"))]);
    const t = blockTargetAtPos(doc, posInText(doc, "title"))!;
    expect(t.node.type.name).toBe("toggle");
    expect(t.pos).toBe(0);
  });

  it("targets the NESTED toggle (its own handle) — not the summary, not the parent", () => {
    const doc = schema.nodes.doc.create(null, [toggle(para("outer"), toggle(para("inner")))]);
    const t = blockTargetAtPos(doc, posInText(doc, "inner"))!;
    expect(t.node.type.name).toBe("toggle");
    expect(doc.nodeAt(t.pos)?.textContent).toBe("inner");
  });

  it("targets a nested body paragraph (a non-summary child) by itself", () => {
    const doc = schema.nodes.doc.create(null, [toggle(para("title"), para("body"))]);
    const t = blockTargetAtPos(doc, posInText(doc, "body"))!;
    expect(t.node.type.name).toBe("paragraph");
    expect(t.node.textContent).toBe("body");
  });

  it("targets the outer toggle from its own summary even when it holds a nested toggle", () => {
    const doc = schema.nodes.doc.create(null, [toggle(para("outer"), toggle(para("inner")))]);
    const t = blockTargetAtPos(doc, posInText(doc, "outer"))!;
    expect(t.node.type.name).toBe("toggle");
    expect(t.pos).toBe(0); // the outer toggle at the top level
  });

  it("clamps an out-of-range position instead of throwing", () => {
    const doc = schema.nodes.doc.create(null, [para("x")]);
    expect(() => blockTargetAtPos(doc, 9999)).not.toThrow();
    expect(() => blockTargetAtPos(doc, -5)).not.toThrow();
  });
});

describe("[COMP:app-web/block-drag-handle] blockTargetAtPos — lists", () => {
  // A hover inside a list resolves to the ROW (listItem), never the inner
  // paragraph (dragging a bare paragraph out of a list is broken) and never the
  // <ul>/<ol> container (which gave every sub-bullet one shared grip anchored to
  // the list top — the reported flicker / unreachable sub-bullet).
  it("targets the enclosing list item for a top-level bullet, not its paragraph", () => {
    const doc = schema.nodes.doc.create(null, [bulletList(li(para("alpha")), li(para("beta")))]);
    const t = blockTargetAtPos(doc, posInText(doc, "alpha"))!;
    expect(t.node.type.name).toBe("listItem");
    expect(t.node.firstChild?.textContent).toBe("alpha");
    expect(doc.nodeAt(t.pos)?.type.name).toBe("listItem");
  });

  it("targets the NESTED sub-bullet's own list item (its own grip at its depth)", () => {
    const doc = schema.nodes.doc.create(null, [
      bulletList(li(para("parent"), bulletList(li(para("child"))))),
    ]);
    const t = blockTargetAtPos(doc, posInText(doc, "child"))!;
    expect(t.node.type.name).toBe("listItem");
    expect(t.node.firstChild?.textContent).toBe("child");
  });

  it("targets the PARENT row (not the whole subtree's container) from the parent's own text", () => {
    const doc = schema.nodes.doc.create(null, [
      bulletList(li(para("parent"), bulletList(li(para("child"))))),
    ]);
    const t = blockTargetAtPos(doc, posInText(doc, "parent"))!;
    expect(t.node.type.name).toBe("listItem");
    // The parent row's first line is "parent" — the deepest enclosing listItem of
    // the "parent" text is the OUTER item (the inner one holds "child").
    expect(t.node.firstChild?.textContent).toBe("parent");
  });

  it("descends a list-CONTAINER boundary hit to a row, never the bare <ul>", () => {
    const doc = schema.nodes.doc.create(null, [bulletList(li(para("one")), li(para("two")))]);
    // The position just inside the bulletList (before its first item) is what the
    // rightward DOM scan lands on over the marker column; it must resolve to a row.
    let listPos = -1;
    doc.descendants((node, p) => {
      if (listPos < 0 && node.type.name === "bulletList") listPos = p;
      return listPos < 0;
    });
    const t = blockTargetAtPos(doc, listPos + 1)!;
    expect(t.node.type.name).toBe("listItem");
    expect(t.node.firstChild?.textContent).toBe("one");
  });
});

describe("[COMP:app-web/block-drag-handle] blockDragSelection", () => {
  // The drag range MUST stay at the grabbed block's own parent depth. The
  // reported bug — "drag one bullet, all three move" — was an undefined depth
  // collapsing a nested block's range to the doc level, so the NodeRange's
  // parent became the doc and the whole <ul> got selected.
  const rangeFor = (doc: PMNode, needle: string) => {
    const t = blockTargetAtPos(doc, posInText(doc, needle))!;
    return blockDragSelection(doc, t.pos, t.pos + t.node.nodeSize)!;
  };

  it("drags ONE bullet, not the whole list", () => {
    const doc = schema.nodes.doc.create(null, [
      bulletList(li(para("alpha")), li(para("beta")), li(para("gamma"))),
    ]);
    const sel = rangeFor(doc, "beta");
    expect(isNodeRangeSelection(sel)).toBe(true);
    expect(sel.ranges.length).toBe(1); // the single row, NOT the 3-item list
    expect(sel.$from.nodeAfter?.type.name).toBe("listItem");
    expect(sel.$from.nodeAfter?.firstChild?.textContent).toBe("beta");
  });

  it("drags a NESTED sub-bullet alone, not its parent row's subtree", () => {
    const doc = schema.nodes.doc.create(null, [
      bulletList(li(para("parent"), bulletList(li(para("child")), li(para("sibling"))))),
    ]);
    const sel = rangeFor(doc, "child");
    expect(sel.ranges.length).toBe(1);
    expect(sel.$from.nodeAfter?.firstChild?.textContent).toBe("child");
  });

  it("drags a nested body block out of a toggle, not the whole toggle", () => {
    const doc = schema.nodes.doc.create(null, [toggle(para("title"), para("body"))]);
    const sel = rangeFor(doc, "body");
    expect(sel.ranges.length).toBe(1);
    expect(sel.$from.nodeAfter?.textContent).toBe("body");
  });

  it("still drags a top-level block as itself (depth 0 unchanged)", () => {
    const doc = schema.nodes.doc.create(null, [para("one"), para("two")]);
    const sel = rangeFor(doc, "one");
    expect(sel.ranges.length).toBe(1);
    expect(sel.$from.nodeAfter?.textContent).toBe("one");
  });
});

describe("[COMP:app-web/block-drag-handle] refineContainerTarget", () => {
  // A toggle "title" holding a body child "body": the rightward DOM scan lands
  // on the toggle (container) when the cursor sits in its empty chevron gutter
  // beside the child's row; posAtCoords recovers the child there.
  const doc = schema.nodes.doc.create(null, [toggle(para("title"), para("body"))]);
  const container = blockTargetAtPos(doc, posInText(doc, "title"))!; // the toggle
  const child = blockTargetAtPos(doc, posInText(doc, "body"))!; // the "body" paragraph

  it("keeps a leaf-block scan authoritative (no override)", () => {
    // Hovering the child's text directly — the scan already resolved the child;
    // the coords value must not pull it back up to the container.
    expect(refineContainerTarget(child, container)).toBe(child);
  });

  it("prefers the posAtCoords child when the scan landed on a container", () => {
    expect(refineContainerTarget(container, child)).toBe(child);
  });

  it("falls back to the container when posAtCoords yields nothing", () => {
    expect(refineContainerTarget(container, null)).toBe(container);
  });

  it("passes a null scan straight through", () => {
    expect(refineContainerTarget(null, child)).toBe(null);
  });

  // Lists are ambiguous the same way containers are: the rightward scan lands on
  // the <ul>/<ol> (or its first item) over the marker column, so the posAtCoords
  // row must override it — without this the sub-bullet grip ran away to the list
  // top (the reported flicker). A listItem scan is itself ambiguous (the scan
  // can land on the wrong row), so it's overridden too.
  const listDoc = schema.nodes.doc.create(null, [
    bulletList(li(para("one")), li(para("two"))),
  ]);
  const listContainerScan = { node: listDoc.child(0), pos: 0 }; // the bulletList
  const rowTwo = blockTargetAtPos(listDoc, posInText(listDoc, "two"))!; // listItem "two"

  it("overrides a list-container scan with the posAtCoords row", () => {
    expect(refineContainerTarget(listContainerScan, rowTwo)).toBe(rowTwo);
  });

  it("overrides a list-item scan with the posAtCoords row (wrong-row scan)", () => {
    const rowOne = blockTargetAtPos(listDoc, posInText(listDoc, "one"))!;
    expect(refineContainerTarget(rowOne, rowTwo)).toBe(rowTwo);
  });

  it("keeps the list-container scan when posAtCoords yields nothing (far gutter)", () => {
    expect(refineContainerTarget(listContainerScan, null)).toBe(listContainerScan);
  });
});

describe("[COMP:app-web/block-drag-handle] gripReferenceRect", () => {
  // jsdom has no layout, so stub the geometry: a list item's text box is
  // indented past its parent list's left (where the bullet/number marker sits).
  const stubRect = (el: Element, left: number, right = left + 100) => {
    el.getBoundingClientRect = () =>
      ({
        left,
        x: left,
        top: 10,
        y: 10,
        right,
        bottom: 30,
        width: right - left,
        height: 20,
        toJSON: () => ({}),
      }) as DOMRect;
  };

  it("anchors a list-item block to its parent list's left (clears the marker)", () => {
    const ul = document.createElement("ul");
    const li = document.createElement("li");
    const p = document.createElement("p");
    li.appendChild(p);
    ul.appendChild(li);
    stubRect(ul, 40); // list border-left — left of the marker column
    stubRect(p, 64); // the text box, indented past the marker
    // Anchored to the list edge (40), NOT the indented text box (64), so the
    // grip lands left of the bullet/number instead of on top of it.
    expect(gripReferenceRect(p).left).toBe(40);
  });

  it("anchors a non-list block to its own box (top/height stay the block's)", () => {
    const p = document.createElement("p");
    stubRect(p, 64); // top:10, bottom:30, height:20
    const r = gripReferenceRect(p);
    expect(r.left).toBe(64);
    // Geometry only — the block's real box. Vertical centring is NOT baked in here
    // (it rides tippy's offset); the reference must stay cheap + the block's box,
    // or a stale/short rect parks the grip at the page top.
    expect(r.top).toBe(10);
    expect(r.height).toBe(20);
  });
});

describe("[COMP:app-web/block-drag-handle] deepestRowCoordsRight", () => {
  // The grip's anchor for a gutter hover. `posAtCoords` is null in the left
  // gutter; stepping rightward to the first text position recovers the row at the
  // cursor's Y, so a sub-bullet's grip tracks the bullet, not the toggle/parent
  // that fills the gutter at that Y. Stub the view: text begins at `textLeft`.
  const stubView = (textLeft: number, right: number): EditorView =>
    ({
      dom: { getBoundingClientRect: () => ({ right }) },
      posAtCoords: ({ left }: { left: number }) =>
        left >= textLeft ? { pos: 42, inside: 41 } : null,
    }) as unknown as EditorView;

  it("steps right from the gutter to the first text position (the hovered row)", () => {
    // Cursor at x=40 in the gutter; the sub-bullet's text starts at x=90.
    const at = deepestRowCoordsRight(stubView(90, 400), 40, 100);
    expect(at).toEqual({ pos: 42, inside: 41 });
  });

  it("returns null when no text lies rightward before the editor edge (inter-block gap)", () => {
    // Text would start at x=500 but the editor ends at x=120 — nothing to hit.
    expect(deepestRowCoordsRight(stubView(500, 120), 40, 100)).toBeNull();
  });

  it("returns the cursor's own row immediately when already over text", () => {
    // startX already past textLeft → first probe hits.
    expect(deepestRowCoordsRight(stubView(30, 400), 96, 100)).toEqual({
      pos: 42,
      inside: 41,
    });
  });

  it("probes in coarse ROW_PROBE_STEP_PX increments (cheap on the hover hot path)", () => {
    const seen: number[] = [];
    const view = {
      dom: { getBoundingClientRect: () => ({ right: 100 }) },
      posAtCoords: ({ left }: { left: number }) => {
        seen.push(left);
        return null;
      },
    } as unknown as EditorView;
    deepestRowCoordsRight(view, 40, 10);
    // 40, 46, 52, ... — never pixel-by-pixel.
    expect(seen.slice(0, 3)).toEqual([40, 40 + ROW_PROBE_STEP_PX, 40 + 2 * ROW_PROBE_STEP_PX]);
  });
});

describe("[COMP:app-web/block-drag-handle] pointerInGripCorridor", () => {
  // The grip lives in the left margin; the corridor keeps it shown while the
  // pointer travels from the block toward it. Grip box: x[40,60], y[20,44].
  const grip = { left: 40, right: 60, top: 20, bottom: 44 };

  it("keeps the grip while the pointer is between the grip and the block's left edge", () => {
    const block = { left: 80, top: 18, bottom: 46 };
    // Pointer in the gutter, mid-corridor, at the block's Y.
    expect(pointerInGripCorridor({ x: 52, y: 30 }, grip, block)).toBe(true);
  });

  it("keeps the grip for a reach from a LOWER wrapped line (block taller than the grip)", () => {
    // Multi-line block: y[18,120]. The old grip-only band (y≈14..50) would have
    // dropped a reach made from the block's last line — the reported disappear.
    const tall = { left: 80, top: 18, bottom: 120 };
    expect(pointerInGripCorridor({ x: 50, y: 110 }, grip, tall)).toBe(true);
  });

  it("drops the grip once the pointer is clearly above the block and grip", () => {
    const block = { left: 80, top: 18, bottom: 46 };
    expect(pointerInGripCorridor({ x: 50, y: 4 }, grip, block)).toBe(false);
  });

  it("drops the grip once the pointer is right of the block's text edge", () => {
    const block = { left: 80, top: 18, bottom: 46 };
    expect(pointerInGripCorridor({ x: 200, y: 30 }, grip, block)).toBe(false);
  });

  it("falls back to the grip's own box when the block DOM is missing", () => {
    // No block rect → corridor is the grip band plus the 8px tolerances.
    expect(pointerInGripCorridor({ x: 55, y: 30 }, grip, null)).toBe(true);
    expect(pointerInGripCorridor({ x: 90, y: 30 }, grip, null)).toBe(false);
  });
});

describe("[COMP:app-web/block-drag-handle] gripVerticalOffset", () => {
  const stubRect = (el: Element, top: number, height: number) => {
    el.getBoundingClientRect = () =>
      ({
        left: 0,
        x: 0,
        top,
        y: top,
        right: 100,
        bottom: top + height,
        width: 100,
        height,
        toJSON: () => ({}),
      }) as DOMRect;
  };

  it("drops the grip ~½ line below an H1's top so its 24px centre lands on the line", () => {
    // line-height 36, padding-top 3 → 3 + 18 − 12 = 9px down. (The reported bug:
    // grip sat at the block top, ~9px above the cap line.)
    const h1 = document.createElement("h1");
    h1.style.lineHeight = "36px";
    h1.style.paddingTop = "3px";
    h1.style.fontSize = "28px";
    expect(gripVerticalOffset(h1)).toBe(9);
  });

  it("nudges a body paragraph only ~3px (already near-centred)", () => {
    const p = document.createElement("p");
    p.style.lineHeight = "24px";
    p.style.paddingTop = "3px";
    p.style.fontSize = "16px";
    expect(gripVerticalOffset(p)).toBe(3);
  });

  it("clamps to 0 for a short line (grip never rides above the block top)", () => {
    const p = document.createElement("p");
    p.style.lineHeight = "16px"; // 0 + 8 − 12 = −4 → clamped 0
    p.style.paddingTop = "0px";
    p.style.fontSize = "13px";
    expect(gripVerticalOffset(p)).toBe(0);
  });

  it("centres on a divider's padded box, going negative for a thin rule", () => {
    const hr = document.createElement("hr");
    stubRect(hr, 100, 17); // 17px rule box → 17/2 − 12 = −3.5 → grip nudged UP onto the rule
    expect(gripVerticalOffset(hr)).toBe(-3.5);
    stubRect(hr, 100, 40); // 40px box → 40/2 − 12 = 8px DOWN → grip on the rule
    expect(gripVerticalOffset(hr)).toBe(8);
  });

  it("centres on the box for a SHORT embed (child-page row) — no text line to sit on", () => {
    // A `child_page` link embed is ~32px tall with its content vertically
    // centred; the first-line metric would pin the grip to the box top (the
    // reported "not vertically middle"). Box-centre it: 32/2 − 12 = 4px down.
    // Keyed on `node-embed` — Tiptap's OUTER wrapper class, which is what
    // `view.nodeDOM()` returns (NOT the inner `.doc-embed`).
    const embed = document.createElement("div");
    embed.className = "node-embed";
    stubRect(embed, 100, 32);
    expect(gripVerticalOffset(embed)).toBe(4);
  });

  it("does NOT box-centre the inner doc-embed class (not the node DOM)", () => {
    // Regression guard for the original bug: the grip kept matching nothing
    // because it checked `doc-embed` (the inner NodeViewWrapper), while
    // `view.nodeDOM()` returns the outer `node-embed`. A `doc-embed` element
    // must fall through to the text-line metric, not the box-centre branch.
    const inner = document.createElement("div");
    inner.className = "doc-embed my-2";
    inner.style.lineHeight = "24px";
    inner.style.fontSize = "16px";
    stubRect(inner, 100, 32);
    expect(gripVerticalOffset(inner)).toBe(0); // text-line metric, not 4
  });

  it("centres on a callout's first content line, below the inner box padding", () => {
    // The reported bug: the grip sat at the callout box TOP, ~12px above the
    // text. The node DOM is the OUTER `node-callout` wrapper (no padding); its
    // padded box + text line live on the inner `.doc-callout`. Read the metric
    // there: pad-top 12 + line 24/2 − grip 24/2 = 12px down (margins collapse, so
    // the inner box top equals the wrapper top → no extra delta).
    const outer = document.createElement("div");
    outer.className = "node-callout";
    const inner = document.createElement("div");
    inner.className = "doc-callout";
    inner.style.paddingTop = "12px";
    inner.style.lineHeight = "24px";
    inner.style.fontSize = "16px";
    outer.appendChild(inner);
    stubRect(outer, 100, 48);
    stubRect(inner, 100, 48); // collapsed margin → same top as the wrapper
    expect(gripVerticalOffset(outer)).toBe(12);
  });

  it("adds the inner box's top offset when the callout wrapper is NOT flush", () => {
    // Robustness guard: if a future border/padding on the wrapper stops the inner
    // margin collapsing, the inner box sits below the wrapper top — the offset
    // must include that delta so the grip still lands on the first line.
    const outer = document.createElement("div");
    outer.className = "node-callout";
    const inner = document.createElement("div");
    inner.className = "doc-callout";
    inner.style.paddingTop = "12px";
    inner.style.lineHeight = "24px";
    inner.style.fontSize = "16px";
    outer.appendChild(inner);
    stubRect(outer, 100, 60);
    stubRect(inner, 112, 48); // inner pushed 12px below the wrapper top
    // 12 (delta) + 12 (pad) + 24/2 − 24/2 = 24px down.
    expect(gripVerticalOffset(outer)).toBe(24);
  });

  it("keeps a TALL embed (data table) top-anchored via the text-line metric", () => {
    // Above EMBED_BOX_CENTER_MAX a centred grip would float in the widget's
    // middle, so it falls through to the first-line metric (here line-height
    // 24 / pad 0 → max(0, 12 − 12) = 0, i.e. near the top).
    const embed = document.createElement("div");
    embed.className = "node-embed";
    embed.style.lineHeight = "24px";
    embed.style.fontSize = "16px";
    stubRect(embed, 100, 320);
    expect(gripVerticalOffset(embed)).toBe(0);
  });
});

describe("[COMP:app-web/block-drag-handle] hasLayoutBox", () => {
  const stubRect = (el: Element, width: number, height: number) => {
    el.getBoundingClientRect = () =>
      ({
        left: 0,
        x: 0,
        top: 0,
        y: 0,
        right: width,
        bottom: height,
        width,
        height,
        toJSON: () => ({}),
      }) as DOMRect;
  };

  it("is true for a real laid-out block (non-zero box)", () => {
    const p = document.createElement("p");
    stubRect(p, 720, 24);
    expect(hasLayoutBox(p)).toBe(true);
  });

  it("is false for an un-laid-out anchor (zero box) — the origin-park trigger", () => {
    // A node mid React node-view swap / collab re-render reports a zero rect;
    // anchoring the grip to it resolves the reference to (0,0) and parks the
    // popup at the wrapper origin (on the comment composer). Treated as no anchor.
    const swapping = document.createElement("div");
    stubRect(swapping, 0, 0);
    expect(hasLayoutBox(swapping)).toBe(false);
  });

  it("is true for a thin divider rule (small but non-zero height)", () => {
    const hr = document.createElement("hr");
    stubRect(hr, 720, 1);
    expect(hasLayoutBox(hr)).toBe(true);
  });
});

describe("[COMP:app-web/block-drag-handle] resolveLineHeight", () => {
  it("returns a px line-height as-is", () => {
    expect(resolveLineHeight("36.4px", 28)).toBeCloseTo(36.4);
  });

  it("multiplies a bare unitless ratio by font-size (some engines return this)", () => {
    expect(resolveLineHeight("1.5", 16)).toBe(24);
  });

  it("falls back to 1.2× font-size for `normal` and an unstyled empty string", () => {
    expect(resolveLineHeight("normal", 20)).toBe(24);
    expect(resolveLineHeight("", 20)).toBe(24);
  });
});

describe("[COMP:app-web/block-drag-handle] blockRangeAfterDrop", () => {
  it("recasts a multi-block drop span into a NodeRangeSelection over those blocks", () => {
    const doc = schema.nodes.doc.create(null, [para("a"), para("b"), para("c")]);
    // What the native drop leaves: a TextSelection from inside "a" to inside "c".
    const sel = blockRangeAfterDrop(doc, posInText(doc, "a"), posInText(doc, "c") + 1)!;
    expect(sel).not.toBeNull();
    expect(isNodeRangeSelection(sel)).toBe(true);
    expect(sel.ranges.length).toBe(3); // one SelectionRange per moved block
  });

  it("recasts a single-block drop into a one-block NodeRangeSelection", () => {
    const doc = schema.nodes.doc.create(null, [para("solo")]);
    const from = posInText(doc, "solo");
    const sel = blockRangeAfterDrop(doc, from, from + "solo".length)!;
    expect(isNodeRangeSelection(sel)).toBe(true);
    expect(sel.ranges.length).toBe(1);
  });

  it("returns null for a collapsed or inverted span (nothing to re-select)", () => {
    const doc = schema.nodes.doc.create(null, [para("x")]);
    expect(blockRangeAfterDrop(doc, 1, 1)).toBeNull(); // collapsed cursor
    expect(blockRangeAfterDrop(doc, 2, 1)).toBeNull(); // inverted
  });
});

// The hover-reveal ORDER is a contract, not just geometry: tippy.css isn't
// imported (no opacity-fade) and popper positions ASYNC, so the grip must not be
// flipped visible until popper has run a layout pass against the just-set
// reference — otherwise it paints one frame at the wrapper origin (page top-left,
// by the title) before snapping onto the block. That regression ("drag icon at the
// top of the page, not beside the hovered block") is invisible to the pure-geometry
// tests above and un-drivable in jsdom (no layout; tippy is stubbed). Guard the
// source contract the way drag-handle.test.tsx guards its CSS contract — by reading
// the file and asserting `popup.show()` → `forceUpdate()` → reveal stay in order.
describe("[COMP:app-web/block-drag-handle] hover reveal forces sync layout", () => {
  const src = readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), "../block-drag-handle.ts"),
    "utf8",
  );

  it("forces a popper layout between show() and the visibility reveal", () => {
    // Ordered span: show() must precede forceUpdate(), which must precede the one
    // `visibility = "visible"` reveal. Each token appears once, so a single ordered
    // match proves the sequence (a future edit that drops forceUpdate or reveals
    // first breaks this).
    expect(src).toMatch(
      /popup\.show\(\);[\s\S]*popup\.popperInstance\?\.forceUpdate\(\);[\s\S]*element\.style\.visibility = "visible"/,
    );
  });

  it("guards the popper instance access so it can't throw if tippy defers the mount", () => {
    // `?.` not `.` — the reveal must survive a tippy that hasn't created the
    // popper synchronously (its own async pass lands then).
    expect(src).toContain("popup.popperInstance?.forceUpdate()");
  });

  // A fresh page's FIRST AI edit replaces + GC's the whole initial Yjs fragment,
  // so the hovered block's relative position resolves to `null`. The old
  // `getAbsolutePos(...) || 0` collapsed that onto doc-START (pos 0), parking the
  // grip at the wrapper origin over the comment composer and stranding
  // `currentNodePos` so re-hover never recovered. This pairs the geometry-blind
  // `apply()` closure (un-drivable in jsdom — no Yjs, no mounted editor) with a
  // source contract, the way the reveal order is guarded above.
  it("returns a -1 'lost' sentinel for an unresolvable Yjs anchor (no `|| 0` collapse)", () => {
    expect(src).toContain("return abs == null ? -1 : abs;");
    expect(src).not.toMatch(/\)\s*\|\| 0\s*\);/); // the old collapse-to-doc-start
  });

  it("drops the grip (not retarget to pos 0) when the remapped anchor is lost", () => {
    // The isChangeOrigin branch must HIDE + reset on `mapped < 0`, gated on the
    // pinned menu (`locked`), instead of stamping `currentNodePos = 0`.
    expect(src).toMatch(
      /if \(mapped < 0\) \{[\s\S]*if \(!locked\) \{[\s\S]*currentNodePos = -1;/,
    );
  });

  // The `mousemove` SHOW path is the ONLY path that flips the grip visible, so it
  // is where an un-laid-out anchor strands the grip at the wrapper origin (on the
  // PageComments composer) — the reported "drag icon bugged at the top-left of the
  // comment box" right after an AI generation, when a hovered node-view (callout /
  // toggle / data / image) is mid-(re)mount with a zero-size box. The doc-change
  // `update` path already gates on `hasLayoutBox`; this asserts the show path does
  // too — and does it BEFORE latching `currentNodePos`, so an un-laid-out node is
  // never committed (which would short-circuit re-hover once it lays out). Like the
  // reveal-order guard above, this is a source contract: the bad-geometry stick is
  // un-drivable in jsdom (no layout; tippy stubbed).
  it("layout-gates the mousemove show against an un-laid-out anchor", () => {
    // Ordered span: resolve the dom from `target.pos` → `hasLayoutBox` early-return
    // → only THEN latch `currentNodePos` → `popup.show()`. A future edit that latches
    // before the gate, or drops the gate, breaks this.
    expect(src).toMatch(
      /const dom = view\.nodeDOM\(target\.pos\);[\s\S]*!hasLayoutBox\(dom\)\) return false;[\s\S]*currentNodePos = target\.pos;[\s\S]*popup\.show\(\)/,
    );
  });

  it("does not commit currentNodePos before the layout gate (no early latch)", () => {
    // Guard the ordering directly: the only `currentNodePos = target.pos` assignment
    // must come AFTER the `hasLayoutBox(dom)) return false` gate, never before it.
    const gateIdx = src.indexOf("!hasLayoutBox(dom)) return false;");
    const latchIdx = src.indexOf("currentNodePos = target.pos;");
    expect(gateIdx).toBeGreaterThan(-1);
    expect(latchIdx).toBeGreaterThan(gateIdx);
  });

  // The dominant cause of "drag icon bugged at the top-left of the comment box"
  // (observed live: tippyRootCount 0, the grip parented straight in the wrapper at
  // top:0, and the console warning "setProps()/show() called on a destroyed
  // instance") is a DESTROYED-but-non-null popup. A recreated EditorView re-runs
  // this plugin's `view()`/`destroy()` against the SAME plugin closure, so the
  // old view's `destroy()` destroyed `popup` without nulling it; the `!popup`
  // creation check then read "already have one" and never rebuilt it, so
  // `setProps()`/`show()` no-op'd and the grip — never relocated into a tippy box —
  // surfaced at the wrapper origin on the PageComments composer. This requires a
  // real EditorView teardown + tippy lifecycle (un-drivable in jsdom — tippy is
  // stubbed, no layout), so it is guarded as a source contract like the reveal
  // order above.
  it("recreates the popup when a prior instance was destroyed (keys off isDestroyed, not !popup)", () => {
    expect(src).toContain("if (!popup || popup.state.isDestroyed) {");
    // The bare `!popup` creation check that let a destroyed instance slip through
    // must be gone.
    expect(src).not.toMatch(/if \(!popup\) \{\s*popup = tippy/);
  });

  it("nulls popup on view destroy so a recreated view rebuilds it", () => {
    // `popup = null` immediately before `removeNode(wrapper)` is unique to the
    // plugin-view `destroy()` — a destroy that only `popup?.destroy()`s (no null)
    // re-introduces the destroyed-but-non-null bug on the next view().
    expect(src).toMatch(/popup = null;\s*removeNode\(wrapper\);/);
  });

  it("mousemove ensures a live popup instead of bailing on a destroyed one", () => {
    // The guard must drop the old `!popup` short-circuit (which a destroyed
    // instance passed) and `ensurePopup` before reaching `show()`.
    expect(src).toMatch(
      /mousemove\(view, event\) \{\s*if \(!element \|\| locked\) return false;[\s\S]*ensurePopup\(view\.dom\)/,
    );
    expect(src).not.toContain("if (!element || !popup || locked) return false;");
  });
});

describe("[COMP:app-web/block-drag-handle] drop-to-nest decision", () => {
  it("dropIndentsDeeper: nests only when the drop X clears the row's text-start + threshold", () => {
    const contentLeft = 200;
    // straight down (same indent) → sibling, not nest
    expect(dropIndentsDeeper(contentLeft, contentLeft)).toBe(false);
    expect(dropIndentsDeeper(contentLeft + NEST_DROP_INDENT_PX - 1, contentLeft)).toBe(false);
    // dragged clearly rightward → nest
    expect(dropIndentsDeeper(contentLeft + NEST_DROP_INDENT_PX, contentLeft)).toBe(true);
    expect(dropIndentsDeeper(contentLeft + 60, contentLeft)).toBe(true);
    // dropping LEFT of the row (outdent intent) never nests
    expect(dropIndentsDeeper(contentLeft - 40, contentLeft)).toBe(false);
  });

  it("listRowAround: resolves the listItem at or around a position", () => {
    const d = schema.nodes.doc.create(null, [
      bulletList(li(para("alpha")), li(para("beta"))),
    ]);
    const pos = posInText(d, "beta");
    const row = listRowAround(d, pos);
    expect(row).not.toBeNull();
    expect(row!.node.type.name).toBe("listItem");
    // The before-position resolves back to that same listItem.
    expect(d.nodeAt(row!.pos)?.type.name).toBe("listItem");
  });

  it("listRowAround: returns null outside any list", () => {
    const d = schema.nodes.doc.create(null, [para("just a paragraph")]);
    expect(listRowAround(d, posInText(d, "just"))).toBeNull();
  });
});

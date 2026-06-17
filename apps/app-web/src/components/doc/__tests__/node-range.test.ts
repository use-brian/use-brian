/**
 * [COMP:app-web/doc-schema] Multi-block area selection (NodeRange).
 *
 * `browserDocExtensions()` wires `@tiptap/extension-node-range` so a plain
 * drag across block boundaries (Notion-style, `key: null`) selects whole blocks
 * as a `NodeRangeSelection`. These node-only checks pin the wiring, that the
 * shared doc schema actually supports a range spanning sibling blocks, and
 * the highlight's CSS contract — the live gesture (drag-select + drag-move) is
 * an e2e concern, verified in-app.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { docSchema } from "@sidanclaw/doc-model";
import { NodeRangeSelection } from "@tiptap/extension-node-range";
import { browserDocExtensions } from "../doc-schema";
import { crossesBlocks, dragRect, isAreaSelectDrag } from "../block-area-select";

describe("[COMP:app-web/doc-schema] NodeRange (area select)", () => {
  it("wires NodeRange (key: Mod — keyboard/decorations/class) + BlockAreaSelect (the gesture)", () => {
    const exts = browserDocExtensions();
    const nodeRange = exts.find((e) => e.name === "nodeRange");
    expect(nodeRange).toBeTruthy();
    // key: 'Mod' so NodeRange's own plain-drag mousedown doesn't double-drive
    // the gesture — BlockAreaSelect owns plain drag.
    expect(nodeRange!.options.key).toBe("Mod");
    expect(exts.find((e) => e.name === "blockAreaSelect")).toBeTruthy();
  });

  it("crossesBlocks: in-block drag is text-select, cross-block is area-select", () => {
    const schema = docSchema();
    const p = (t: string) => schema.nodes.paragraph.create(null, schema.text(t));
    const doc = schema.nodes.doc.create(null, [p("alpha"), p("beta")]);
    // both ends inside block 1 ("alpha", pos 1..5) → not a cross-block drag
    expect(crossesBlocks(doc, 1, 4)).toBe(false);
    // anchor in block 1, head in block 2 → cross-block area select
    expect(crossesBlocks(doc, 2, doc.content.size - 1)).toBe(true);
    // out-of-range positions clamp instead of throwing
    expect(() => crossesBlocks(doc, -10, 9999)).not.toThrow();
  });

  it("selects a range spanning multiple top-level blocks over the doc schema", () => {
    const schema = docSchema();
    const p = (t: string) => schema.nodes.paragraph.create(null, schema.text(t));
    const doc = schema.nodes.doc.create(null, [p("one"), p("two"), p("three")]);
    // anchor inside block 1, head inside block 3 → a range covering all three.
    const sel = NodeRangeSelection.create(doc, 1, doc.content.size - 1);
    expect(sel.ranges.length).toBe(3); // one SelectionRange per covered block
  });

  it("CSS strips the single-node ring from a node-view block in a range select", () => {
    // A toggle/callout/embed inside an area selection is tagged BOTH
    // `.selectednoderange` (band) and `.selectednode` (the node-view machinery's
    // single-node ring) — plain text blocks aren't node-views, so they only get
    // the band. The ring made a selected toggle look different from other blocks
    // AND boxed a nested toggle. CSS kills the ring on/inside a range select.
    const css = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), "../../../app/globals.css"),
      "utf8",
    );
    // the container itself (both classes on one element) → ring's box-shadow gone
    expect(css).toMatch(
      /\.ProseMirror-selectednoderange\.ProseMirror-selectednode\s*\{[\s\S]{0,120}box-shadow:\s*none/,
    );
    // a node-view nested INSIDE the range → ring gone + no band of its own
    expect(css).toMatch(
      /\.ProseMirror-selectednoderange\s+\.ProseMirror-selectednode\s*\{[\s\S]{0,160}box-shadow:\s*none/,
    );
  });

  it("CSS gives the selected range a translucent --primary band", () => {
    const css = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), "../../../app/globals.css"),
      "utf8",
    );
    expect(css).toMatch(
      /\.ProseMirror-selectednoderange\s*\{[\s\S]{0,160}background-color:[^;]*var\(--primary\)/,
    );
  });

  it("isAreaSelectDrag: empty space rubber-bands; in-block text stays native", () => {
    // Empty space (no block on the press row) — the blank-doc / tail-padding
    // drag the user reported: always an area select, regardless of the rest.
    expect(
      isAreaSelectDrag({
        startOnBlockRow: false,
        startInEditor: true,
        startPos: 99,
        crossedBlocks: false,
      }),
    ).toBe(true);
    // Margin beside a block (press not in the editor) → area select.
    expect(
      isAreaSelectDrag({
        startOnBlockRow: true,
        startInEditor: false,
        startPos: null,
        crossedBlocks: false,
      }),
    ).toBe(true);
    // On a block's own text, still inside that block → leave it to the browser.
    expect(
      isAreaSelectDrag({
        startOnBlockRow: true,
        startInEditor: true,
        startPos: 3,
        crossedBlocks: false,
      }),
    ).toBe(false);
    // On text but the drag has crossed into another block → area select.
    expect(
      isAreaSelectDrag({
        startOnBlockRow: true,
        startInEditor: true,
        startPos: 3,
        crossedBlocks: true,
      }),
    ).toBe(true);
  });

  it("dragRect: normalises any corner order into a positive-extent box", () => {
    // down-right drag
    expect(dragRect(10, 20, 40, 60)).toEqual({ left: 10, top: 20, width: 30, height: 40 });
    // up-left drag — same box, corners swapped
    expect(dragRect(40, 60, 10, 20)).toEqual({ left: 10, top: 20, width: 30, height: 40 });
    // mixed axes (down-left)
    expect(dragRect(40, 20, 10, 60)).toEqual({ left: 10, top: 20, width: 30, height: 40 });
    // zero-extent (no drag yet) never goes negative
    expect(dragRect(15, 15, 15, 15)).toEqual({ left: 15, top: 15, width: 0, height: 0 });
  });

  it("CSS: the live marquee is a fixed, non-interactive on-brand --primary box", () => {
    const css = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), "../../../app/globals.css"),
      "utf8",
    );
    const rule = css.match(/\.doc-area-select-rect\s*\{[\s\S]{0,400}?\}/)?.[0] ?? "";
    expect(rule).toMatch(/position:\s*fixed/);
    // must never eat the drag it's drawing
    expect(rule).toMatch(/pointer-events:\s*none/);
    // on-brand blue: a borderless translucent --primary fill (no outline — the
    // sweep reads as a soft band matching the NodeRange block tint). Keyed off
    // --primary so it resolves in both themes.
    expect(rule).not.toMatch(/border:\s*\d+px\s+solid/);
    expect(rule).toMatch(/background-color:[^;]*var\(--primary\)/);
  });
});

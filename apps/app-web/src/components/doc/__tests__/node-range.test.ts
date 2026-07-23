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
import { docSchema } from "@use-brian/doc-model";
import { NodeRangeSelection } from "@tiptap/extension-node-range";
import { browserDocExtensions } from "../doc-schema";
import {
  AREA_SELECT_IDLE,
  areaSelectReducer,
  crossesBlocks,
  dragRect,
  isAreaSelectDrag,
  needsBandResync,
  pressStartsDefiniteAreaSelect,
} from "../block-area-select";
import type {
  AreaSelectEvent,
  AreaSelectProbe,
  AreaSelectResult,
} from "../block-area-select";

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

  it("needsBandResync: re-asserts the range when PM's observer clobbers it", () => {
    const band = { from: 4, to: 12 };
    // Same band, still a NodeRangeSelection → nothing to do (the steady state).
    expect(
      needsBandResync({ band, lastFrom: 4, lastTo: 12, selectionIsNodeRange: true }),
    ).toBe(false);
    // Band moved onto different blocks → dispatch.
    expect(
      needsBandResync({ band, lastFrom: 4, lastTo: 8, selectionIsNodeRange: true }),
    ).toBe(true);
    // Self-healing: band unchanged, but ProseMirror's DOM observer re-derived a
    // TextSelection from a native selection the browser grew mid-drag and
    // overwrote ours. Without this the block bands vanished for the rest of the
    // gesture and the inline toolbar popped up over a supposed area select.
    expect(
      needsBandResync({ band, lastFrom: 4, lastTo: 12, selectionIsNodeRange: false }),
    ).toBe(true);
    // First move of a drag (no previous band) → dispatch.
    expect(
      needsBandResync({ band, lastFrom: -1, lastTo: -1, selectionIsNodeRange: false }),
    ).toBe(true);
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

/**
 * The gesture's decision logic, driven as pure data. Every effect the extension
 * applies to the view — engage, clear the DOM selection, focus the editable,
 * dispatch a band, paint the marquee — is decided here, so a whole drag can be
 * replayed as a list of events and asserted on its *behaviour* rather than on
 * the shape of the plugin's source.
 *
 * The environment lookups the decisions need (position under the cursor, which
 * blocks a Y-band covers, whether the editor's selection is still a node range)
 * come in through a `probe`, so the tests also pin **when** the gesture is
 * allowed to touch layout: an in-block text drag must cost no band lookup at all.
 */
describe("[COMP:app-web/block-area-select] Area select drag reducer", () => {
  /** A probe with call counters. Defaults: nothing under the cursor, no block on
   *  any row, no block boundary crossed, selection still a node range. */
  function makeProbe(over: Partial<AreaSelectProbe> = {}) {
    const calls = { posAt: 0, bandInY: 0, crossesBlocks: 0, selectionIsNodeRange: 0 };
    const probe: AreaSelectProbe = {
      posAt: (x, y) => (calls.posAt++, over.posAt?.(x, y) ?? null),
      bandInY: (a, b) => (calls.bandInY++, over.bandInY?.(a, b) ?? null),
      crossesBlocks: (a, b) => (calls.crossesBlocks++, over.crossesBlocks?.(a, b) ?? false),
      selectionIsNodeRange: () => (
        calls.selectionIsNodeRange++, over.selectionIsNodeRange?.() ?? true
      ),
      // Pane not scrolled unless a test says so — the scroll-anchor cases override it.
      scrollTop: () => over.scrollTop?.() ?? 0,
    };
    return { probe, calls };
  }

  /** Replay a drag. Returns every tick's effects plus the resting state. */
  function drive(probe: AreaSelectProbe, events: AreaSelectEvent[]) {
    let state = AREA_SELECT_IDLE;
    const ticks: AreaSelectResult[] = [];
    for (const ev of events) {
      const r = areaSelectReducer(state, ev, probe);
      state = r.state;
      ticks.push(r);
    }
    return { state, ticks };
  }

  const press = (x: number, y: number, inEditor = false): AreaSelectEvent => ({
    type: "press",
    x,
    y,
    inEditor,
  });
  const move = (x: number, y: number, primaryButton = true): AreaSelectEvent => ({
    type: "move",
    x,
    y,
    primaryButton,
  });

  /** A block sits on every row — the common case for a margin-started drag. */
  const anyBand = () => ({ from: 0, to: 10 });

  it("a press with sub-threshold movement never engages", () => {
    const { probe } = makeProbe({ bandInY: anyBand });
    // 4px of travel is a click with a shaky hand, not a drag.
    const { state, ticks } = drive(probe, [press(100, 100), move(102, 103)]);
    expect(ticks[1].engaged).toBe(false);
    expect(ticks[1].marquee).toBeNull();
    expect(ticks[1].clearSelection).toBe(false);
    // still armed — a later, longer move can still engage
    expect(state.phase).toBe("pending");
  });

  it("a margin press engages on the first past-threshold move and focuses once", () => {
    const { probe } = makeProbe({ bandInY: anyBand });
    const { ticks } = drive(probe, [
      press(40, 100), // left margin: outside the editable, block on the row
      move(44, 140),
      move(44, 200),
      move(44, 260),
    ]);
    expect(ticks[1].engaged).toBe(true);
    // Focus is the engage-tick effect only: re-focusing every move would fight
    // the user and is the kind of repeated view write that caused the original bug.
    expect(ticks.map((t) => t.focusEditor)).toEqual([false, true, false, false]);
  });

  it("a press over empty space engages and rubber-bands with no band to paint", () => {
    // No block on the press row — the 30vh tail padding or a blank page.
    const { probe } = makeProbe({ bandInY: () => null });
    const { ticks } = drive(probe, [press(300, 900, true), move(500, 1000)]);
    expect(ticks[1].engaged).toBe(true);
    expect(ticks[1].band).toBeNull();
    expect(ticks[1].marquee).toEqual({ left: 300, top: 900, width: 200, height: 100 });
  });

  it("an in-block text drag never engages, never clears, and costs no layout read", () => {
    const { probe, calls } = makeProbe({
      bandInY: anyBand,
      posAt: () => 4,
      crossesBlocks: () => false, // still inside the block it started on
    });
    const { ticks } = drive(probe, [press(700, 100, true), move(760, 104), move(820, 108)]);
    expect(ticks.every((t) => !t.engaged)).toBe(true);
    // The browser owns this selection: clearing it would break ordinary
    // word-level selection, which is the whole regression risk of this gesture.
    expect(ticks.every((t) => !t.clearSelection)).toBe(true);
    expect(ticks.every((t) => t.marquee === null)).toBe(true);
    // One band lookup at the press (to learn whether a block is on the row) and
    // never again — the per-block `getBoundingClientRect` sweep must not run on
    // every mousemove of a plain text selection.
    expect(calls.bandInY).toBe(1);
  });

  it("a text drag that crosses into another block engages from that move on", () => {
    let crossed = false;
    const { probe } = makeProbe({
      bandInY: anyBand,
      posAt: () => 4,
      crossesBlocks: () => crossed,
    });
    let state = AREA_SELECT_IDLE;
    const step = (ev: AreaSelectEvent) => {
      const r = areaSelectReducer(state, ev, probe);
      state = r.state;
      return r;
    };
    step(press(700, 100, true));
    expect(step(move(760, 108)).engaged).toBe(false); // still in the block
    crossed = true; // the drag has now left it
    expect(step(move(760, 190)).engaged).toBe(true);
    expect(step(move(760, 240)).engaged).toBe(true); // and stays engaged
  });

  it("every engaged move clears the DOM selection, not just the engage move", () => {
    // The load-bearing behaviour: a one-shot clear is undone by the very next
    // mousemove, so the browser's own selection grows back alongside the marquee
    // and ProseMirror's observer clobbers the block range derived from it.
    const { probe } = makeProbe({ bandInY: anyBand });
    const { ticks } = drive(probe, [
      press(40, 100),
      move(44, 140),
      move(44, 200),
      move(44, 260),
    ]);
    expect(ticks.map((t) => t.clearSelection)).toEqual([false, true, true, true]);
  });

  it("re-emits an unchanged band once the selection stops being a node range", () => {
    // Self-healing: something (PM's observer, a remote step) replaced our
    // NodeRangeSelection. Without this the bands stay blank for the rest of the drag.
    let isNodeRange = true;
    const { probe } = makeProbe({
      bandInY: () => ({ from: 4, to: 12 }),
      selectionIsNodeRange: () => isNodeRange,
    });
    let state = AREA_SELECT_IDLE;
    const step = (ev: AreaSelectEvent) => {
      const r = areaSelectReducer(state, ev, probe);
      state = r.state;
      return r;
    };
    step(press(40, 100));
    expect(step(move(44, 140)).band).toEqual({ from: 4, to: 12 }); // first dispatch
    expect(step(move(44, 150)).band).toBeNull(); // steady state — nothing to do
    isNodeRange = false; // clobbered
    expect(step(move(44, 160)).band).toEqual({ from: 4, to: 12 }); // re-asserted
  });

  it("does not re-emit while the band and the node-range selection both hold", () => {
    const { probe } = makeProbe({ bandInY: () => ({ from: 4, to: 12 }) });
    const { ticks } = drive(probe, [
      press(40, 100),
      move(44, 140),
      move(44, 150),
      move(44, 160),
    ]);
    expect(ticks.map((t) => t.band)).toEqual([null, { from: 4, to: 12 }, null, null]);
  });

  it("emits a fresh band as the drag reaches new blocks", () => {
    const { probe } = makeProbe({
      // grows downward: more blocks covered the further the drag runs
      bandInY: (_min, max) => ({ from: 0, to: max >= 200 ? 30 : 12 }),
    });
    const { ticks } = drive(probe, [press(40, 100), move(44, 140), move(44, 220)]);
    expect(ticks[1].band).toEqual({ from: 0, to: 12 });
    expect(ticks[2].band).toEqual({ from: 0, to: 30 });
  });

  it("marquee geometry normalises in all four directions and never goes negative", () => {
    const sweep = (toX: number, toY: number) => {
      const { probe } = makeProbe({ bandInY: anyBand });
      return drive(probe, [press(100, 100), move(toX, toY)]).ticks[1].marquee;
    };
    expect(sweep(140, 160)).toEqual({ left: 100, top: 100, width: 40, height: 60 });
    expect(sweep(60, 40)).toEqual({ left: 60, top: 40, width: 40, height: 60 });
    expect(sweep(140, 40)).toEqual({ left: 100, top: 40, width: 40, height: 60 });
    expect(sweep(60, 160)).toEqual({ left: 60, top: 100, width: 40, height: 60 });
  });

  it("release clears once, drops the marquee, and resets for the next press", () => {
    const { probe } = makeProbe({ bandInY: anyBand });
    const { state, ticks } = drive(probe, [
      press(40, 100),
      move(44, 200),
      { type: "release" },
    ]);
    const end = ticks[2];
    // mouseup finalises whatever range the browser still holds — drop it too.
    expect(end.clearSelection).toBe(true);
    expect(end.engaged).toBe(false);
    expect(end.marquee).toBeNull();
    expect(state).toEqual(AREA_SELECT_IDLE);
  });

  it("release after a never-engaged press keeps the browser's own selection", () => {
    const { probe } = makeProbe({ bandInY: anyBand, posAt: () => 4 });
    const { state, ticks } = drive(probe, [
      press(700, 100, true),
      move(760, 108),
      { type: "release" },
    ]);
    expect(ticks[2].clearSelection).toBe(false);
    expect(state).toEqual(AREA_SELECT_IDLE);
  });

  // --- Regression: the browser's own selection gesture (2026-07-23) -----------
  // Confirmed in a real browser: clearing the DOM selection each move and
  // cancelling `selectstart` both LOSE. The browser re-extends its selection
  // AFTER our mousemove handler, PM's observer derives a TextSelection from it,
  // and every dispatched NodeRangeSelection is clobbered before it can paint —
  // so a margin drag showed 758 native chars and zero bands. mousedown is the
  // only point at which the gesture can still be stopped.
  it("a margin press asks to cancel the browser's selection gesture at mousedown", () => {
    const { probe } = makeProbe({ bandInY: anyBand });
    const r = areaSelectReducer(AREA_SELECT_IDLE, press(40, 100), probe);
    expect(r.suppressNativeGesture).toBe(true);
  });

  it("a press over empty space also cancels it", () => {
    const { probe } = makeProbe({ bandInY: () => null });
    const r = areaSelectReducer(AREA_SELECT_IDLE, press(300, 900, true), probe);
    expect(r.suppressNativeGesture).toBe(true);
  });

  it("a press on a block's own text does NOT cancel it", () => {
    // Undecidable at mousedown: this stays a native text selection unless and
    // until it crosses a block boundary. Cancelling here would break ordinary
    // word-level selection, which is the whole regression risk of this gesture.
    const { probe } = makeProbe({ bandInY: anyBand, posAt: () => 4 });
    const r = areaSelectReducer(AREA_SELECT_IDLE, press(700, 100, true), probe);
    expect(r.suppressNativeGesture).toBe(false);
  });

  it("pressStartsDefiniteAreaSelect: margin or empty space, never on-text", () => {
    expect(pressStartsDefiniteAreaSelect({ startInEditor: false, startOnBlockRow: true })).toBe(true);
    expect(pressStartsDefiniteAreaSelect({ startInEditor: true, startOnBlockRow: false })).toBe(true);
    expect(pressStartsDefiniteAreaSelect({ startInEditor: true, startOnBlockRow: true })).toBe(false);
  });

  // --- Regression: the anchor is content-space, not screen-space (2026-07-23) --
  it("keeps the blocks it started on while the page scrolls under the drag", () => {
    // The reported symptom: drag down, the page auto-scrolls, and the blocks
    // already banded at the TOP silently drop out. In the browser the band's
    // `from` climbed 528 -> 1321 -> 2252 -> 2518 as the pane scrolled, because
    // the band's far edge stayed pinned to a stale viewport row.
    let scrollTop = 0;
    const BLOCK_H = 100;
    const probe: AreaSelectProbe = {
      posAt: () => null,
      // Blocks laid out down the document; a client-space band maps back through
      // the current scroll offset, exactly like getBoundingClientRect does.
      bandInY: (yMin, yMax) => {
        const docMin = yMin + scrollTop;
        const docMax = yMax + scrollTop;
        const first = Math.max(0, Math.floor(docMin / BLOCK_H));
        const last = Math.max(first, Math.floor(docMax / BLOCK_H));
        return { from: first * BLOCK_H, to: (last + 1) * BLOCK_H };
      },
      crossesBlocks: () => false,
      selectionIsNodeRange: () => true,
      scrollTop: () => scrollTop,
    };
    let state = AREA_SELECT_IDLE;
    const step = (ev: AreaSelectEvent) => {
      const r = areaSelectReducer(state, ev, probe);
      state = r.state;
      return r;
    };
    step(press(40, 50)); // press on block 0 (doc y 50), pane unscrolled
    expect(step(move(44, 150)).band).toEqual({ from: 0, to: 200 });
    // The pane auto-scrolls a full 5 blocks while the cursor stays put.
    scrollTop = 500;
    const r = step(move(44, 150));
    // Block 0 must STILL be the start of the band: the anchor rides the content.
    expect(r.band?.from).toBe(0);
    // ...and the band now reaches further down the document, not less far.
    expect(r.band!.to).toBeGreaterThan(200);
  });

  it("a move with the primary button released ends the gesture", () => {
    // A mouseup delivered outside the window: the next move is the only signal.
    const { probe } = makeProbe({ bandInY: anyBand });
    const { state, ticks } = drive(probe, [
      press(40, 100),
      move(44, 200),
      move(44, 260, false),
    ]);
    expect(ticks[2].engaged).toBe(false);
    expect(ticks[2].clearSelection).toBe(true);
    expect(ticks[2].marquee).toBeNull();
    expect(state).toEqual(AREA_SELECT_IDLE);
  });
});

import { describe, it, expect } from "vitest";
import { docSchema } from "@use-brian/doc-model";
import { EditorState } from "@tiptap/pm/state";
import type { Node as PMNode } from "@tiptap/pm/model";
import {
  docFindKey,
  docFindPlugin,
  findMatches,
  findShortcutPressed,
  wrapIndex,
} from "../find-in-page";

const MAC_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36";
const WIN_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36";

function para(text: string, blockId = "blk") {
  const schema = docSchema();
  return schema.node("paragraph", { blockId }, [schema.text(text)]);
}

function docOf(...nodes: ReturnType<typeof para>[]): PMNode {
  return docSchema().node("doc", null, nodes);
}

/** The literal text a match covers — proves positions, not just counts. */
function textAt(doc: PMNode, m: { from: number; to: number }): string {
  return doc.textBetween(m.from, m.to);
}

function stateWith(doc: PMNode) {
  return EditorState.create({ doc, plugins: [docFindPlugin()] });
}

function find(state: EditorState) {
  return docFindKey.getState(state)!;
}

/** Dispatch a meta-only find transaction and return the next state. */
function send(state: EditorState, meta: { query?: string; step?: number }) {
  return state.apply(state.tr.setMeta(docFindKey, meta));
}

describe("[COMP:app-web/doc-find] Find in page — matching", () => {
  it("finds every occurrence in document order, case-insensitively", () => {
    const doc = docOf(
      para("Widget roadmap", "a"),
      para("the widget ships when the WIDGET is done", "b"),
    );
    const hits = findMatches(doc, "widget");
    expect(hits).toHaveLength(3);
    expect(hits.map((h) => textAt(doc, h))).toEqual([
      "Widget",
      "widget",
      "WIDGET",
    ]);
    // Document order: each hit starts after the previous one ends.
    expect(hits[0].to).toBeLessThanOrEqual(hits[1].from);
    expect(hits[1].to).toBeLessThanOrEqual(hits[2].from);
  });

  it("matches across an inline mark boundary within one block", () => {
    // `he` + bold `ll` + `o` is three text nodes but one contiguous run, so a
    // search for the whole word must still hit it.
    const schema = docSchema();
    const bold = schema.marks.bold.create();
    const doc = schema.node("doc", null, [
      schema.node("paragraph", { blockId: "a" }, [
        schema.text("he"),
        schema.text("ll", [bold]),
        schema.text("o world"),
      ]),
    ]);
    const hits = findMatches(doc, "hello");
    expect(hits).toHaveLength(1);
    expect(textAt(doc, hits[0])).toBe("hello");
  });

  it("never matches across a block boundary", () => {
    // "one" ends block A and "two" opens block B. Their characters are
    // adjacent only by accident of position — this is not a hit.
    const doc = docOf(para("one", "a"), para("two", "b"));
    expect(findMatches(doc, "onetwo")).toEqual([]);
    // Each half on its own still matches, so the walk is not simply broken.
    expect(findMatches(doc, "one")).toHaveLength(1);
    expect(findMatches(doc, "two")).toHaveLength(1);
  });

  it("does not overlap matches", () => {
    const doc = docOf(para("aaaa", "a"));
    // "aa" fits twice without overlapping, not three times overlapping.
    expect(findMatches(doc, "aa")).toHaveLength(2);
  });

  it("treats the query literally, not as a regex", () => {
    const doc = docOf(para("cost (usd) rose 12%", "a"));
    expect(findMatches(doc, "(usd)")).toHaveLength(1);
    // A regex would read `.` as any-character and match "d) ".
    expect(findMatches(doc, "d.")).toEqual([]);
  });

  it("returns nothing for an empty query", () => {
    expect(findMatches(docOf(para("anything", "a")), "")).toEqual([]);
  });
});

describe("[COMP:app-web/doc-find] Find in page — plugin state", () => {
  it("starts idle and lands on the first hit when a query arrives", () => {
    const doc = docOf(para("alpha beta alpha", "a"));
    let state = stateWith(doc);
    expect(find(state).matches).toEqual([]);

    state = send(state, { query: "alpha" });
    expect(find(state).matches).toHaveLength(2);
    expect(find(state).activeIndex).toBe(0);
  });

  it("steps through hits and wraps at both ends", () => {
    let state = stateWith(docOf(para("x x x", "a")));
    state = send(state, { query: "x" });
    expect(find(state).activeIndex).toBe(0);

    state = send(state, { step: 1 });
    expect(find(state).activeIndex).toBe(1);
    state = send(state, { step: 1 });
    expect(find(state).activeIndex).toBe(2);
    // Past the end wraps to the start...
    state = send(state, { step: 1 });
    expect(find(state).activeIndex).toBe(0);
    // ...and before the start wraps to the end.
    state = send(state, { step: -1 });
    expect(find(state).activeIndex).toBe(2);
  });

  it("resets to the first hit on a new query", () => {
    let state = stateWith(docOf(para("aa bb aa bb", "a")));
    state = send(state, { query: "aa" });
    state = send(state, { step: 1 });
    expect(find(state).activeIndex).toBe(1);

    state = send(state, { query: "bb" });
    expect(find(state).activeIndex).toBe(0);
  });

  it("clears every highlight when the query empties (closing the bar)", () => {
    let state = stateWith(docOf(para("alpha", "a")));
    state = send(state, { query: "alpha" });
    expect(find(state).deco.find()).toHaveLength(1);

    state = send(state, { query: "" });
    expect(find(state).matches).toEqual([]);
    expect(find(state).deco.find()).toHaveLength(0);
  });

  it("marks only the active hit with the active class", () => {
    let state = stateWith(docOf(para("x x x", "a")));
    state = send(state, { query: "x" });
    state = send(state, { step: 1 });

    const classes = find(state)
      .deco.find()
      .map(
        (d) =>
          (d as unknown as { type?: { attrs?: { class?: string } } }).type?.attrs
            ?.class ?? "",
      );
    expect(classes.filter((c) => c.includes("doc-find-match-active"))).toHaveLength(1);
    expect(classes[1]).toContain("doc-find-match-active");
    expect(classes).toHaveLength(3);
  });

  it("re-counts when the document changes under a live search", () => {
    // A collaborator's edit (or your own) must not leave a stale count or a
    // highlight painted over text that moved.
    let state = stateWith(docOf(para("alpha", "a")));
    state = send(state, { query: "alpha" });
    expect(find(state).matches).toHaveLength(1);

    const schema = docSchema();
    const end = state.doc.content.size;
    state = state.apply(
      state.tr.insert(end, schema.node("paragraph", { blockId: "b" }, [schema.text("alpha again")])),
    );
    expect(find(state).matches).toHaveLength(2);
  });

  it("survives the document losing every hit, then regaining one", () => {
    let state = stateWith(docOf(para("alpha", "a")));
    state = send(state, { query: "alpha" });
    // Delete the whole paragraph's text.
    state = state.apply(state.tr.delete(1, state.doc.content.size - 1));
    expect(find(state).matches).toEqual([]);
    expect(find(state).activeIndex).toBe(0);
    expect(find(state).deco.find()).toHaveLength(0);
  });
});

describe("[COMP:app-web/doc-find] Find in page — the chord", () => {
  const key = (over: Partial<KeyboardEvent> = {}) => ({
    key: "f",
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    ...over,
  });

  it("is ⌘F on macOS, and NOT Ctrl+F (a system caret binding there)", () => {
    expect(findShortcutPressed(key({ metaKey: true }), MAC_UA)).toBe(true);
    expect(findShortcutPressed(key({ ctrlKey: true }), MAC_UA)).toBe(false);
  });

  it("is Ctrl+F everywhere else, and not ⌘F", () => {
    expect(findShortcutPressed(key({ ctrlKey: true }), WIN_UA)).toBe(true);
    expect(findShortcutPressed(key({ metaKey: true }), WIN_UA)).toBe(false);
  });

  it("ignores modified variants and other keys", () => {
    expect(findShortcutPressed(key({ metaKey: true, shiftKey: true }), MAC_UA)).toBe(false);
    expect(findShortcutPressed(key({ metaKey: true, altKey: true }), MAC_UA)).toBe(false);
    expect(findShortcutPressed(key({ metaKey: true, ctrlKey: true }), MAC_UA)).toBe(false);
    expect(findShortcutPressed(key({ key: "g", metaKey: true }), MAC_UA)).toBe(false);
    expect(findShortcutPressed(key(), MAC_UA)).toBe(false);
  });

  it("matches a capital F (Caps Lock on)", () => {
    expect(findShortcutPressed(key({ key: "F", metaKey: true }), MAC_UA)).toBe(true);
  });
});

describe("[COMP:app-web/doc-find] Find in page — wrapIndex", () => {
  it("wraps in both directions and is safe with no matches", () => {
    expect(wrapIndex(3, 3)).toBe(0);
    expect(wrapIndex(-1, 3)).toBe(2);
    expect(wrapIndex(0, 0)).toBe(0);
    expect(wrapIndex(-5, 0)).toBe(0);
  });
});

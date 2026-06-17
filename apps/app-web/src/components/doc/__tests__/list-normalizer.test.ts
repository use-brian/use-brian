// @vitest-environment jsdom
/**
 * [COMP:app-web/list-normalizer] Adjacent same-kind list merge.
 *
 * `firstAdjacentListJoinPos` is pure (runs on a constructed doc); the merge
 * behaviour is exercised against a real mounted editor with the full
 * `browserDocExtensions()` so the `appendTransaction` actually installs and
 * fires. The guarantee: after any LOCAL doc edit, consecutive same-kind list
 * wrappers collapse into ONE list — so a list split into one-item sibling
 * `<ul>`s (the AI write path, or a `liftListItem`) heals back to a single list,
 * and native Tab/Shift-Tab/drag operate on one coherent list.
 */

import { describe, expect, it, afterEach } from "vitest";
import { Editor } from "@tiptap/core";
import { docSchema } from "@sidanclaw/doc-model";
import type { Node as PMNode } from "@tiptap/pm/model";
import { browserDocExtensions } from "../doc-schema";
import { firstAdjacentListJoinPos } from "../list-normalizer";

const schema = docSchema();
const li = (t: string): PMNode =>
  schema.nodes.listItem.create(null, schema.nodes.paragraph.create(null, schema.text(t)));
const bul = (...items: PMNode[]): PMNode => schema.nodes.bulletList.create(null, items);
const ord = (...items: PMNode[]): PMNode => schema.nodes.orderedList.create(null, items);
const par = (t: string): PMNode => schema.nodes.paragraph.create(null, schema.text(t));
const doc = (...blocks: PMNode[]): PMNode => schema.nodes.doc.create(null, blocks);

describe("[COMP:app-web/list-normalizer] firstAdjacentListJoinPos", () => {
  it("finds the boundary between two adjacent same-kind lists", () => {
    expect(firstAdjacentListJoinPos(doc(bul(li("a")), bul(li("b"))))).toBeGreaterThan(0);
  });
  it("returns -1 for a single multi-item list (nothing to merge)", () => {
    expect(firstAdjacentListJoinPos(doc(bul(li("a"), li("b"))))).toBe(-1);
  });
  it("returns -1 when a non-list block separates two lists", () => {
    expect(firstAdjacentListJoinPos(doc(bul(li("a")), par("x"), bul(li("b"))))).toBe(-1);
  });
  it("returns -1 for adjacent DIFFERENT-kind lists (no cross-kind merge)", () => {
    expect(firstAdjacentListJoinPos(doc(bul(li("a")), ord(li("b"))))).toBe(-1);
  });
});

let editor: Editor | null = null;
afterEach(() => {
  editor?.destroy();
  editor = null;
});
function mount(content: unknown[]): Editor {
  const el = document.createElement("div");
  document.body.appendChild(el);
  editor = new Editor({
    element: el,
    extensions: browserDocExtensions(),
    content: { type: "doc", content: content as never },
  });
  return editor;
}
const bulletJSON = (text: string) => ({
  type: "bulletList",
  content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text }] }] }],
});

describe("[COMP:app-web/list-normalizer] merge on local edit", () => {
  it("collapses three separate bullet wrappers into one list after an edit", () => {
    const ed = mount([bulletJSON("a"), bulletJSON("b"), bulletJSON("c")]);
    // Initial content load does NOT dispatch a transaction, so the separate
    // wrappers are intact until the first local edit.
    expect(ed.getJSON().content).toHaveLength(3);
    // Any local doc edit triggers the normalizer's appendTransaction, which
    // re-runs until no adjacent same-kind wrappers remain.
    ed.chain().focus("end").insertContent("!").run();
    const top = ed.getJSON().content!;
    expect(top).toHaveLength(1);
    expect(top[0].type).toBe("bulletList");
    expect(top[0].content).toHaveLength(3); // a, b, c! all in one list
  });

  it("does not merge across a paragraph or a different list kind", () => {
    const ed = mount([
      bulletJSON("a"),
      { type: "paragraph", content: [{ type: "text", text: "mid" }] },
      bulletJSON("b"),
    ]);
    ed.chain().focus("end").insertContent("!").run();
    const kinds = ed.getJSON().content!.map((n) => n.type);
    expect(kinds).toEqual(["bulletList", "paragraph", "bulletList"]);
  });
});

// @vitest-environment jsdom
/**
 * [COMP:app-web/block-indent] Tab / Shift-Tab / Backspace / Enter keymap
 * integration + the toggle caret guard.
 *
 * Mounts a real editor with `browserDocExtensions()` (so the `BlockIndent`
 * keymap and caret-guard plugin are actually installed) and drives keys
 * through the editor's own `handleKeyDown` — the exact path a keystroke
 * takes. Guards the original bugs: with no binding, Tab escaped to the
 * browser's focus traversal; with PM defaults, Backspace wrapped paragraphs
 * into lists/toggles and Enter split into a collapsed toggle's hidden body.
 * Finding IDs (B1/T1/E1/S1…) refer to
 * `docs/architecture/features/doc.md` §3.
 */

import { describe, expect, it, afterEach } from "vitest";
import { Editor } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";
import type { Node as PMNode } from "@tiptap/pm/model";
import { browserDocExtensions } from "../doc-schema";

let editor: Editor | null = null;
afterEach(() => {
  editor?.destroy();
  editor = null;
});

function posInText(doc: PMNode, needle: string): number {
  let pos = -1;
  doc.descendants((node, p) => {
    if (pos < 0 && node.isText && node.text?.includes(needle)) pos = p;
    return pos < 0;
  });
  return pos;
}

function mount(): Editor {
  return mountContent([
    { type: "toggle", attrs: { open: true }, content: [{ type: "paragraph", content: [{ type: "text", text: "first" }] }] },
    { type: "toggle", attrs: { open: true }, content: [{ type: "paragraph", content: [{ type: "text", text: "second" }] }] },
  ]);
}

function mountContent(content: unknown[]): Editor {
  const element = document.createElement("div");
  document.body.appendChild(element);
  editor = new Editor({
    element,
    extensions: browserDocExtensions(),
    content: { type: "doc", content: content as never },
  });
  return editor;
}

function posInFirstEmpty(doc: PMNode): number {
  let pos = -1;
  doc.descendants((node, p) => {
    if (pos < 0 && node.isTextblock && node.content.size === 0) pos = p + 1;
    return pos < 0;
  });
  return pos;
}

function press(ed: Editor, key: string, shift = false): boolean {
  return !!ed.view.someProp("handleKeyDown", (f) =>
    f(ed.view, new window.KeyboardEvent("keydown", { key, shiftKey: shift, bubbles: true, cancelable: true })),
  );
}

const p = (text: string) => ({ type: "paragraph", content: [{ type: "text", text }] });
const li = (text: string) => ({ type: "listItem", content: [p(text)] });
const task = (text: string) => ({ type: "taskItem", attrs: { checked: false }, content: [p(text)] });

describe("[COMP:app-web/block-indent] Tab keymap", () => {
  it("Tab indents the second toggle into the first (and is swallowed)", () => {
    const ed = mount();
    ed.commands.setTextSelection(posInText(ed.state.doc, "second"));
    const handled = press(ed, "Tab");
    expect(handled).toBe(true); // swallowed — never traverses focus
    const top = ed.getJSON().content!;
    expect(top).toHaveLength(1);
    expect(top[0].content).toHaveLength(2);
    expect(top[0].content![1].type).toBe("toggle");
  });

  it("Shift-Tab outdents it back to the top level", () => {
    const ed = mount();
    ed.commands.setTextSelection(posInText(ed.state.doc, "second"));
    press(ed, "Tab");
    ed.commands.setTextSelection(posInText(ed.state.doc, "second"));
    const handled = press(ed, "Tab", true);
    expect(handled).toBe(true);
    expect(ed.getJSON().content).toHaveLength(2);
  });

  it("Tab into a COLLAPSED toggle auto-opens it (T2)", () => {
    const ed = mountContent([
      { type: "toggle", attrs: { open: false }, content: [p("title")] },
      p("after"),
    ]);
    ed.commands.setTextSelection(posInText(ed.state.doc, "after"));
    expect(press(ed, "Tab")).toBe(true);
    const top = ed.getJSON().content!;
    expect(top).toHaveLength(1);
    expect(top[0].attrs!.open).toBe(true); // nothing nests invisibly
    expect(top[0].content).toHaveLength(2);
  });

  it("Tab on a to-do nests it (A7) and never throws or traverses focus (T1)", () => {
    // Historically sinkListItem('taskItem') threw a RangeError against the
    // flat (nested:false) schema and the escaped exception skipped
    // preventDefault — the browser's focus traversal fired. The schema now
    // nests to-dos; the handler must still never throw regardless.
    const ed = mountContent([
      { type: "taskList", content: [task("one"), task("two")] },
    ]);
    ed.commands.setTextSelection(posInText(ed.state.doc, "two"));
    let handled = false;
    expect(() => {
      handled = press(ed, "Tab");
    }).not.toThrow();
    expect(handled).toBe(true);
    const top = ed.getJSON().content!;
    expect(top).toHaveLength(1);
    expect(top[0].content).toHaveLength(1); // "two" nested under "one"
    const firstItem = top[0].content![0];
    expect(firstItem.content![1].type).toBe("taskList"); // nested sub-list
  });
});

describe("[COMP:app-web/block-indent] Tab across separate sibling lists", () => {
  // The AI write path (`applyOpsToYDoc`) historically dropped each added bullet
  // in its own one-item `bulletList`, so a model-built list was a stack of
  // sibling <ul>s. Native sinkListItem can only nest under a preceding item in
  // the SAME list, so Tab on these silently no-op'd — the reported bug. The
  // keymap now joins the previous same-kind list first, then sinks.
  function twoLists(type: "bulletList" | "orderedList") {
    return mountContent([
      { type, content: [li("first")] },
      { type, content: [li("second")] },
    ]);
  }

  it("Tab nests the second bullet (its own <ul>) under the first", () => {
    const ed = twoLists("bulletList");
    ed.commands.setTextSelection(posInText(ed.state.doc, "second"));
    expect(press(ed, "Tab")).toBe(true);
    const top = ed.getJSON().content!;
    // The two wrappers merged into one, with "second" nested inside "first".
    expect(top).toHaveLength(1);
    expect(top[0].type).toBe("bulletList");
    expect(top[0].content).toHaveLength(1);
    const firstItem = top[0].content![0];
    expect(firstItem.content![1].type).toBe("bulletList"); // nested sub-list
    const nestedText = firstItem.content![1].content![0].content![0].content![0].text;
    expect(nestedText).toBe("second");
  });

  it("works for numbered lists too (orderedList)", () => {
    const ed = twoLists("orderedList");
    ed.commands.setTextSelection(posInText(ed.state.doc, "second"));
    expect(press(ed, "Tab")).toBe(true);
    const top = ed.getJSON().content!;
    expect(top).toHaveLength(1);
    expect(top[0].type).toBe("orderedList");
    expect(top[0].content![0].content![1].type).toBe("orderedList");
  });

  it("Shift-Tab lifts the nested bullet back out to its own level", () => {
    const ed = twoLists("bulletList");
    ed.commands.setTextSelection(posInText(ed.state.doc, "second"));
    press(ed, "Tab"); // nest
    ed.commands.setTextSelection(posInText(ed.state.doc, "second"));
    expect(press(ed, "Tab", true)).toBe(true); // outdent
    const top = ed.getJSON().content!;
    expect(top[0].content).toHaveLength(2); // both items back at one level
  });

  it("does NOT merge when the previous sibling is not a same-kind list", () => {
    const ed = mountContent([
      p("para"),
      { type: "bulletList", content: [li("only")] },
    ]);
    ed.commands.setTextSelection(posInText(ed.state.doc, "only"));
    expect(press(ed, "Tab")).toBe(true); // swallowed
    // No preceding bullet to nest under — the doc is unchanged (still a top-
    // level paragraph + a one-item list), never merged into the paragraph.
    const top = ed.getJSON().content!;
    expect(top).toHaveLength(2);
    expect(top[0].type).toBe("paragraph");
    expect(top[1].type).toBe("bulletList");
    expect(top[1].content).toHaveLength(1);
  });
});

describe("[COMP:app-web/block-indent] Shift-Tab Notion ordering (S1/S2)", () => {
  it("a bullet inside a toggle outdents OUT of the toggle, still a bullet (S1)", () => {
    const ed = mountContent([
      {
        type: "toggle",
        attrs: { open: true },
        content: [p("summary"), { type: "bulletList", content: [li("one"), li("two")] }],
      },
    ]);
    ed.commands.setTextSelection(posInText(ed.state.doc, "two"));
    expect(press(ed, "Tab", true)).toBe(true);
    const top = ed.getJSON().content!;
    expect(top).toHaveLength(2);
    expect(top[0].type).toBe("toggle");
    expect(top[0].content![1].content).toHaveLength(1); // "one" stays inside
    expect(top[1].type).toBe("bulletList"); // kind preserved — NOT a paragraph
    expect(top[1].content![0].content![0].content![0].text).toBe("two");
  });

  it("a top-level bullet is a no-op (S2) — never un-formats on Shift-Tab", () => {
    const ed = mountContent([
      { type: "bulletList", content: [li("one"), li("two")] },
    ]);
    ed.commands.setTextSelection(posInText(ed.state.doc, "two"));
    expect(press(ed, "Tab", true)).toBe(true); // swallowed
    const top = ed.getJSON().content!;
    expect(top).toHaveLength(1);
    expect(top[0].type).toBe("bulletList");
    expect(top[0].content).toHaveLength(2); // unchanged
  });
});

describe("[COMP:app-web/block-indent] Backspace keymap", () => {
  it("Backspace at the start of an empty toggle unwraps it to a paragraph", () => {
    const ed = mountContent([
      { type: "toggle", attrs: { open: true }, content: [{ type: "paragraph" }] },
    ]);
    ed.commands.setTextSelection(posInFirstEmpty(ed.state.doc));
    const handled = press(ed, "Backspace");
    expect(handled).toBe(true);
    const top = ed.getJSON().content!;
    expect(top).toHaveLength(1);
    expect(top[0].type).toBe("paragraph");
  });

  it("unwraps a populated toggle: title stays, children become siblings (B3)", () => {
    const ed = mountContent([
      p("before"),
      { type: "toggle", attrs: { open: true }, content: [p("title"), p("body")] },
    ]);
    ed.commands.setTextSelection(posInText(ed.state.doc, "title"));
    expect(press(ed, "Backspace")).toBe(true);
    const top = ed.getJSON().content!;
    expect(top).toHaveLength(3);
    expect(top[0].content![0].text).toBe("before"); // not merged into
    expect(top[1].content![0].text).toBe("title");
    expect(top[2].content![0].text).toBe("body");
  });

  it("a paragraph after a list joins the last bullet's TEXT — never becomes a new bullet (B1)", () => {
    const ed = mountContent([
      { type: "bulletList", content: [li("one"), li("two")] },
      p("after"),
    ]);
    ed.commands.setTextSelection(posInText(ed.state.doc, "after"));
    expect(press(ed, "Backspace")).toBe(true);
    const top = ed.getJSON().content!;
    expect(top).toHaveLength(1);
    expect(top[0].content).toHaveLength(2); // still two bullets
    expect(top[0].content![1].content![0].content![0].text).toBe("twoafter");
  });

  it("a paragraph after a COLLAPSED toggle joins the summary, not the hidden body (B2)", () => {
    const ed = mountContent([
      { type: "toggle", attrs: { open: false }, content: [p("summary"), p("child")] },
      p("after"),
    ]);
    ed.commands.setTextSelection(posInText(ed.state.doc, "after"));
    expect(press(ed, "Backspace")).toBe(true);
    const top = ed.getJSON().content!;
    expect(top).toHaveLength(1);
    expect(top[0].content![0].content![0].text).toBe("summaryafter");
    expect(top[0].content![1].content![0].text).toBe("child"); // untouched
  });

  it("a mid-list bullet un-formats IN PLACE; the list splits (B4)", () => {
    const ed = mountContent([
      { type: "bulletList", content: [li("one"), li("two"), li("three")] },
    ]);
    ed.commands.setTextSelection(posInText(ed.state.doc, "two"));
    expect(press(ed, "Backspace")).toBe(true);
    const top = ed.getJSON().content!;
    expect(top).toHaveLength(3);
    expect(top[0].type).toBe("bulletList");
    expect(top[1].type).toBe("paragraph");
    expect(top[1].content![0].text).toBe("two");
    expect(top[2].type).toBe("bulletList");
  });

  it("does not swallow Backspace inside normal text (falls through to native delete)", () => {
    // In-text deletion is the browser's job — ProseMirror only intercepts
    // Backspace for structural joins. Our binding must NOT claim the key here,
    // or native single-char deletion would silently stop working.
    const ed = mountContent([{ type: "paragraph", content: [{ type: "text", text: "ab" }] }]);
    ed.commands.focus("end");
    expect(press(ed, "Backspace")).toBe(false);
  });
});

describe("[COMP:app-web/block-indent] Enter on a toggle summary (E1–E3)", () => {
  it("collapsed: Enter at summary end creates a visible SIBLING below (E1)", () => {
    const ed = mountContent([
      { type: "toggle", attrs: { open: false }, content: [p("summary"), p("child")] },
    ]);
    ed.commands.setTextSelection(posInText(ed.state.doc, "summary") + "summary".length);
    expect(press(ed, "Enter")).toBe(true);
    const top = ed.getJSON().content!;
    expect(top).toHaveLength(2);
    expect(top[0].type).toBe("toggle");
    expect(top[0].content).toHaveLength(2); // body untouched
    expect(top[1].type).toBe("paragraph"); // the caret's new home — visible
  });

  it("collapsed: Enter mid-summary splits the tail to the sibling (E2)", () => {
    const ed = mountContent([
      { type: "toggle", attrs: { open: false }, content: [p("headtail"), p("child")] },
    ]);
    ed.commands.setTextSelection(posInText(ed.state.doc, "headtail") + "head".length);
    expect(press(ed, "Enter")).toBe(true);
    const top = ed.getJSON().content!;
    expect(top[0].content![0].content![0].text).toBe("head");
    expect(top[1].content![0].text).toBe("tail");
  });

  it("Enter at the START of a summary pushes the toggle down — the title never hides (E3)", () => {
    const ed = mountContent([
      { type: "toggle", attrs: { open: false }, content: [p("summary"), p("child")] },
    ]);
    ed.commands.setTextSelection(posInText(ed.state.doc, "summary"));
    expect(press(ed, "Enter")).toBe(true);
    const top = ed.getJSON().content!;
    expect(top).toHaveLength(2);
    expect(top[0].type).toBe("paragraph"); // empty block above
    expect(top[1].content![0].content![0].text).toBe("summary"); // title intact
  });

  it("open toggle: Enter keeps the default split into the first child (E4)", () => {
    const ed = mountContent([
      { type: "toggle", attrs: { open: true }, content: [p("summary")] },
    ]);
    ed.commands.setTextSelection(posInText(ed.state.doc, "summary") + "summary".length);
    press(ed, "Enter"); // our binding returns false; the editor default splits
    const top = ed.getJSON().content!;
    expect(top).toHaveLength(1);
    expect(top[0].content).toHaveLength(2); // new first child inside the toggle
  });
});

describe("[COMP:app-web/block-indent] toggle caret guard", () => {
  it("opens a collapsed toggle when content + caret land in its hidden body (drop/paste path)", () => {
    const ed = mountContent([
      { type: "toggle", attrs: { open: false }, content: [p("summary"), p("child")] },
      p("loose"),
    ]);
    // Simulate a drop: move the loose paragraph into the hidden body with the
    // selection following it (what ProseMirror's drop handling produces).
    const loosePos = posInText(ed.state.doc, "loose");
    const $loose = ed.state.doc.resolve(loosePos);
    const block = $loose.parent;
    const childEnd = posInText(ed.state.doc, "child") + "child".length + 1; // after the child paragraph
    let tr = ed.state.tr.delete($loose.before(), $loose.after());
    const insertAt = tr.mapping.map(childEnd);
    tr = tr.insert(insertAt, block);
    tr = tr.setSelection(TextSelection.create(tr.doc, insertAt + 1));
    ed.view.dispatch(tr);
    const top = ed.getJSON().content!;
    expect(top[0].attrs!.open).toBe(true); // guard opened the way
    expect(top[0].content).toHaveLength(3);
  });

  it("moves the caret to the summary when the toggle collapses AROUND it (chevron path)", () => {
    const ed = mountContent([
      { type: "toggle", attrs: { open: true }, content: [p("summary"), p("child")] },
    ]);
    ed.commands.setTextSelection(posInText(ed.state.doc, "child") + 2);
    // Simulate the chevron click syncing open:false through the node attr.
    const tr = ed.state.tr.setNodeMarkup(0, undefined, { open: false });
    ed.view.dispatch(tr);
    expect(ed.getJSON().content![0].attrs!.open).toBe(false); // stays collapsed
    const { $head } = ed.state.selection;
    expect($head.parent.textContent).toBe("summary"); // caret escaped the hidden body
  });
});

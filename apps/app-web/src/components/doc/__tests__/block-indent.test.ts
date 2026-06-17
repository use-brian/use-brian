/**
 * [COMP:app-web/block-indent] Structural keymap commands (Tab / Shift-Tab /
 * Backspace / Enter Notion semantics).
 *
 * The commands are plain ProseMirror commands, so they run against a
 * constructed `EditorState` over the real shared `docSchema()` — no editor
 * mount, no jsdom. The keymap wiring (Tab swallows focus, lists keep
 * `sinkListItem`, the caret guard) is covered by the jsdom integration test
 * in `block-indent.keymap.test.ts`. Finding IDs (B1/E3/S1…) refer to
 * `docs/plans/doc-editor-notion-parity-audit.md` §3.
 */

import { describe, expect, it } from "vitest";
import { docSchema } from "@sidanclaw/doc-model";
import { EditorState, TextSelection } from "@tiptap/pm/state";
import type { Node as PMNode } from "@tiptap/pm/model";
import type { Command } from "@tiptap/pm/state";
import {
  indentBlock,
  indentBlockRange,
  outdentBlock,
  outdentBlockRange,
  outdentListItemFromContainer,
  unwrapToggle,
  unwrapListItem,
  joinBackwardIntoVisible,
  toggleSummaryEnter,
  modEnterDisclosure,
} from "../block-indent";

const schema = docSchema();

const toggle = (text: string, ...rest: PMNode[]): PMNode =>
  schema.nodes.toggle.create({ open: true }, [
    schema.nodes.paragraph.create(null, text ? schema.text(text) : undefined),
    ...rest,
  ]);
const closedToggle = (text: string, ...rest: PMNode[]): PMNode =>
  schema.nodes.toggle.create({ open: false }, [
    schema.nodes.paragraph.create(null, text ? schema.text(text) : undefined),
    ...rest,
  ]);
const para = (text: string): PMNode =>
  schema.nodes.paragraph.create(null, schema.text(text));
const bullets = (...texts: string[]): PMNode =>
  schema.nodes.bulletList.create(
    null,
    texts.map((t) => schema.nodes.listItem.create(null, [para(t)])),
  );

/** Position just inside the textblock that contains `needle`. */
function posInText(doc: PMNode, needle: string): number {
  let pos = -1;
  doc.descendants((node, p) => {
    if (pos < 0 && node.isText && node.text?.includes(needle)) pos = p;
    return pos < 0;
  });
  return pos;
}

function run(doc: PMNode, needle: string, cmd: Command, offset = 0) {
  let state = EditorState.create({ doc, schema });
  state = state.apply(
    state.tr.setSelection(TextSelection.create(state.doc, posInText(doc, needle) + offset)),
  );
  let next: EditorState | null = null;
  const ok = cmd(state, (tr) => {
    next = state.apply(tr);
  });
  return { ok, doc: (next ?? state).doc };
}

describe("[COMP:app-web/block-indent] indentBlock (Tab)", () => {
  it("nests a toggle into the preceding toggle (cursor in its summary)", () => {
    const doc = schema.nodes.doc.create(null, [toggle("first"), toggle("second")]);
    const { ok, doc: out } = run(doc, "second", indentBlock);
    expect(ok).toBe(true);
    expect(out.childCount).toBe(1);
    expect(out.child(0).childCount).toBe(2); // summary + the nested toggle
    expect(out.child(0).child(1).type.name).toBe("toggle");
    expect(out.child(0).child(1).textContent).toBe("second");
  });

  it("nests a plain paragraph into the preceding toggle", () => {
    const doc = schema.nodes.doc.create(null, [toggle("title"), para("hello")]);
    const { ok, doc: out } = run(doc, "hello", indentBlock);
    expect(ok).toBe(true);
    expect(out.childCount).toBe(1);
    expect(out.child(0).child(1).textContent).toBe("hello");
  });

  it("auto-opens a collapsed toggle it nests into (T2 — content must stay visible)", () => {
    const doc = schema.nodes.doc.create(null, [closedToggle("title"), para("hello")]);
    const { ok, doc: out } = run(doc, "hello", indentBlock);
    expect(ok).toBe(true);
    expect(out.childCount).toBe(1);
    expect(out.child(0).attrs.open).toBe(true);
    expect(out.child(0).child(1).textContent).toBe("hello");
  });

  it("is a no-op for the first block (no previous sibling)", () => {
    const doc = schema.nodes.doc.create(null, [para("only"), toggle("t")]);
    expect(run(doc, "only", indentBlock).ok).toBe(false);
  });

  it("is a no-op when the previous sibling is not a container or list", () => {
    const doc = schema.nodes.doc.create(null, [para("a"), para("b")]);
    expect(run(doc, "b", indentBlock).ok).toBe(false);
  });

  it("nests a paragraph after a list under the LAST bullet (T3)", () => {
    const doc = schema.nodes.doc.create(null, [bullets("one", "two"), para("after")]);
    const { ok, doc: out } = run(doc, "after", indentBlock);
    expect(ok).toBe(true);
    expect(out.childCount).toBe(1);
    const lastItem = out.child(0).child(1);
    expect(lastItem.childCount).toBe(2); // its paragraph + the nested block
    expect(lastItem.child(1).type.name).toBe("paragraph");
    expect(lastItem.child(1).textContent).toBe("after");
  });

  it("nests a bullet after a NUMBERED list under its last item, kind kept (T4)", () => {
    const doc = schema.nodes.doc.create(null, [
      schema.nodes.orderedList.create(null, [
        schema.nodes.listItem.create(null, [para("num")]),
      ]),
      bullets("bullet", "stays"),
    ]);
    const { ok, doc: out } = run(doc, "bullet", indentBlock);
    expect(ok).toBe(true);
    expect(out.childCount).toBe(2);
    const numItem = out.child(0).child(0);
    expect(numItem.child(1).type.name).toBe("bulletList"); // nested, still a bullet
    expect(numItem.child(1).textContent).toBe("bullet");
    expect(out.child(1).type.name).toBe("bulletList"); // "stays" kept its own list
    expect(out.child(1).textContent).toBe("stays");
  });

  it("nests a paragraph under the last to-do (taskItem is paragraph+)", () => {
    const doc = schema.nodes.doc.create(null, [
      schema.nodes.taskList.create(null, [
        schema.nodes.taskItem.create({ checked: false }, [para("todo")]),
      ]),
      para("after"),
    ]);
    const { ok, doc: out } = run(doc, "after", indentBlock);
    expect(ok).toBe(true);
    expect(out.childCount).toBe(1);
    expect(out.child(0).child(0).childCount).toBe(2); // to-do text + nested paragraph
  });
});

function runRange(doc: PMNode, fromNeedle: string, toNeedle: string, cmd: Command) {
  let state = EditorState.create({ doc, schema });
  state = state.apply(
    state.tr.setSelection(
      TextSelection.create(
        state.doc,
        posInText(doc, fromNeedle),
        posInText(doc, toNeedle) + toNeedle.length,
      ),
    ),
  );
  let next: EditorState | null = null;
  const ok = cmd(state, (tr) => {
    next = state.apply(tr);
  });
  return { ok, doc: (next ?? state).doc };
}

describe("[COMP:app-web/block-indent] indentBlockRange / outdentBlockRange (Tab, T5)", () => {
  it("indents a multi-block selection into the preceding toggle", () => {
    const doc = schema.nodes.doc.create(null, [toggle("title"), para("one"), para("two")]);
    const { ok, doc: out } = runRange(doc, "one", "two", indentBlockRange);
    expect(ok).toBe(true);
    expect(out.childCount).toBe(1);
    expect(out.child(0).childCount).toBe(3); // summary + both blocks
    expect(out.child(0).child(1).textContent).toBe("one");
    expect(out.child(0).child(2).textContent).toBe("two");
  });

  it("auto-opens a collapsed toggle target", () => {
    const doc = schema.nodes.doc.create(null, [closedToggle("title"), para("one"), para("two")]);
    const { ok, doc: out } = runRange(doc, "one", "two", indentBlockRange);
    expect(ok).toBe(true);
    expect(out.child(0).attrs.open).toBe(true);
  });

  it("outdents a multi-block selection out of its toggle", () => {
    const doc = schema.nodes.doc.create(null, [
      toggle("title", para("one"), para("two"), para("three")),
    ]);
    const { ok, doc: out } = runRange(doc, "one", "two", outdentBlockRange);
    expect(ok).toBe(true);
    expect(out.childCount).toBe(3);
    expect(out.child(0).childCount).toBe(2); // summary + "three" stay inside
    expect(out.child(1).textContent).toBe("one");
    expect(out.child(2).textContent).toBe("two");
  });

  it("never indents under a plain paragraph", () => {
    const doc = schema.nodes.doc.create(null, [para("a"), para("one"), para("two")]);
    expect(runRange(doc, "one", "two", indentBlockRange).ok).toBe(false);
  });
});

describe("[COMP:app-web/block-indent] modEnterDisclosure (Mod-Enter, A5)", () => {
  it("flips a toggle open/closed from the summary", () => {
    const doc = schema.nodes.doc.create(null, [closedToggle("summary", para("child"))]);
    const { ok, doc: out } = run(doc, "summary", modEnterDisclosure);
    expect(ok).toBe(true);
    expect(out.child(0).attrs.open).toBe(true);
  });

  it("checks a to-do instead when the caret is in one", () => {
    const doc = schema.nodes.doc.create(null, [
      schema.nodes.taskList.create(null, [
        schema.nodes.taskItem.create({ checked: false }, [para("todo")]),
      ]),
    ]);
    const { ok, doc: out } = run(doc, "todo", modEnterDisclosure);
    expect(ok).toBe(true);
    expect(out.child(0).child(0).attrs.checked).toBe(true);
  });

  it("falls through outside both", () => {
    const doc = schema.nodes.doc.create(null, [para("plain")]);
    expect(run(doc, "plain", modEnterDisclosure).ok).toBe(false);
  });
});

describe("[COMP:app-web/block-indent] outdentBlock (Shift-Tab)", () => {
  it("lifts a body child out of its toggle, after the toggle", () => {
    const doc = schema.nodes.doc.create(null, [toggle("title", para("body"))]);
    const { ok, doc: out } = run(doc, "body", outdentBlock);
    expect(ok).toBe(true);
    expect(out.childCount).toBe(2);
    expect(out.child(0).childCount).toBe(1); // toggle keeps just its summary
    expect(out.child(1).textContent).toBe("body");
  });

  it("round-trips indent: a nested toggle lifts back to the top level", () => {
    const doc = schema.nodes.doc.create(null, [toggle("first"), toggle("second")]);
    const indented = run(doc, "second", indentBlock).doc;
    const { ok, doc: out } = run(indented, "second", outdentBlock);
    expect(ok).toBe(true);
    expect(out.childCount).toBe(2);
    expect(out.child(0).textContent).toBe("first");
    expect(out.child(1).textContent).toBe("second");
  });

  it("is a no-op at the top level (nothing to lift out of)", () => {
    const doc = schema.nodes.doc.create(null, [toggle("a"), toggle("b")]);
    expect(run(doc, "b", outdentBlock).ok).toBe(false);
  });
});

describe("[COMP:app-web/block-indent] outdentListItemFromContainer (Shift-Tab, S1)", () => {
  it("moves a bullet out of a toggle as its own list, kind preserved", () => {
    const doc = schema.nodes.doc.create(null, [toggle("title", bullets("one", "two"))]);
    const { ok, doc: out } = run(doc, "two", outdentListItemFromContainer);
    expect(ok).toBe(true);
    expect(out.childCount).toBe(2);
    expect(out.child(0).type.name).toBe("toggle");
    expect(out.child(0).child(1).childCount).toBe(1); // "one" stays inside
    expect(out.child(1).type.name).toBe("bulletList"); // still a bullet, after the toggle
    expect(out.child(1).textContent).toBe("two");
  });

  it("drops the wrapper husk when the only item leaves", () => {
    const doc = schema.nodes.doc.create(null, [toggle("title", bullets("only"))]);
    const { ok, doc: out } = run(doc, "only", outdentListItemFromContainer);
    expect(ok).toBe(true);
    expect(out.child(0).childCount).toBe(1); // toggle keeps just its summary
    expect(out.child(1).type.name).toBe("bulletList");
    expect(out.child(1).textContent).toBe("only");
  });

  it("is a no-op for a top-level list (not inside a container)", () => {
    const doc = schema.nodes.doc.create(null, [bullets("one", "two")]);
    expect(run(doc, "two", outdentListItemFromContainer).ok).toBe(false);
  });
});

/** A toggle whose only child is `child` — the staircase building block. */
const nest = (child: PMNode): PMNode =>
  schema.nodes.toggle.create({ open: true }, [child]);

/** Position at offset 0 inside the first empty textblock in the doc. */
function posInFirstEmpty(doc: PMNode): number {
  let pos = -1;
  doc.descendants((node, p) => {
    if (pos < 0 && node.isTextblock && node.content.size === 0) pos = p + 1;
    return pos < 0;
  });
  return pos;
}

function runEmpty(doc: PMNode, cmd: Command) {
  let state = EditorState.create({ doc, schema });
  state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, posInFirstEmpty(doc))));
  let next: EditorState | null = null;
  const ok = cmd(state, (tr) => {
    next = state.apply(tr);
  });
  return { ok, doc: (next ?? state).doc };
}

describe("[COMP:app-web/block-indent] unwrapToggle (Backspace, B3/B6)", () => {
  it("unwraps a lone empty toggle back to a paragraph", () => {
    const doc = schema.nodes.doc.create(null, [toggle("")]);
    const { ok, doc: out } = runEmpty(doc, unwrapToggle);
    expect(ok).toBe(true);
    expect(out.childCount).toBe(1);
    expect(out.child(0).type.name).toBe("paragraph");
    expect(out.child(0).content.size).toBe(0);
  });

  it("peels one nested level per press (dismantles the staircase)", () => {
    const doc = schema.nodes.doc.create(null, [nest(nest(schema.nodes.paragraph.create()))]);
    const once = runEmpty(doc, unwrapToggle);
    expect(once.ok).toBe(true);
    expect(once.doc.child(0).type.name).toBe("toggle");
    expect(once.doc.child(0).childCount).toBe(1); // one toggle layer remains

    const twice = runEmpty(once.doc, unwrapToggle);
    expect(twice.ok).toBe(true);
    expect(twice.doc.child(0).type.name).toBe("paragraph"); // fully unwrapped
  });

  it("unwraps a non-empty toggle: summary stays a block, children become siblings (B3)", () => {
    const doc = schema.nodes.doc.create(null, [para("before"), toggle("title", para("body"))]);
    const { ok, doc: out } = run(doc, "title", unwrapToggle);
    expect(ok).toBe(true);
    expect(out.childCount).toBe(3);
    expect(out.child(0).textContent).toBe("before"); // never merged into
    expect(out.child(1).type.name).toBe("paragraph");
    expect(out.child(1).textContent).toBe("title");
    expect(out.child(2).textContent).toBe("body");
  });

  it("only fires from the summary line, not a body child", () => {
    const doc = schema.nodes.doc.create(null, [toggle("title", para("body"))]);
    expect(run(doc, "body", unwrapToggle).ok).toBe(false);
  });

  it("is a no-op on an empty paragraph that is not in a toggle", () => {
    const doc = schema.nodes.doc.create(null, [para("x")]);
    const empty = schema.nodes.doc.create(null, [schema.nodes.paragraph.create()]);
    expect(runEmpty(empty, unwrapToggle).ok).toBe(false);
    expect(run(doc, "x", unwrapToggle).ok).toBe(false);
  });
});

describe("[COMP:app-web/block-indent] unwrapListItem (Backspace, B4)", () => {
  it("un-bullets a middle item in place; the list splits around it", () => {
    const doc = schema.nodes.doc.create(null, [bullets("one", "two", "three")]);
    const { ok, doc: out } = run(doc, "two", unwrapListItem);
    expect(ok).toBe(true);
    expect(out.childCount).toBe(3);
    expect(out.child(0).type.name).toBe("bulletList");
    expect(out.child(0).textContent).toBe("one");
    expect(out.child(1).type.name).toBe("paragraph"); // un-bulleted in place
    expect(out.child(1).textContent).toBe("two");
    expect(out.child(2).type.name).toBe("bulletList");
    expect(out.child(2).textContent).toBe("three");
  });

  it("un-bullets the first item without touching the block above", () => {
    const doc = schema.nodes.doc.create(null, [para("before"), bullets("one", "two")]);
    const { ok, doc: out } = run(doc, "one", unwrapListItem);
    expect(ok).toBe(true);
    expect(out.child(0).textContent).toBe("before");
    expect(out.child(1).type.name).toBe("paragraph");
    expect(out.child(1).textContent).toBe("one");
    expect(out.child(2).type.name).toBe("bulletList");
  });

  it("un-checks a to-do into a paragraph", () => {
    const doc = schema.nodes.doc.create(null, [
      schema.nodes.taskList.create(null, [
        schema.nodes.taskItem.create({ checked: true }, [para("todo")]),
      ]),
    ]);
    const { ok, doc: out } = run(doc, "todo", unwrapListItem);
    expect(ok).toBe(true);
    expect(out.child(0).type.name).toBe("paragraph");
    expect(out.child(0).textContent).toBe("todo");
  });

  it("only fires at the start of the item's lead textblock", () => {
    const doc = schema.nodes.doc.create(null, [bullets("one", "two")]);
    expect(run(doc, "two", unwrapListItem, 1).ok).toBe(false);
  });
});

describe("[COMP:app-web/block-indent] joinBackwardIntoVisible (Backspace, B1/B2)", () => {
  it("joins a paragraph after a list into the LAST bullet's text — never a new bullet (B1)", () => {
    const doc = schema.nodes.doc.create(null, [bullets("one", "two"), para("after")]);
    const { ok, doc: out } = run(doc, "after", joinBackwardIntoVisible);
    expect(ok).toBe(true);
    expect(out.childCount).toBe(1);
    expect(out.child(0).type.name).toBe("bulletList");
    expect(out.child(0).childCount).toBe(2); // still two items — nothing was wrapped
    expect(out.child(0).child(1).textContent).toBe("twoafter");
  });

  it("joins a paragraph after a COLLAPSED toggle into the summary, not the hidden body (B2)", () => {
    const doc = schema.nodes.doc.create(null, [
      closedToggle("summary", para("child")),
      para("after"),
    ]);
    const { ok, doc: out } = run(doc, "after", joinBackwardIntoVisible);
    expect(ok).toBe(true);
    expect(out.childCount).toBe(1);
    const t = out.child(0);
    expect(t.child(0).textContent).toBe("summaryafter"); // into the visible line
    expect(t.child(1).textContent).toBe("child"); // hidden body untouched
  });

  it("joins into the deepest visible line of an OPEN toggle", () => {
    const doc = schema.nodes.doc.create(null, [
      toggle("summary", para("child")),
      para("after"),
    ]);
    const { ok, doc: out } = run(doc, "after", joinBackwardIntoVisible);
    expect(ok).toBe(true);
    expect(out.child(0).child(1).textContent).toBe("childafter");
  });

  it("falls through when the previous sibling is a plain textblock", () => {
    const doc = schema.nodes.doc.create(null, [para("a"), para("b")]);
    expect(run(doc, "b", joinBackwardIntoVisible).ok).toBe(false);
  });
});

describe("[COMP:app-web/block-indent] toggleSummaryEnter (Enter, E1–E3)", () => {
  it("collapsed toggle: Enter at summary end creates a SIBLING after the toggle (E1)", () => {
    const doc = schema.nodes.doc.create(null, [closedToggle("summary", para("child"))]);
    const { ok, doc: out } = run(doc, "summary", toggleSummaryEnter, "summary".length);
    expect(ok).toBe(true);
    expect(out.childCount).toBe(2);
    expect(out.child(0).type.name).toBe("toggle");
    expect(out.child(0).childCount).toBe(2); // summary + child, body untouched
    expect(out.child(1).type.name).toBe("paragraph"); // the new visible sibling
  });

  it("collapsed toggle: Enter mid-summary splits the tail to the sibling (E2)", () => {
    const doc = schema.nodes.doc.create(null, [closedToggle("headtail", para("child"))]);
    const { ok, doc: out } = run(doc, "headtail", toggleSummaryEnter, "head".length);
    expect(ok).toBe(true);
    expect(out.child(0).child(0).textContent).toBe("head");
    expect(out.child(1).textContent).toBe("tail"); // visible, after the toggle
  });

  it("Enter at the START of a non-empty summary inserts a paragraph ABOVE — the title stays (E3)", () => {
    const doc = schema.nodes.doc.create(null, [closedToggle("summary", para("child"))]);
    const { ok, doc: out } = run(doc, "summary", toggleSummaryEnter);
    expect(ok).toBe(true);
    expect(out.childCount).toBe(2);
    expect(out.child(0).type.name).toBe("paragraph");
    expect(out.child(0).content.size).toBe(0);
    expect(out.child(1).child(0).textContent).toBe("summary"); // title intact
  });

  it("open toggle: falls through to the default split (first child is Notion parity)", () => {
    const doc = schema.nodes.doc.create(null, [toggle("summary")]);
    expect(run(doc, "summary", toggleSummaryEnter, "summary".length).ok).toBe(false);
  });

  it("only fires on the summary line", () => {
    const doc = schema.nodes.doc.create(null, [closedToggle("summary", para("child"))]);
    expect(run(doc, "child", toggleSummaryEnter, "child".length).ok).toBe(false);
  });
});

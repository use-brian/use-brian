// @vitest-environment jsdom
/**
 * [COMP:app-web/block-actions] Multi-block (area-select) deletion.
 *
 * Guards the "I selected several blocks but delete didn't remove everything"
 * bug. Two paths must each clear the WHOLE multi-block `NodeRangeSelection`:
 *
 *   1. **Keyboard** — Backspace / Delete on an active `NodeRangeSelection` runs
 *      the editor's default keymap (`deleteSelection`). The production failure
 *      was a margin-started selection that never focused the editor, so the key
 *      never reached this path (focus fix lives in `block-area-select.ts`); the
 *      deletion logic itself, exercised here through the real keymap, has always
 *      been correct and must stay so.
 *   2. **Drag-handle menu Delete** — `deleteBlockSelectionOrAt` removes the
 *      whole selection when the handle's target block is inside it, else just
 *      that one block.
 *
 * The scenario mirrors the report: a stack of toggles (one with nested list
 * content) plus a trailing empty paragraph, all area-selected.
 */

import { describe, expect, it, afterEach } from "vitest";
import { Editor } from "@tiptap/core";
import { NodeRangeSelection } from "@tiptap/extension-node-range";
import { browserDocExtensions } from "../doc-schema";
import { deleteBlockSelectionOrAt } from "../block-actions";

let editor: Editor | null = null;
afterEach(() => {
  editor?.destroy();
  editor = null;
});

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

function press(ed: Editor, key: string): boolean {
  return !!ed.view.someProp("handleKeyDown", (f) =>
    f(ed.view, new window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })),
  );
}

const SCENARIO = [
  { type: "toggle", attrs: { open: true }, content: [{ type: "paragraph", content: [{ type: "text", text: "first" }] }] },
  {
    type: "toggle",
    attrs: { open: true },
    content: [
      { type: "paragraph", content: [{ type: "text", text: "second" }] },
      { type: "bulletList", content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "nested" }] }] }] },
    ],
  },
  { type: "toggle", attrs: { open: true }, content: [{ type: "paragraph", content: [{ type: "text", text: "third" }] }] },
  { type: "paragraph" },
];

/** Select every top-level block as one `NodeRangeSelection`, exactly as the
 *  area-select gesture does (`create(doc, bandFrom + 1, bandTo - 1)`). */
function selectAllBlocks(ed: Editor): void {
  const size = ed.state.doc.content.size;
  const sel = NodeRangeSelection.create(ed.state.doc, 1, size - 1);
  ed.view.dispatch(ed.state.tr.setSelection(sel));
}

function topLevelTypes(ed: Editor): string[] {
  return ed.getJSON().content!.map((b) => b.type as string);
}

describe("[COMP:app-web/block-actions] Multi-block area-select deletion", () => {
  it("Backspace clears the whole area selection (toggles + nested list + empty para)", () => {
    const ed = mountContent(SCENARIO);
    selectAllBlocks(ed);
    expect(press(ed, "Backspace")).toBe(true);
    // Everything gone; ProseMirror leaves one empty paragraph behind.
    expect(topLevelTypes(ed)).toEqual(["paragraph"]);
    expect(ed.state.doc.textContent).toBe("");
  });

  it("Delete (forward) clears the whole area selection too", () => {
    const ed = mountContent(SCENARIO);
    selectAllBlocks(ed);
    expect(press(ed, "Delete")).toBe(true);
    expect(topLevelTypes(ed)).toEqual(["paragraph"]);
    expect(ed.state.doc.textContent).toBe("");
  });

  it("does not leave nested content (the 'nested' bullet) behind", () => {
    const ed = mountContent(SCENARIO);
    selectAllBlocks(ed);
    press(ed, "Backspace");
    expect(ed.state.doc.textContent).not.toContain("nested");
  });
});

describe("[COMP:app-web/block-actions] deleteBlockSelectionOrAt (menu Delete)", () => {
  it("deletes the WHOLE selection when the target block is inside it", () => {
    const ed = mountContent(SCENARIO);
    selectAllBlocks(ed);
    // Target = the second top-level block (a toggle), which is inside the range.
    const secondPos = ed.state.doc.resolve(0).posAtIndex(1);
    expect(deleteBlockSelectionOrAt(ed, secondPos)).toBe(true);
    expect(topLevelTypes(ed)).toEqual(["paragraph"]);
    expect(ed.state.doc.textContent).toBe("");
  });

  it("deletes ONLY the single block when no multi-selection is active", () => {
    const ed = mountContent(SCENARIO);
    // A plain caret in the first block — not a NodeRangeSelection.
    ed.commands.setTextSelection(2);
    const firstPos = ed.state.doc.resolve(0).posAtIndex(0);
    expect(deleteBlockSelectionOrAt(ed, firstPos)).toBe(true);
    // Only the first toggle ("first") was removed; the rest survive.
    const text = ed.state.doc.textContent;
    expect(text).not.toContain("first");
    expect(text).toContain("second");
    expect(text).toContain("third");
  });

  it("deletes only the single target block when it sits OUTSIDE the active selection", () => {
    const ed = mountContent(SCENARIO);
    // Area-select just the first two blocks.
    const twoBlocksEnd = ed.state.doc.resolve(0).posAtIndex(2);
    ed.view.dispatch(
      ed.state.tr.setSelection(NodeRangeSelection.create(ed.state.doc, 1, twoBlocksEnd - 1)),
    );
    // Delete the THIRD block (outside the selection) → only it goes.
    const thirdPos = ed.state.doc.resolve(0).posAtIndex(2);
    expect(deleteBlockSelectionOrAt(ed, thirdPos)).toBe(true);
    const text = ed.state.doc.textContent;
    expect(text).toContain("first");
    expect(text).toContain("second");
    expect(text).not.toContain("third");
  });
});

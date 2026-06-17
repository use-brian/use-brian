// @vitest-environment jsdom
/**
 * [COMP:app-web/doc-table] Simple-table node-view controls.
 *
 * Drives a REAL headless ProseMirror editor (the shared `docExtensions()` —
 * raw nodes, no React node-views) so the row/column add/delete + header-toggle
 * commands are verified against an actual document, not a recorded chain.
 * The node-view (`table-view.tsx`) only renders the control bar; this exercises
 * the `runTableCommand` logic those buttons call.
 */

import { describe, it, expect, afterEach } from "vitest";
import { Editor } from "@tiptap/core";
import { browserDocExtensions } from "../doc-schema";
import { runTableCommand } from "../table-controls";
import type { Node as PMNode } from "@tiptap/pm/model";

const tableJSON = (rows: number, cols: number, headerRow: boolean) => ({
  type: "table",
  attrs: { blockId: "tb" },
  content: Array.from({ length: rows }, (_unused, r) => ({
    type: "tableRow",
    content: Array.from({ length: cols }, () => ({
      type: r === 0 && headerRow ? "tableHeader" : "tableCell",
      content: [{ type: "paragraph" }],
    })),
  })),
});

let editor: Editor | null = null;
afterEach(() => {
  editor?.destroy();
  editor = null;
});

function makeEditor(nodes: unknown[]): Editor {
  const element = document.createElement("div");
  document.body.appendChild(element);
  return new Editor({
    element,
    extensions: browserDocExtensions(),
    content: { type: "doc", content: nodes as never },
  });
}

/** Locate the table node + its document position. */
function findTable(ed: Editor): { node: PMNode; pos: number } {
  let found: { node: PMNode; pos: number } | null = null;
  ed.state.doc.descendants((node, pos) => {
    if (node.type.name === "table") {
      found = { node, pos };
      return false;
    }
    return true;
  });
  if (!found) throw new Error("no table in doc");
  return found;
}

function dims(ed: Editor): { rows: number; cols: number } {
  const { node } = findTable(ed);
  return { rows: node.childCount, cols: node.firstChild?.childCount ?? 0 };
}

describe("[COMP:app-web/doc-table] runTableCommand", () => {
  it("adds a row after the current cell", () => {
    editor = makeEditor([tableJSON(3, 3, true)]);
    expect(dims(editor).rows).toBe(3);
    const { node, pos } = findTable(editor);
    runTableCommand(editor, () => pos, node, "addRowAfter");
    expect(dims(editor).rows).toBe(4);
  });

  it("adds a column after the current cell", () => {
    editor = makeEditor([tableJSON(3, 3, true)]);
    expect(dims(editor).cols).toBe(3);
    const { node, pos } = findTable(editor);
    runTableCommand(editor, () => pos, node, "addColumnAfter");
    expect(dims(editor).cols).toBe(4);
  });

  it("deletes a row and a column", () => {
    editor = makeEditor([tableJSON(3, 3, true)]);
    let t = findTable(editor);
    runTableCommand(editor, () => t.pos, t.node, "deleteRow");
    expect(dims(editor).rows).toBe(2);
    t = findTable(editor);
    runTableCommand(editor, () => t.pos, t.node, "deleteColumn");
    expect(dims(editor).cols).toBe(2);
  });

  it("toggles the header row (tableHeader ↔ tableCell)", () => {
    editor = makeEditor([tableJSON(3, 3, true)]);
    const headerKind = () => findTable(editor!).node.firstChild!.firstChild!.type.name;
    expect(headerKind()).toBe("tableHeader");
    const { node, pos } = findTable(editor);
    runTableCommand(editor, () => pos, node, "toggleHeaderRow");
    expect(headerKind()).toBe("tableCell");
  });

  it("works even when the selection starts OUTSIDE the table", () => {
    // A leading paragraph holds the caret; the control must still drop the
    // selection into the table before running the command.
    editor = makeEditor([{ type: "paragraph", content: [{ type: "text", text: "hi" }] }, tableJSON(2, 2, false)]);
    editor.commands.setTextSelection(1); // inside the paragraph, not the table
    const { node, pos } = findTable(editor);
    runTableCommand(editor, () => pos, node, "addRowAfter");
    expect(dims(editor).rows).toBe(3);
  });
});

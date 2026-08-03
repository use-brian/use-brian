// @vitest-environment jsdom
/**
 * [COMP:app-web/doc-table] Simple-table node-view controls.
 *
 * Drives a REAL headless ProseMirror editor (the shared `docExtensions()` —
 * raw nodes, no React node-views) so targeted row/column operations, reorder,
 * and the table-last repair are verified against an actual document.
 */

import { describe, it, expect, afterEach } from "vitest";
import { Editor } from "@tiptap/core";
import { browserDocExtensions } from "../doc-schema";
import { moveTableAxis, runTableCommand } from "../table-controls";
import { createTableTrailingParagraphExtension } from "../table-trailing-paragraph";
import type { Node as PMNode } from "@tiptap/pm/model";

const tableJSON = (
  rows: number,
  cols: number,
  headerRow: boolean,
  headerColumn = false,
  labels = false,
) => ({
  type: "table",
  attrs: { blockId: "tb" },
  content: Array.from({ length: rows }, (_unused, r) => ({
    type: "tableRow",
    content: Array.from({ length: cols }, (_unusedCell, c) => ({
      type: (r === 0 && headerRow) || (c === 0 && headerColumn)
        ? "tableHeader"
        : "tableCell",
      content: [
        {
          type: "paragraph",
          ...(labels ? { content: [{ type: "text", text: `${r}:${c}` }] } : {}),
        },
      ],
    })),
  })),
});

let editor: Editor | null = null;
afterEach(() => {
  editor?.destroy();
  editor = null;
});

function makeEditor(nodes: unknown[], trailingParagraph = false): Editor {
  const element = document.createElement("div");
  document.body.appendChild(element);
  return new Editor({
    element,
    extensions: [
      ...browserDocExtensions(),
      ...(trailingParagraph ? [createTableTrailingParagraphExtension()] : []),
    ],
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

function cells(ed: Editor): string[][] {
  const { node } = findTable(ed);
  return Array.from({ length: node.childCount }, (_unused, row) =>
    Array.from(
      { length: node.child(row).childCount },
      (_unusedCell, column) => node.child(row).child(column).textContent,
    ),
  );
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

  it("targets the row and column represented by the clicked edge handle", () => {
    editor = makeEditor([tableJSON(3, 3, false, false, true)]);
    let t = findTable(editor);
    runTableCommand(editor, () => t.pos, t.node, "deleteRow", {
      axis: "row",
      index: 1,
    });
    expect(cells(editor)).toEqual([
      ["0:0", "0:1", "0:2"],
      ["2:0", "2:1", "2:2"],
    ]);

    t = findTable(editor);
    runTableCommand(editor, () => t.pos, t.node, "deleteColumn", {
      axis: "column",
      index: 1,
    });
    expect(cells(editor)).toEqual([
      ["0:0", "0:2"],
      ["2:0", "2:2"],
    ]);
  });

  it("duplicates the targeted row and column", () => {
    editor = makeEditor([tableJSON(3, 3, false, false, true)]);
    let t = findTable(editor);
    expect(
      runTableCommand(editor, () => t.pos, t.node, "duplicateRow", {
        axis: "row",
        index: 1,
      }),
    ).toBe(true);
    expect(cells(editor)).toEqual([
      ["0:0", "0:1", "0:2"],
      ["1:0", "1:1", "1:2"],
      ["1:0", "1:1", "1:2"],
      ["2:0", "2:1", "2:2"],
    ]);

    t = findTable(editor);
    expect(
      runTableCommand(editor, () => t.pos, t.node, "duplicateColumn", {
        axis: "column",
        index: 1,
      }),
    ).toBe(true);
    expect(cells(editor)).toEqual([
      ["0:0", "0:1", "0:1", "0:2"],
      ["1:0", "1:1", "1:1", "1:2"],
      ["1:0", "1:1", "1:1", "1:2"],
      ["2:0", "2:1", "2:1", "2:2"],
    ]);
  });

  it("clears every cell in the targeted row or column", () => {
    editor = makeEditor([tableJSON(3, 3, false, false, true)]);
    let t = findTable(editor);
    expect(
      runTableCommand(editor, () => t.pos, t.node, "clearRow", {
        axis: "row",
        index: 1,
      }),
    ).toBe(true);
    expect(cells(editor)[1]).toEqual(["", "", ""]);

    t = findTable(editor);
    expect(
      runTableCommand(editor, () => t.pos, t.node, "clearColumn", {
        axis: "column",
        index: 2,
      }),
    ).toBe(true);
    expect(cells(editor).map((row) => row[2])).toEqual(["", "", ""]);
  });

  it("toggles the header row (tableHeader ↔ tableCell)", () => {
    editor = makeEditor([tableJSON(3, 3, true)]);
    const headerKind = () => findTable(editor!).node.firstChild!.firstChild!.type.name;
    expect(headerKind()).toBe("tableHeader");
    const { node, pos } = findTable(editor);
    runTableCommand(editor, () => pos, node, "toggleHeaderRow");
    expect(headerKind()).toBe("tableCell");
  });

  it("toggles the first column as a header column", () => {
    editor = makeEditor([tableJSON(3, 3, false)]);
    const t = findTable(editor);
    runTableCommand(editor, () => t.pos, t.node, "toggleHeaderColumn", {
      axis: "column",
      index: 2,
    });
    const table = findTable(editor).node;
    expect(Array.from({ length: 3 }, (_unused, row) => table.child(row).child(0).type.name))
      .toEqual(["tableHeader", "tableHeader", "tableHeader"]);
  });

  it("reorders rows and columns while keeping header semantics on the edges", () => {
    editor = makeEditor([tableJSON(3, 3, true, true, true)]);
    let t = findTable(editor);
    expect(moveTableAxis(editor, () => t.pos, "row", 2, 1)).toBe(true);
    expect(cells(editor)).toEqual([
      ["0:0", "0:1", "0:2"],
      ["2:0", "2:1", "2:2"],
      ["1:0", "1:1", "1:2"],
    ]);

    t = findTable(editor);
    expect(moveTableAxis(editor, () => t.pos, "column", 2, 1)).toBe(true);
    expect(cells(editor)).toEqual([
      ["0:0", "0:2", "0:1"],
      ["2:0", "2:2", "2:1"],
      ["1:0", "1:2", "1:1"],
    ]);

    const table = findTable(editor).node;
    expect(Array.from({ length: 3 }, (_unused, col) => table.child(0).child(col).type.name))
      .toEqual(["tableHeader", "tableHeader", "tableHeader"]);
    expect(Array.from({ length: 3 }, (_unused, row) => table.child(row).child(0).type.name))
      .toEqual(["tableHeader", "tableHeader", "tableHeader"]);
    expect(table.child(1).child(1).type.name).toBe("tableCell");
  });

  it("reorders rows and columns toward a later index too", () => {
    editor = makeEditor([tableJSON(3, 3, false, false, true)]);
    let t = findTable(editor);
    expect(moveTableAxis(editor, () => t.pos, "row", 1, 2)).toBe(true);
    expect(cells(editor)).toEqual([
      ["0:0", "0:1", "0:2"],
      ["2:0", "2:1", "2:2"],
      ["1:0", "1:1", "1:2"],
    ]);

    t = findTable(editor);
    expect(moveTableAxis(editor, () => t.pos, "column", 1, 2)).toBe(true);
    expect(cells(editor)).toEqual([
      ["0:0", "0:2", "0:1"],
      ["2:0", "2:2", "2:1"],
      ["1:0", "1:2", "1:1"],
    ]);
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

  it("always leaves an editable paragraph after a final table", async () => {
    editor = makeEditor([tableJSON(2, 2, false)], true);
    // Tiptap emits the create lifecycle on its next tick.
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    expect(editor.state.doc.lastChild?.type.name).toBe("paragraph");
    expect(editor.state.doc.childCount).toBe(2);

    // The appendTransaction path repairs later content replacements too (the
    // same path a table-last remote Yjs update takes).
    editor.commands.setContent({ type: "doc", content: [tableJSON(1, 1, false)] });
    expect(editor.state.doc.lastChild?.type.name).toBe("paragraph");
    expect(editor.state.doc.childCount).toBe(2);
  });
});

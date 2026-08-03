/**
 * Notion-style command glue for the native simple-table node view.
 *
 * Every command is targeted by a row/column index from the edge handle that
 * invoked it. We first install a real `CellSelection` over that axis, then run
 * the stock prosemirror-tables command in the same chain. That makes a menu
 * reliable even when focus moved into the portalled popup or the caret was in
 * another block before the user clicked the handle.
 *
 * Row/column reorder uses prosemirror-tables' structural move commands. Header
 * status belongs to the table edge (first row / first column), not the moved
 * content, so the follow-up normalization preserves that invariant when a
 * header is dragged.
 *
 * [COMP:app-web/doc-table]
 */

import type { Editor } from "@tiptap/core";
// Side-effect import: brings the table chain commands into Tiptap's Commands
// augmentation so `editor.chain()` is fully typed below.
import "@tiptap/extension-table";
import type { Node as PMNode } from "@tiptap/pm/model";
import type { Transaction } from "@tiptap/pm/state";
import {
  CellSelection,
  TableMap,
  moveTableColumn,
  moveTableRow,
} from "@tiptap/pm/tables";
import { remintBlockIds } from "./block-actions";

export type TableAxis = "row" | "column";

export type TableTarget = {
  axis: TableAxis;
  index: number;
};

export type TableCommand =
  | "addRowBefore"
  | "addRowAfter"
  | "addColumnBefore"
  | "addColumnAfter"
  | "deleteRow"
  | "deleteColumn"
  | "toggleHeaderRow"
  | "toggleHeaderColumn"
  | "duplicateRow"
  | "duplicateColumn"
  | "clearRow"
  | "clearColumn";

type LiveTable = { node: PMNode; pos: number };

function liveTable(editor: Editor, getPos: () => number): LiveTable | null {
  const pos = getPos();
  if (typeof pos !== "number") return null;
  const node = editor.state.doc.nodeAt(pos);
  return node?.type.spec.tableRole === "table" ? { node, pos } : null;
}

function axisSelection(
  doc: PMNode,
  table: LiveTable,
  target: TableTarget,
): CellSelection | null {
  const map = TableMap.get(table.node);
  const limit = target.axis === "row" ? map.height : map.width;
  if (target.index < 0 || target.index >= limit) return null;

  const start = table.pos + 1;
  if (target.axis === "row") {
    const first = start + map.positionAt(target.index, 0, table.node);
    const last = start + map.positionAt(target.index, map.width - 1, table.node);
    return CellSelection.rowSelection(doc.resolve(first), doc.resolve(last));
  }

  const first = start + map.positionAt(0, target.index, table.node);
  const last = start + map.positionAt(map.height - 1, target.index, table.node);
  return CellSelection.colSelection(doc.resolve(first), doc.resolve(last));
}

function selectAxisInTransaction(
  tr: Transaction,
  tablePos: number,
  target: TableTarget,
): boolean {
  const node = tr.doc.nodeAt(tablePos);
  if (!node || node.type.spec.tableRole !== "table") return false;
  const selection = axisSelection(tr.doc, { node, pos: tablePos }, target);
  if (!selection) return false;
  tr.setSelection(selection);
  return true;
}

function dispatchTableTransaction(
  editor: Editor,
  tr: Transaction,
  tablePos: number,
  target: TableTarget,
  flags: { row: boolean; column: boolean },
): boolean {
  normalizeHeaderEdges(tr, tablePos, flags);
  if (!selectAxisInTransaction(tr, tablePos, target)) return false;
  editor.view.dispatch(tr.scrollIntoView());
  editor.view.focus();
  return true;
}

function duplicateRow(
  editor: Editor,
  table: LiveTable,
  index: number,
): boolean {
  if (index < 0 || index >= table.node.childCount) return false;
  const row = table.node.child(index);
  let rowPos = table.pos + 1;
  for (let current = 0; current < index; current += 1) {
    rowPos += table.node.child(current).nodeSize;
  }
  const clone = editor.state.schema.nodeFromJSON(remintBlockIds(row.toJSON()));
  const tr = editor.state.tr.insert(rowPos + row.nodeSize, clone);
  return dispatchTableTransaction(
    editor,
    tr,
    table.pos,
    { axis: "row", index: index + 1 },
    headerFlags(table.node),
  );
}

function duplicateColumn(
  editor: Editor,
  table: LiveTable,
  index: number,
): boolean {
  const map = TableMap.get(table.node);
  // Simple tables do not expose merge/split actions. Refuse a malformed or
  // externally-authored spanning grid rather than constructing an invalid map.
  if (
    index < 0 ||
    index >= map.width ||
    Array.from({ length: table.node.childCount }, (_unused, row) =>
      table.node.child(row),
    ).some((row) => row.childCount !== map.width)
  ) {
    return false;
  }

  const insertions: Array<{ pos: number; node: PMNode }> = [];
  let rowPos = table.pos + 1;
  for (let rowIndex = 0; rowIndex < table.node.childCount; rowIndex += 1) {
    const row = table.node.child(rowIndex);
    let cellPos = rowPos + 1;
    for (let column = 0; column < index; column += 1) {
      cellPos += row.child(column).nodeSize;
    }
    const cell = row.child(index);
    insertions.push({
      pos: cellPos + cell.nodeSize,
      node: editor.state.schema.nodeFromJSON(remintBlockIds(cell.toJSON())),
    });
    rowPos += row.nodeSize;
  }

  const tr = editor.state.tr;
  for (const insertion of insertions.reverse()) {
    tr.insert(insertion.pos, insertion.node);
  }
  return dispatchTableTransaction(
    editor,
    tr,
    table.pos,
    { axis: "column", index: index + 1 },
    headerFlags(table.node),
  );
}

function clearAxis(
  editor: Editor,
  table: LiveTable,
  target: TableTarget,
): boolean {
  const map = TableMap.get(table.node);
  const limit = target.axis === "row" ? map.height : map.width;
  if (target.index < 0 || target.index >= limit) return false;
  const relativePositions = new Set<number>();
  if (target.axis === "row") {
    for (let column = 0; column < map.width; column += 1) {
      relativePositions.add(map.positionAt(target.index, column, table.node));
    }
  } else {
    for (let row = 0; row < map.height; row += 1) {
      relativePositions.add(map.positionAt(row, target.index, table.node));
    }
  }

  const paragraph = editor.state.schema.nodes.paragraph?.createAndFill();
  if (!paragraph) return false;
  const cells = [...relativePositions]
    .map((relativePos) => {
      const node = table.node.nodeAt(relativePos);
      return node ? { node, pos: table.pos + 1 + relativePos } : null;
    })
    .filter((cell): cell is { node: PMNode; pos: number } => cell !== null)
    .sort((a, b) => b.pos - a.pos);
  if (cells.length === 0) return false;

  const tr = editor.state.tr;
  for (const cell of cells) {
    tr.replaceWith(cell.pos + 1, cell.pos + cell.node.nodeSize - 1, paragraph);
  }
  return dispatchTableTransaction(
    editor,
    tr,
    table.pos,
    target,
    headerFlags(table.node),
  );
}

/** Select a complete row or column so the blue table-selection affordance and
 * subsequent keyboard/table commands agree with the handle the user clicked. */
export function selectTableAxis(
  editor: Editor,
  getPos: () => number,
  target: TableTarget,
): boolean {
  const table = liveTable(editor, getPos);
  if (!table) return false;
  const selection = axisSelection(editor.state.doc, table, target);
  if (!selection) return false;
  editor.view.dispatch(editor.state.tr.setSelection(selection).scrollIntoView());
  editor.view.focus();
  return true;
}

/** Run an insert/delete/header command against an explicit edge handle. */
export function runTableCommand(
  editor: Editor,
  getPos: () => number,
  _node: PMNode,
  command: TableCommand,
  target?: TableTarget,
): boolean {
  const table = liveTable(editor, getPos);
  if (!table) return false;
  if (command === "duplicateRow") {
    return target?.axis === "row"
      ? duplicateRow(editor, table, target.index)
      : false;
  }
  if (command === "duplicateColumn") {
    return target?.axis === "column"
      ? duplicateColumn(editor, table, target.index)
      : false;
  }
  if (command === "clearRow" || command === "clearColumn") {
    const axis = command === "clearRow" ? "row" : "column";
    return target?.axis === axis ? clearAxis(editor, table, target) : false;
  }
  const current = editor.state.selection;
  const inside =
    current.from > table.pos && current.to < table.pos + table.node.nodeSize;

  const ensureTargetSelection = ({
    tr,
    dispatch,
  }: {
    tr: Transaction;
    dispatch?: unknown;
  }) => {
    if (!dispatch) return true;
    if (target) {
      const selection = axisSelection(tr.doc, table, target);
      if (!selection) return false;
      tr.setSelection(selection);
    } else if (!inside) {
      // Backward-compatible fallback for callers without an edge target.
      const map = TableMap.get(table.node);
      const firstCell = table.pos + 1 + map.positionAt(0, 0, table.node);
      tr.setSelection(CellSelection.create(tr.doc, firstCell));
    }
    return true;
  };

  const chain = editor.chain().focus().command(ensureTargetSelection);
  switch (command) {
    case "addRowBefore":
      return chain.addRowBefore().run();
    case "addRowAfter":
      return chain.addRowAfter().run();
    case "addColumnBefore":
      return chain.addColumnBefore().run();
    case "addColumnAfter":
      return chain.addColumnAfter().run();
    case "deleteRow":
      return chain.deleteRow().run();
    case "deleteColumn":
      return chain.deleteColumn().run();
    case "toggleHeaderRow":
      return chain.toggleHeaderRow().run();
    case "toggleHeaderColumn":
      return chain.toggleHeaderColumn().run();
  }
}

export function tableHeaderState(table: PMNode): {
  row: boolean;
  column: boolean;
} {
  const map = TableMap.get(table);
  const row = Array.from({ length: map.width }, (_unused, column) =>
    table.nodeAt(map.positionAt(0, column, table)),
  ).every((cell) => cell?.type.spec.tableRole === "header_cell");
  const column = Array.from({ length: map.height }, (_unused, rowIndex) =>
    table.nodeAt(map.positionAt(rowIndex, 0, table)),
  ).every((cell) => cell?.type.spec.tableRole === "header_cell");
  return { row, column };
}

const headerFlags = tableHeaderState;

/** Keep header semantics attached to the first row/column after moving data. */
function normalizeHeaderEdges(
  tr: Transaction,
  tablePos: number,
  flags: { row: boolean; column: boolean },
): void {
  const table = tr.doc.nodeAt(tablePos);
  if (!table || table.type.spec.tableRole !== "table") return;
  const map = TableMap.get(table);
  const seen = new Set<number>();

  for (let row = 0; row < map.height; row += 1) {
    for (let column = 0; column < map.width; column += 1) {
      const relativePos = map.positionAt(row, column, table);
      if (seen.has(relativePos)) continue;
      seen.add(relativePos);
      const cell = table.nodeAt(relativePos);
      if (!cell) continue;
      const shouldBeHeader = (flags.row && row === 0) || (flags.column && column === 0);
      const desired = shouldBeHeader
        ? tr.doc.type.schema.nodes.tableHeader
        : tr.doc.type.schema.nodes.tableCell;
      if (desired && cell.type !== desired) {
        tr.setNodeMarkup(tablePos + 1 + relativePos, desired, cell.attrs, cell.marks);
      }
    }
  }
}

/** Move a row/column by index and leave the moved axis selected. */
export function moveTableAxis(
  editor: Editor,
  getPos: () => number,
  axis: TableAxis,
  from: number,
  to: number,
): boolean {
  if (from === to) return false;
  const table = liveTable(editor, getPos);
  if (!table) return false;
  const map = TableMap.get(table.node);
  const limit = axis === "row" ? map.height : map.width;
  if (from < 0 || to < 0 || from >= limit || to >= limit) return false;

  // The move helpers inspect the current selection while resolving the source
  // axis, even when `pos` is supplied, so install the handle's selection first.
  if (!selectTableAxis(editor, getPos, { axis, index: from })) return false;
  const flags = headerFlags(table.node);
  const command =
    axis === "row"
      ? moveTableRow({ from, to, select: true, pos: table.pos + 2 })
      : moveTableColumn({ from, to, select: true, pos: table.pos + 2 });

  return command(editor.state, (tr) => {
    normalizeHeaderEdges(tr, table.pos, flags);
    editor.view.dispatch(tr.scrollIntoView());
    editor.view.focus();
  });
}

"use client";

import {
  NodeViewWrapper,
  NodeViewContent,
  type NodeViewProps,
} from "@tiptap/react";
import { useT } from "@/lib/i18n/client";
import { runTableCommand, type TableCommand } from "../table-controls";

/**
 * React node-view for the native simple-table block. The table's cells stay
 * fully ProseMirror-managed (real CRDT nodes that co-edit) — this view only
 * adds the surrounding chrome: a hover control bar with Notion-style row /
 * column add / delete + a header-row toggle.
 *
 * Rendering follows the safe table-node-view shape: a plain `<table>` element
 * with `NodeViewContent as="tbody"` as the content host, mirroring the node's
 * default `['table', ['tbody', 0]]` renderHTML so ProseMirror's content
 * matching + `tableEditing` cell selection keep working. The control bar is
 * `contentEditable={false}` so PM ignores it, and each button does
 * `onMouseDown preventDefault` to keep the editor selection put while it runs
 * the command (see `table-controls.ts`).
 *
 * We deliberately do NOT enable `columnResizing` (the Table extension stays at
 * its `resizable: false` default), so there's no `prosemirror-tables` direct-
 * DOM resize handle fighting this React-rendered table.
 *
 * [COMP:app-web/doc-table]
 */
export function TableView(props: NodeViewProps) {
  const t = useT().docPage.table;
  const run = (command: TableCommand) => (e: React.MouseEvent) => {
    e.preventDefault();
    runTableCommand(props.editor, props.getPos, props.node, command);
  };

  const controls: Array<{ key: TableCommand; label: string }> = [
    { key: "addRowAfter", label: t.addRow },
    { key: "addColumnAfter", label: t.addColumn },
    { key: "deleteRow", label: t.deleteRow },
    { key: "deleteColumn", label: t.deleteColumn },
    { key: "toggleHeaderRow", label: t.toggleHeader },
  ];

  return (
    <NodeViewWrapper className="doc-table-block relative my-2">
      <div className="doc-table-controls" contentEditable={false}>
        {controls.map((c) => (
          <button
            key={c.key}
            type="button"
            tabIndex={-1}
            className="doc-table-control"
            title={c.label}
            aria-label={c.label}
            onMouseDown={run(c.key)}
          >
            {c.label}
          </button>
        ))}
      </div>
      <table className="doc-table">
        <NodeViewContent as="tbody" />
      </table>
    </NodeViewWrapper>
  );
}

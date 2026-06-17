/**
 * Editor-command glue for the simple-table node-view's row/column controls
 * (`table-view.tsx`). Kept out of the React component so the command logic is
 * unit-testable against a real headless ProseMirror editor (app-web's vitest
 * is node-only but can build the shared schema + drive an `Editor` in jsdom).
 *
 * The `prosemirror-tables` commands (`addRowAfter` / `addColumnAfter` /
 * `deleteRow` / `deleteColumn` / `toggleHeaderRow`) all act on the current
 * **cell selection**. When the user clicks a control button the editor
 * selection may not be inside this table (it's wherever the caret last was),
 * so `runTableCommand` first drops the selection into the table's first cell
 * (only if it isn't already inside), then runs the command in the same chain —
 * Tiptap's chained commands see the in-progress selection, so the table
 * command acts on the cell we just selected.
 *
 * [COMP:app-web/doc-table]
 */

import type { Editor } from "@tiptap/core";
// Side-effect import: brings the `prosemirror-tables` chain commands
// (`addRowAfter`/`addColumnAfter`/`deleteRow`/`deleteColumn`/`toggleHeaderRow`)
// into the `@tiptap/core` `Commands` augmentation so the chain is typed.
import "@tiptap/extension-table";
import type { Node as PMNode } from "@tiptap/pm/model";
import { TextSelection } from "@tiptap/pm/state";

export type TableCommand =
  | "addRowAfter"
  | "addColumnAfter"
  | "deleteRow"
  | "deleteColumn"
  | "toggleHeaderRow";

/**
 * Run a table command against the table whose node-view called this, returning
 * the boolean the underlying chain returns. `getPos` + `node` come from the
 * node-view props and bound the table's document range.
 */
export function runTableCommand(
  editor: Editor,
  getPos: () => number,
  node: PMNode,
  command: TableCommand,
): boolean {
  const pos = getPos();
  if (typeof pos !== "number") return false;
  const { from, to } = editor.state.selection;
  // Strictly inside the table's content (exclusive of its open/close tokens).
  const inside = from > pos && to < pos + node.nodeSize;

  const ensureSelectionInTable = ({
    tr,
    dispatch,
  }: {
    tr: import("@tiptap/pm/state").Transaction;
    dispatch?: unknown;
  }) => {
    if (!inside && dispatch) {
      const target = Math.min(pos + 1, tr.doc.content.size);
      tr.setSelection(TextSelection.near(tr.doc.resolve(target)));
    }
    return true;
  };

  const chain = editor.chain().focus().command(ensureSelectionInTable);
  switch (command) {
    case "addRowAfter":
      return chain.addRowAfter().run();
    case "addColumnAfter":
      return chain.addColumnAfter().run();
    case "deleteRow":
      return chain.deleteRow().run();
    case "deleteColumn":
      return chain.deleteColumn().run();
    case "toggleHeaderRow":
      return chain.toggleHeaderRow().run();
  }
}

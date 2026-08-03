/**
 * Notion-style trailing-edit-line invariant for simple tables.
 *
 * ProseMirror permits a table as the final top-level node, but a caret cannot
 * be placed after that node. Editable doc clients therefore heal table-last
 * documents by appending one empty paragraph on creation and after every
 * document-changing transaction (including a remote Yjs update).
 *
 * Browser-only and schema-neutral: the paragraph node already exists in the
 * shared schema; this extension only contributes lifecycle/plugin behavior.
 *
 * [COMP:app-web/doc-table]
 */

import { Extension, type Editor } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { Plugin } from "@tiptap/pm/state";

function tableNeedsTrailingParagraph(doc: PMNode): boolean {
  return doc.lastChild?.type.spec.tableRole === "table";
}

function appendTrailingParagraph(editor: Editor): boolean {
  if (!tableNeedsTrailingParagraph(editor.state.doc)) return false;
  return editor.commands.insertContentAt(editor.state.doc.content.size, {
    type: "paragraph",
  });
}

export function createTableTrailingParagraphExtension(): Extension {
  return Extension.create({
    name: "tableTrailingParagraph",

    onCreate() {
      appendTrailingParagraph(this.editor);
    },

    addProseMirrorPlugins() {
      return [
        new Plugin({
          appendTransaction(transactions, _oldState, newState) {
            if (!transactions.some((tr) => tr.docChanged)) return null;
            if (!tableNeedsTrailingParagraph(newState.doc)) return null;
            return newState.tr.insert(
              newState.doc.content.size,
              newState.schema.nodes.paragraph.create(),
            );
          },
        }),
      ];
    },
  });
}

/** Visible open/resolved Document comment ranges derived from relative anchors. [COMP:app-web/office-comments] */
import { Extension } from "@tiptap/core";
import type { Editor } from "@tiptap/react";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { OfficeCommentThread, OfficeSuggestion } from "@/lib/office/api";
import { resolveDocumentCommentAnchor } from "./comment-anchor";

const commentDecorationKey = new PluginKey<DecorationSet>("officeDocumentComments");

export const DocumentCommentDecorations = Extension.create({
  name: "officeDocumentComments",
  addProseMirrorPlugins() {
    return [new Plugin({
      key: commentDecorationKey,
      state: {
        init: () => DecorationSet.empty,
        apply(transaction, previous) {
          const replacement = transaction.getMeta(commentDecorationKey) as DecorationSet | undefined;
          return replacement ?? previous.map(transaction.mapping, transaction.doc);
        },
      },
      props: { decorations: (state) => commentDecorationKey.getState(state) ?? DecorationSet.empty },
    })];
  },
});

export function updateDocumentReviewDecorations(editor: Editor, threads: OfficeCommentThread[], suggestions: OfficeSuggestion[]): void {
  const commentDecorations = threads.flatMap((thread) => {
    if (thread.status === "detached" || thread.anchor.kind !== "text_range") return [];
    const range = resolveDocumentCommentAnchor(editor, thread.anchor);
    if (!range || range.from === range.to) return [];
    return [Decoration.inline(range.from, range.to, {
      class: `office-document-comment office-document-comment-${thread.status}`,
      "data-office-comment-id": thread.id,
      "data-office-comment-status": thread.status,
    })];
  });
  const suggestionDecorations = suggestions.flatMap((suggestion) => {
    if (suggestion.status !== "open" && suggestion.status !== "conflicted") return [];
    const command = suggestion.commandBatch;
    if (command.kind !== "replaceTextRange") return [];
    let start: number | null = null;
    let size = 0;
    editor.state.doc.descendants((node, position) => {
      if (start !== null || !node.isTextblock || node.attrs.id !== command.targetId) return;
      start = position + 1;
      size = node.content.size;
    });
    if (start === null || command.from > command.to || command.to > size) return [];
    return [Decoration.inline(start + command.from, start + command.to, {
      class: `office-document-suggestion office-document-suggestion-${suggestion.status}`,
      "data-office-suggestion-id": suggestion.id,
      "data-office-suggestion-status": suggestion.status,
    })];
  });
  editor.view.dispatch(editor.state.tr.setMeta(commentDecorationKey, DecorationSet.create(editor.state.doc, [...commentDecorations, ...suggestionDecorations])));
}

/** Visual-only page starts derived from the deterministic Office paginator. [COMP:app-web/office-document-editor] */
import { Extension } from "@tiptap/core";
import type { Editor } from "@tiptap/react";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

const paginationDecorationKey = new PluginKey<DecorationSet>("officeDocumentPagination");

export const DocumentPaginationDecorations = Extension.create({
  name: "officeDocumentPagination",
  addProseMirrorPlugins: () => [new Plugin({
    key: paginationDecorationKey,
    state: {
      init: () => DecorationSet.empty,
      apply(transaction, previous) {
        const replacement = transaction.getMeta(paginationDecorationKey) as DecorationSet | undefined;
        return replacement ?? previous.map(transaction.mapping, transaction.doc);
      },
    },
    props: { decorations: (state) => paginationDecorationKey.getState(state) ?? DecorationSet.empty },
  })],
});

export function refreshDocumentPagination(editor: Editor): void {
  editor.view.dispatch(editor.state.tr.setMeta(paginationDecorationKey, DecorationSet.empty));
  const firstObjectIds = pageStartIdsFromEditorDom(editor.view.dom);
  const decorations: Decoration[] = [];
  editor.state.doc.descendants((node, position) => {
    if (typeof node.attrs.id !== "string") return;
    if (!firstObjectIds.has(node.attrs.id)) return;
    decorations.push(Decoration.node(position, position + node.nodeSize, {
      class: "office-document-page-start",
      "data-office-page-start": "true",
    }));
  });
  editor.view.dispatch(editor.state.tr.setMeta(
    paginationDecorationKey,
    DecorationSet.create(editor.state.doc, decorations),
  ));
}

export type DocumentPaginationBlock = {
  id: string;
  heightPx: number;
  spacingBeforePx: number;
  breakAfter: boolean;
};

export function documentPageStartIds(blocks: DocumentPaginationBlock[], pageBodyHeightPx: number): Set<string> {
  const starts = new Set<string>();
  let used = 0;
  let forceNextPage = false;
  for (const block of blocks) {
    if (block.breakAfter) {
      forceNextPage = used > 0 || forceNextPage;
      continue;
    }
    const height = Math.max(0, block.heightPx) + (used > 0 ? Math.max(0, block.spacingBeforePx) : 0);
    if (forceNextPage || (used > 0 && used + height > pageBodyHeightPx)) {
      starts.add(block.id);
      used = Math.max(0, block.heightPx);
      forceNextPage = false;
      continue;
    }
    used += height;
  }
  return starts;
}

function pageStartIdsFromEditorDom(root: HTMLElement): Set<string> {
  const starts = new Set<string>();
  for (const section of root.querySelectorAll<HTMLElement>(".office-document-section")) {
    const style = window.getComputedStyle(section);
    const pageHeight = cssLengthPx(style.getPropertyValue("--office-page-height"), 792 * 4 / 3);
    const topMargin = cssLengthPx(style.getPropertyValue("--office-margin-top"), 72 * 4 / 3);
    const bottomMargin = cssLengthPx(style.getPropertyValue("--office-margin-bottom"), 72 * 4 / 3);
    const bodyHeight = Math.max(1, pageHeight - topMargin - bottomMargin);
    const blocks = [...(section.querySelector<HTMLElement>(".office-document-body")?.children ?? [])]
      .filter((child): child is HTMLElement => child instanceof HTMLElement)
      .map((child) => ({
        id: child.id,
        heightPx: child.getBoundingClientRect().height,
        spacingBeforePx: Number.parseFloat(window.getComputedStyle(child).marginTop) || 0,
        breakAfter: child.classList.contains("office-document-page-break") || child.classList.contains("office-document-section-break"),
      }))
      .filter((block) => block.id.length > 0);
    for (const id of documentPageStartIds(blocks, bodyHeight)) starts.add(id);
  }
  return starts;
}

function cssLengthPx(value: string, fallback: number): number {
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed)) return fallback;
  if (value.trim().endsWith("pt")) return parsed * 4 / 3;
  return parsed;
}

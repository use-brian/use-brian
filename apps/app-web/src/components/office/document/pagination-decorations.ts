/** Visual-only page starts measured from unpaginated editor DOM. [COMP:app-web/office-document-editor] */
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
  const attributes = pageAttributesFromEditorDom(editor.view.dom);
  const decorations: Decoration[] = [];
  editor.state.doc.descendants((node, position) => {
    if (typeof node.attrs.id !== "string") return;
    const attrs = attributes.get(node.attrs.id);
    if (attrs) decorations.push(Decoration.node(position, position + node.nodeSize, attrs));
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

export function documentPageLayout(blocks: DocumentPaginationBlock[], pageBodyHeightPx: number): {
  pageStarts: Map<string, number>;
  pageCount: number;
  overflowPx: number;
} {
  const pageStarts = new Map<string, number>();
  let used = 0;
  let overflowPx = 0;
  let forceNextPage = false;
  for (const block of blocks) {
    if (block.breakAfter) {
      forceNextPage = used > 0 || forceNextPage;
      // Break markers occupy DOM space too, even though they have no content.
      used += Math.max(0, block.spacingBeforePx) + Math.max(0, block.heightPx);
      continue;
    }
    const height = Math.max(0, block.heightPx) + Math.max(0, block.spacingBeforePx);
    if (forceNextPage || (used > 0 && used + height > pageBodyHeightPx)) {
      // The new page's margin replaces this block's ordinary spacing-before.
      // Keep the unused outgoing body area, not just the two page margins.
      pageStarts.set(block.id, Math.max(0, pageBodyHeightPx - used));
      overflowPx += Math.max(0, used - pageBodyHeightPx);
      used = Math.max(0, block.heightPx);
      forceNextPage = false;
      continue;
    }
    used += height;
  }
  return { pageStarts, pageCount: pageStarts.size + 1, overflowPx };
}

function pageAttributesFromEditorDom(root: HTMLElement): Map<string, Record<string, string>> {
  const attributes = new Map<string, Record<string, string>>();
  for (const section of root.querySelectorAll<HTMLElement>(".office-document-section")) {
    const style = window.getComputedStyle(section);
    const pageHeight = cssLengthPx(style.getPropertyValue("--office-page-height"), 792 * 4 / 3);
    const topMargin = cssLengthPx(style.getPropertyValue("--office-margin-top"), 72 * 4 / 3);
    const bottomMargin = cssLengthPx(style.getPropertyValue("--office-margin-bottom"), 72 * 4 / 3);
    const borderHeight = (Number.parseFloat(style.borderTopWidth) || 0) + (Number.parseFloat(style.borderBottomWidth) || 0);
    const bodyHeight = Math.max(1, pageHeight - topMargin - bottomMargin - borderHeight);
    const body = section.querySelector<HTMLElement>(".office-document-body");
    if (!body) continue;
    const blocks = measureDocumentPaginationBlocks(body);
    const { pageStarts, pageCount, overflowPx } = documentPageLayout(blocks, bodyHeight);
    // Reserve the final page's body area; the section supplies outer margins.
    attributes.set(body.id, {
      style: `--office-paginated-body-height: calc(${pageCount * pageHeight - topMargin - bottomMargin - borderHeight + overflowPx}px + ${pageCount - 1} * 1.5rem);`,
    });
    const paper = section.getBoundingClientRect();
    for (const child of body.children) {
      if (!(child instanceof HTMLElement)) continue;
      const remainingPx = pageStarts.get(child.id);
      if (remainingPx === undefined) continue;
      const block = child.getBoundingClientRect();
      attributes.set(child.id, {
        class: "office-document-page-start",
        "data-office-page-start": "true",
        style: `--office-page-remainder: ${remainingPx + borderHeight}px; --office-page-divider-left: ${paper.left - block.left - child.clientLeft}px; --office-page-divider-width: ${paper.width}px;`,
      });
    }
  }
  return attributes;
}

// Read adjacent border-box positions, not a sum of CSS margins: vertical
// margins may collapse and a previous block's margin-bottom may own the gap.
// The caller removes page decorations first, so gutters never feed back in.
export function measureDocumentPaginationBlocks(body: HTMLElement | null): DocumentPaginationBlock[] {
  let previousBottom = body?.getBoundingClientRect().top ?? 0;
  return [...(body?.children ?? [])]
    .filter((child): child is HTMLElement => child instanceof HTMLElement)
    .map((child) => {
      const rect = child.getBoundingClientRect();
      const spacingBeforePx = Math.max(0, rect.top - previousBottom);
      previousBottom = rect.bottom;
      return {
        id: child.id,
        heightPx: rect.height,
        spacingBeforePx,
        breakAfter: child.classList.contains("office-document-page-break") || child.classList.contains("office-document-section-break"),
      };
    })
    .filter(block => block.id.length > 0);
}

function cssLengthPx(value: string, fallback: number): number {
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed)) return fallback;
  if (value.trim().endsWith("pt")) return parsed * 4 / 3;
  return parsed;
}

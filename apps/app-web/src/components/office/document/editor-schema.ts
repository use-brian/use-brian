"use client";

/** Constrained Tiptap schema for the canonical Office Document subset. */
import { Mark, Node, mergeAttributes, type AnyExtension } from "@tiptap/core";
import { NodeViewContent, NodeViewWrapper, ReactNodeViewRenderer, useEditorState, type NodeViewProps } from "@tiptap/react";
import { createElement, type CSSProperties } from "react";
import StarterKit from "@tiptap/starter-kit";
import { officeTableResolvedColumnWidthsPt, officeNumberingCounter, type OfficeRichTextRun, type OfficeTable, type OfficeEditorJsonNode, type OfficeParagraphFormat } from "@use-brian/office-model";
import { officeDocumentCellStyles, officeParagraphCss, officeScaleSegments, officeScaledSegmentCss, officeTextAdvance, officeRunFontCss } from "@use-brian/office-renderer";
import { Extension } from "@tiptap/core";
import { Plugin } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { useOfficeResourceMedia } from "@/lib/use-doc-media";
import { DocumentCommentDecorations } from "./comment-decorations";
import { DocumentPaginationDecorations } from "./pagination-decorations";
import { findDocumentHeaderImage } from "./header-image-projection";

const attr = { default: null };
const attrs = (...names: string[]) => Object.fromEntries(names.map((name) => [name, attr]));
const render = (tag: string, className?: string) => ({ HTMLAttributes }: { HTMLAttributes: Record<string, unknown> }) => [tag, mergeAttributes(HTMLAttributes, className ? { class: className } : {}), 0] as const;
const atomRender = (tag: string, className: string) => ({ HTMLAttributes }: { HTMLAttributes: Record<string, unknown> }) => [tag, mergeAttributes(HTMLAttributes, { class: className })] as const;

const OfficeDocument = Node.create({ name: "doc", topNode: true, content: "officeSection+" });
const OfficeSection = Node.create({
  name: "officeSection", content: "officeHeader officeBody officeFooter", group: "block", defining: true,
  addAttributes: () => attrs("id", "page", "headerImage", "headerAlignment", "footerAlignment", "headerBorderBottom", "footerBorderTop", "showPageNumber"),
  parseHTML: () => [{ tag: "section[data-office-section]" }],
  renderHTML: ({ node, HTMLAttributes }) => ["section", mergeAttributes(withoutObjectAttributes(HTMLAttributes, ["page", "headerImage", "headerBorderBottom", "footerBorderTop"]), {
    class: "office-document-section", "data-office-section": "true",
    "data-office-page-number": node.attrs.showPageNumber ? "true" : "false",
    "data-header-alignment": node.attrs.headerAlignment ?? "start",
    "data-footer-alignment": node.attrs.footerAlignment ?? "start",
    "data-header-border": node.attrs.headerBorderBottom ? "true" : "false",
    "data-footer-border": node.attrs.footerBorderTop ? "true" : "false",
    style: sectionStyle(node.attrs.page),
  }), 0],
});
const OfficeHeader = Node.create({
  addOptions: () => ({artifactId:null as string|null}),
  name: "officeHeader", content: "inline*", group: "block", addAttributes: () => attrs("id"),
  parseHTML: () => [{ tag: "header[data-office-header]" }],
  renderHTML: ({ HTMLAttributes }) => ["header", mergeAttributes(HTMLAttributes, { class: "office-document-header", "data-office-header": "true" }), 0],
  addNodeView: () => ReactNodeViewRenderer(OfficeHeaderView),
});
const OfficeBody = Node.create({ name: "officeBody", content: "officeFlow*", group: "block", addAttributes: () => attrs("id"), parseHTML: () => [{ tag: "main[data-office-body]" }], renderHTML: render("main", "office-document-body") });
const OfficeFooter = Node.create({ name: "officeFooter", content: "inline*", group: "block", addAttributes: () => attrs("id"), parseHTML: () => [{ tag: "footer[data-office-footer]" }], renderHTML: ({ HTMLAttributes }) => ["footer", mergeAttributes(HTMLAttributes, { class: "office-document-footer", "data-office-footer": "true" }), 0] });

function OfficeHeaderView({ node, editor, extension }: NodeViewProps) {
  const sectionId = typeof node.attrs.id === "string" ? node.attrs.id.split(":header")[0] : "";
  const headerImage = useEditorState({
    editor,
    selector: ({ editor: current }) => findDocumentHeaderImage(current, sectionId),
  });
  const artifactId = extension.options.artifactId as string|null;
  const {url:src} = useOfficeResourceMedia(artifactId,headerImage?.resourceId??null);
  const style = headerImage ? {
    "--office-header-image-width": `${headerImage.displayWidthPt}pt`,
    "--office-header-image-height": `${headerImage.displayHeightPt}pt`,
    backgroundImage: src ? `url("${src.replaceAll('"', '%22')}")` : undefined,
  } as CSSProperties : undefined;
  return createElement(NodeViewWrapper, {
    as: "header",
    className: "office-document-header",
    "data-office-header": "true",
    "data-office-header-image": headerImage ? "true" : undefined,
    role: headerImage?.altText ? "img" : undefined,
    "aria-label": headerImage?.altText || undefined,
    style,
  }, createElement(NodeViewContent));
}

const Paragraph = Node.create({
  name: "paragraph", content: "inline*", group: "officeFlow", defining: true,
  addAttributes: () => attrs("id", "styleName", "alignment", "spacingBeforePt", "spacingAfterPt", "lineSpacingPt", "lineSpacingRule", "lineSpacingMultiple", "indentLeftPt", "hangingPt", "numbering"),
  parseHTML: () => [{ tag: "p" }], renderHTML: ({ node, HTMLAttributes }) => ["p", mergeAttributes(withoutObjectAttributes(HTMLAttributes, []), { style: blockStyle(HTMLAttributes, node) }), 0],
});
const Heading = Node.create({
  name: "heading", content: "inline*", group: "officeFlow", defining: true,
  addAttributes: () => attrs("id", "level", "styleName", "alignment", "spacingBeforePt", "spacingAfterPt", "lineSpacingPt", "lineSpacingRule", "lineSpacingMultiple", "indentLeftPt", "hangingPt", "numbering"),
  parseHTML: () => [1, 2, 3, 4, 5, 6].map((level) => ({ tag: `h${level}`, attrs: { level } })),
  renderHTML: ({ node, HTMLAttributes }) => [`h${Math.min(6, Math.max(1, Number(node.attrs.level) || 1))}`, mergeAttributes(withoutObjectAttributes(HTMLAttributes, []), { style: blockStyle(HTMLAttributes, node) }), 0],
});
const OfficeList = Node.create({
  name: "officeList", content: "officeListItem+", group: "officeFlow", defining: true,
  addAttributes: () => attrs("id", "ordered", "level"),
  parseHTML: () => [{ tag: "ul[data-office-list]" }, { tag: "ol[data-office-list]" }],
  renderHTML: ({ node, HTMLAttributes }) => [node.attrs.ordered ? "ol" : "ul", mergeAttributes(HTMLAttributes, { "data-office-list": "true", style: `padding-inline-start:${24 + Number(node.attrs.level ?? 0) * 20}px` }), 0],
});
const OfficeListItem = Node.create({ name: "officeListItem", content: "inline*", addAttributes: () => attrs("id"), parseHTML: () => [{ tag: "li[data-office-list-item]" }], renderHTML: render("li") });
function tableProjection(node: import("@tiptap/pm/model").Node): OfficeTable {
  return { ...node.attrs, id: String(node.attrs.id), headerRows: Number(node.attrs.headerRows ?? 0), kind: "table", rows: Array.from({ length: node.childCount }, (_, index) => {
    const row = node.child(index);
    return { ...row.attrs, id: String(row.attrs.id), cells: Array.from({ length: row.childCount }, (_, cellIndex) => ({ ...row.child(cellIndex).attrs, id: String(row.child(cellIndex).attrs.id), rowSpan: Number(row.child(cellIndex).attrs.rowSpan ?? 1), colSpan: Number(row.child(cellIndex).attrs.colSpan ?? 1), runs: [] })) };
  }) };
}
const OfficeTable = Node.create({
  name: "officeTable", content: "officeTableRow+", group: "officeFlow", defining: true,
  addAttributes: () => attrs("id", "headerRows", "columnWidthsPt", "widthPt", "alignment", "indentPt", "layout", "margins", "borders"),
  parseHTML: () => [{ tag: "table[data-office-table]" }],
  renderHTML: ({ node, HTMLAttributes }) => {
    const widths = officeTableResolvedColumnWidthsPt(tableProjection(node), Number(node.attrs.widthPt) || 468);
    const total = widths.reduce((sum, width) => sum + width, 0);
    return ["table", mergeAttributes(withoutObjectAttributes(HTMLAttributes, ["columnWidthsPt", "margins", "borders"]), { "data-office-table": "true", class: "office-document-table", style: tableStyle(HTMLAttributes) }),
      ["colgroup", {}, ...widths.map((width) => ["col", { style: `width:${width / total * 100}%` }])], ["tbody", {}, 0]];
  },
});
const OfficeTableRow = Node.create({ name: "officeTableRow", content: "officeTableCell*", addAttributes: () => attrs("id", "minHeightPt"), parseHTML: () => [{ tag: "tr" }], renderHTML: ({ HTMLAttributes }) => ["tr", mergeAttributes(HTMLAttributes, { style: typeof HTMLAttributes.minHeightPt === "number" ? `height:${HTMLAttributes.minHeightPt}pt` : undefined }), 0] });
const OfficeTableCell = Node.create({ name: "officeTableCell", content: "officeTableCellText+", isolating: true, addAttributes: () => attrs("id", "rowSpan", "colSpan", "fill", "alignment", "verticalAlignment", "margins", "borders", "wrapText"), parseHTML: () => [{ tag: "td" }, { tag: "th" }], renderHTML: ({ HTMLAttributes }) => ["td", mergeAttributes(withoutObjectAttributes(HTMLAttributes, ["margins", "borders"]), { rowspan: HTMLAttributes.rowSpan, colspan: HTMLAttributes.colSpan }), 0] });
const OfficeTableCellText = Node.create({
  priority: 1000,
  addKeyboardShortcuts() {
    return { Enter: () => {
      if (!this.editor.isActive("officeTableCellText")) return false;
      const { $from } = this.editor.state.selection;
      const attributes = $from.parent.attrs;
      const cellId = $from.node($from.depth - 1).attrs.id;
      const promoted = { ...attributes, paragraphStart: true, id: !attributes.paragraphStart || attributes.id === cellId ? crypto.randomUUID() : attributes.id };
      return this.editor.chain().command(({ tr }) => {
        tr.setNodeMarkup(tr.selection.$from.before(), undefined, promoted);
        return true;
      }).splitBlock().command(({ tr }) => {
        tr.setNodeMarkup(tr.selection.$from.before(), undefined, { ...attributes, id: crypto.randomUUID(), paragraphStart: true });
        return true;
      }).run();
    } };
  },
  name: "officeTableCellText", content: "inline*", group: "block", addAttributes: () => attrs("id", "paragraphStart", "alignment", "spacingBeforePt", "spacingAfterPt", "lineSpacingPt", "lineSpacingRule", "lineSpacingMultiple", "indentLeftPt", "hangingPt", "numbering"), parseHTML: () => [{ tag: "p[data-office-table-cell-text]" }], renderHTML: ({ node, HTMLAttributes }) => ["p", { "data-office-table-cell-text": "true", style: `margin:0;${blockStyle(HTMLAttributes, node) ?? ''}` }, 0] });

// Cell edges depend on their parent table and merged-cell placement. Decorations
// project them without persisting derived CSS or changing the collaboration data.
const OfficeTableFormatting = Extension.create({
  name: "officeTableFormatting",
  addProseMirrorPlugins: () => [new Plugin({ props: { decorations(state) {
    const decorations: Decoration[] = [];
    state.doc.descendants((node, position) => {
      if (node.type.name !== "officeTable") return;
      const table = tableProjection(node);
      const cellStyles = officeDocumentCellStyles(table, "pt");
      node.forEach((row, rowOffset) => row.forEach((cell, cellOffset) => {
        const start = position + 2 + rowOffset + cellOffset;
        decorations.push(Decoration.node(start, start + cell.nodeSize, { style: cellStyles.get(String(cell.attrs.id)) ?? "" }));
      }));
      return false;
    });
    return DecorationSet.create(state.doc, decorations);
  } } })],
});

// Parent DOM is reused for inline mark changes. Recompute the at-least strut
// from live runs rather than leaving the initial renderHTML font-size estimate.
const OfficeParagraphSpacing = Extension.create({
  name: "officeParagraphSpacing",
  addProseMirrorPlugins: () => [new Plugin({ props: { decorations(state) {
    const decorations: Decoration[] = [];
    state.doc.descendants((node, position) => {
      if (!["paragraph", "heading", "officeTableCellText"].includes(node.type.name) || node.attrs.lineSpacingRule !== "atLeast" || typeof node.attrs.lineSpacingPt !== "number" || node.attrs.lineSpacingMultiple != null) return;
      decorations.push(Decoration.node(position, position + node.nodeSize, {
        style: officeParagraphCss({ lineSpacingPt: node.attrs.lineSpacingPt, lineSpacingRule: "atLeast" }, "pt", maxRunFontSize(node)),
      }));
    });
    return DecorationSet.create(state.doc, decorations);
  } } })],
});

// Derived markers and scaled advances never enter the collaborative text.
// Inline decorations split only at wrap opportunities, not whole rich runs.
const OfficeInlineFidelity = Extension.create({
  name: "officeInlineFidelity",
  addProseMirrorPlugins() {
    let context: CanvasRenderingContext2D | null = null;
    if (typeof CanvasRenderingContext2D !== "undefined") context = document.createElement("canvas").getContext("2d");
    return [new Plugin({
      view(view) {
        const refresh = () => { if (!view.isDestroyed) view.dispatch(view.state.tr); };
        document.fonts?.addEventListener("loadingdone", refresh);
        return { destroy: () => document.fonts?.removeEventListener("loadingdone", refresh) };
      },
      props: { decorations(state) {
        const decorations: Decoration[] = [];
        const nextNumber = officeNumberingCounter();
        state.doc.descendants((node, position) => {
          if (["paragraph", "heading", "officeTableCellText"].includes(node.type.name) && node.attrs.numbering) {
            const definition = node.attrs.numbering as NonNullable<OfficeParagraphFormat["numbering"]>;
            const label = nextNumber(definition);
            const first = node.firstChild?.marks.find(mark => mark.type.name === "officeRun")?.attrs.style;
            const style = { fontFamily: "Arial", fontSizePt: 11, color: "#111111", ...first, ...definition.markerStyle } as OfficeRichTextRun["style"];
            decorations.push(Decoration.widget(position + 1, () => {
              const marker = document.createElement("span");
              marker.dataset.officeNumberMarker = "true";
              marker.textContent = label;
              marker.contentEditable = "false";
              marker.style.cssText = `${officeRunFontCss(style, "pt")};position:absolute;left:${Math.max(0, (node.attrs.indentLeftPt ?? 0) - (node.attrs.hangingPt ?? 0))}pt;white-space:pre;user-select:none;transform:scaleX(${(style.widthScalePercent ?? 100) / 100});transform-origin:left center`;
              return marker;
            }, { side: -1, key: `${node.attrs.id}:${label}:${node.attrs.indentLeftPt}:${node.attrs.hangingPt}:${JSON.stringify(style)}`, ignoreSelection: true }));
          }
          if (!node.isText || !node.text) return;
          const style = node.marks.find(mark => mark.type.name === "officeRun")?.attrs.style as OfficeRichTextRun["style"] | undefined;
          if (!style?.widthScalePercent || style.widthScalePercent === 100) return;
          const sizePx = style.fontSizePt * 96 / 72;
          if (context) context.font = `${style.italic ? "italic" : "normal"} ${style.bold ? "bold" : "normal"} ${sizePx}px ${JSON.stringify(style.fontFamily)}${style.eastAsianFontFamily ? `,${JSON.stringify(style.eastAsianFontFamily)}` : ""}`;
          for (const segment of officeScaleSegments(node.text)) {
            if (/[\r\n\t]/.test(segment.text)) continue;
            const width = context?.measureText(segment.text).width ?? officeTextAdvance(segment.text, sizePx);
            decorations.push(Decoration.inline(position + segment.offset, position + segment.offset + segment.text.length, {
              "data-office-width-scale": String(style.widthScalePercent),
              style: officeScaledSegmentCss(width, style.widthScalePercent),
            }));
          }
        });
        return DecorationSet.create(state.doc, decorations);
      } },
    })];
  },
});

function atom(name: string, label: string, extraAttrs: string[] = []): AnyExtension {
  return Node.create({ name, group: "officeFlow", atom: true, selectable: true, addAttributes: () => attrs("id", ...extraAttrs), parseHTML: () => [{ tag: `span[data-office-${label}]` }], renderHTML: atomRender("span", `office-document-${label}`) });
}

function projectionAtom(name: string, label: string, labelAttrs: string[], extraAttrs: string[] = []): AnyExtension {
  return Node.create({
    name,
    group: "officeFlow",
    atom: true,
    selectable: true,
    addAttributes: () => attrs("id", ...extraAttrs),
    parseHTML: () => [{ tag: `span[data-office-${label}]` }],
    renderHTML: ({ node, HTMLAttributes }) => {
      const accessibleLabel = labelAttrs
        .map((key) => node.attrs[key])
        .find((value) => typeof value === "string" && value.trim().length > 0);
      return ["span", mergeAttributes(withoutObjectAttributes(HTMLAttributes, []), {
        class: `office-document-${label}`,
        [`data-office-${label}`]: "true",
        "data-office-label": accessibleLabel,
        "aria-label": accessibleLabel,
      })];
    },
  });
}

const OfficeImage = Node.create({
  addOptions: () => ({artifactId:null as string|null}),
  name: "officeImage", group: "officeFlow", atom: true, selectable: true,
  addAttributes: () => attrs("id", "resourceId", "altText", "decorative", "widthPt", "heightPt", "crop"),
  parseHTML: () => [{ tag: "figure[data-office-image]" }],
  renderHTML: atomRender("figure", "office-document-image"),
  addNodeView: () => ReactNodeViewRenderer(OfficeImageView),
});

function OfficeImageView({ node, extension }: NodeViewProps) {
  const artifactId = extension.options.artifactId as string|null;
  const {url:src} = useOfficeResourceMedia(artifactId,typeof node.attrs.resourceId==='string'?node.attrs.resourceId:null);
  const alt = node.attrs.decorative ? "" : String(node.attrs.altText ?? "");
  return createElement(NodeViewWrapper, { as: "figure", "data-office-image": "true", className: "office-document-image", style: { width: `${Number(node.attrs.widthPt ?? 240)}pt`, maxWidth: "100%" } },
    src
      ? createElement("img", { src, alt, draggable: false, style: { width: "100%", height: `${Number(node.attrs.heightPt ?? 160)}pt`, objectFit: "contain" } })
      : createElement("span", { role: "img", "aria-label": alt || undefined, className: "flex min-h-20 items-center justify-center rounded border bg-muted text-xs text-muted-foreground" }, alt),
  );
}

function runCss(runStyle: Record<string, unknown> | null): string | undefined {
  return runStyle ? [
      "line-height:var(--office-run-line-height,inherit)", `font-family:${JSON.stringify(runStyle.fontFamily)}${runStyle.eastAsianFontFamily ? `,${JSON.stringify(runStyle.eastAsianFontFamily)}` : ""}`, `font-size:${String(runStyle.fontSizePt)}pt`,
      runStyle.bold ? "font-weight:700" : "font-weight:400", runStyle.italic ? "font-style:italic" : "font-style:normal",
      runStyle.color ? `color:${String(runStyle.color)}` : "", runStyle.highlight ? `background-color:${String(runStyle.highlight)}` : "",
      runStyle.underline || runStyle.strike ? `text-decoration:${[runStyle.underline ? "underline" : "", runStyle.strike ? "line-through" : ""].filter(Boolean).join(" ")}` : "",
  ].filter(Boolean).join(";") : undefined;
}

const OfficeEmptyRun = Node.create({ name: "officeEmptyRun", inline: true, group: "inline", atom: true, selectable: false, addAttributes: () => attrs("id", "style", "href"), parseHTML: () => [{ tag: "span[data-office-empty-run]" }], renderHTML: ({ HTMLAttributes }) => ["span", mergeAttributes(withoutObjectAttributes(HTMLAttributes, ["style"]), { "data-office-empty-run": "true", "aria-hidden": "true", style: runCss(HTMLAttributes.style as Record<string, unknown> | null) }), "\u200b"] });
const OfficeRun = Mark.create({
  name: "officeRun", inclusive: true,
  addAttributes: () => attrs("id", "style", "href"),
  parseHTML: () => [{ tag: "span[data-office-run]" }, { tag: "a[data-office-run]" }],
  renderHTML: ({ HTMLAttributes }) => {
    const runStyle = HTMLAttributes.style as Record<string, unknown> | null;
    const css = runCss(runStyle);
    const tag = HTMLAttributes.href ? "a" : "span";
    const { style: _style, ...attributes } = HTMLAttributes;
    return [tag, mergeAttributes(attributes, { "data-office-run": "true", style: css, rel: tag === "a" ? "noopener noreferrer" : undefined }), 0];
  },
});

export function officeDocumentEditorExtensions(artifactId:string|null=null): AnyExtension[] {
  return [
    OfficeDocument, OfficeSection, OfficeHeader.configure({artifactId}), OfficeBody, OfficeFooter,
    Paragraph, Heading, OfficeList, OfficeListItem, OfficeTable, OfficeTableRow,
    OfficeTableCell, OfficeTableCellText, OfficeTableFormatting, OfficeParagraphSpacing, OfficeInlineFidelity, OfficeEmptyRun, OfficeRun,
    OfficeImage.configure({artifactId}),
    DocumentCommentDecorations,
    projectionAtom("officeChart", "chart", ["altText", "title"], ["chartType", "title", "categories", "series", "altText"]),
    projectionAtom("officeVideo", "video", ["altText", "transcript", "recipientAccessibleUrl"], ["resourceId", "posterResourceId", "altText", "captionsResourceId", "transcript", "recipientAccessibleUrl"]),
    atom("officePageBreak", "page-break"), atom("officeSectionBreak", "section-break"),
    StarterKit.configure({ document: false, paragraph: false, heading: false, bulletList: false, orderedList: false, listItem: false, history: false, blockquote: false, codeBlock: false, horizontalRule: false }),
    DocumentPaginationDecorations,
  ];
}

function sectionStyle(page: unknown): string | undefined {
  if (!page || typeof page !== "object") return undefined;
  const value = page as Record<string, unknown>;
  return [`--office-page-width:${Number(value.widthPt)}pt`, `--office-page-height:${Number(value.heightPt)}pt`, `--office-margin-top:${Number(value.marginTopPt)}pt`, `--office-margin-right:${Number(value.marginRightPt)}pt`, `--office-margin-bottom:${Number(value.marginBottomPt)}pt`, `--office-margin-left:${Number(value.marginLeftPt)}pt`].join(";");
}

function withoutObjectAttributes(value: Record<string, unknown>, names: string[]): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([key, field]) => !names.includes(key) && (typeof field !== "object" || field === null)));
}

function maxRunFontSize(node: import("@tiptap/pm/model").Node): number {
  let maxRunFontSizePt = 1;
  node.forEach((child) => {
    const style = child.type.name === "officeEmptyRun" ? child.attrs.style : child.marks.find((mark) => mark.type.name === "officeRun")?.attrs.style;
    if (typeof style?.fontSizePt === "number") maxRunFontSizePt = Math.max(maxRunFontSizePt, style.fontSizePt);
  });
  return maxRunFontSizePt;
}

function blockStyle(value: Record<string, unknown>, node: import("@tiptap/pm/model").Node): string | undefined {
  return officeParagraphCss(Object.fromEntries(Object.entries(value).filter(([, field]) => field != null)) as OfficeParagraphFormat, "pt", maxRunFontSize(node)) || undefined;
}

function tableStyle(value: Record<string, unknown>): string | undefined {
  const styles: string[] = [];
  if (typeof value.widthPt === "number") styles.push(`width:${value.widthPt}pt;max-width:100%`);
  styles.push(`table-layout:${value.layout === "autofit" && !value.columnWidthsPt ? "auto" : "fixed"}`);
  if (typeof value.widthPt !== "number" && Array.isArray(value.columnWidthsPt)) styles.push(`width:${value.columnWidthsPt.reduce((sum, width) => sum + Number(width), 0)}pt;max-width:100%`);
  if (typeof value.indentPt === "number") styles.push(`margin-inline-start:${value.indentPt}pt`);
  if (value.alignment === "center") styles.push("margin-inline:auto");
  if (value.alignment === "end") styles.push("margin-inline-start:auto");
  return styles.join(";") || undefined;
}

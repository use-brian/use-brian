"use client";

/** Constrained Tiptap schema for the canonical Office Document subset. */
import { Mark, Node, mergeAttributes, type AnyExtension } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import type { OfficeEditorJsonNode } from "@use-brian/office-model";

const attr = { default: null };
const attrs = (...names: string[]) => Object.fromEntries(names.map((name) => [name, attr]));
const render = (tag: string, className?: string) => ({ HTMLAttributes }: { HTMLAttributes: Record<string, unknown> }) => [tag, mergeAttributes(HTMLAttributes, className ? { class: className } : {}), 0] as const;
const atomRender = (tag: string, className: string) => ({ HTMLAttributes }: { HTMLAttributes: Record<string, unknown> }) => [tag, mergeAttributes(HTMLAttributes, { class: className })] as const;

const OfficeDocument = Node.create({ name: "doc", topNode: true, content: "officeSection+" });
const OfficeSection = Node.create({
  name: "officeSection", content: "officeHeader officeBody officeFooter", group: "block", defining: true,
  addAttributes: () => attrs("id", "page", "headerImage", "headerAlignment", "footerAlignment", "headerBorderBottom", "footerBorderTop", "showPageNumber"),
  parseHTML: () => [{ tag: "section[data-office-section]" }], renderHTML: render("section", "office-document-section"),
});
const OfficeHeader = Node.create({ name: "officeHeader", content: "inline*", group: "block", addAttributes: () => attrs("id"), parseHTML: () => [{ tag: "header[data-office-header]" }], renderHTML: render("header", "office-document-header") });
const OfficeBody = Node.create({ name: "officeBody", content: "officeFlow*", group: "block", addAttributes: () => attrs("id"), parseHTML: () => [{ tag: "main[data-office-body]" }], renderHTML: render("main", "office-document-body") });
const OfficeFooter = Node.create({ name: "officeFooter", content: "inline*", group: "block", addAttributes: () => attrs("id"), parseHTML: () => [{ tag: "footer[data-office-footer]" }], renderHTML: render("footer", "office-document-footer") });

const Paragraph = Node.create({
  name: "paragraph", content: "inline*", group: "officeFlow", defining: true,
  addAttributes: () => attrs("id", "styleName", "alignment", "spacingBeforePt", "spacingAfterPt", "lineSpacingPt"),
  parseHTML: () => [{ tag: "p" }], renderHTML: render("p"),
});
const Heading = Node.create({
  name: "heading", content: "inline*", group: "officeFlow", defining: true,
  addAttributes: () => attrs("id", "level", "styleName", "alignment", "spacingBeforePt", "spacingAfterPt", "lineSpacingPt"),
  parseHTML: () => [1, 2, 3, 4, 5, 6].map((level) => ({ tag: `h${level}`, attrs: { level } })),
  renderHTML: ({ node, HTMLAttributes }) => [`h${Math.min(6, Math.max(1, Number(node.attrs.level) || 1))}`, HTMLAttributes, 0],
});
const OfficeList = Node.create({
  name: "officeList", content: "officeListItem+", group: "officeFlow", defining: true,
  addAttributes: () => attrs("id", "ordered", "level"),
  parseHTML: () => [{ tag: "ul[data-office-list]" }, { tag: "ol[data-office-list]" }],
  renderHTML: ({ node, HTMLAttributes }) => [node.attrs.ordered ? "ol" : "ul", mergeAttributes(HTMLAttributes, { "data-office-list": "true" }), 0],
});
const OfficeListItem = Node.create({ name: "officeListItem", content: "inline*", addAttributes: () => attrs("id"), parseHTML: () => [{ tag: "li[data-office-list-item]" }], renderHTML: render("li") });
const OfficeTable = Node.create({ name: "officeTable", content: "officeTableRow+", group: "officeFlow", defining: true, addAttributes: () => attrs("id", "headerRows", "columnWidthsPt", "widthPt", "alignment", "indentPt", "layout", "margins", "borders"), parseHTML: () => [{ tag: "table[data-office-table]" }], renderHTML: render("table", "office-document-table") });
const OfficeTableRow = Node.create({ name: "officeTableRow", content: "officeTableCell+", addAttributes: () => attrs("id", "minHeightPt"), parseHTML: () => [{ tag: "tr" }], renderHTML: render("tr") });
const OfficeTableCell = Node.create({ name: "officeTableCell", content: "officeTableCellText", isolating: true, addAttributes: () => attrs("id", "rowSpan", "colSpan", "fill", "alignment", "verticalAlignment", "margins", "borders", "wrapText"), parseHTML: () => [{ tag: "td" }, { tag: "th" }], renderHTML: ({ HTMLAttributes }) => ["td", mergeAttributes(HTMLAttributes, { rowspan: HTMLAttributes.rowSpan, colspan: HTMLAttributes.colSpan }), 0] });
const OfficeTableCellText = Node.create({ name: "officeTableCellText", content: "inline*", group: "block", addAttributes: () => attrs("id"), parseHTML: () => [{ tag: "p[data-office-table-cell-text]" }], renderHTML: render("p") });

function atom(name: string, label: string, extraAttrs: string[] = []): AnyExtension {
  return Node.create({ name, group: "officeFlow", atom: true, selectable: true, addAttributes: () => attrs("id", ...extraAttrs), parseHTML: () => [{ tag: `span[data-office-${label}]` }], renderHTML: atomRender("span", `office-document-${label}`) });
}

const OfficeEmptyRun = Node.create({ name: "officeEmptyRun", inline: true, group: "inline", atom: true, selectable: false, addAttributes: () => attrs("id", "style", "href"), parseHTML: () => [{ tag: "span[data-office-empty-run]" }], renderHTML: ({ HTMLAttributes }) => ["span", mergeAttributes(HTMLAttributes, { "data-office-empty-run": "true", "aria-hidden": "true" }), "\u200b"] });
const OfficeRun = Mark.create({
  name: "officeRun", inclusive: true,
  addAttributes: () => attrs("id", "style", "href"),
  parseHTML: () => [{ tag: "span[data-office-run]" }, { tag: "a[data-office-run]" }],
  renderHTML: ({ HTMLAttributes }) => {
    const runStyle = HTMLAttributes.style as Record<string, unknown> | null;
    const css = runStyle ? [
      `font-family:${String(runStyle.fontFamily)}`, `font-size:${String(runStyle.fontSizePt)}pt`,
      runStyle.bold ? "font-weight:700" : "", runStyle.italic ? "font-style:italic" : "",
      runStyle.color ? `color:${String(runStyle.color)}` : "", runStyle.highlight ? `background-color:${String(runStyle.highlight)}` : "",
      runStyle.underline || runStyle.strike ? `text-decoration:${[runStyle.underline ? "underline" : "", runStyle.strike ? "line-through" : ""].filter(Boolean).join(" ")}` : "",
    ].filter(Boolean).join(";") : undefined;
    const tag = HTMLAttributes.href ? "a" : "span";
    const { style: _style, ...attributes } = HTMLAttributes;
    return [tag, mergeAttributes(attributes, { "data-office-run": "true", style: css, rel: tag === "a" ? "noopener noreferrer" : undefined }), 0];
  },
});

export function officeDocumentEditorExtensions(): AnyExtension[] {
  return [
    OfficeDocument, OfficeSection, OfficeHeader, OfficeBody, OfficeFooter,
    Paragraph, Heading, OfficeList, OfficeListItem, OfficeTable, OfficeTableRow,
    OfficeTableCell, OfficeTableCellText, OfficeEmptyRun, OfficeRun,
    atom("officeImage", "image", ["resourceId", "altText", "decorative", "widthPt", "heightPt", "crop"]),
    atom("officeChart", "chart", ["chartType", "title", "categories", "series", "altText"]),
    atom("officeVideo", "video", ["resourceId", "posterResourceId", "altText", "captionsResourceId", "transcript", "recipientAccessibleUrl"]),
    atom("officePageBreak", "page-break"), atom("officeSectionBreak", "section-break"),
    StarterKit.configure({ document: false, paragraph: false, heading: false, bulletList: false, orderedList: false, listItem: false, history: false, blockquote: false, codeBlock: false, horizontalRule: false }),
  ];
}

export function editorPlainText(node: OfficeEditorJsonNode): string {
  if (node.type === "text") return node.text ?? "";
  if (["officeImage", "officeChart", "officeVideo", "officePageBreak", "officeSectionBreak", "officeEmptyRun"].includes(node.type)) return "";
  return (node.content ?? []).map(editorPlainText).join(["paragraph", "heading", "officeListItem", "officeTableCellText"].includes(node.type) ? "" : "\n");
}

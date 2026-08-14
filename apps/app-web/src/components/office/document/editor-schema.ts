"use client";

/** Constrained Tiptap schema for the canonical Office Document subset. */
import { Mark, Node, mergeAttributes, type AnyExtension } from "@tiptap/core";
import { NodeViewContent, NodeViewWrapper, ReactNodeViewRenderer, useEditorState, type NodeViewProps } from "@tiptap/react";
import { createElement, useEffect, useState, type CSSProperties } from "react";
import StarterKit from "@tiptap/starter-kit";
import type { OfficeEditorJsonNode } from "@use-brian/office-model";
import { getOfficeResourceObjectUrl } from "@/lib/office/api";
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
  name: "officeHeader", content: "inline*", group: "block", addAttributes: () => attrs("id"),
  parseHTML: () => [{ tag: "header[data-office-header]" }],
  renderHTML: ({ HTMLAttributes }) => ["header", mergeAttributes(HTMLAttributes, { class: "office-document-header", "data-office-header": "true" }), 0],
  addNodeView: () => ReactNodeViewRenderer(OfficeHeaderView),
});
const OfficeBody = Node.create({ name: "officeBody", content: "officeFlow*", group: "block", addAttributes: () => attrs("id"), parseHTML: () => [{ tag: "main[data-office-body]" }], renderHTML: render("main", "office-document-body") });
const OfficeFooter = Node.create({ name: "officeFooter", content: "inline*", group: "block", addAttributes: () => attrs("id"), parseHTML: () => [{ tag: "footer[data-office-footer]" }], renderHTML: ({ HTMLAttributes }) => ["footer", mergeAttributes(HTMLAttributes, { class: "office-document-footer", "data-office-footer": "true" }), 0] });

function OfficeHeaderView({ node, editor }: NodeViewProps) {
  const sectionId = typeof node.attrs.id === "string" ? node.attrs.id.split(":header")[0] : "";
  const headerImage = useEditorState({
    editor,
    selector: ({ editor: current }) => findDocumentHeaderImage(current, sectionId),
  });
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    setSrc(null);
    const artifactId = document.querySelector<HTMLElement>("[data-office-editor='document']")?.dataset.officeArtifactId;
    if (!artifactId || !headerImage) return () => { active = false; };
    void getOfficeResourceObjectUrl(artifactId, headerImage.resourceId).then((url) => { if (active) setSrc(url); }).catch(() => undefined);
    return () => { active = false; };
  }, [headerImage?.resourceId]);
  const style = headerImage ? {
    "--office-header-image-width": `${headerImage.widthPt}pt`,
    "--office-header-image-height": `${headerImage.heightPt}pt`,
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
  addAttributes: () => attrs("id", "styleName", "alignment", "spacingBeforePt", "spacingAfterPt", "lineSpacingPt"),
  parseHTML: () => [{ tag: "p" }], renderHTML: ({ HTMLAttributes }) => ["p", mergeAttributes(withoutObjectAttributes(HTMLAttributes, []), { style: blockStyle(HTMLAttributes) }), 0],
});
const Heading = Node.create({
  name: "heading", content: "inline*", group: "officeFlow", defining: true,
  addAttributes: () => attrs("id", "level", "styleName", "alignment", "spacingBeforePt", "spacingAfterPt", "lineSpacingPt"),
  parseHTML: () => [1, 2, 3, 4, 5, 6].map((level) => ({ tag: `h${level}`, attrs: { level } })),
  renderHTML: ({ node, HTMLAttributes }) => [`h${Math.min(6, Math.max(1, Number(node.attrs.level) || 1))}`, mergeAttributes(withoutObjectAttributes(HTMLAttributes, []), { style: blockStyle(HTMLAttributes) }), 0],
});
const OfficeList = Node.create({
  name: "officeList", content: "officeListItem+", group: "officeFlow", defining: true,
  addAttributes: () => attrs("id", "ordered", "level"),
  parseHTML: () => [{ tag: "ul[data-office-list]" }, { tag: "ol[data-office-list]" }],
  renderHTML: ({ node, HTMLAttributes }) => [node.attrs.ordered ? "ol" : "ul", mergeAttributes(HTMLAttributes, { "data-office-list": "true", style: `padding-inline-start:${24 + Number(node.attrs.level ?? 0) * 20}px` }), 0],
});
const OfficeListItem = Node.create({ name: "officeListItem", content: "inline*", addAttributes: () => attrs("id"), parseHTML: () => [{ tag: "li[data-office-list-item]" }], renderHTML: render("li") });
const OfficeTable = Node.create({ name: "officeTable", content: "officeTableRow+", group: "officeFlow", defining: true, addAttributes: () => attrs("id", "headerRows", "columnWidthsPt", "widthPt", "alignment", "indentPt", "layout", "margins", "borders"), parseHTML: () => [{ tag: "table[data-office-table]" }], renderHTML: ({ HTMLAttributes }) => ["table", mergeAttributes(withoutObjectAttributes(HTMLAttributes, ["columnWidthsPt", "margins", "borders"]), { class: "office-document-table", style: tableStyle(HTMLAttributes) }), 0] });
const OfficeTableRow = Node.create({ name: "officeTableRow", content: "officeTableCell+", addAttributes: () => attrs("id", "minHeightPt"), parseHTML: () => [{ tag: "tr" }], renderHTML: render("tr") });
const OfficeTableCell = Node.create({ name: "officeTableCell", content: "officeTableCellText", isolating: true, addAttributes: () => attrs("id", "rowSpan", "colSpan", "fill", "alignment", "verticalAlignment", "margins", "borders", "wrapText"), parseHTML: () => [{ tag: "td" }, { tag: "th" }], renderHTML: ({ HTMLAttributes }) => ["td", mergeAttributes(withoutObjectAttributes(HTMLAttributes, ["margins", "borders"]), { rowspan: HTMLAttributes.rowSpan, colspan: HTMLAttributes.colSpan, style: cellStyle(HTMLAttributes) }), 0] });
const OfficeTableCellText = Node.create({ name: "officeTableCellText", content: "inline*", group: "block", addAttributes: () => attrs("id"), parseHTML: () => [{ tag: "p[data-office-table-cell-text]" }], renderHTML: render("p") });

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
  name: "officeImage", group: "officeFlow", atom: true, selectable: true,
  addAttributes: () => attrs("id", "resourceId", "altText", "decorative", "widthPt", "heightPt", "crop"),
  parseHTML: () => [{ tag: "figure[data-office-image]" }],
  renderHTML: atomRender("figure", "office-document-image"),
  addNodeView: () => ReactNodeViewRenderer(OfficeImageView),
});

function OfficeImageView({ node }: { node: { attrs: Record<string, unknown> } }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    const artifactId = document.querySelector<HTMLElement>("[data-office-editor='document']")?.dataset.officeArtifactId;
    if (!artifactId || typeof node.attrs.resourceId !== "string") return;
    void getOfficeResourceObjectUrl(artifactId, node.attrs.resourceId).then((url) => { if (active) setSrc(url); }).catch(() => undefined);
    return () => { active = false; };
  }, [node.attrs.resourceId]);
  const alt = node.attrs.decorative ? "" : String(node.attrs.altText ?? "");
  return createElement(NodeViewWrapper, { as: "figure", "data-office-image": "true", className: "office-document-image", style: { width: `${Number(node.attrs.widthPt ?? 240)}pt`, maxWidth: "100%" } },
    src
      ? createElement("img", { src, alt, draggable: false, style: { width: "100%", height: `${Number(node.attrs.heightPt ?? 160)}pt`, objectFit: "contain" } })
      : createElement("span", { role: "img", "aria-label": alt || undefined, className: "flex min-h-20 items-center justify-center rounded border bg-muted text-xs text-muted-foreground" }, alt),
  );
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
    OfficeImage,
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

function cellStyle(value: Record<string, unknown>): string | undefined {
  const styles: string[] = [];
  if (typeof value.fill === "string") styles.push(`background-color:${value.fill}`);
  if (typeof value.alignment === "string") styles.push(`text-align:${value.alignment === "start" ? "left" : value.alignment === "end" ? "right" : value.alignment}`);
  if (typeof value.verticalAlignment === "string") styles.push(`vertical-align:${value.verticalAlignment}`);
  return styles.join(";") || undefined;
}

function blockStyle(value: Record<string, unknown>): string | undefined {
  const styles: string[] = [];
  if (typeof value.alignment === "string") styles.push(`text-align:${value.alignment === "start" ? "left" : value.alignment === "end" ? "right" : value.alignment}`);
  if (typeof value.spacingBeforePt === "number") styles.push(`margin-top:${value.spacingBeforePt}pt`);
  if (typeof value.spacingAfterPt === "number") styles.push(`margin-bottom:${value.spacingAfterPt}pt`);
  if (typeof value.lineSpacingPt === "number") styles.push(`line-height:${value.lineSpacingPt}pt`);
  return styles.join(";") || undefined;
}

function tableStyle(value: Record<string, unknown>): string | undefined {
  const styles: string[] = [];
  if (typeof value.widthPt === "number") styles.push(`width:${value.widthPt}pt;max-width:100%`);
  if (value.layout === "fixed") styles.push("table-layout:fixed");
  if (typeof value.indentPt === "number") styles.push(`margin-inline-start:${value.indentPt}pt`);
  if (value.alignment === "center") styles.push("margin-inline:auto");
  if (value.alignment === "end") styles.push("margin-inline-start:auto");
  return styles.join(";") || undefined;
}

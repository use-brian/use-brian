"use client";

/** Fragment-native Document actions shared by every adaptive toolbar surface. [COMP:app-web/office-document-editor] */
import type { Editor } from "@tiptap/react";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import type { OfficeRichTextRun } from "@use-brian/office-model";

export type DocumentRunFormatting = Partial<OfficeRichTextRun["style"]> & { href?: string | null };
export type DocumentBlockStyle = "Body" | "Title" | "Subtitle" | `Heading ${1 | 2 | 3 | 4 | 5 | 6}`;
export type DocumentAlignment = "start" | "center" | "end" | "justify";

export const DOCUMENT_EDITOR_ACTIONS = {
  richText: ["fontFamily", "fontSize", "bold", "italic", "underline", "strike", "textColor", "highlight", "clearFormatting"],
  hyperlink: ["link", "unlink"],
  table: ["insertTable", "addRow", "deleteRow", "addColumn", "deleteColumn", "mergeCellRight", "splitCell", "tableHeader", "tableCellFill", "tableBorders", "tableColumnWidth"],
  image: ["insertImage", "replaceImage", "imageSize", "imageAlt", "imageDecorative", "deleteImage"],
  namedStyles: ["Body", "Title", "Subtitle"],
  heading: ["Heading 1", "Heading 2", "Heading 3", "Heading 4", "Heading 5", "Heading 6"],
  nestedList: ["bulletList", "numberedList", "indentList", "outdentList"],
  pageSetup: ["pageSize", "orientation", "margins"],
  pageBreak: ["insertPageBreak"],
  sectionBreak: ["insertSectionBreak"],
  headerFooter: ["headerContent", "footerContent", "headerAlignment", "footerAlignment", "headerBorder", "footerBorder"],
  pageNumber: ["togglePageNumber"],
} as const;

const DEFAULT_STYLE: OfficeRichTextRun["style"] = {
  fontFamily: "Arial",
  fontSizePt: 11,
  bold: false,
  italic: false,
  underline: false,
  strike: false,
  color: "#111111",
};

type Ancestor = { node: ProseMirrorNode; pos: number; depth: number };

function ancestor(editor: Editor, names: readonly string[]): Ancestor | null {
  const $from = editor.state.selection.$from;
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    const node = $from.node(depth);
    if (names.includes(node.type.name)) return { node, pos: $from.before(depth), depth };
  }
  return null;
}

function uuid(): string {
  return crypto.randomUUID();
}

function richMark(editor: Editor, attrs?: Record<string, unknown>) {
  return editor.schema.marks.officeRun.create({ id: uuid(), style: DEFAULT_STYLE, ...attrs });
}

export function documentSelectionFormatting(editor: Editor | null): Array<OfficeRichTextRun["style"] & { href?: string }> {
  if (!editor || editor.state.selection.empty) return [];
  const values: Array<OfficeRichTextRun["style"] & { href?: string }> = [];
  const { from, to } = editor.state.selection;
  editor.state.doc.nodesBetween(from, to, (node) => {
    if (!node.isText) return;
    const mark = node.marks.find((candidate) => candidate.type.name === "officeRun");
    const style = (mark?.attrs.style ?? DEFAULT_STYLE) as OfficeRichTextRun["style"];
    values.push({ ...style, ...(typeof mark?.attrs.href === "string" ? { href: mark.attrs.href } : {}) });
  });
  return values;
}

export function documentSelectionHasStyle(editor: Editor | null, field: "bold" | "italic" | "underline" | "strike"): boolean {
  const styles = documentSelectionFormatting(editor);
  return styles.length > 0 && styles.every((style) => style[field]);
}

export function applyDocumentRunFormatting(editor: Editor | null, patch: DocumentRunFormatting): void {
  if (!editor || editor.state.selection.empty) return;
  const { from, to } = editor.state.selection;
  const transaction = editor.state.tr;
  editor.state.doc.nodesBetween(from, to, (node, position) => {
    if (!node.isText) return;
    const existing = node.marks.find((candidate) => candidate.type.name === "officeRun");
    const start = Math.max(from, position);
    const end = Math.min(to, position + node.nodeSize);
    if (start >= end) return;
    if (existing) transaction.removeMark(start, end, existing.type);
    const previousStyle = (existing?.attrs.style ?? DEFAULT_STYLE) as OfficeRichTextRun["style"];
    const nextHref = patch.href === null ? undefined : patch.href ?? existing?.attrs.href;
    const { href: _href, ...stylePatch } = patch;
    const style = Object.fromEntries(Object.entries({ ...previousStyle, ...stylePatch }).filter(([, value]) => value !== undefined));
    transaction.addMark(start, end, richMark(editor, {
      style,
      ...(nextHref ? { href: nextHref } : {}),
    }));
  });
  editor.view.dispatch(transaction.scrollIntoView());
  editor.commands.focus();
}

export function toggleDocumentRunStyle(editor: Editor | null, field: "bold" | "italic" | "underline" | "strike"): void {
  applyDocumentRunFormatting(editor, { [field]: !documentSelectionHasStyle(editor, field) });
}

export function clearDocumentRunFormatting(editor: Editor | null): void {
  if (!editor || editor.state.selection.empty) return;
  applyDocumentRunFormatting(editor, { ...DEFAULT_STYLE, highlight: undefined, language: undefined, href: null });
}

export function setDocumentBlockStyle(editor: Editor | null, style: DocumentBlockStyle): void {
  if (!editor) return;
  const current = ancestor(editor, ["paragraph", "heading"]);
  if (!current) return;
  const headingMatch = /^Heading ([1-6])$/.exec(style);
  const type = headingMatch ? editor.schema.nodes.heading : editor.schema.nodes.paragraph;
  const nextAttrs: Record<string, unknown> = headingMatch
    ? { ...current.node.attrs, level: Number(headingMatch[1]), styleName: style }
    : { ...current.node.attrs, styleName: style };
  if (!headingMatch) delete nextAttrs.level;
  editor.view.dispatch(editor.state.tr.setNodeMarkup(current.pos, type, nextAttrs).scrollIntoView());
  editor.commands.focus();
}

export function setDocumentBlockAttributes(editor: Editor | null, patch: Record<string, unknown>): void {
  if (!editor) return;
  const current = ancestor(editor, ["paragraph", "heading", "officeList", "officeTableCell"]);
  if (!current) return;
  editor.view.dispatch(editor.state.tr.setNodeMarkup(current.pos, undefined, { ...current.node.attrs, ...patch }).scrollIntoView());
  editor.commands.focus();
}

export function setDocumentSectionAttributes(editor: Editor | null, patch: Record<string, unknown>): void {
  if (!editor) return;
  const section = ancestor(editor, ["officeSection"]);
  if (!section) return;
  editor.view.dispatch(editor.state.tr.setNodeMarkup(section.pos, undefined, { ...section.node.attrs, ...patch }).scrollIntoView());
  editor.commands.focus();
}

export function currentDocumentSectionAttributes(editor: Editor | null): Record<string, unknown> | null {
  return editor ? ancestor(editor, ["officeSection"])?.node.attrs ?? null : null;
}

function bodyInsertion(editor: Editor): number | null {
  const $from = editor.state.selection.$from;
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    if ($from.node(depth).type.name !== "officeBody") continue;
    const body = $from.node(depth);
    const index = $from.indexAfter(depth);
    let offset = 0;
    for (let child = 0; child < index; child += 1) offset += body.child(child).nodeSize;
    return $from.start(depth) + offset;
  }
  let fallback: number | null = null;
  editor.state.doc.descendants((node, pos) => {
    if (fallback === null && node.type.name === "officeBody") fallback = pos + 1 + node.content.size;
  });
  return fallback;
}

function emptyCell(editor: Editor): ProseMirrorNode {
  return editor.schema.nodes.officeTableCell.create(
    { id: uuid(), rowSpan: 1, colSpan: 1 },
    editor.schema.nodes.officeTableCellText.create({ id: uuid() }),
  );
}

export function insertDocumentTable(editor: Editor | null, rows = 2, columns = 2): void {
  if (!editor) return;
  const position = bodyInsertion(editor);
  if (position === null) return;
  const tableRows = Array.from({ length: rows }, () => editor.schema.nodes.officeTableRow.create(
    { id: uuid() },
    Array.from({ length: columns }, () => emptyCell(editor)),
  ));
  const table = editor.schema.nodes.officeTable.create({ id: uuid(), headerRows: 0, layout: "autofit" }, tableRows);
  editor.view.dispatch(editor.state.tr.insert(position, table).scrollIntoView());
  editor.commands.focus();
}

export function insertDocumentBreak(editor: Editor | null, kind: "page" | "section"): void {
  if (!editor) return;
  const position = bodyInsertion(editor);
  if (position === null) return;
  const type = kind === "page" ? editor.schema.nodes.officePageBreak : editor.schema.nodes.officeSectionBreak;
  editor.view.dispatch(editor.state.tr.insert(position, type.create({ id: uuid() })).scrollIntoView());
  editor.commands.focus();
}

export function insertDocumentImage(editor: Editor | null, attrs: { resourceId: string; altText: string; decorative: boolean; widthPt: number; heightPt: number }): void {
  if (!editor) return;
  const position = bodyInsertion(editor);
  if (position === null) return;
  const image = editor.schema.nodes.officeImage.create({ id: uuid(), ...attrs });
  editor.view.dispatch(editor.state.tr.insert(position, image).scrollIntoView());
  editor.commands.focus();
}

export function convertDocumentList(editor: Editor | null, ordered: boolean): void {
  if (!editor) return;
  const list = ancestor(editor, ["officeList"]);
  if (list) {
    editor.view.dispatch(editor.state.tr.setNodeMarkup(list.pos, undefined, { ...list.node.attrs, ordered }).scrollIntoView());
    editor.commands.focus();
    return;
  }
  const block = ancestor(editor, ["paragraph", "heading"]);
  if (!block) return;
  const item = editor.schema.nodes.officeListItem.create({ id: uuid() }, block.node.content);
  const replacement = editor.schema.nodes.officeList.create({ id: uuid(), ordered, level: 0 }, item);
  editor.view.dispatch(editor.state.tr.replaceWith(block.pos, block.pos + block.node.nodeSize, replacement).scrollIntoView());
  editor.commands.focus();
}

export function changeDocumentListLevel(editor: Editor | null, delta: -1 | 1): void {
  if (!editor) return;
  const list = ancestor(editor, ["officeList"]);
  if (!list) return;
  const level = Math.max(0, Math.min(8, Number(list.node.attrs.level ?? 0) + delta));
  editor.view.dispatch(editor.state.tr.setNodeMarkup(list.pos, undefined, { ...list.node.attrs, level }).scrollIntoView());
  editor.commands.focus();
}

function selectedTable(editor: Editor): { table: Ancestor; row: Ancestor | null; cell: Ancestor | null } | null {
  const table = ancestor(editor, ["officeTable"]);
  if (!table) return null;
  return { table, row: ancestor(editor, ["officeTableRow"]), cell: ancestor(editor, ["officeTableCell"]) };
}

export type DocumentTableAction = "addRow" | "deleteRow" | "addColumn" | "deleteColumn" | "mergeCellRight" | "splitCell";

export function runDocumentTableAction(editor: Editor | null, action: DocumentTableAction): void {
  if (!editor) return;
  const selected = selectedTable(editor);
  if (!selected) return;
  const { table, row, cell } = selected;
  const transaction = editor.state.tr;
  if (action === "addRow") {
    const columns = Math.max(1, table.node.firstChild?.childCount ?? 1);
    const added = editor.schema.nodes.officeTableRow.create({ id: uuid() }, Array.from({ length: columns }, () => emptyCell(editor)));
    transaction.insert(table.pos + table.node.nodeSize - 1, added);
  } else if (action === "deleteRow" && row && table.node.childCount > 1) {
    transaction.delete(row.pos, row.pos + row.node.nodeSize);
  } else if (action === "addColumn") {
    const insertions: Array<{ pos: number; node: ProseMirrorNode }> = [];
    table.node.forEach((tableRow, offset) => insertions.push({ pos: table.pos + 1 + offset + tableRow.nodeSize - 1, node: emptyCell(editor) }));
    for (const insertion of insertions.sort((left, right) => right.pos - left.pos)) transaction.insert(insertion.pos, insertion.node);
  } else if (action === "deleteColumn" && row && cell && row.node.childCount > 1) {
    let selectedIndex = 0;
    row.node.forEach((_candidate, offset, index) => { if (row.pos + 1 + offset === cell.pos) selectedIndex = index; });
    const deletions: Array<{ from: number; to: number }> = [];
    table.node.forEach((tableRow, rowOffset) => {
      if (tableRow.childCount <= selectedIndex || tableRow.childCount <= 1) return;
      let cellOffset = 0;
      for (let index = 0; index < selectedIndex; index += 1) cellOffset += tableRow.child(index).nodeSize;
      const from = table.pos + 1 + rowOffset + 1 + cellOffset;
      deletions.push({ from, to: from + tableRow.child(selectedIndex).nodeSize });
    });
    for (const deletion of deletions.sort((left, right) => right.from - left.from)) transaction.delete(deletion.from, deletion.to);
  } else if (action === "mergeCellRight" && row && cell) {
    let index = 0;
    row.node.forEach((_candidate, offset, candidate) => { if (row.pos + 1 + offset === cell.pos) index = candidate; });
    if (index < row.node.childCount - 1) {
      const right = row.node.child(index + 1);
      const nextAttrs = { ...cell.node.attrs, colSpan: Number(cell.node.attrs.colSpan ?? 1) + Number(right.attrs.colSpan ?? 1) };
      transaction.setNodeMarkup(cell.pos, undefined, nextAttrs);
      transaction.delete(cell.pos + cell.node.nodeSize, cell.pos + cell.node.nodeSize + right.nodeSize);
    }
  } else if (action === "splitCell" && row && cell) {
    const span = Math.max(1, Number(cell.node.attrs.colSpan ?? 1));
    if (span > 1) {
      transaction.setNodeMarkup(cell.pos, undefined, { ...cell.node.attrs, colSpan: 1 });
      for (let index = 1; index < span; index += 1) transaction.insert(cell.pos + cell.node.nodeSize, emptyCell(editor));
    }
  }
  if (transaction.steps.length > 0) editor.view.dispatch(transaction.scrollIntoView());
  editor.commands.focus();
}

export function moveDocumentTableCell(editor: Editor | null, direction: -1 | 1): boolean {
  if (!editor || !ancestor(editor, ["officeTableCell"])) return false;
  const cells: number[] = [];
  editor.state.doc.descendants((node, pos) => { if (node.type.name === "officeTableCellText") cells.push(pos + 1); });
  const current = editor.state.selection.from;
  const next = direction > 0 ? cells.find((pos) => pos > current) : [...cells].reverse().find((pos) => pos < current);
  if (next === undefined) return false;
  editor.commands.setTextSelection(next);
  editor.commands.focus();
  return true;
}

export function setDocumentTableAttributes(editor: Editor | null, patch: Record<string, unknown>): void {
  if (!editor) return;
  const table = ancestor(editor, ["officeTable"]);
  if (!table) return;
  editor.view.dispatch(editor.state.tr.setNodeMarkup(table.pos, undefined, { ...table.node.attrs, ...patch }).scrollIntoView());
  editor.commands.focus();
}

export function setDocumentCellAttributes(editor: Editor | null, patch: Record<string, unknown>): void {
  if (!editor) return;
  const cell = ancestor(editor, ["officeTableCell"]);
  if (!cell) return;
  editor.view.dispatch(editor.state.tr.setNodeMarkup(cell.pos, undefined, { ...cell.node.attrs, ...patch }).scrollIntoView());
  editor.commands.focus();
}

export function selectedDocumentNode(editor: Editor | null, type: string): { node: ProseMirrorNode; pos: number } | null {
  if (!editor) return null;
  const found = ancestor(editor, [type]);
  if (found) return found;
  const selected = editor.state.selection.$from.nodeAfter;
  return selected?.type.name === type ? { node: selected, pos: editor.state.selection.from } : null;
}

export function updateSelectedDocumentNode(editor: Editor | null, type: string, patch: Record<string, unknown>): void {
  const selected = selectedDocumentNode(editor, type);
  if (!editor || !selected) return;
  editor.view.dispatch(editor.state.tr.setNodeMarkup(selected.pos, undefined, { ...selected.node.attrs, ...patch }).scrollIntoView());
  editor.commands.focus();
}

export function deleteSelectedDocumentNode(editor: Editor | null, type: string): void {
  const selected = selectedDocumentNode(editor, type);
  if (!editor || !selected) return;
  editor.view.dispatch(editor.state.tr.delete(selected.pos, selected.pos + selected.node.nodeSize).scrollIntoView());
  editor.commands.focus();
}

export type DocumentHeading = { id: string; level: number; text: string; pos: number };
export type DocumentCounts = { words: number; characters: number; charactersNoSpaces: number; selectionWords: number; selectionCharacters: number };

function wordCount(text: string): number {
  return text.trim() ? text.trim().split(/\s+/u).length : 0;
}

export function documentProductivity(editor: Editor | null): { headings: DocumentHeading[]; counts: DocumentCounts } {
  const empty = { headings: [], counts: { words: 0, characters: 0, charactersNoSpaces: 0, selectionWords: 0, selectionCharacters: 0 } };
  if (!editor) return empty;
  const headings: DocumentHeading[] = [];
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name === "heading") headings.push({ id: String(node.attrs.id), level: Number(node.attrs.level), text: node.textContent, pos });
  });
  const text = editor.state.doc.textBetween(0, editor.state.doc.content.size, "\n", "");
  const { from, to } = editor.state.selection;
  const selectionText = from === to ? "" : editor.state.doc.textBetween(from, to, "\n", "");
  return {
    headings,
    counts: {
      words: wordCount(text),
      characters: text.length,
      charactersNoSpaces: text.replace(/\s/gu, "").length,
      selectionWords: wordCount(selectionText),
      selectionCharacters: selectionText.length,
    },
  };
}

function textMatches(editor: Editor, query: string, matchCase: boolean): Array<{ from: number; to: number }> {
  if (!query) return [];
  const needle = matchCase ? query : query.toLocaleLowerCase();
  const matches: Array<{ from: number; to: number }> = [];
  editor.state.doc.descendants((node, pos) => {
    if (!node.isText) return;
    const value = matchCase ? (node.text ?? "") : (node.text ?? "").toLocaleLowerCase();
    let index = value.indexOf(needle);
    while (index >= 0) {
      matches.push({ from: pos + index, to: pos + index + needle.length });
      index = value.indexOf(needle, index + Math.max(needle.length, 1));
    }
  });
  return matches;
}

export function findDocumentText(editor: Editor | null, query: string, direction: 1 | -1, matchCase = false): number {
  if (!editor) return 0;
  const matches = textMatches(editor, query, matchCase);
  if (matches.length === 0) return 0;
  const cursor = direction > 0 ? editor.state.selection.to : editor.state.selection.from;
  const match = direction > 0
    ? matches.find((candidate) => candidate.from >= cursor) ?? matches[0]
    : [...matches].reverse().find((candidate) => candidate.to <= cursor) ?? matches[matches.length - 1];
  editor.commands.setTextSelection(match);
  editor.commands.focus();
  return matches.length;
}

export function replaceDocumentText(editor: Editor | null, query: string, replacement: string, all: boolean, matchCase = false): number {
  if (!editor) return 0;
  const matches = textMatches(editor, query, matchCase);
  if (matches.length === 0) return 0;
  const targets = all ? matches : [matches.find((match) => match.from === editor.state.selection.from && match.to === editor.state.selection.to) ?? matches[0]];
  const transaction = editor.state.tr;
  for (const target of [...targets].sort((left, right) => right.from - left.from)) transaction.insertText(replacement, target.from, target.to);
  editor.view.dispatch(transaction.scrollIntoView());
  editor.commands.focus();
  return targets.length;
}

export function focusDocumentHeading(editor: Editor | null, heading: DocumentHeading): void {
  if (!editor) return;
  editor.commands.setTextSelection(Math.min(heading.pos + 1, editor.state.doc.content.size));
  editor.commands.focus();
}

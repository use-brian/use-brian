// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { Editor } from "@tiptap/core";
import { Collaboration } from "@tiptap/extension-collaboration";
import { TextSelection } from "@tiptap/pm/state";
import { attachDocumentResource, getDocumentFragment, snapshotToYDoc, yDocToSnapshot } from "@use-brian/office-model";
import { documentFixture } from "./editor-fixtures";
import { officeDocumentEditorExtensions } from "../document/editor-schema";
import { applyDocumentRunFormatting, clearDocumentRunFormatting, convertDocumentList, currentDocumentSectionAttributes, documentProductivity, findDocumentText, insertDocumentBreak, insertDocumentImage, insertDocumentTable, replaceDocumentText, runDocumentTableAction, setDocumentBlockAttributes, setDocumentBlockStyle, setDocumentSectionAttributes } from "../document/editor-actions";

describe("[COMP:app-web/office-document-editor] Document productivity and keyboard actions", () => {
  it("finds and replaces text nodes without touching link href metadata", () => {
    const doc = snapshotToYDoc(documentFixture());
    const editor = new Editor({ extensions: [...officeDocumentEditorExtensions(), Collaboration.configure({ fragment: getDocumentFragment(doc) })] });
    expect(findDocumentText(editor, "format", 1)).toBe(1);
    expect(replaceDocumentText(editor, "format", "style", true)).toBe(1);
    const snapshot = yDocToSnapshot(doc);
    if (snapshot.family !== "document") throw new Error("document required");
    const paragraph = snapshot.sections[0].nodes.find((node) => node.id.endsWith("000026"));
    expect(paragraph?.kind === "paragraph" && paragraph.runs.map((run) => run.text).join("")).toBe("Mixed style");
    expect(paragraph?.kind === "paragraph" && paragraph.runs.some((run) => run.href === "https://example.com/format")).toBe(true);
    editor.destroy(); doc.destroy();
  });

  it("creates heading and list structures and derives outline and selection counts", () => {
    const doc = snapshotToYDoc(documentFixture());
    const editor = new Editor({ extensions: [...officeDocumentEditorExtensions(), Collaboration.configure({ fragment: getDocumentFragment(doc) })] });
    let position = 0;
    editor.state.doc.descendants((node, pos) => { if (node.type.name === "paragraph" && node.attrs.id?.endsWith("000012")) position = pos + 1; });
    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, position, position + 4)));
    setDocumentBlockStyle(editor, "Heading 2");
    const productivity = documentProductivity(editor);
    expect(productivity.headings.some((heading) => heading.level === 2 && heading.text === "Body copy")).toBe(true);
    expect(productivity.counts.selectionCharacters).toBe(4);
    convertDocumentList(editor, false);
    const snapshot = yDocToSnapshot(doc);
    expect(snapshot.family === "document" && snapshot.sections[0].nodes.some((node) => node.kind === "list")).toBe(true);
    editor.destroy(); doc.destroy();
  });

  it("authors the admitted formatting, page, table, break, and image fields in the fragment", () => {
    const doc = snapshotToYDoc(documentFixture());
    const editor = new Editor({ extensions: [...officeDocumentEditorExtensions(), Collaboration.configure({ fragment: getDocumentFragment(doc) })] });
    let paragraphPosition = 0;
    editor.state.doc.descendants((node, pos) => { if (node.type.name === "paragraph" && node.attrs.id?.endsWith("000012")) paragraphPosition = pos + 1; });
    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, paragraphPosition, paragraphPosition + 4)));
    applyDocumentRunFormatting(editor, { fontFamily: "Georgia", fontSizePt: 18, color: "#336699", highlight: "#FFF2CC", href: "https://example.com/edited" });
    setDocumentBlockAttributes(editor, { alignment: "center", spacingBeforePt: 6, spacingAfterPt: 8, lineSpacingPt: 18 });
    const page = currentDocumentSectionAttributes(editor)?.page as Record<string, unknown>;
    const resource = { id: "00000000-0000-4000-8000-000000000099", kind: "image" as const, hash: "c".repeat(64), mime: "image/png", sensitivity: "internal" as const };
    attachDocumentResource(doc, resource);
    setDocumentSectionAttributes(editor, { page: { ...page, marginLeftPt: 54, orientation: "landscape", widthPt: 792, heightPt: 612 }, showPageNumber: false, headerAlignment: "center", footerAlignment: "end", headerImage: { resourceId: resource.id, altText: "Company mark", decorative: false, widthPt: 96, heightPt: 48 } });
    insertDocumentTable(editor, 2, 2);
    insertDocumentBreak(editor, "page");
    insertDocumentBreak(editor, "section");
    insertDocumentImage(editor, { resourceId: resource.id, altText: "Accessible diagram", decorative: false, widthPt: 180, heightPt: 120 });

    let newTableCell = 0;
    let inAuthoredTable = false;
    editor.state.doc.descendants((node, pos) => {
      if (node.type.name === "officeTable") inAuthoredTable = Number(node.attrs.headerRows) === 0;
      if (node.type.name === "officeTableCellText" && inAuthoredTable && newTableCell === 0) newTableCell = pos + 1;
      return true;
    });
    editor.commands.setTextSelection(newTableCell);
    runDocumentTableAction(editor, "addRow");
    runDocumentTableAction(editor, "addColumn");

    const snapshot = yDocToSnapshot(doc);
    if (snapshot.family !== "document") throw new Error("document required");
    const paragraph = snapshot.sections[0].nodes.find((node) => node.id.endsWith("000012"));
    expect(paragraph).toMatchObject({ kind: "paragraph", alignment: "center", spacingBeforePt: 6, spacingAfterPt: 8, lineSpacingPt: 18 });
    expect(paragraph?.kind === "paragraph" && paragraph.runs.some((run) => run.style.fontFamily === "Georgia" && run.style.highlight === "#FFF2CC" && run.href === "https://example.com/edited")).toBe(true);
    expect(snapshot.sections[0]).toMatchObject({ page: { marginLeftPt: 54, orientation: "landscape", widthPt: 792, heightPt: 612 }, showPageNumber: false, headerAlignment: "center", footerAlignment: "end", headerImage: { resourceId: resource.id, altText: "Company mark", widthPt: 96, heightPt: 48 } });
    expect(snapshot.sections[0].nodes.some((node) => node.kind === "pageBreak")).toBe(true);
    expect(snapshot.sections[0].nodes.some((node) => node.kind === "sectionBreak")).toBe(true);
    expect(snapshot.sections[0].nodes.some((node) => node.kind === "image" && node.resourceId === resource.id && node.altText === "Accessible diagram")).toBe(true);
    const authoredTable = snapshot.sections[0].nodes.find((node) => node.kind === "table" && node.headerRows === 0);
    expect(authoredTable?.kind === "table" && authoredTable.rows.length).toBe(3);
    expect(authoredTable?.kind === "table" && authoredTable.rows.every((row) => row.cells.length === 3)).toBe(true);

    editor.commands.setTextSelection({ from: paragraphPosition, to: paragraphPosition + 4 });
    clearDocumentRunFormatting(editor);
    const cleared = yDocToSnapshot(doc);
    const clearedParagraph = cleared.family === "document" ? cleared.sections[0].nodes.find((node) => node.id.endsWith("000012")) : null;
    expect(clearedParagraph?.kind === "paragraph" && clearedParagraph.runs.every((run) => !run.href && !run.style.highlight)).toBe(true);
    editor.destroy(); doc.destroy();
  });
});

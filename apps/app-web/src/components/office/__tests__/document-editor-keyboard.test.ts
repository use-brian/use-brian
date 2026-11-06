// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { Editor } from "@tiptap/core";
import { Collaboration } from "@tiptap/extension-collaboration";
import { TextSelection } from "@tiptap/pm/state";
import { applyDocumentCommand, documentRangePreimageHash, attachDocumentResource, getDocumentFragment, snapshotToYDoc, yDocToSnapshot } from "@use-brian/office-model";
import { readFileSync } from "node:fs";
import { documentFixture, uid } from "./editor-fixtures";
import { officeDocumentEditorExtensions } from "../document/editor-schema";
import { applyDocumentRunFormatting, clearDocumentRunFormatting, convertDocumentList, currentDocumentSectionAttributes, documentProductivity, findDocumentText, insertDocumentBreak, insertDocumentImage, insertDocumentTable, moveDocumentTableCell, replaceDocumentText, runDocumentTableAction, setDocumentBlockAttributes, setDocumentBlockStyle, setDocumentRowAttributes, setDocumentSectionAttributes } from "../document/editor-actions";

describe("[COMP:app-web/office-document-editor] Document productivity and keyboard actions", () => {
  it("retains numeric-input focus while persisting fractional paragraph spacing", () => {
    const doc = snapshotToYDoc(documentFixture());
    const editor = new Editor({ extensions: [...officeDocumentEditorExtensions(), Collaboration.configure({ fragment: getDocumentFragment(doc) })] });
    const input = document.createElement("input");
    document.body.append(input);
    try {
      let start = 0;
      editor.state.doc.descendants((node, pos) => { if (node.type.name === "officeTableCellText") start = pos + 1; });
      editor.commands.setTextSelection(start);
      input.focus();
      setDocumentBlockAttributes(editor, { lineSpacingPt: 11, spacingBeforePt: 1.3, spacingAfterPt: 0 }, false);
      setDocumentBlockAttributes(editor, { lineSpacingPt: 11.45 }, false);
      expect(document.activeElement).toBe(input);
      const result = yDocToSnapshot(doc);
      const table = result.family === "document" ? result.sections[0].nodes.find(node => node.kind === "table") : undefined;
      expect(table?.kind === "table" && table.rows[0].cells[0].runs[0].paragraphStart).toMatchObject({ lineSpacingPt: 11.45, lineSpacingRule: "exact", spacingBeforePt: 1.3, spacingAfterPt: 0 });
      expect(editor.view.dom.querySelector("[data-office-table-cell-text]")?.getAttribute("style")).toContain("line-height: 11.45pt");
    } finally { input.remove(); editor.destroy(); doc.destroy(); }
  });

  it("persists row sizing and footer position changes through the collaborative editor", () => {
    const snapshot = documentFixture();
    const table = snapshot.sections[0].nodes.find(node => node.kind === "table")!;
    if (table.kind !== "table") throw new Error("table required");
    const doc = snapshotToYDoc(snapshot);
    const editor = new Editor({ extensions: [...officeDocumentEditorExtensions(), Collaboration.configure({ fragment: getDocumentFragment(doc) })] });
    try {
      let start = 0;
      editor.state.doc.descendants((node, position) => { if (node.type.name === "officeTableCellText" && node.attrs.id === table.rows[0].cells[0].id) start = position + 1; });
      editor.commands.setTextSelection(start);
      setDocumentRowAttributes(editor, { minHeightPt: 12.65, heightRule: "exact" });
      setDocumentSectionAttributes(editor, { footerIndentLeftPt: 5.45, page: { ...snapshot.sections[0].page, footerDistancePt: 40.25 } }, false);
      const result = yDocToSnapshot(doc);
      if (result.family !== "document") throw new Error("document required");
      expect(result.sections[0]).toMatchObject({ footerIndentLeftPt: 5.45, page: { footerDistancePt: 40.25 } });
      const updated = result.sections[0].nodes.find(node => node.kind === "table");
      expect(updated?.kind === "table" && updated.rows[0]).toMatchObject({ minHeightPt: 12.65, heightRule: "exact" });
      expect(editor.view.dom.querySelector("section")?.getAttribute("style")).toContain("--office-footer-indent-left: 5.45pt");
    } finally { editor.destroy(); doc.destroy(); }
  });

  it("keeps multiline pasted values inside their cell and retains exact row heights", () => {
    const snapshot = documentFixture();
    const table = snapshot.sections[0].nodes.find(node => node.kind === "table")!;
    if (table.kind !== "table") throw new Error("table required");
    table.rows[0].minHeightPt = 18;
    table.rows[0].heightRule = "exact";
    const cell = table.rows[0].cells[0];
    cell.runs[0].style.bold = true;
    const originalNodeIds = snapshot.sections[0].nodes.map(node => node.id);
    const doc = snapshotToYDoc(snapshot);
    const editor = new Editor({ extensions: [...officeDocumentEditorExtensions(), Collaboration.configure({ fragment: getDocumentFragment(doc) })] });
    let start = 0;
    editor.state.doc.descendants((node, position) => { if (node.type.name === "officeTableCellText" && node.attrs.id === cell.id) start = position + 1; });
    editor.commands.setTextSelection({ from: start, to: start + cell.runs[0].text.length });
    const paste = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(paste, "clipboardData", { value: { getData: (type: string) => type === "text/plain" ? "Venue A /\r\nVenue B /\nVenue C" : "", types: ["text/plain"], files: [] } });
    editor.view.dom.dispatchEvent(paste);
    const result = yDocToSnapshot(doc);
    if (result.family !== "document") throw new Error("document required");
    expect(result.sections[0].nodes.map(node => node.id)).toEqual(originalNodeIds);
    const edited = result.sections[0].nodes.find(node => node.id === table.id);
    if (edited?.kind !== "table") throw new Error("table required");
    expect(edited.rows[0]).toMatchObject({ minHeightPt: 18, heightRule: "exact" });
    expect(edited.rows[0].cells[0].runs.map(run => run.text).join("")).toBe("Venue A /\nVenue B /\nVenue C");
    expect(edited.rows[0].cells[0].runs[0].style.bold).toBe(true);
    editor.destroy(); doc.destroy();
  });

  it("promotes legacy cell formatting to a distinct paragraph ID before split and range edits", () => {
    const snapshot = documentFixture();
    const table = snapshot.sections[0].nodes.find((node) => node.kind === "table")!;
    if (table.kind !== "table") throw new Error("table required");
    const cellId = table.rows[0].cells[0].id;
    const doc = snapshotToYDoc(snapshot);
    const editor = new Editor({ extensions: [...officeDocumentEditorExtensions(), Collaboration.configure({ fragment: getDocumentFragment(doc) })] });
    let start = 0;
    editor.state.doc.descendants((node, pos) => { if (node.type.name === "officeTableCellText") start = pos + 1; });
    editor.commands.setTextSelection(start + 2);
    expect(editor.state.selection.$from.parent.attrs.id).toBe(cellId);
    setDocumentBlockAttributes(editor, { alignment: "end" });
    const paragraphId = editor.state.selection.$from.parent.attrs.id;
    expect(paragraphId).not.toBe(cellId);
    setDocumentBlockAttributes(editor, { spacingAfterPt: 0 });
    expect(editor.state.selection.$from.parent.attrs.id).toBe(paragraphId);
    editor.view.dom.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    const before = yDocToSnapshot(doc);
    const beforeTable = before.family === "document" ? before.sections[0].nodes.find((node) => node.kind === "table") : undefined;
    if (beforeTable?.kind !== "table") throw new Error("table required");
    expect(beforeTable.rows[0].cells[0].runs.filter((run) => run.paragraphStart).map((run) => run.paragraphStart!.id)).toEqual([paragraphId, expect.not.stringMatching(paragraphId)]);
    applyDocumentCommand(doc, { artifactId: snapshot.artifactId, baseVersion: 0, actor: { type: "user", id: uid(400) }, origin: "manual", commandId: uid(401), kind: "replaceTextRange", targetId: paragraphId, from: 0, to: 2, preimageHash: documentRangePreimageHash("Ce"), runs: [{ ...table.rows[0].cells[0].runs[0], id: uid(402), text: "Updated" }] });
    const after = yDocToSnapshot(doc);
    const afterTable = after.family === "document" ? after.sections[0].nodes.find((node) => node.kind === "table") : undefined;
    if (afterTable?.kind !== "table") throw new Error("table required");
    expect(afterTable.rows[0].cells[0].runs.map((run) => run.text)).toEqual(["Updated", "ll"]);
    expect(afterTable.rows[0].cells[0].runs[0].paragraphStart?.id).toBe(paragraphId);
    expect(afterTable.rows[0].cells[0].runs[1]).toEqual(beforeTable.rows[0].cells[0].runs[1]);
    editor.destroy(); doc.destroy();
  });

  it("also promotes the original paragraph when Enter first splits an unformatted legacy cell", () => {
    const snapshot = documentFixture();
    const doc = snapshotToYDoc(snapshot);
    const editor = new Editor({ extensions: [...officeDocumentEditorExtensions(), Collaboration.configure({ fragment: getDocumentFragment(doc) })] });
    let start = 0;
    editor.state.doc.descendants((node, pos) => { if (node.type.name === "officeTableCellText") start = pos + 1; });
    editor.commands.setTextSelection(start + 2);
    const cellId = editor.state.selection.$from.parent.attrs.id;
    editor.view.dom.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    const result = yDocToSnapshot(doc);
    const table = result.family === "document" ? result.sections[0].nodes.find((node) => node.kind === "table") : undefined;
    if (table?.kind !== "table") throw new Error("table required");
    const ids = table.rows[0].cells[0].runs.map((run) => run.paragraphStart?.id);
    expect(ids).toHaveLength(2);
    expect(ids.every((id) => typeof id === "string" && id !== cellId)).toBe(true);
    expect(new Set(ids).size).toBe(2);
    editor.destroy(); doc.destroy();
  });

  it("moves Tab and Shift-Tab between cells, skipping additional paragraphs within each cell", () => {
    const snapshot = documentFixture();
    const table = snapshot.sections[0].nodes.find((node) => node.kind === "table")!;
    if (table.kind !== "table") throw new Error("table required");
    const cell = table.rows[0].cells[0];
    const run = cell.runs[0];
    cell.colSpan = 1;
    cell.runs = [ { ...run, text: "Alpha", paragraphStart: { id: uid(410) } }, { ...run, id: uid(411), text: "Beta", paragraphStart: { id: uid(412) } } ];
    table.rows[0].cells.push({ ...cell, id: uid(413), runs: [ { ...run, id: uid(414), text: "Destination one", paragraphStart: { id: uid(415) } }, { ...run, id: uid(416), text: "Destination two", paragraphStart: { id: uid(417) } } ] });
    const doc = snapshotToYDoc(snapshot);
    const editor = new Editor({ extensions: [...officeDocumentEditorExtensions(), Collaboration.configure({ fragment: getDocumentFragment(doc) })] });
    const positions = new Map<string, number>();
    editor.state.doc.descendants((node, pos) => { if (node.type.name === "officeTableCellText") positions.set(node.textContent, pos + 1); });
    for (const text of ["Alpha", "Beta"]) {
      editor.commands.setTextSelection(positions.get(text)! + 2);
      expect(moveDocumentTableCell(editor, 1)).toBe(true);
      expect(editor.state.selection.from).toBe(positions.get("Destination one"));
    }
    editor.commands.setTextSelection(positions.get("Destination two")! + 3);
    expect(moveDocumentTableCell(editor, -1)).toBe(true);
    expect(editor.state.selection.from).toBe(positions.get("Alpha"));
    expect(moveDocumentTableCell(editor, -1)).toBe(false);
    editor.commands.setTextSelection(positions.get("Destination one")!);
    expect(moveDocumentTableCell(editor, 1)).toBe(false);
    editor.destroy(); doc.destroy();
  });

  it("uses actual run sizes for at-least spacing and recomputes on inline formatting", () => {
    const snapshot = documentFixture();
    const body = snapshot.sections[0].nodes.find((node) => node.kind === "paragraph")!;
    if (body.kind !== "paragraph") throw new Error("paragraph required");
    body.lineSpacingPt = 14; body.lineSpacingRule = "atLeast";
    body.runs[0].style.fontSizePt = 30;
    const table = snapshot.sections[0].nodes.find((node) => node.kind === "table")!;
    if (table.kind !== "table") throw new Error("table required");
    const run = table.rows[0].cells[0].runs[0];
    run.style.fontSizePt = 40;
    run.paragraphStart = { id: uid(420), lineSpacingPt: 20, lineSpacingRule: "atLeast" };
    const doc = snapshotToYDoc(snapshot);
    const editor = new Editor({ extensions: [...officeDocumentEditorExtensions(), Collaboration.configure({ fragment: getDocumentFragment(doc) })] });
    const bodyDom = [...editor.view.dom.querySelectorAll("p")].find((p) => p.textContent === "Body copy")!;
    expect(bodyDom.style.lineHeight).toBe("34.5pt");
    expect(editor.view.dom.querySelector("td p")?.getAttribute("style")).toContain("line-height: 46pt");
    let start = 0;
    editor.state.doc.descendants((node, pos) => { if (node.type.name === "paragraph" && node.attrs.id === body.id) start = pos + 1; });
    editor.commands.setTextSelection({ from: start, to: start + "Body copy".length });
    applyDocumentRunFormatting(editor, { fontSizePt: 40 });
    expect(bodyDom.style.lineHeight).toBe("46pt");
    applyDocumentRunFormatting(editor, { fontSizePt: 10 });
    expect(bodyDom.style.lineHeight).toBe("14pt");
    editor.destroy(); doc.destroy();
  });

  it("projects grids, merged edges, zero margins, minimum heights and paragraph spacing without CSS overrides", () => {
    const snapshot = documentFixture();
    const table = snapshot.sections[0].nodes.find((node) => node.kind === "table")!;
    if (table.kind !== "table") throw new Error("table required");
    const cell = table.rows[0].cells[0];
    cell.borders = { bottom: { style: "none", widthPt: 0, color: "#000000" } };
    cell.margins = { topPt: 0, rightPt: 0, bottomPt: 1, leftPt: 0 };
    cell.wrapText = false;
    cell.runs = [
      { ...cell.runs[0], text: "Alpha\tBeta\nGamma", paragraphStart: { id: uid(301), alignment: "center", spacingBeforePt: 0, spacingAfterPt: 0, lineSpacingPt: 14, lineSpacingRule: "exact" } },
      { ...cell.runs[0], id: uid(101), text: "", paragraphStart: { id: uid(302), lineSpacingMultiple: 1.5 } },
      { ...cell.runs[0], id: uid(102), text: "Delta", paragraphStart: { id: uid(303), alignment: "end", lineSpacingPt: 20, lineSpacingRule: "atLeast" } },
    ];
    const doc = snapshotToYDoc(snapshot);
    const editor = new Editor({ extensions: [...officeDocumentEditorExtensions(), Collaboration.configure({ fragment: getDocumentFragment(doc) })] });
    document.body.append(editor.view.dom);
    // Apply the actual table rules, not a hand-written stand-in for globals.css.
    const stylesheet = document.createElement("style");
    const css = readFileSync("src/app/globals.css", "utf8");
    stylesheet.textContent = css.match(/\.office-document-table[^{}]*\{[^}]*\}/g)!.join("\n");
    document.head.append(stylesheet);
    const domTable = editor.view.dom.querySelector("table")!;
    const columns = [...domTable.querySelectorAll("col")];
    expect(columns).toHaveLength(2);
    expect(parseFloat(columns[0].style.width)).toBeCloseTo(100 / 3);
    expect(parseFloat(columns[1].style.width)).toBeCloseTo(200 / 3);
    expect(domTable.querySelector("tbody > tr")?.getAttribute("style")).toContain("height: 18pt");
    const td = domTable.querySelector("td")!;
    expect(td.colSpan).toBe(2);
    expect(td.style.borderBottomStyle).toBe("none");
    expect(td.style.paddingLeft).toBe("0pt");
    expect(td.style.paddingTop).toBe("0pt");
    expect(td.style.paddingBottom).toBe("1pt");
    expect(td.style.verticalAlign).toBe("middle");
    expect(getComputedStyle(td).minWidth).toBe("0px");
    expect(getComputedStyle(td).whiteSpace).toBe("pre");
    const paragraphs = [...td.querySelectorAll("p")];
    expect(paragraphs).toHaveLength(3);
    expect(paragraphs[0].style.lineHeight).toBe("14pt");
    expect(parseFloat(paragraphs[0].style.marginBottom)).toBe(0);
    expect(paragraphs[1].style.lineHeight).toBe("1.5");
    expect(paragraphs[2].style.textAlign).toBe("right");
    expect(td.textContent).toContain("Alpha\tBeta\nGamma");
    expect(yDocToSnapshot(doc)).toEqual(snapshot);
    // Formatting splits a text node; it must not duplicate paragraph boundaries.
    let start = 0;
    editor.state.doc.descendants((node, pos) => { if (node.type.name === "officeTableCellText" && node.textContent.startsWith("Alpha")) start = pos + 1; });
    editor.commands.setTextSelection({ from: start + 1, to: start + 3 });
    applyDocumentRunFormatting(editor, { italic: true });
    const edited = yDocToSnapshot(doc);
    const editedTable = edited.family === "document" ? edited.sections[0].nodes.find((node) => node.kind === "table") : undefined;
    expect(editedTable?.kind === "table" && editedTable.rows[0].cells[0].runs.filter((run) => run.paragraphStart)).toHaveLength(3);
    editor.commands.setTextSelection(start + 2);
    editor.view.dom.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    const split = yDocToSnapshot(doc);
    const splitTable = split.family === "document" ? split.sections[0].nodes.find((node) => node.kind === "table") : undefined;
    const paragraphIds = splitTable?.kind === "table" ? splitTable.rows[0].cells[0].runs.flatMap((run) => run.paragraphStart ? [run.paragraphStart.id] : []) : [];
    expect(paragraphIds).toHaveLength(4);
    expect(new Set(paragraphIds).size).toBe(4);
    setDocumentBlockAttributes(editor, { lineSpacingPt: 18 });
    const changed = yDocToSnapshot(doc);
    const changedTable = changed.family === "document" ? changed.sections[0].nodes.find((node) => node.kind === "table") : undefined;
    expect(changedTable?.kind === "table" && changedTable.rows[0].cells[0].runs.some((run) => run.paragraphStart?.lineSpacingPt === 18 && run.paragraphStart.lineSpacingMultiple === undefined)).toBe(true);
    stylesheet.remove(); editor.view.dom.remove(); editor.destroy(); doc.destroy();
  });

  it("resolves inherited inside and outer borders around row spans and reacts to table edits", () => {
    const snapshot = documentFixture();
    const table = snapshot.sections[0].nodes.find((node) => node.kind === "table")!;
    if (table.kind !== "table") throw new Error("table required");
    const first = table.rows[0].cells[0];
    first.colSpan = 1; first.rowSpan = 2;
    table.rows[0].cells.push({ ...first, id: uid(201), rowSpan: 1, runs: [{ ...first.runs[0], id: uid(202), text: "Right" }] });
    table.rows.push({ id: uid(203), cells: [{ ...first, id: uid(204), rowSpan: 1, runs: [{ ...first.runs[0], id: uid(205), text: "Below" }] }] });
    const doc = snapshotToYDoc(snapshot);
    const editor = new Editor({ extensions: [...officeDocumentEditorExtensions(), Collaboration.configure({ fragment: getDocumentFragment(doc) })] });
    const cells = [...editor.view.dom.querySelectorAll("td")];
    expect(cells[0].style.borderRightWidth).toBe("0.625pt");
    expect(cells[0].style.borderBottomWidth).toBe("1.125pt");
    expect(cells[2].style.borderLeftWidth).toBe("0.625pt");
    expect(cells[2].style.borderRightStyle).toBe("none");
    let tablePos = 0;
    editor.state.doc.descendants((node, pos) => { if (node.type.name === "officeTable") tablePos = pos; });
    editor.view.dispatch(editor.state.tr.setNodeMarkup(tablePos, undefined, { ...editor.state.doc.nodeAt(tablePos)!.attrs, columnWidthsPt: [120, 120], margins: { topPt: 0, rightPt: 0, bottomPt: 0, leftPt: 0 } }));
    expect(editor.view.dom.querySelector("col")?.getAttribute("style")).toContain("50%");
    expect(editor.view.dom.querySelector("td")?.style.padding).toBe("0pt");
    editor.destroy(); doc.destroy();
  });

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

/** @vitest-environment jsdom */

import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { appendOfficeCommand, createOfficeUndoManager, snapshotToYDoc, yDocToSnapshot, officeCapabilityManifest, type SpreadsheetSnapshot, type OfficeCommand } from "@use-brian/office-model";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import type { Dictionary } from "@/lib/i18n/dictionaries";
import { SpreadsheetEditor, autofitSpreadsheetDimension, gridAxisOffset, moveSpreadsheetAddress, parseSpreadsheetClipboard, shiftSpreadsheetFormula, spreadsheetDimensionModelSize, spreadsheetSelectionAddresses, spreadsheetSelectionLabel, spreadsheetSelectionTsv, worksheetContentExceedsEditorBounds } from "../spreadsheet-editor";
import { spreadsheetFixture } from "./editor-fixtures";

const coveredCapabilities = ["spreadsheetTable", "worksheet", "cellValue", "cellFormula", "cellStyle", "mergedCell", "rowColumnDimensions", "freezePane", "dataValidation", "conditionalFormatting", "worksheetImage", "spreadsheetPrintSetup", "spreadsheetPdf"].sort();
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const setInputValue = (input: HTMLInputElement, value: string) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value); input.dispatchEvent(new Event("input", { bubbles: true })); };

// Explicit native, unstyled table fixture, not a capability-count placeholder.
function tableFixture(): SpreadsheetSnapshot {
  const snapshot = spreadsheetFixture();
  const sheet = snapshot.worksheets[0];
  sheet.merges = [];
  sheet.cells = sheet.cells.map((cell) => ({ ...cell, locked: false, style: { fill: "#FF0000" } }));
  // SUM accepts blank input rows while exercising relative formula copying.
  sheet.cells[2].formula = "SUM(A2)";
  sheet.tables = [{ id: "00000000-0000-4000-8000-000000000103", name: "Records", ref: "A1:B2", autoFilter: true, columns: [{ id: 1, name: "Amount" }, { id: 2, name: "Total" }], style: { name: "", showFirstColumn: false, showLastColumn: false, showRowStripes: false, showColumnStripes: false } }];
  return snapshot;
}

describe("[COMP:app-web/office-spreadsheet-editor] Spreadsheet editor", () => {
  it("renders native worksheet geometry, styling, formulas, merges, and sheet tabs", () => {
    const html = renderToStaticMarkup(<I18nProvider locale="en" dict={en as unknown as Dictionary}><SpreadsheetEditor snapshot={spreadsheetFixture()} baseVersion={1} role="edit" suggestMode={false} onCommand={vi.fn()} /></I18nProvider>);
    expect(html).toContain('data-office-editor="spreadsheet"');
    expect(html).toContain('data-worksheet="Invoice"');
    expect(html).toContain('role="grid"');
    expect(html).toContain('role="tablist"');
    expect(html).toContain("Use Brian");
    expect(html).toContain("4.00");
    expect(html).toContain("font-family:Courier New");
    expect(html).toContain("background-color:#10202C");
    expect(html).toContain("grid-column:2 / span 2");
    expect(html).toContain('aria-label="Cell value or formula"');
    expect(html).toContain('aria-label="Add worksheet"');
    expect(html).toContain('aria-label="Duplicate worksheet"');
    expect(html).toContain('aria-label="Move worksheet left"');
    expect(html).toContain('aria-label="Move worksheet right"');
    expect(html).toContain('aria-label="Rename worksheet"');
    expect(html).toContain('aria-label="Delete worksheet"');
    expect(html).toContain('aria-label="Select all cells"');
    expect(html).toContain('aria-label="Resize column A. Double-click to fit to data."');
    expect(html).toContain('aria-label="Resize row 1. Double-click to fit to data."');
    expect(html).toContain('data-column-resize="A"');
    expect(html).toContain('data-row-resize="1"');
    expect(html).toContain('data-cell-address="A2"');
    expect(html).toContain("position:sticky");
  });


  it.each(["literal", "formula", "empty", "fill-only"] as const)("projects a readable paper foreground for %s cells without changing the snapshot", (kind) => {
    const snapshot = spreadsheetFixture(), sheet = snapshot.worksheets[0];
    const cell = { ...sheet.cells[1], address: "A1", value: kind === "fill-only" ? 0 : 7, style: {}, numberFormat: "[Red]0.00" };
    sheet.merges = [];
    sheet.cells = kind === "empty" ? [] : [kind === "formula" ? { ...cell, value: null, formula: "7*2", calculatedValue: 14 } : cell];
    sheet.conditionalFormats = kind === "fill-only" ? [{ id: "00000000-0000-4000-8000-000000000201", range: "A1", ruleType: "cellIs", operator: "equal", formulas: ["0"], style: { fill: "#E0E7FF" }, priority: 1 }] : [];
    const before = structuredClone(snapshot), onCommand = vi.fn();
    const host = document.createElement("div"), root = createRoot(host);
    host.style.color = "#D4D4D4";
    document.body.append(host);
    try {
      act(() => root.render(<I18nProvider locale="en" dict={en as unknown as Dictionary}><SpreadsheetEditor snapshot={snapshot} baseVersion={1} role="edit" suggestMode={false} onCommand={onCommand} /></I18nProvider>));
      const rendered = host.querySelector<HTMLButtonElement>('[data-cell-address="A1"]')!;
      expect(rendered.style.color).toBe("rgb(15, 23, 42)");
      if (kind === "formula") expect(rendered.textContent).toBe("14.00");
      if (kind === "fill-only") expect(rendered.style.backgroundColor).toBe("rgb(224, 231, 255)");
      expect(rendered.getAttribute("aria-selected")).toBe("true");
      act(() => host.querySelector<HTMLButtonElement>('[data-cell-address="B1"]')!.click());
      expect(rendered.getAttribute("aria-selected")).toBe("false");
      expect(rendered.style.color).toBe("rgb(15, 23, 42)");
      expect(onCommand).not.toHaveBeenCalled();
      expect(snapshot).toEqual(before);
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  });

  it("preserves authored fonts and fills and matching conditional font precedence", () => {
    const snapshot = spreadsheetFixture(), sheet = snapshot.worksheets[0];
    const font = sheet.cells[0].style.font!;
    const numberCell = sheet.cells[1];
    sheet.merges = [];
    sheet.cells = [
      sheet.cells[0],
      { ...numberCell, address: "A2", style: { font: { ...font, color: "#126C5A" } } },
      { ...numberCell, id: "00000000-0000-4000-8000-000000000202", address: "B2", style: { font: { ...font, color: "#126C5A" } } },
      { ...numberCell, id: "00000000-0000-4000-8000-000000000203", address: "C2", style: { font: { ...font, color: "#126C5A" } } },
    ];
    sheet.conditionalFormats = [
      { id: "00000000-0000-4000-8000-000000000204", range: "A2", ruleType: "cellIs", operator: "greaterThan", formulas: ["0"], style: { fill: "#DAF9E9" }, priority: 1 },
      { id: "00000000-0000-4000-8000-000000000205", range: "B2", ruleType: "cellIs", operator: "greaterThan", formulas: ["0"], style: { font: { ...font, color: "#7C3AED" } }, priority: 1 },
      { id: "00000000-0000-4000-8000-000000000206", range: "B2", ruleType: "cellIs", operator: "greaterThan", formulas: ["0"], style: { font: { ...font, color: "#DC2626" } }, priority: 2 },
      { id: "00000000-0000-4000-8000-000000000207", range: "C2", ruleType: "cellIs", operator: "lessThan", formulas: ["0"], style: { font: { ...font, color: "#DC2626" } }, priority: 1 },
    ];
    const before = structuredClone(snapshot), onCommand = vi.fn(), host = document.createElement("div");
    host.innerHTML = renderToStaticMarkup(<I18nProvider locale="en" dict={en as unknown as Dictionary}><SpreadsheetEditor snapshot={snapshot} baseVersion={1} role="edit" suggestMode={false} onCommand={onCommand} /></I18nProvider>);
    const cell = (address: string) => host.querySelector<HTMLElement>(`[data-cell-address="${address}"]`)!;
    expect(cell("A1").style.color).toBe("rgb(255, 255, 255)");
    expect(cell("A1").style.backgroundColor).toBe("rgb(16, 32, 44)");
    expect(cell("A2").style.color).toBe("rgb(18, 108, 90)");
    expect(cell("A2").style.backgroundColor).toBe("rgb(218, 249, 233)");
    expect(cell("B2").style.color).toBe("rgb(124, 58, 237)");
    expect(cell("C2").style.color).toBe("rgb(18, 108, 90)");
    expect(onCommand).not.toHaveBeenCalled();
    expect(snapshot).toEqual(before);
  });

  it("keeps negative Red number-format priority over authored and conditional fonts", () => {
    const snapshot = spreadsheetFixture(), sheet = snapshot.worksheets[0];
    const font = { ...sheet.cells[0].style.font!, color: "#126C5A" }, base = sheet.cells[1];
    sheet.merges = [];
    sheet.cells = [
      { ...base, address: "A1", value: -7, numberFormat: "[Red]0.00", style: { font } },
      { ...base, id: "00000000-0000-4000-8000-000000000208", address: "A2", value: null, formula: "-7*2", calculatedValue: -14, numberFormat: "[Red]0.00", style: { font } },
      { ...base, id: "00000000-0000-4000-8000-000000000209", address: "B1", value: 7, numberFormat: "[Red]0.00", style: { font } },
      { ...base, id: "00000000-0000-4000-8000-000000000210", address: "B2", value: 0, numberFormat: "[Red]0.00", style: { font } },
    ];
    sheet.conditionalFormats = [
      { id: "00000000-0000-4000-8000-000000000211", range: "A2 B2", ruleType: "cellIs", operator: "lessThanOrEqual", formulas: ["0"], style: { font: { ...font, color: "#7C3AED" } }, priority: 1 },
    ];
    const before = structuredClone(snapshot), onCommand = vi.fn(), host = document.createElement("div");
    host.innerHTML = renderToStaticMarkup(<I18nProvider locale="en" dict={en as unknown as Dictionary}><SpreadsheetEditor snapshot={snapshot} baseVersion={1} role="edit" suggestMode={false} onCommand={onCommand} /></I18nProvider>);
    const cell = (address: string) => host.querySelector<HTMLElement>(`[data-cell-address="${address}"]`)!;
    expect(cell("A1").style.color).toBe("rgb(220, 38, 38)");
    expect(cell("A2").style.color).toBe("rgb(220, 38, 38)");
    expect(cell("A2").textContent).toBe("-14.00");
    expect(cell("B1").style.color).toBe("rgb(18, 108, 90)");
    expect(cell("B2").style.color).toBe("rgb(124, 58, 237)");
    expect(onCommand).not.toHaveBeenCalled();
    expect(snapshot).toEqual(before);
  });

  it("keeps an explicit editor fixture for every editable Spreadsheet capability", () => {
    const expected = officeCapabilityManifest.capabilities.filter((capability) => capability.disposition === "editable" && capability.family === "spreadsheet").map((capability) => capability.id).sort();
    expect(coveredCapabilities).toEqual(expected);
  });

  it("renders/selects a native table and emits an undoable canonical blank append, then edits inputs", () => {
    const source = tableFixture();
    const doc = snapshotToYDoc(source);
    const history = createOfficeUndoManager(doc);
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const onSelectTargets = vi.fn();
    const onCommand = vi.fn((command: OfficeCommand) => appendOfficeCommand(doc, command));
    const render = (snapshot = yDocToSnapshot(doc) as SpreadsheetSnapshot, role: "edit" | "view" = "edit") => act(() => root.render(<I18nProvider locale="en" dict={en as unknown as Dictionary}><SpreadsheetEditor snapshot={snapshot} baseVersion={1} role={role} suggestMode={false} onCommand={onCommand} onSelectTargets={onSelectTargets} /></I18nProvider>));
    const append = () => Array.from(host.querySelectorAll<HTMLButtonElement>("button")).find((button) => button.textContent === en.office.appendTableRow)!;
    render();
    expect(append().disabled).toBe(true);
    const table = host.querySelector<HTMLButtonElement>("[data-spreadsheet-table]")!;
    expect(table.textContent).toBe("Records (A1:B2)");
    act(() => table.click());
    expect(onSelectTargets).toHaveBeenLastCalledWith([source.worksheets[0].tables![0].id]);
    expect(table.getAttribute("aria-pressed")).toBe("true");
    act(() => append().click());
    expect(onCommand).toHaveBeenCalledTimes(1);
    expect(onCommand).toHaveBeenLastCalledWith(expect.objectContaining({ kind: "appendSpreadsheetRecords", sheetId: source.worksheets[0].id, tableId: source.worksheets[0].tables![0].id, records: [{ "1": { valueType: "blank", value: null } }] }));
    const appended = yDocToSnapshot(doc) as SpreadsheetSnapshot;
    expect(appended.worksheets[0].cells.find((cell) => cell.address === "A3")).toMatchObject({ valueType: "blank", value: null, style: { fill: "#FF0000" }, numberFormat: "#,##0.00" });
    expect(appended.worksheets[0].cells.find((cell) => cell.address === "B3")).toMatchObject({ formula: "SUM(A3)", calculatedValue: 0, style: { fill: "#FF0000" } });
    render();
    expect(table.textContent).toBe("Records (A1:B3)");
    act(() => history.undo());
    render();
    expect(table.textContent).toBe("Records (A1:B2)");
    expect((yDocToSnapshot(doc) as SpreadsheetSnapshot).worksheets[0].cells.some((cell) => cell.address === "A3")).toBe(false);
    act(() => history.redo());
    render();
    act(() => host.querySelector<HTMLButtonElement>('[data-cell-address="A3"]')!.click());
    const formula = host.querySelector<HTMLInputElement>('[aria-label="Cell value or formula"]')!;
    act(() => setInputValue(formula, "7"));
    act(() => formula.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(onCommand).toHaveBeenLastCalledWith(expect.objectContaining({ kind: "setSpreadsheetCell", address: "A3", value: 7 }));
    render(undefined, "view");
    act(() => table.click());
    expect(append().disabled).toBe(true);
    act(() => root.unmount());
    history.destroy(); doc.destroy(); host.remove();
  }, 15_000);

  it.each(["locked", "no prototype", "collision", "formula"])("shows the owned error alert for unsafe append: %s", (reason) => {
    const snapshot = tableFixture(), sheet = snapshot.worksheets[0];
    if (reason === "locked") sheet.cells[1].locked = true;
    if (reason === "no prototype") sheet.tables![0].ref = "A1:B1";
    if (reason === "collision") sheet.cells.push({ ...sheet.cells[1], id: "00000000-0000-4000-8000-000000000104", address: "A3" });
    if (reason === "formula") sheet.cells[2].formula = "1/0";
    const before = structuredClone(snapshot);
    const host = document.createElement("div"), root = createRoot(host), onCommand = vi.fn();
    act(() => root.render(<I18nProvider locale="en" dict={en as unknown as Dictionary}><SpreadsheetEditor snapshot={snapshot} baseVersion={1} role="edit" suggestMode={false} onCommand={onCommand} /></I18nProvider>));
    act(() => host.querySelector<HTMLButtonElement>("[data-spreadsheet-table]")!.click());
    act(() => Array.from(host.querySelectorAll<HTMLButtonElement>("button")).find((button) => button.textContent === en.office.appendTableRow)!.click());
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(en.office.appendTableRowFailed);
    expect(onCommand).not.toHaveBeenCalled();
    expect(snapshot).toEqual(before);
    act(() => root.unmount());
  });

  it("interpolates fractional image anchors within worksheet rows and columns", () => {
    expect(gridAxisOffset([26, 100], 0.5)).toBe(13);
    expect(gridAxisOffset([26, 100], 1.25)).toBe(51);
    const oversized = spreadsheetFixture().worksheets[0];
    oversized.cells.push({ ...oversized.cells[1], id: "00000000-0000-4000-8000-000000000099", address: "A251" });
    expect(worksheetContentExceedsEditorBounds(oversized)).toBe(true);
  });

  it("selects a worksheet image as an object without selecting its underlying cell", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const snapshot = spreadsheetFixture();
    const imageId = "00000000-0000-4000-8000-000000000097";
    snapshot.worksheets[0].images.push({ id: imageId, resourceId: "00000000-0000-4000-8000-000000000096", altText: "Brian logo", decorative: false, from: { row: 1, column: 0 }, to: { row: 2, column: 1 } });
    const onSelectTargets = vi.fn();
    const onCommand = vi.fn();
    const onEditImageWithBrian = vi.fn();
    act(() => root.render(<I18nProvider locale="en" dict={en as unknown as Dictionary}><SpreadsheetEditor snapshot={snapshot} baseVersion={1} role="edit" suggestMode={false} onCommand={onCommand} onSelectTargets={onSelectTargets} onEditImageWithBrian={onEditImageWithBrian} /></I18nProvider>));

    const image = host.querySelector<HTMLButtonElement>(`[data-worksheet-image="${imageId}"]`)!;
    const underlyingCell = host.querySelector<HTMLButtonElement>('[data-cell-address="A2"]')!;
    const formula = host.querySelector<HTMLInputElement>('[aria-label="Cell value or formula"]')!;
    act(() => image.click());
    expect(image.getAttribute("aria-pressed")).toBe("true");
    expect(underlyingCell.getAttribute("aria-selected")).toBe("false");
    expect(formula.disabled).toBe(true);
    expect(onSelectTargets).toHaveBeenLastCalledWith([imageId]);
    expect(host.querySelector('[aria-label="Worksheet image editor"]')).toBeTruthy();
    const alt = host.querySelector<HTMLInputElement>('[aria-label="Alternative text"]')!;
    act(() => setInputValue(alt, "Updated Brian logo"));
    act(() => host.querySelector<HTMLButtonElement>('[aria-label="Worksheet image editor"] button')!.click());
    expect(onCommand).toHaveBeenCalledWith(expect.objectContaining({ kind: "updateSpreadsheetImage", imageId, altText: "Updated Brian logo" }));
    const brianInput = host.querySelector<HTMLInputElement>('[aria-label="Edit with Brian"]')!;
    act(() => setInputValue(brianInput, "Make it wider"));
    const brianButton = Array.from(host.querySelectorAll<HTMLButtonElement>('[aria-label="Worksheet image editor"] button')).at(-1)!;
    act(() => brianButton.click());
    expect(onEditImageWithBrian).toHaveBeenCalledWith(imageId, "Make it wider");

    act(() => underlyingCell.click());
    expect(image.getAttribute("aria-pressed")).toBe("false");
    expect(underlyingCell.getAttribute("aria-selected")).toBe("true");
    expect(formula.disabled).toBe(false);
    expect(onSelectTargets).toHaveBeenLastCalledWith([snapshot.worksheets[0].cells.find((cell) => cell.address === "A2")!.id]);

    act(() => root.unmount());
    host.remove();
  }, 15_000);

  it("normalizes ranges, spreadsheet navigation, and clipboard formulas", () => {
    const selection = { anchor: "C3", focus: "A1" };
    expect(spreadsheetSelectionLabel(selection)).toBe("A1:C3");
    expect(spreadsheetSelectionAddresses(selection)).toHaveLength(9);
    expect(moveSpreadsheetAddress("A1", "up", { rows: 30, columns: 12 })).toBe("A1");
    expect(moveSpreadsheetAddress("A1", "right", { rows: 30, columns: 12 })).toBe("B1");
    expect(moveSpreadsheetAddress("A1", "right", { rows: 30, columns: 12 }, ["A1:B1"])).toBe("C1");
    expect(parseSpreadsheetClipboard('One\t"Two\nlines"\r\n3\t4\r\n')).toEqual([["One", "Two\nlines"], ["3", "4"]]);
    expect(shiftSpreadsheetFormula('SUM(A1,$B2,C$3,$D$4,"A1")', 1, 2)).toBe('SUM(C2,$B3,E$3,$D$4,"A1")');
    expect(shiftSpreadsheetFormula("LOG10('Q1'!A1)+Q1!B2", 1, 1)).toBe("LOG10('Q1'!B2)+Q1!C3");
    expect(spreadsheetSelectionTsv(spreadsheetFixture().worksheets[0], { anchor: "A1", focus: "B2" })).toBe("Use Brian\t\n2\t=A2*2");
  });

  it("converts rendered dimensions and autofits from unmerged cell content", () => {
    const sheet = spreadsheetFixture().worksheets[0];
    expect(spreadsheetDimensionModelSize("column", 75)).toBe(10);
    expect(spreadsheetDimensionModelSize("row", 32)).toBe(24);
    expect(autofitSpreadsheetDimension(sheet, "column", 1, null)).toBeLessThan(100);
    const numericCell = { id: "00000000-0000-4000-8000-000000000099", address: "C3", valueType: "number" as const, value: 1212, style: {}, locked: false };
    sheet.cells.push(numericCell);
    expect(autofitSpreadsheetDimension(sheet, "column", 3, null)).toBeGreaterThanOrEqual(42);
    Object.assign(numericCell, { valueType: "string", value: "A much longer customer address for autofit" });
    expect(autofitSpreadsheetDimension(sheet, "column", 3, null)).toBeGreaterThan(200);
    sheet.cells.push({ id: "00000000-0000-4000-8000-000000000098", address: "D3", valueType: "blank", value: null, style: {}, locked: false });
    expect(autofitSpreadsheetDimension(sheet, "column", 4, null)).toBe(72);
  });

  it("commits one canonical dimension command after drag and supports double-click autofit", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const onCommand = vi.fn();
    act(() => root.render(<I18nProvider locale="en" dict={en as unknown as Dictionary}><SpreadsheetEditor snapshot={spreadsheetFixture()} baseVersion={1} role="edit" suggestMode={false} onCommand={onCommand} /></I18nProvider>));

    const rowHandle = host.querySelector<HTMLElement>('[data-row-resize="1"]')!;
    act(() => rowHandle.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, cancelable: true, button: 0, clientY: 100 })));
    act(() => window.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, clientY: 120 })));
    expect(onCommand).not.toHaveBeenCalled();
    act(() => window.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, clientY: 120 })));
    expect(onCommand).toHaveBeenCalledTimes(1);
    expect(onCommand).toHaveBeenLastCalledWith(expect.objectContaining({ kind: "setSpreadsheetDimension", axis: "row", index: 1, size: 41.25 }));

    const columnHandle = host.querySelector<HTMLElement>('[data-column-resize="B"]')!;
    act(() => columnHandle.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true })));
    expect(onCommand).toHaveBeenCalledTimes(2);
    expect(onCommand).toHaveBeenLastCalledWith(expect.objectContaining({ kind: "setSpreadsheetDimension", axis: "column", index: 2 }));

    act(() => root.unmount());
    host.remove();
  }, 15_000);

  it("drives range selection, keyboard navigation, direct entry, and clearing through the real grid", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const onCommand = vi.fn();
    act(() => root.render(<I18nProvider locale="en" dict={en as unknown as Dictionary}><SpreadsheetEditor snapshot={spreadsheetFixture()} baseVersion={1} role="edit" suggestMode={false} onCommand={onCommand} /></I18nProvider>));

    const cell = (address: string) => host.querySelector<HTMLButtonElement>(`[data-cell-address="${address}"]`)!;
    const reference = host.querySelector<HTMLElement>('[aria-label="Cell reference"]')!;
    const grid = host.querySelector<HTMLDivElement>('[role="grid"]')!;
    const formula = host.querySelector<HTMLInputElement>('[aria-label="Cell value or formula"]')!;

    act(() => cell("A2").click());
    expect(reference.textContent).toBe("A2");
    act(() => cell("B3").dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: true })));
    expect(reference.textContent).toBe("A2:B3");

    act(() => cell("A2").click());
    act(() => grid.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true })));
    expect(reference.textContent).toBe("A3");
    act(() => grid.dispatchEvent(new KeyboardEvent("keydown", { key: "7", bubbles: true, cancelable: true })));
    expect(formula.value).toBe("7");
    act(() => formula.focus());
    act(() => formula.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));
    expect(onCommand).toHaveBeenCalledWith(expect.objectContaining({ kind: "setSpreadsheetCell", address: "A3", valueType: "number", value: 7 }));
    expect(reference.textContent).toBe("A4");
    expect(onCommand).toHaveBeenCalledTimes(1);
    act(() => formula.blur());
    expect(onCommand).toHaveBeenCalledTimes(1);

    act(() => cell("A2").click());
    act(() => grid.dispatchEvent(new KeyboardEvent("keydown", { key: "Backspace", bubbles: true, cancelable: true })));
    expect(onCommand).toHaveBeenLastCalledWith(expect.objectContaining({ kind: "setSpreadsheetCell", address: "A2", valueType: "blank", value: null }));

    act(() => root.unmount());
    host.remove();
  }, 15_000);
});

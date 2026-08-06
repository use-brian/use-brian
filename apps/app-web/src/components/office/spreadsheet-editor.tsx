"use client";

/** Brian-owned worksheet grid over the canonical spreadsheet model. [COMP:app-web/office-spreadsheet-editor] */
import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { ArrowLeft, ArrowRight, Copy, FileSpreadsheet, LockKeyhole, Pencil, Plus, Trash2 } from "lucide-react";
import {
  columnIndexToName,
  parseCellAddress,
  spreadsheetCellDisplayValue,
  type OfficeCommand,
  type SpreadsheetCell,
  type SpreadsheetCellStyle,
  type SpreadsheetSnapshot,
  type SpreadsheetWorksheet,
} from "@use-brian/office-model";
import { addWorksheetCommand, deleteWorksheetCommand, renameWorksheetCommand, reorderWorksheetCommand, setSpreadsheetCellCommand } from "@/lib/office/editor-commands";
import { getOfficeResourceObjectUrl } from "@/lib/office/api";
import { confirmDialog } from "@/components/ui/confirm-dialog";
import { useT } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";

const ROW_HEADER_WIDTH = 46;
const COLUMN_HEADER_HEIGHT = 28;
const DEFAULT_COLUMN_WIDTH = 72;
const DEFAULT_ROW_HEIGHT = 20;

export function SpreadsheetEditor({ snapshot, baseVersion, role, suggestMode, onCommand, onSelectTargets }: { snapshot: SpreadsheetSnapshot; baseVersion: number; role: "view" | "comment" | "edit"; suggestMode: boolean; onCommand(command: OfficeCommand): void; onSelectTargets?(ids: string[]): void }) {
  const t = useT().office;
  const canChange = role === "edit" || role === "comment" && suggestMode;
  const firstVisible = snapshot.worksheets.find((sheet) => sheet.visibility === "visible") ?? snapshot.worksheets[0];
  const [sheetId, setSheetId] = useState(snapshot.worksheets.some((sheet) => sheet.id === snapshot.activeSheetId && sheet.visibility === "visible") ? snapshot.activeSheetId : firstVisible.id);
  const [selectedAddress, setSelectedAddress] = useState("A1");
  const [draft, setDraft] = useState("");
  const [editError, setEditError] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState<string | null>(null);
  const sheet = snapshot.worksheets.find((candidate) => candidate.id === sheetId) ?? firstVisible;
  const cellMap = useMemo(() => new Map(sheet.cells.map((cell) => [cell.address, cell])), [sheet.cells]);
  const selectedCell = cellMap.get(selectedAddress);

  useEffect(() => {
    const cell = cellMap.get(selectedAddress);
    setDraft(cell?.formula ? `=${cell.formula}` : cell?.value === null || cell?.value === undefined ? "" : String(cell.value));
    setEditError(null);
    onSelectTargets?.(cell ? [cell.id] : [sheet.id]);
  }, [cellMap, onSelectTargets, selectedAddress, sheet.id]);

  function commit() {
    if (!canChange || selectedCell?.locked) return;
    const value = draft.trim();
    if (spreadsheetValidationError(sheet, selectedAddress, value)) { setEditError(t.invalidCellValue.replace("{address}", selectedAddress)); return; }
    setEditError(null);
    const formula = value.startsWith("=") ? value.slice(1) : undefined;
    const parsedNumber = value !== "" && !formula ? Number(value) : Number.NaN;
    const bool = !formula && /^(true|false)$/i.test(value);
    const valueType = formula ? selectedCell?.valueType === "date" ? "date" : "number" : value === "" ? "blank" : bool ? "boolean" : Number.isFinite(parsedNumber) ? "number" : "string";
    const cellValue = formula ? null : valueType === "blank" ? null : valueType === "boolean" ? value.toLocaleLowerCase() === "true" : valueType === "number" ? parsedNumber : value;
    onCommand(setSpreadsheetCellCommand({ artifactId: snapshot.artifactId, baseVersion, sheetId: sheet.id, cellId: selectedCell?.id ?? crypto.randomUUID(), address: selectedAddress, valueType, value: cellValue, formula }));
  }

  function addBlankWorksheet() {
    if (!canChange) return;
    const id = crypto.randomUUID();
    const name = uniqueWorksheetName(t.newWorksheet, snapshot.worksheets.map((item) => item.name));
    onCommand(addWorksheetCommand(snapshot.artifactId, baseVersion, snapshot.worksheets.length, { id, name, visibility: "visible", cells: [], merges: [], rowDimensions: [], columnDimensions: [], freeze: { rows: 0, columns: 0 }, images: [], validations: [], conditionalFormats: [], print: { paperSize: "A4", orientation: "portrait", fitToWidth: 1, fitToHeight: 1, margins: { leftIn: 0.7, rightIn: 0.7, topIn: 0.75, bottomIn: 0.75, headerIn: 0.3, footerIn: 0.3 }, horizontalCentered: false, verticalCentered: false, showGridLines: false, showHeadings: false } }));
    setSheetId(id);
    setSelectedAddress("A1");
  }

  function duplicateWorksheet() {
    if (!canChange) return;
    const duplicate = duplicateSheet(sheet, uniqueWorksheetName(`${sheet.name} ${t.copySuffix}`, snapshot.worksheets.map((item) => item.name)));
    onCommand(addWorksheetCommand(snapshot.artifactId, baseVersion, snapshot.worksheets.indexOf(sheet) + 1, duplicate));
    setSheetId(duplicate.id);
    setSelectedAddress("A1");
  }

  function saveRename() {
    const name = renameDraft?.trim();
    if (!name || name === sheet.name || snapshot.worksheets.some((item) => item.id !== sheet.id && item.name.toLocaleLowerCase() === name.toLocaleLowerCase())) { setRenameDraft(null); return; }
    onCommand(renameWorksheetCommand(snapshot.artifactId, baseVersion, sheet.id, name));
    setRenameDraft(null);
  }

  async function deleteCurrentWorksheet() {
    if (!canChange || snapshot.worksheets.length <= 1) return;
    const confirmed = await confirmDialog({ title: t.deleteWorksheet, description: t.deleteWorksheetDescription.replace("{sheet}", sheet.name), confirmLabel: t.deleteWorksheet, cancelLabel: t.cancelWorksheetAction, variant: "destructive" });
    if (!confirmed) return;
    const index = snapshot.worksheets.indexOf(sheet);
    const next = snapshot.worksheets[index + 1] ?? snapshot.worksheets[index - 1];
    setSheetId(next.id);
    setSelectedAddress("A1");
    onCommand(deleteWorksheetCommand(snapshot.artifactId, baseVersion, sheet.id));
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background" data-office-editor="spreadsheet">
      <div className="flex items-center gap-2 border-b bg-background px-2 py-1.5" role="toolbar" aria-label={t.spreadsheetToolbar}>
        <div className="flex h-8 w-20 shrink-0 items-center rounded border bg-muted/30 px-2 font-mono text-xs" aria-label={t.cellReference}>{selectedAddress}</div>
        <span className="text-sm font-semibold text-muted-foreground" aria-hidden>=</span>
        <input
          value={draft}
          disabled={!canChange || Boolean(selectedCell?.locked)}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); commit(); event.currentTarget.blur(); } }}
          aria-label={t.formulaBar}
          className="h-8 min-w-0 flex-1 rounded border bg-background px-2 font-mono text-xs disabled:bg-muted/30"
        />
        {selectedCell?.locked ? <span className="inline-flex items-center gap-1 text-xs text-muted-foreground"><LockKeyhole className="size-3.5" aria-hidden />{t.lockedCell}</span> : null}
        {suggestMode ? <span className="rounded-full bg-amber-100 px-2 py-1 text-xs text-amber-900">{t.suggesting}</span> : null}
      </div>
      {editError ? <p role="alert" className="border-b bg-destructive/5 px-3 py-1.5 text-xs text-destructive">{editError}</p> : null}
      <WorksheetGrid artifactId={snapshot.artifactId} sheet={sheet} selectedAddress={selectedAddress} onSelect={setSelectedAddress} />
      {renameDraft !== null ? <div className="flex items-center gap-2 border-t bg-muted/20 px-2 py-1.5"><input autoFocus maxLength={31} value={renameDraft} onChange={(event) => setRenameDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") saveRename(); if (event.key === "Escape") setRenameDraft(null); }} aria-label={t.worksheetName} className="h-8 min-w-0 flex-1 rounded border bg-background px-2 text-xs" /><button type="button" onClick={saveRename} className="h-8 rounded bg-action px-3 text-xs font-medium text-action-foreground">{t.saveWorksheetName}</button><button type="button" onClick={() => setRenameDraft(null)} className="h-8 rounded border px-3 text-xs">{t.cancelWorksheetAction}</button></div> : null}
      <div className="flex min-h-10 items-end gap-0.5 overflow-x-auto border-t bg-muted/30 px-2 pt-1" role="tablist" aria-label={t.worksheetTabs}>
        {snapshot.worksheets.filter((item) => item.visibility === "visible").map((item) => (
          <button key={item.id} type="button" role="tab" aria-selected={item.id === sheet.id} onClick={() => { setSheetId(item.id); setSelectedAddress("A1"); }} className={cn("h-9 shrink-0 rounded-t-md border border-b-0 px-4 text-xs", item.id === sheet.id ? "bg-background font-medium text-foreground" : "bg-muted text-muted-foreground hover:text-foreground")}>{item.name}</button>
        ))}
        <div className="sticky right-0 ml-auto flex h-9 items-center gap-0.5 bg-muted/95 pl-2">
          <button type="button" disabled={!canChange} onClick={addBlankWorksheet} aria-label={t.addWorksheet} title={t.addWorksheet} className="rounded p-1.5 hover:bg-background disabled:opacity-30"><Plus className="size-3.5" /></button>
          <button type="button" disabled={!canChange} onClick={duplicateWorksheet} aria-label={t.duplicateWorksheet} title={t.duplicateWorksheet} className="rounded p-1.5 hover:bg-background disabled:opacity-30"><Copy className="size-3.5" /></button>
          <button type="button" disabled={!canChange || snapshot.worksheets.indexOf(sheet) === 0} onClick={() => onCommand(reorderWorksheetCommand(snapshot.artifactId, baseVersion, sheet.id, snapshot.worksheets.indexOf(sheet) - 1))} aria-label={t.moveWorksheetLeft} title={t.moveWorksheetLeft} className="rounded p-1.5 hover:bg-background disabled:opacity-30"><ArrowLeft className="size-3.5" /></button>
          <button type="button" disabled={!canChange || snapshot.worksheets.indexOf(sheet) === snapshot.worksheets.length - 1} onClick={() => onCommand(reorderWorksheetCommand(snapshot.artifactId, baseVersion, sheet.id, snapshot.worksheets.indexOf(sheet) + 1))} aria-label={t.moveWorksheetRight} title={t.moveWorksheetRight} className="rounded p-1.5 hover:bg-background disabled:opacity-30"><ArrowRight className="size-3.5" /></button>
          <button type="button" disabled={!canChange} onClick={() => setRenameDraft(sheet.name)} aria-label={t.renameWorksheet} title={t.renameWorksheet} className="rounded p-1.5 hover:bg-background disabled:opacity-30"><Pencil className="size-3.5" /></button>
          <button type="button" disabled={!canChange || snapshot.worksheets.length <= 1} onClick={() => void deleteCurrentWorksheet()} aria-label={t.deleteWorksheet} title={t.deleteWorksheet} className="rounded p-1.5 text-destructive hover:bg-background disabled:opacity-30"><Trash2 className="size-3.5" /></button>
        </div>
      </div>
    </div>
  );
}

function WorksheetGrid({ artifactId, sheet, selectedAddress, onSelect }: { artifactId: string; sheet: SpreadsheetWorksheet; selectedAddress: string; onSelect(address: string): void }) {
  const bounds = useMemo(() => worksheetBounds(sheet), [sheet]);
  const columnWidths = useMemo(() => Array.from({ length: bounds.columns }, (_, index) => widthOf(sheet, index + 1)), [bounds.columns, sheet]);
  const rowHeights = useMemo(() => Array.from({ length: bounds.rows }, (_, index) => heightOf(sheet, index + 1)), [bounds.rows, sheet]);
  const mergeMap = useMemo(() => mergedCells(sheet), [sheet]);
  const cells = useMemo(() => new Map(sheet.cells.map((cell) => [cell.address, cell])), [sheet.cells]);
  const gridTemplateColumns = `${ROW_HEADER_WIDTH}px ${columnWidths.map((width) => `${width}px`).join(" ")}`;
  const gridTemplateRows = `${COLUMN_HEADER_HEIGHT}px ${rowHeights.map((height) => `${height}px`).join(" ")}`;
  const totalWidth = ROW_HEADER_WIDTH + columnWidths.reduce((total, width) => total + width, 0);
  const totalHeight = COLUMN_HEADER_HEIGHT + rowHeights.reduce((total, height) => total + height, 0);

  return (
    <div className="relative min-h-0 flex-1 overflow-auto bg-[#f5f6f8]" data-worksheet={sheet.name}>
      <div role="grid" aria-label={sheet.name} className="relative grid bg-white shadow-sm" style={{ gridTemplateColumns, gridTemplateRows, width: totalWidth, height: totalHeight }}>
        <div className="sticky left-0 top-0 z-40 border-b border-r bg-[#f3f4f6]" />
        {columnWidths.map((_, index) => <div key={`column-${index + 1}`} role="columnheader" className="sticky top-0 z-30 flex items-center justify-center border-b border-r bg-[#f3f4f6] text-[11px] text-slate-600" style={{ gridColumn: index + 2, gridRow: 1 }}>{columnIndexToName(index + 1)}</div>)}
        {rowHeights.map((_, index) => <div key={`row-${index + 1}`} role="rowheader" className="sticky left-0 z-20 flex items-center justify-center border-b border-r bg-[#f3f4f6] text-[11px] text-slate-600" style={{ gridColumn: 1, gridRow: index + 2 }}>{index + 1}</div>)}
        {Array.from({ length: bounds.rows }, (_, rowIndex) => Array.from({ length: bounds.columns }, (_, columnIndex) => {
          const address = `${columnIndexToName(columnIndex + 1)}${rowIndex + 1}`;
          const merge = mergeMap.get(address);
          if (merge?.covered) return null;
          const cell = cells.get(address);
          return <WorksheetCell key={address} address={address} cell={cell} conditionalStyle={conditionalStyleFor(sheet, address, cell)} selected={selectedAddress === address} merge={merge} row={rowIndex + 1} column={columnIndex + 1} onSelect={onSelect} />;
        }))}
        {sheet.images.map((image) => <WorksheetImage key={image.id} artifactId={artifactId} resourceId={image.resourceId} alt={image.altText} decorative={image.decorative} left={ROW_HEADER_WIDTH + gridAxisOffset(columnWidths, image.from.column)} top={COLUMN_HEADER_HEIGHT + gridAxisOffset(rowHeights, image.from.row)} width={Math.max(1, gridAxisOffset(columnWidths, image.to.column) - gridAxisOffset(columnWidths, image.from.column))} height={Math.max(1, gridAxisOffset(rowHeights, image.to.row) - gridAxisOffset(rowHeights, image.from.row))} />)}
      </div>
    </div>
  );
}

function WorksheetCell({ address, cell, conditionalStyle, selected, merge, row, column, onSelect }: { address: string; cell?: SpreadsheetCell; conditionalStyle?: SpreadsheetCellStyle; selected: boolean; merge?: MergePlacement; row: number; column: number; onSelect(address: string): void }) {
  const style = cellStyle(mergeCellStyles(cell?.style, conditionalStyle), cell?.numberFormat, cell);
  return (
    <button
      type="button"
      role="gridcell"
      aria-label={`${address}: ${cell ? spreadsheetCellDisplayValue(cell) : ""}`}
      aria-selected={selected}
      onClick={() => onSelect(address)}
      className={cn("relative z-0 flex min-h-0 min-w-0 overflow-hidden border-b border-r border-[#d9dde3] bg-white px-1 text-left text-xs outline-none", selected && "z-10 ring-2 ring-inset ring-[#2684ff]")}
      style={{ ...style, gridColumn: `${column + 1} / span ${merge?.columnSpan ?? 1}`, gridRow: `${row + 1} / span ${merge?.rowSpan ?? 1}` }}
    >
      <span className="block max-h-full w-full overflow-hidden">{cell ? spreadsheetCellDisplayValue(cell) : ""}</span>
    </button>
  );
}

function WorksheetImage({ artifactId, resourceId, alt, decorative, left, top, width, height }: { artifactId: string; resourceId: string; alt: string; decorative: boolean; left: number; top: number; width: number; height: number }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => { let active = true; void getOfficeResourceObjectUrl(artifactId, resourceId).then((url) => { if (active) setSrc(url); }).catch(() => undefined); return () => { active = false; }; }, [artifactId, resourceId]);
  if (!src) return <span className="pointer-events-none absolute z-10 flex items-center justify-center bg-muted/60" style={{ left, top, width, height }}><FileSpreadsheet className="size-5 text-muted-foreground/40" /></span>;
  return <img src={src} alt={decorative ? "" : alt} className="pointer-events-none absolute z-10 object-contain" style={{ left, top, width, height }} />;
}

type MergePlacement = { covered: boolean; rowSpan: number; columnSpan: number };
function mergedCells(sheet: SpreadsheetWorksheet): Map<string, MergePlacement> {
  const result = new Map<string, MergePlacement>();
  for (const range of sheet.merges) {
    const [fromRaw, toRaw] = range.split(":");
    const from = parseCellAddress(fromRaw);
    const to = parseCellAddress(toRaw);
    if (!from || !to) continue;
    for (let row = from.row; row <= to.row; row += 1) for (let column = from.column; column <= to.column; column += 1) result.set(`${columnIndexToName(column)}${row}`, { covered: row !== from.row || column !== from.column, rowSpan: to.row - from.row + 1, columnSpan: to.column - from.column + 1 });
  }
  return result;
}

function worksheetBounds(sheet: SpreadsheetWorksheet): { rows: number; columns: number } {
  let rows = 30;
  let columns = 12;
  const printEnd = sheet.print.printArea?.split(":")[1];
  for (const address of [...sheet.cells.map((cell) => cell.address), ...sheet.merges.flatMap((merge) => merge.split(":")), ...(printEnd ? [printEnd] : [])]) {
    const parsed = parseCellAddress(address);
    if (!parsed) continue;
    rows = Math.max(rows, parsed.row);
    columns = Math.max(columns, parsed.column);
  }
  return { rows: Math.min(rows, 250), columns: Math.min(columns, 60) };
}

function widthOf(sheet: SpreadsheetWorksheet, column: number): number {
  const dimension = sheet.columnDimensions.find((item) => item.index === column);
  if (dimension?.hidden) return 0;
  return dimension ? Math.max(18, Math.round(dimension.widthChars * 7 + 5)) : DEFAULT_COLUMN_WIDTH;
}

function heightOf(sheet: SpreadsheetWorksheet, row: number): number {
  const dimension = sheet.rowDimensions.find((item) => item.index === row);
  if (dimension?.hidden) return 0;
  return dimension ? Math.max(4, Math.round(dimension.heightPt * 96 / 72)) : DEFAULT_ROW_HEIGHT;
}

export function gridAxisOffset(values: number[], coordinate: number): number {
  const bounded = Math.max(0, coordinate);
  const whole = Math.floor(bounded);
  const fraction = bounded - whole;
  return values.slice(0, whole).reduce((total, value) => total + value, 0) + (values[whole] ?? 0) * fraction;
}

function cellStyle(style: SpreadsheetCellStyle | undefined, numberFormat: string | undefined, cell: SpreadsheetCell | undefined): CSSProperties {
  const border = (side: NonNullable<SpreadsheetCellStyle["border"]>["top"]) => side?.style ? `${side.style === "double" ? 3 : side.style === "thick" ? 2 : 1}px ${side.style === "dotted" ? "dotted" : side.style === "dashed" ? "dashed" : side.style === "double" ? "double" : "solid"} ${side.color ?? "#334155"}` : undefined;
  return {
    backgroundColor: style?.fill,
    color: numberFormat?.includes("[Red]") && typeof (cell?.formula ? cell.calculatedValue : cell?.value) === "number" && Number(cell?.formula ? cell.calculatedValue : cell?.value) < 0 ? "#DC2626" : style?.font?.color,
    fontFamily: style?.font?.family,
    fontSize: style?.font ? `${style.font.sizePt}pt` : undefined,
    fontWeight: style?.font?.bold ? 700 : undefined,
    fontStyle: style?.font?.italic ? "italic" : undefined,
    textDecoration: style?.font?.underline ? "underline" : style?.font?.strike ? "line-through" : undefined,
    textAlign: style?.alignment?.horizontal === "center" ? "center" : style?.alignment?.horizontal === "right" ? "right" : "left",
    alignItems: style?.alignment?.vertical === "middle" ? "center" : style?.alignment?.vertical === "bottom" ? "end" : "start",
    whiteSpace: style?.alignment?.wrapText ? "normal" : "nowrap",
    paddingLeft: style?.alignment?.indent ? `${4 + style.alignment.indent * 8}px` : undefined,
    borderTop: border(style?.border?.top),
    borderRight: border(style?.border?.right),
    borderBottom: border(style?.border?.bottom),
    borderLeft: border(style?.border?.left),
    fontVariantNumeric: numberFormat ? "tabular-nums" : undefined,
  };
}

function spreadsheetValidationError(sheet: SpreadsheetWorksheet, address: string, value: string): boolean {
  const validation = sheet.validations.find((candidate) => addressInRange(address, candidate.range));
  if (!validation || value === "" && validation.allowBlank || value.startsWith("=")) return false;
  if (validation.type === "list") {
    const inline = validation.formulas[0]?.replace(/^=/, "").replace(/^"|"$/g, "");
    if (!inline || !inline.includes(",")) return false;
    return !inline.split(",").map((item) => item.trim()).includes(value);
  }
  if (validation.type === "whole" || validation.type === "decimal") {
    const number = Number(value);
    if (!Number.isFinite(number) || validation.type === "whole" && !Number.isInteger(number)) return true;
    const first = Number(validation.formulas[0]);
    const second = Number(validation.formulas[1]);
    if (validation.operator === "between") return Number.isFinite(first) && number < first || Number.isFinite(second) && number > second;
    if (validation.operator === "notBetween") return Number.isFinite(first) && Number.isFinite(second) && number >= first && number <= second;
    if (validation.operator === "equal") return Number.isFinite(first) && number !== first;
    if (validation.operator === "notEqual") return Number.isFinite(first) && number === first;
    if (validation.operator === "greaterThan") return Number.isFinite(first) && number <= first;
    if (validation.operator === "greaterThanOrEqual") return Number.isFinite(first) && number < first;
    if (validation.operator === "lessThan") return Number.isFinite(first) && number >= first;
    if (validation.operator === "lessThanOrEqual") return Number.isFinite(first) && number > first;
  }
  return false;
}

function addressInRange(address: string, range: string): boolean {
  const cell = parseCellAddress(address);
  const [from, to = from] = range.split(":").map(parseCellAddress);
  return Boolean(cell && from && to && cell.row >= Math.min(from.row, to.row) && cell.row <= Math.max(from.row, to.row) && cell.column >= Math.min(from.column, to.column) && cell.column <= Math.max(from.column, to.column));
}

function conditionalStyleFor(sheet: SpreadsheetWorksheet, address: string, cell: SpreadsheetCell | undefined): SpreadsheetCellStyle | undefined {
  if (!cell) return undefined;
  const display = spreadsheetCellDisplayValue(cell);
  const numeric = Number(cell.formula ? cell.calculatedValue : cell.value);
  const rules = sheet.conditionalFormats.filter((rule) => addressInRange(address, rule.range)).sort((left, right) => left.priority - right.priority);
  for (const rule of rules) {
    const formula = rule.formulas[0]?.replace(/^=/, "").replace(/^"|"$/g, "") ?? "";
    if (rule.ruleType === "containsText" && display.includes(formula)) return rule.style;
    if (rule.ruleType === "expression") {
      const match = /^(?:[A-Z]{1,3}[1-9][0-9]{0,6})?\s*(=|<>)\s*"([^"]*)"$/.exec(formula);
      if (match && (match[1] === "=" ? display === match[2] : display !== match[2])) return rule.style;
    }
    if (rule.ruleType === "cellIs" && Number.isFinite(numeric)) {
      const expected = Number(formula);
      const second = Number(rule.formulas[1]);
      const matches = rule.operator === "greaterThan" ? numeric > expected : rule.operator === "lessThan" ? numeric < expected : rule.operator === "greaterThanOrEqual" ? numeric >= expected : rule.operator === "lessThanOrEqual" ? numeric <= expected : rule.operator === "notEqual" ? numeric !== expected : rule.operator === "between" ? numeric >= expected && numeric <= second : rule.operator === "notBetween" ? numeric < expected || numeric > second : numeric === expected;
      if (matches) return rule.style;
    }
  }
  return undefined;
}

function mergeCellStyles(base: SpreadsheetCellStyle | undefined, overlay: SpreadsheetCellStyle | undefined): SpreadsheetCellStyle | undefined {
  if (!overlay) return base;
  return { ...base, ...overlay, font: overlay.font ?? base?.font, border: { ...base?.border, ...overlay.border }, alignment: overlay.alignment ?? base?.alignment };
}

function uniqueWorksheetName(base: string, existingNames: string[]): string {
  const occupied = new Set(existingNames.map((name) => name.toLocaleLowerCase()));
  const safeBase = (base.trim() || "Sheet").slice(0, 31);
  if (!occupied.has(safeBase.toLocaleLowerCase())) return safeBase;
  for (let suffix = 2; suffix < 10_000; suffix += 1) {
    const suffixText = ` ${suffix}`;
    const candidate = `${safeBase.slice(0, 31 - suffixText.length)}${suffixText}`;
    if (!occupied.has(candidate.toLocaleLowerCase())) return candidate;
  }
  return crypto.randomUUID().slice(0, 31);
}

function duplicateSheet(sheet: SpreadsheetWorksheet, name: string): SpreadsheetWorksheet {
  const duplicate = structuredClone(sheet);
  duplicate.id = crypto.randomUUID();
  duplicate.name = name;
  duplicate.cells = duplicate.cells.map((cell) => ({ ...cell, id: crypto.randomUUID() }));
  duplicate.images = duplicate.images.map((image) => ({ ...image, id: crypto.randomUUID() }));
  duplicate.validations = duplicate.validations.map((validation) => ({ ...validation, id: crypto.randomUUID() }));
  duplicate.conditionalFormats = duplicate.conditionalFormats.map((rule) => ({ ...rule, id: crypto.randomUUID() }));
  return duplicate;
}

"use client";

/** Brian-owned worksheet grid over the canonical spreadsheet model. [COMP:app-web/office-spreadsheet-editor] */
import { useEffect, useMemo, useRef, useState, type ClipboardEvent as ReactClipboardEvent, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { ArrowLeft, ArrowRight, Copy, FileSpreadsheet, LockKeyhole, Pencil, Plus, Sparkles, Trash2 } from "lucide-react";
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
import { addWorksheetCommand, deleteCommand, deleteWorksheetCommand, renameWorksheetCommand, reorderWorksheetCommand, setSpreadsheetCellCommand, setSpreadsheetDimensionCommand, updateSpreadsheetImageCommand } from "@/lib/office/editor-commands";
import { getOfficeResourceObjectUrl } from "@/lib/office/api";
import { confirmDialog } from "@/components/ui/confirm-dialog";
import { useT } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";

const ROW_HEADER_WIDTH = 46;
const COLUMN_HEADER_HEIGHT = 28;
const DEFAULT_COLUMN_WIDTH = 72;
const DEFAULT_ROW_HEIGHT = 20;
const MIN_COLUMN_WIDTH = 18;
const MAX_COLUMN_WIDTH = 1_790;
const MIN_ROW_HEIGHT = 4;
const MAX_ROW_HEIGHT = Math.round(4_096 * 96 / 72);
const SPREADSHEET_CLIPBOARD_MIME = "application/x-use-brian-spreadsheet-range";

export type SpreadsheetSelection = { anchor: string; focus: string };

export function SpreadsheetEditor({ snapshot, baseVersion, role, suggestMode, onCommand, onSelectTargets, onEditImageWithBrian }: { snapshot: SpreadsheetSnapshot; baseVersion: number; role: "view" | "comment" | "edit"; suggestMode: boolean; onCommand(command: OfficeCommand): void; onSelectTargets?(ids: string[]): void; onEditImageWithBrian?(imageId: string, instruction: string): Promise<void> | void }) {
  const t = useT().office;
  const canChange = role === "edit" || role === "comment" && suggestMode;
  const firstVisible = snapshot.worksheets.find((sheet) => sheet.visibility === "visible") ?? snapshot.worksheets[0];
  const [sheetId, setSheetId] = useState(snapshot.worksheets.some((sheet) => sheet.id === snapshot.activeSheetId && sheet.visibility === "visible") ? snapshot.activeSheetId : firstVisible.id);
  const [selection, setSelection] = useState<SpreadsheetSelection>({ anchor: "A1", focus: "A1" });
  const [selectedImageId, setSelectedImageId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [editError, setEditError] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState<string | null>(null);
  const formulaInputRef = useRef<HTMLInputElement | null>(null);
  const skipFormulaBlurCommit = useRef(false);
  const sheet = snapshot.worksheets.find((candidate) => candidate.id === sheetId) ?? firstVisible;
  const cellMap = useMemo(() => new Map(sheet.cells.map((cell) => [cell.address, cell])), [sheet.cells]);
  const selectedAddress = selection.focus;
  const selectedCell = cellMap.get(selectedAddress);
  const selectedImage = selectedImageId ? sheet.images.find((image) => image.id === selectedImageId) : undefined;

  useEffect(() => {
    const cell = cellMap.get(selectedAddress);
    setDraft(cell?.formula ? `=${cell.formula}` : cell?.value === null || cell?.value === undefined ? "" : String(cell.value));
    setEditError(null);
    if (selectedImage) {
      onSelectTargets?.([selectedImage.id]);
      return;
    }
    const targetIds = spreadsheetSelectionAddresses(selection).map((address) => cellMap.get(address)?.id).filter((id): id is string => Boolean(id));
    onSelectTargets?.(targetIds.length > 0 ? targetIds : [sheet.id]);
  }, [cellMap, onSelectTargets, selectedAddress, selectedImage, selection, sheet.id]);

  function selectAddress(address: string, extend = false) {
    setSelectedImageId(null);
    setSelection((current) => ({ anchor: extend ? current.anchor : address, focus: address }));
  }

  function commandCell(address: string, input: string): boolean {
    const cell = cellMap.get(address);
    if (!canChange || cell?.locked) return false;
    if (input === spreadsheetCellEditorInput(cell)) { setEditError(null); return true; }
    if (spreadsheetValidationError(sheet, address, input)) { setEditError(t.invalidCellValue.replace("{address}", address)); return false; }
    setEditError(null);
    const parsed = spreadsheetInput(input, cell);
    onCommand(setSpreadsheetCellCommand({ artifactId: snapshot.artifactId, baseVersion, sheetId: sheet.id, cellId: cell?.id ?? crypto.randomUUID(), address, ...parsed }));
    return true;
  }

  function commit() {
    commandCell(selectedAddress, draft);
  }

  function clearSelection() {
    for (const address of spreadsheetSelectionAddresses(selection)) if (cellMap.has(address)) commandCell(address, "");
  }

  function copySelection(event: ReactClipboardEvent, cut: boolean) {
    const range = spreadsheetSelectionRange(selection);
    const text = spreadsheetSelectionTsv(sheet, selection);
    event.clipboardData.setData("text/plain", text);
    event.clipboardData.setData(SPREADSHEET_CLIPBOARD_MIME, JSON.stringify({ from: range.from, text }));
    event.preventDefault();
    if (cut && canChange) clearSelection();
  }

  function pasteSelection(event: ReactClipboardEvent) {
    if (!canChange) return;
    const raw = event.clipboardData.getData("text/plain");
    if (!raw) return;
    event.preventDefault();
    const matrix = parseSpreadsheetClipboard(raw);
    const target = parseCellAddress(selectedAddress);
    if (!target || matrix.length === 0) return;
    let source = target;
    try {
      const internal = JSON.parse(event.clipboardData.getData(SPREADSHEET_CLIPBOARD_MIME)) as { from?: string; text?: string };
      if (internal.text === raw && internal.from) source = parseCellAddress(internal.from) ?? target;
    } catch { /* A normal external clipboard has no Brian payload. */ }
    for (const [rowOffset, row] of matrix.entries()) for (const [columnOffset, value] of row.entries()) {
      const address = `${columnIndexToName(target.column + columnOffset)}${target.row + rowOffset}`;
      const translated = value.startsWith("=") ? `=${shiftSpreadsheetFormula(value.slice(1), target.row - source.row, target.column - source.column)}` : value;
      commandCell(address, translated);
    }
    const focus = `${columnIndexToName(target.column + Math.max(0, ...matrix.map((row) => row.length - 1)))}${target.row + matrix.length - 1}`;
    setSelection({ anchor: selectedAddress, focus });
  }

  function moveSelection(key: SpreadsheetNavigationKey, extend: boolean) {
    const bounds = worksheetBounds(sheet);
    const focus = moveSpreadsheetAddress(selectedAddress, key, bounds, sheet.merges);
    selectAddress(focus, extend);
  }

  function beginEdit(seed?: string) {
    if (!canChange || selectedCell?.locked) return;
    if (seed !== undefined) setDraft(seed);
    requestAnimationFrame(() => {
      const input = formulaInputRef.current;
      input?.focus();
      if (!input) return;
      const caret = seed?.length ?? input.value.length;
      input.setSelectionRange(caret, caret);
    });
  }

  function addBlankWorksheet() {
    if (!canChange) return;
    const id = crypto.randomUUID();
    const name = uniqueWorksheetName(t.newWorksheet, snapshot.worksheets.map((item) => item.name));
    onCommand(addWorksheetCommand(snapshot.artifactId, baseVersion, snapshot.worksheets.length, { id, name, visibility: "visible", cells: [], merges: [], rowDimensions: [], columnDimensions: [], freeze: { rows: 0, columns: 0 }, images: [], validations: [], conditionalFormats: [], print: { paperSize: "A4", orientation: "portrait", fitToWidth: 1, fitToHeight: 1, margins: { leftIn: 0.7, rightIn: 0.7, topIn: 0.75, bottomIn: 0.75, headerIn: 0.3, footerIn: 0.3 }, horizontalCentered: false, verticalCentered: false, showGridLines: false, showHeadings: false } }));
    setSheetId(id);
    setSelectedImageId(null);
    setSelection({ anchor: "A1", focus: "A1" });
  }

  function duplicateWorksheet() {
    if (!canChange) return;
    const duplicate = duplicateSheet(sheet, uniqueWorksheetName(`${sheet.name} ${t.copySuffix}`, snapshot.worksheets.map((item) => item.name)));
    onCommand(addWorksheetCommand(snapshot.artifactId, baseVersion, snapshot.worksheets.indexOf(sheet) + 1, duplicate));
    setSheetId(duplicate.id);
    setSelectedImageId(null);
    setSelection({ anchor: "A1", focus: "A1" });
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
    setSelectedImageId(null);
    setSelection({ anchor: "A1", focus: "A1" });
    onCommand(deleteWorksheetCommand(snapshot.artifactId, baseVersion, sheet.id));
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background" data-office-editor="spreadsheet">
      <div className="flex items-center gap-2 border-b bg-background px-2 py-1.5" role="toolbar" aria-label={t.spreadsheetToolbar}>
        <div className="flex h-8 w-24 shrink-0 items-center rounded border bg-muted/30 px-2 font-mono text-xs" aria-label={t.cellReference}>{spreadsheetSelectionLabel(selection)}</div>
        <span className="text-sm font-semibold text-muted-foreground" aria-hidden>=</span>
        <input
          ref={formulaInputRef}
          value={draft}
          disabled={!canChange || Boolean(selectedCell?.locked) || Boolean(selectedImage)}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => { if (skipFormulaBlurCommit.current) skipFormulaBlurCommit.current = false; else commit(); }}
          onKeyDown={(event) => {
            if (event.key === "Enter") { event.preventDefault(); if (commandCell(selectedAddress, draft)) moveSelection("down", event.shiftKey); }
            if (event.key === "Escape") { event.preventDefault(); skipFormulaBlurCommit.current = true; setDraft(selectedCell?.formula ? `=${selectedCell.formula}` : selectedCell?.value === null || selectedCell?.value === undefined ? "" : String(selectedCell.value)); event.currentTarget.blur(); }
          }}
          aria-label={t.formulaBar}
          className="h-8 min-w-0 flex-1 rounded border bg-background px-2 font-mono text-xs disabled:bg-muted/30"
        />
        {selectedCell?.locked ? <span className="inline-flex items-center gap-1 text-xs text-muted-foreground"><LockKeyhole className="size-3.5" aria-hidden />{t.lockedCell}</span> : null}
        {suggestMode ? <span className="rounded-full bg-amber-100 px-2 py-1 text-xs text-amber-900">{t.suggesting}</span> : null}
      </div>
      {editError ? <p role="alert" className="border-b bg-destructive/5 px-3 py-1.5 text-xs text-destructive">{editError}</p> : null}
      {selectedImage ? <SpreadsheetImageInspector image={selectedImage} canChange={canChange} canRequestBrian={canChange && Boolean(onEditImageWithBrian)} onApply={(next) => onCommand(updateSpreadsheetImageCommand({ artifactId: snapshot.artifactId, baseVersion, sheetId: sheet.id, imageId: selectedImage.id, ...next }))} onDelete={async () => { const confirmed = await confirmDialog({ title: t.deleteWorksheetImage, description: t.deleteWorksheetImageDescription, confirmLabel: t.deleteWorksheetImage, cancelLabel: t.cancelWorksheetAction, variant: "destructive" }); if (confirmed) { onCommand(deleteCommand(snapshot.artifactId, baseVersion, selectedImage.id)); setSelectedImageId(null); } }} onEditWithBrian={(instruction) => onEditImageWithBrian?.(selectedImage.id, instruction)} /> : null}
      {worksheetContentExceedsEditorBounds(sheet) ? <p role="status" className="border-b bg-amber-50 px-3 py-1.5 text-xs text-amber-950">{t.spreadsheetRangeLimited}</p> : null}
      <WorksheetGrid artifactId={snapshot.artifactId} sheet={sheet} selection={selection} selectedImageId={selectedImage?.id ?? null} canChange={canChange} onSelect={selectAddress} onSelectImage={setSelectedImageId} onMove={moveSelection} onBeginEdit={beginEdit} onClear={clearSelection} onCopy={(event) => copySelection(event, false)} onCut={(event) => copySelection(event, true)} onPaste={pasteSelection} onResizeDimension={(axis, index, size) => onCommand(setSpreadsheetDimensionCommand({ artifactId: snapshot.artifactId, baseVersion, sheetId: sheet.id, axis, index, size }))} />
      {renameDraft !== null ? <div className="flex items-center gap-2 border-t bg-muted/20 px-2 py-1.5"><input autoFocus maxLength={31} value={renameDraft} onChange={(event) => setRenameDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") saveRename(); if (event.key === "Escape") setRenameDraft(null); }} aria-label={t.worksheetName} className="h-8 min-w-0 flex-1 rounded border bg-background px-2 text-xs" /><button type="button" onClick={saveRename} className="h-8 rounded bg-action px-3 text-xs font-medium text-action-foreground">{t.saveWorksheetName}</button><button type="button" onClick={() => setRenameDraft(null)} className="h-8 rounded border px-3 text-xs">{t.cancelWorksheetAction}</button></div> : null}
      <div className="flex min-h-10 items-end gap-0.5 overflow-x-auto border-t bg-muted/30 px-2 pt-1" role="tablist" aria-label={t.worksheetTabs}>
        {snapshot.worksheets.filter((item) => item.visibility === "visible").map((item) => (
          <button key={item.id} type="button" role="tab" aria-selected={item.id === sheet.id} onClick={() => { setSheetId(item.id); setSelectedImageId(null); setSelection({ anchor: "A1", focus: "A1" }); }} className={cn("h-9 shrink-0 rounded-t-md border border-b-0 px-4 text-xs", item.id === sheet.id ? "bg-background font-medium text-foreground" : "bg-muted text-muted-foreground hover:text-foreground")}>{item.name}</button>
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

type SpreadsheetImage = SpreadsheetWorksheet["images"][number];

function SpreadsheetImageInspector({ image, canChange, canRequestBrian, onApply, onDelete, onEditWithBrian }: { image: SpreadsheetImage; canChange: boolean; canRequestBrian: boolean; onApply(next: Pick<SpreadsheetImage, "from" | "to" | "altText" | "decorative">): void; onDelete(): void | Promise<void>; onEditWithBrian(instruction: string): void | Promise<void> }) {
  const t = useT().office;
  const [draft, setDraft] = useState(() => imageInspectorDraft(image));
  const [brianInstruction, setBrianInstruction] = useState("");
  const [brianBusy, setBrianBusy] = useState(false);
  const [brianError, setBrianError] = useState(false);
  useEffect(() => setDraft(imageInspectorDraft(image)), [image]);
  const value = (key: keyof typeof draft, next: string | boolean) => setDraft((current) => ({ ...current, [key]: next }));
  const number = (raw: string, fallback: number) => { const parsed = Number(raw); return Number.isFinite(parsed) ? Math.max(0, parsed) : fallback; };
  const apply = () => {
    const x = Math.min(16_383.95, number(draft.x, image.from.column)), y = Math.min(1_048_575.95, number(draft.y, image.from.row));
    const width = Math.min(16_384 - x, Math.max(0.05, number(draft.width, image.to.column - image.from.column)));
    const height = Math.min(1_048_576 - y, Math.max(0.05, number(draft.height, image.to.row - image.from.row)));
    onApply({ from: { row: y, column: x }, to: { row: y + height, column: x + width }, altText: draft.decorative ? "" : draft.altText, decorative: draft.decorative });
  };
  const runBrian = async () => {
    const instruction = brianInstruction.trim();
    if (!instruction || brianBusy) return;
    setBrianBusy(true);
    setBrianError(false);
    try { await onEditWithBrian(instruction); setBrianInstruction(""); } catch { setBrianError(true); } finally { setBrianBusy(false); }
  };
  return <section aria-label={t.worksheetImageEditor} className="flex flex-wrap items-end gap-2 border-b bg-blue-50/60 px-3 py-2 text-xs">
    <strong className="self-center text-blue-950">{t.worksheetImage}</strong>
    <ImageNumber label={t.imageX} value={draft.x} onChange={(next) => value("x", next)} disabled={!canChange} />
    <ImageNumber label={t.imageY} value={draft.y} onChange={(next) => value("y", next)} disabled={!canChange} />
    <ImageNumber label={t.imageWidthCells} value={draft.width} onChange={(next) => value("width", next)} disabled={!canChange} />
    <ImageNumber label={t.imageHeightRows} value={draft.height} onChange={(next) => value("height", next)} disabled={!canChange} />
    <label className="min-w-40 flex-1 text-[11px] text-muted-foreground">{t.altText}<input aria-label={t.altText} value={draft.altText} disabled={!canChange || draft.decorative} onChange={(event) => value("altText", event.target.value)} className="mt-1 h-8 w-full rounded border bg-background px-2 text-xs text-foreground disabled:opacity-50" /></label>
    <label className="flex h-8 items-center gap-1.5"><input type="checkbox" checked={draft.decorative} disabled={!canChange} onChange={(event) => value("decorative", event.target.checked)} />{t.decorativeImage}</label>
    <button type="button" disabled={!canChange} onClick={apply} className="h-8 rounded bg-action px-3 font-medium text-action-foreground disabled:opacity-40">{t.apply}</button>
    <button type="button" disabled={!canChange} onClick={() => void onDelete()} className="flex h-8 items-center gap-1 rounded border border-destructive/40 px-2 text-destructive disabled:opacity-40"><Trash2 className="size-3.5" />{t.deleteWorksheetImage}</button>
    <label className="min-w-52 flex-[1.5] text-[11px] text-blue-800">{t.editWithBrian}<input aria-label={t.editWithBrian} value={brianInstruction} disabled={!canRequestBrian} onChange={(event) => setBrianInstruction(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void runBrian(); } }} placeholder={t.editWorksheetImageWithBrianPlaceholder} className="mt-1 h-8 w-full rounded border border-blue-200 bg-white px-2 text-xs text-foreground disabled:opacity-50" /></label>
    <button type="button" disabled={!canRequestBrian || brianBusy || !brianInstruction.trim()} onClick={() => void runBrian()} className="flex h-8 items-center gap-1 rounded border border-blue-300 bg-white px-2 font-medium text-blue-700 disabled:opacity-40"><Sparkles className="size-3.5" />{brianBusy ? t.brianEditing : t.editWithBrian}</button>
    {brianError ? <span role="alert" className="text-destructive">{t.failed}</span> : null}
  </section>;
}

function imageInspectorDraft(image: SpreadsheetImage) {
  return { x: String(image.from.column), y: String(image.from.row), width: String(image.to.column - image.from.column), height: String(image.to.row - image.from.row), altText: image.altText, decorative: image.decorative };
}

function ImageNumber({ label, value, disabled, onChange }: { label: string; value: string; disabled: boolean; onChange(value: string): void }) {
  return <label className="w-20 text-[11px] text-muted-foreground">{label}<input type="number" min="0" step="0.05" value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)} className="mt-1 h-8 w-full rounded border bg-background px-2 text-xs text-foreground disabled:opacity-50" /></label>;
}

type SpreadsheetNavigationKey = "up" | "down" | "left" | "right";
type SpreadsheetSelectionRange = { from: string; to: string; fromRow: number; toRow: number; fromColumn: number; toColumn: number };
type SpreadsheetDimensionAxis = "row" | "column";
type SpreadsheetDimensionPreview = { axis: SpreadsheetDimensionAxis; index: number; pixels: number };
type SpreadsheetDimensionDrag = { axis: SpreadsheetDimensionAxis; index: number; startClient: number; startPixels: number };

function spreadsheetSelectionRange(selection: SpreadsheetSelection): SpreadsheetSelectionRange {
  const anchor = parseCellAddress(selection.anchor) ?? { row: 1, column: 1 };
  const focus = parseCellAddress(selection.focus) ?? anchor;
  const fromRow = Math.min(anchor.row, focus.row);
  const toRow = Math.max(anchor.row, focus.row);
  const fromColumn = Math.min(anchor.column, focus.column);
  const toColumn = Math.max(anchor.column, focus.column);
  return {
    from: `${columnIndexToName(fromColumn)}${fromRow}`,
    to: `${columnIndexToName(toColumn)}${toRow}`,
    fromRow,
    toRow,
    fromColumn,
    toColumn,
  };
}

export function spreadsheetSelectionLabel(selection: SpreadsheetSelection): string {
  const range = spreadsheetSelectionRange(selection);
  return range.from === range.to ? range.from : `${range.from}:${range.to}`;
}

export function spreadsheetSelectionAddresses(selection: SpreadsheetSelection): string[] {
  const range = spreadsheetSelectionRange(selection);
  const addresses: string[] = [];
  for (let row = range.fromRow; row <= range.toRow; row += 1) {
    for (let column = range.fromColumn; column <= range.toColumn; column += 1) addresses.push(`${columnIndexToName(column)}${row}`);
  }
  return addresses;
}

export function moveSpreadsheetAddress(address: string, key: SpreadsheetNavigationKey, bounds: { rows: number; columns: number }, merges: string[] = []): string {
  const parsed = parseCellAddress(address) ?? { row: 1, column: 1 };
  const containingMerge = merges.map((range) => range.split(":").map(parseCellAddress)).find(([from, to]) => from && to && parsed.row >= from.row && parsed.row <= to.row && parsed.column >= from.column && parsed.column <= to.column);
  const [from, to] = containingMerge ?? [];
  const rowDelta = key === "down" ? to ? to.row - parsed.row + 1 : 1 : key === "up" ? from ? from.row - parsed.row - 1 : -1 : 0;
  const columnDelta = key === "right" ? to ? to.column - parsed.column + 1 : 1 : key === "left" ? from ? from.column - parsed.column - 1 : -1 : 0;
  const row = Math.max(1, Math.min(bounds.rows, parsed.row + rowDelta));
  const column = Math.max(1, Math.min(bounds.columns, parsed.column + columnDelta));
  return `${columnIndexToName(column)}${row}`;
}

function addressInSpreadsheetSelection(address: string, selection: SpreadsheetSelection): boolean {
  const cell = parseCellAddress(address);
  const range = spreadsheetSelectionRange(selection);
  return Boolean(cell && cell.row >= range.fromRow && cell.row <= range.toRow && cell.column >= range.fromColumn && cell.column <= range.toColumn);
}

function spreadsheetCellInputText(cell: SpreadsheetCell | undefined): string {
  if (!cell) return "";
  if (cell.formula) return `=${cell.formula}`;
  return cell.value === null || cell.value === undefined ? "" : String(cell.value);
}

function quoteSpreadsheetClipboardCell(value: string): string {
  return /[\t\r\n"]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

export function spreadsheetSelectionTsv(sheet: SpreadsheetWorksheet, selection: SpreadsheetSelection): string {
  const cells = new Map(sheet.cells.map((cell) => [cell.address, cell]));
  const range = spreadsheetSelectionRange(selection);
  return Array.from({ length: range.toRow - range.fromRow + 1 }, (_, rowOffset) =>
    Array.from({ length: range.toColumn - range.fromColumn + 1 }, (_, columnOffset) => {
      const address = `${columnIndexToName(range.fromColumn + columnOffset)}${range.fromRow + rowOffset}`;
      return quoteSpreadsheetClipboardCell(spreadsheetCellInputText(cells.get(address)));
    }).join("\t"),
  ).join("\n");
}

export function parseSpreadsheetClipboard(input: string): string[][] {
  const rows: string[][] = [[]];
  let value = "";
  let quoted = false;
  for (let index = 0; index < input.length; index += 1) {
    const character = input[index];
    if (character === '"') {
      if (quoted && input[index + 1] === '"') { value += '"'; index += 1; }
      else quoted = !quoted;
      continue;
    }
    if (!quoted && character === "\t") { rows.at(-1)!.push(value); value = ""; continue; }
    if (!quoted && (character === "\n" || character === "\r")) {
      if (character === "\r" && input[index + 1] === "\n") index += 1;
      rows.at(-1)!.push(value);
      rows.push([]);
      value = "";
      continue;
    }
    value += character;
  }
  rows.at(-1)!.push(value);
  if (rows.length > 1 && rows.at(-1)!.length === 1 && rows.at(-1)![0] === "" && /(?:\r\n|\r|\n)$/.test(input)) rows.pop();
  return rows;
}

export function shiftSpreadsheetFormula(formula: string, rowDelta: number, columnDelta: number): string {
  let shifted = "";
  for (let index = 0; index < formula.length;) {
    const quote = formula[index];
    if (quote === '"' || quote === "'") {
      const start = index;
      index += 1;
      while (index < formula.length) {
        if (formula[index] !== quote) { index += 1; continue; }
        if (formula[index + 1] === quote) { index += 2; continue; }
        index += 1;
        break;
      }
      shifted += formula.slice(start, index);
      continue;
    }
    const previous = formula[index - 1] ?? "";
    const reference = !/[A-Z0-9_]/i.test(previous) ? /^(\$?)([A-Z]{1,3})(\$?)([1-9][0-9]{0,6})/.exec(formula.slice(index)) : null;
    if (!reference) { shifted += formula[index]; index += 1; continue; }
    const [token, absoluteColumn, columnName, absoluteRow, rowText] = reference;
    const next = formula[index + token.length] ?? "";
    if (/[A-Z0-9_]/i.test(next) || next === "!" || next === "(") { shifted += token; index += token.length; continue; }
    const parsed = parseCellAddress(`${columnName}${rowText}`);
    if (!parsed) { shifted += token; index += token.length; continue; }
    const column = parsed.column + (absoluteColumn ? 0 : columnDelta);
    const row = parsed.row + (absoluteRow ? 0 : rowDelta);
    shifted += column < 1 || column > 16_384 || row < 1 || row > 1_048_576 ? "#REF!" : `${absoluteColumn}${columnIndexToName(column)}${absoluteRow}${row}`;
    index += token.length;
  }
  return shifted;
}

function spreadsheetInput(input: string, existing: SpreadsheetCell | undefined): { valueType: "blank" | "string" | "number" | "boolean" | "date"; value: SpreadsheetCell["value"]; formula?: string } {
  const formula = input.startsWith("=") && input.slice(1).trim() ? input.slice(1).trim() : undefined;
  const scalar = input.trim();
  const parsedNumber = input === scalar && scalar !== "" && !formula ? Number(scalar) : Number.NaN;
  const bool = !formula && input === scalar && /^(true|false)$/i.test(scalar);
  const valueType = formula ? existing?.valueType === "date" ? "date" : "number" : input === "" ? "blank" : bool ? "boolean" : Number.isFinite(parsedNumber) ? "number" : "string";
  const value = formula ? null : valueType === "blank" ? null : valueType === "boolean" ? scalar.toLocaleLowerCase() === "true" : valueType === "number" ? parsedNumber : input;
  return { valueType, value, formula };
}

function spreadsheetCellEditorInput(cell: SpreadsheetCell | undefined): string {
  if (cell?.formula) return `=${cell.formula}`;
  return cell?.value === null || cell?.value === undefined ? "" : String(cell.value);
}

function WorksheetGrid({ artifactId, sheet, selection, selectedImageId, canChange, onSelect, onSelectImage, onMove, onBeginEdit, onClear, onCopy, onCut, onPaste, onResizeDimension }: {
  artifactId: string;
  sheet: SpreadsheetWorksheet;
  selection: SpreadsheetSelection;
  selectedImageId: string | null;
  canChange: boolean;
  onSelect(address: string, extend?: boolean): void;
  onSelectImage(imageId: string): void;
  onMove(key: SpreadsheetNavigationKey, extend: boolean): void;
  onBeginEdit(seed?: string): void;
  onClear(): void;
  onCopy(event: ReactClipboardEvent): void;
  onCut(event: ReactClipboardEvent): void;
  onPaste(event: ReactClipboardEvent): void;
  onResizeDimension(axis: SpreadsheetDimensionAxis, index: number, size: number): void;
}) {
  const t = useT().office;
  const bounds = useMemo(() => worksheetBounds(sheet), [sheet]);
  const baseColumnWidths = useMemo(() => Array.from({ length: bounds.columns }, (_, index) => widthOf(sheet, index + 1)), [bounds.columns, sheet]);
  const baseRowHeights = useMemo(() => Array.from({ length: bounds.rows }, (_, index) => heightOf(sheet, index + 1)), [bounds.rows, sheet]);
  const mergeMap = useMemo(() => mergedCells(sheet), [sheet]);
  const cells = useMemo(() => new Map(sheet.cells.map((cell) => [cell.address, cell])), [sheet.cells]);
  const gridRef = useRef<HTMLDivElement | null>(null);
  const [dragging, setDragging] = useState(false);
  const [dimensionPreview, setDimensionPreview] = useState<SpreadsheetDimensionPreview | null>(null);
  const dimensionDrag = useRef<SpreadsheetDimensionDrag | null>(null);
  const dimensionPreviewRef = useRef(dimensionPreview);
  const onResizeDimensionRef = useRef(onResizeDimension);
  const columnWidths = baseColumnWidths.map((value, index) => dimensionPreview?.axis === "column" && dimensionPreview.index === index + 1 ? dimensionPreview.pixels : value);
  const rowHeights = baseRowHeights.map((value, index) => dimensionPreview?.axis === "row" && dimensionPreview.index === index + 1 ? dimensionPreview.pixels : value);
  const gridTemplateColumns = `${ROW_HEADER_WIDTH}px ${columnWidths.map((width) => `${width}px`).join(" ")}`;
  const gridTemplateRows = `${COLUMN_HEADER_HEIGHT}px ${rowHeights.map((height) => `${height}px`).join(" ")}`;
  const totalWidth = ROW_HEADER_WIDTH + columnWidths.reduce((total, width) => total + width, 0);
  const totalHeight = COLUMN_HEADER_HEIGHT + rowHeights.reduce((total, height) => total + height, 0);

  useEffect(() => { onResizeDimensionRef.current = onResizeDimension; }, [onResizeDimension]);
  useEffect(() => {
    const handlePointerMove = (event: PointerEvent) => {
      const drag = dimensionDrag.current;
      if (!drag) return;
      const delta = drag.axis === "column" ? event.clientX - drag.startClient : event.clientY - drag.startClient;
      const pixels = clampSpreadsheetDimensionPixels(drag.axis, drag.startPixels + delta);
      const preview = { axis: drag.axis, index: drag.index, pixels };
      dimensionPreviewRef.current = preview;
      setDimensionPreview(preview);
    };
    const handlePointerUp = () => {
      const drag = dimensionDrag.current;
      if (!drag) { setDragging(false); return; }
      const preview = dimensionPreviewRef.current;
      dimensionDrag.current = null;
      dimensionPreviewRef.current = null;
      setDimensionPreview(null);
      if (preview && preview.axis === drag.axis && preview.index === drag.index && preview.pixels !== drag.startPixels) onResizeDimensionRef.current(drag.axis, drag.index, spreadsheetDimensionModelSize(drag.axis, preview.pixels));
    };
    const handlePointerCancel = () => {
      dimensionDrag.current = null;
      dimensionPreviewRef.current = null;
      setDimensionPreview(null);
    };
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    window.addEventListener("pointercancel", handlePointerCancel);
    return () => { window.removeEventListener("pointermove", handlePointerMove); window.removeEventListener("pointerup", handlePointerUp); window.removeEventListener("pointercancel", handlePointerCancel); };
  }, []);
  useEffect(() => {
    const activeCell = gridRef.current?.querySelector<HTMLElement>(`[data-cell-address="${selection.focus}"]`);
    activeCell?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [selection.focus]);

  function handleKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if ((event.target as HTMLElement).getAttribute("role") === "separator") return;
    if ((event.target as HTMLElement).closest("[data-worksheet-image]")) return;
    if (event.defaultPrevented || event.altKey || event.metaKey || event.ctrlKey) return;
    const arrows: Partial<Record<string, SpreadsheetNavigationKey>> = { ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right" };
    const arrow = arrows[event.key];
    if (arrow) { event.preventDefault(); onMove(arrow, event.shiftKey); return; }
    if (event.key === "Enter") { event.preventDefault(); onMove(event.shiftKey ? "up" : "down", false); return; }
    if (event.key === "Tab") { event.preventDefault(); onMove(event.shiftKey ? "left" : "right", false); return; }
    if ((event.key === "Delete" || event.key === "Backspace") && canChange) { event.preventDefault(); onClear(); return; }
    if (event.key === "F2" && canChange) { event.preventDefault(); onBeginEdit(); return; }
    if (canChange && event.key.length === 1) { event.preventDefault(); onBeginEdit(event.key); }
  }

  const selectRange = (anchor: string, focus: string) => { onSelect(anchor); onSelect(focus, true); };

  function beginDimensionResize(event: ReactPointerEvent, axis: SpreadsheetDimensionAxis, index: number, startPixels: number) {
    if (!canChange || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    dimensionDrag.current = { axis, index, startClient: axis === "column" ? event.clientX : event.clientY, startPixels };
    const preview = { axis, index, pixels: startPixels };
    dimensionPreviewRef.current = preview;
    setDimensionPreview(preview);
  }

  function commitAutofit(event: { preventDefault(): void; stopPropagation(): void }, axis: SpreadsheetDimensionAxis, index: number) {
    if (!canChange) return;
    event.preventDefault();
    event.stopPropagation();
    const pixels = autofitSpreadsheetDimension(sheet, axis, index, gridRef.current);
    onResizeDimension(axis, index, spreadsheetDimensionModelSize(axis, pixels));
  }

  function handleSeparatorKeyDown(event: ReactKeyboardEvent<HTMLSpanElement>, axis: SpreadsheetDimensionAxis, index: number, currentPixels: number) {
    const decrease = axis === "column" ? event.key === "ArrowLeft" : event.key === "ArrowUp";
    const increase = axis === "column" ? event.key === "ArrowRight" : event.key === "ArrowDown";
    if (event.key === "Enter") { commitAutofit(event, axis, index); return; }
    if (!canChange || !decrease && !increase) return;
    event.preventDefault();
    event.stopPropagation();
    const delta = (event.shiftKey ? 10 : 1) * (decrease ? -1 : 1);
    const pixels = clampSpreadsheetDimensionPixels(axis, currentPixels + delta);
    if (pixels !== currentPixels) onResizeDimension(axis, index, spreadsheetDimensionModelSize(axis, pixels));
  }

  return (
    <div className="relative min-h-0 flex-1 overflow-auto bg-[#f5f6f8]" data-worksheet={sheet.name}>
      <div ref={gridRef} role="grid" tabIndex={0} aria-label={sheet.name} aria-rowcount={bounds.rows} aria-colcount={bounds.columns} onKeyDown={handleKeyDown} onCopy={onCopy} onCut={onCut} onPaste={onPaste} className="relative grid bg-white shadow-sm outline-none" style={{ gridTemplateColumns, gridTemplateRows, width: totalWidth, height: totalHeight }}>
        <button type="button" aria-label={t.selectAllCells} onClick={() => selectRange("A1", `${columnIndexToName(bounds.columns)}${bounds.rows}`)} className="sticky left-0 top-0 z-40 border-b border-r bg-[#f3f4f6]" />
        {columnWidths.map((_, index) => {
          const column = index + 1;
          const frozen = column <= sheet.freeze.columns;
          const name = columnIndexToName(column);
          return <div key={`column-${column}`} role="columnheader" className="sticky top-0 z-30 flex items-center justify-center border-b border-r bg-[#f3f4f6] text-[11px] text-slate-600" style={{ gridColumn: column + 1, gridRow: 1, left: frozen ? ROW_HEADER_WIDTH + gridAxisOffset(columnWidths, index) : undefined, zIndex: frozen ? 35 : undefined }}><button type="button" onClick={() => selectRange(`${name}1`, `${name}${bounds.rows}`)} className="absolute inset-0 flex items-center justify-center">{name}</button><span role="separator" tabIndex={canChange ? 0 : -1} aria-disabled={!canChange} aria-label={t.resizeColumn.replace("{column}", name)} aria-orientation="vertical" aria-valuemin={MIN_COLUMN_WIDTH} aria-valuemax={MAX_COLUMN_WIDTH} aria-valuenow={columnWidths[index]} data-column-resize={name} onClick={(event) => { event.preventDefault(); event.stopPropagation(); }} onPointerDown={(event) => beginDimensionResize(event, "column", column, columnWidths[index])} onDoubleClick={(event) => commitAutofit(event, "column", column)} onKeyDown={(event) => handleSeparatorKeyDown(event, "column", column, columnWidths[index])} className="absolute -right-1 top-0 z-10 h-full w-2 cursor-col-resize touch-none outline-none focus:bg-[#2684ff]/20" /></div>;
        })}
        {rowHeights.map((_, index) => {
          const row = index + 1;
          const frozen = row <= sheet.freeze.rows;
          return <div key={`row-${row}`} role="rowheader" className="sticky left-0 z-20 flex items-center justify-center border-b border-r bg-[#f3f4f6] text-[11px] text-slate-600" style={{ gridColumn: 1, gridRow: row + 1, top: frozen ? COLUMN_HEADER_HEIGHT + gridAxisOffset(rowHeights, index) : undefined, zIndex: frozen ? 25 : undefined }}><button type="button" onClick={() => selectRange(`A${row}`, `${columnIndexToName(bounds.columns)}${row}`)} className="absolute inset-0 flex items-center justify-center">{row}</button><span role="separator" tabIndex={canChange ? 0 : -1} aria-disabled={!canChange} aria-label={t.resizeRow.replace("{row}", String(row))} aria-orientation="horizontal" aria-valuemin={MIN_ROW_HEIGHT} aria-valuemax={MAX_ROW_HEIGHT} aria-valuenow={rowHeights[index]} data-row-resize={row} onClick={(event) => { event.preventDefault(); event.stopPropagation(); }} onPointerDown={(event) => beginDimensionResize(event, "row", row, rowHeights[index])} onDoubleClick={(event) => commitAutofit(event, "row", row)} onKeyDown={(event) => handleSeparatorKeyDown(event, "row", row, rowHeights[index])} className="absolute -bottom-1 left-0 z-10 h-2 w-full cursor-row-resize touch-none outline-none focus:bg-[#2684ff]/20" /></div>;
        })}
        {Array.from({ length: bounds.rows }, (_, rowIndex) => Array.from({ length: bounds.columns }, (_, columnIndex) => {
          const address = `${columnIndexToName(columnIndex + 1)}${rowIndex + 1}`;
          const merge = mergeMap.get(address);
          if (merge?.covered) return null;
          const cell = cells.get(address);
          return <WorksheetCell key={address} address={address} cell={cell} conditionalStyle={conditionalStyleFor(sheet, address, cell)} selected={!selectedImageId && addressInSpreadsheetSelection(address, selection)} active={!selectedImageId && selection.focus === address} merge={merge} row={rowIndex + 1} column={columnIndex + 1} freezeStyle={frozenGridCellStyle(sheet, rowHeights, columnWidths, rowIndex + 1, columnIndex + 1)} onSelect={onSelect} onBeginEdit={onBeginEdit} dragging={dragging} onDragStart={() => setDragging(true)} />;
        }))}
        {sheet.images.map((image) => <WorksheetImage key={image.id} imageId={image.id} artifactId={artifactId} resourceId={image.resourceId} alt={image.altText} decorative={image.decorative} selected={selectedImageId === image.id} onSelect={onSelectImage} left={ROW_HEADER_WIDTH + gridAxisOffset(columnWidths, image.from.column)} top={COLUMN_HEADER_HEIGHT + gridAxisOffset(rowHeights, image.from.row)} width={Math.max(1, gridAxisOffset(columnWidths, image.to.column) - gridAxisOffset(columnWidths, image.from.column))} height={Math.max(1, gridAxisOffset(rowHeights, image.to.row) - gridAxisOffset(rowHeights, image.from.row))} />)}
      </div>
    </div>
  );
}

function WorksheetCell({ address, cell, conditionalStyle, selected, active, merge, row, column, freezeStyle, onSelect, onBeginEdit, dragging, onDragStart }: { address: string; cell?: SpreadsheetCell; conditionalStyle?: SpreadsheetCellStyle; selected: boolean; active: boolean; merge?: MergePlacement; row: number; column: number; freezeStyle: CSSProperties; onSelect(address: string, extend?: boolean): void; onBeginEdit(): void; dragging: boolean; onDragStart(): void }) {
  const style = cellStyle(mergeCellStyles(cell?.style, conditionalStyle), cell?.numberFormat, cell);
  return (
    <button
      type="button"
      role="gridcell"
      aria-label={`${address}: ${cell ? spreadsheetCellDisplayValue(cell) : ""}`}
      aria-selected={selected}
      tabIndex={active ? 0 : -1}
      data-cell-address={address}
      onClick={(event) => { if (event.detail === 0) onSelect(address, event.shiftKey); }}
      onDoubleClick={() => onBeginEdit()}
      onPointerDown={(event) => { if (event.button === 0) { onSelect(address, event.shiftKey); onDragStart(); } }}
      onPointerEnter={(event) => { if (dragging && event.buttons === 1) onSelect(address, true); }}
      className={cn("relative z-0 flex min-h-0 min-w-0 overflow-hidden border-b border-r border-[#d9dde3] bg-white px-1 text-left text-xs outline-none", selected && "bg-[#e8f1ff]", active && "z-10 ring-2 ring-inset ring-[#2684ff]")}
      style={{ ...style, ...freezeStyle, gridColumn: `${column + 1} / span ${merge?.columnSpan ?? 1}`, gridRow: `${row + 1} / span ${merge?.rowSpan ?? 1}` }}
    >
      <span className="block max-h-full w-full overflow-hidden">{cell ? spreadsheetCellDisplayValue(cell) : ""}</span>
    </button>
  );
}

function WorksheetImage({ imageId, artifactId, resourceId, alt, decorative, selected, onSelect, left, top, width, height }: { imageId: string; artifactId: string; resourceId: string; alt: string; decorative: boolean; selected: boolean; onSelect(imageId: string): void; left: number; top: number; width: number; height: number }) {
  const t = useT().office;
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => { let active = true; void getOfficeResourceObjectUrl(artifactId, resourceId).then((url) => { if (active) setSrc(url); }).catch(() => undefined); return () => { active = false; }; }, [artifactId, resourceId]);
  const name = alt.trim() || t.image;
  return <button type="button" aria-label={t.selectWorksheetImage.replace("{name}", name)} aria-pressed={selected} data-worksheet-image={imageId} onPointerDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); onSelect(imageId); }} className={cn("absolute z-20 flex items-center justify-center bg-transparent p-0 outline-none", selected ? "ring-2 ring-[#2684ff] ring-offset-1" : "focus-visible:ring-2 focus-visible:ring-[#2684ff]")} style={{ left, top, width, height }}>
    {src ? <img src={src} alt={decorative ? "" : alt} className="pointer-events-none size-full object-contain" /> : <span className="pointer-events-none flex size-full items-center justify-center bg-muted/60"><FileSpreadsheet className="size-5 text-muted-foreground/40" /></span>}
  </button>;
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
  const extent = worksheetExtent(sheet);
  return { rows: Math.min(extent.rows, 250), columns: Math.min(extent.columns, 60) };
}

function worksheetExtent(sheet: SpreadsheetWorksheet): { rows: number; columns: number } {
  let rows = 30;
  let columns = 12;
  const rangeAddresses = [...sheet.validations.map((validation) => validation.range), ...sheet.conditionalFormats.map((format) => format.range), ...(sheet.print.printArea ? [sheet.print.printArea] : [])].flatMap((range) => range.split(":"));
  for (const address of [...sheet.cells.map((cell) => cell.address), ...sheet.merges.flatMap((merge) => merge.split(":")), ...rangeAddresses]) {
    const parsed = parseCellAddress(address);
    if (!parsed) continue;
    rows = Math.max(rows, parsed.row);
    columns = Math.max(columns, parsed.column);
  }
  for (const dimension of sheet.rowDimensions) rows = Math.max(rows, dimension.index);
  for (const dimension of sheet.columnDimensions) columns = Math.max(columns, dimension.index);
  for (const image of sheet.images) { rows = Math.max(rows, Math.ceil(image.to.row)); columns = Math.max(columns, Math.ceil(image.to.column)); }
  rows = Math.max(rows, sheet.freeze.rows);
  columns = Math.max(columns, sheet.freeze.columns);
  return { rows, columns };
}

export function worksheetContentExceedsEditorBounds(sheet: SpreadsheetWorksheet): boolean {
  const extent = worksheetExtent(sheet);
  return extent.rows > 250 || extent.columns > 60;
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

function clampSpreadsheetDimensionPixels(axis: SpreadsheetDimensionAxis, pixels: number): number {
  const minimum = axis === "column" ? MIN_COLUMN_WIDTH : MIN_ROW_HEIGHT;
  const maximum = axis === "column" ? MAX_COLUMN_WIDTH : MAX_ROW_HEIGHT;
  return Math.round(Math.min(maximum, Math.max(minimum, pixels)));
}

export function spreadsheetDimensionModelSize(axis: SpreadsheetDimensionAxis, pixels: number): number {
  const bounded = clampSpreadsheetDimensionPixels(axis, pixels);
  const value = axis === "column" ? (bounded - 5) / 7 : bounded * 72 / 96;
  return Math.round(value * 1_000) / 1_000;
}

export function autofitSpreadsheetDimension(sheet: SpreadsheetWorksheet, axis: SpreadsheetDimensionAxis, index: number, grid: HTMLElement | null): number {
  const mergeMap = mergedCells(sheet);
  const candidates = sheet.cells.filter((cell) => {
    const address = parseCellAddress(cell.address);
    if (!address || axis === "column" && address.column !== index || axis === "row" && address.row !== index) return false;
    if (spreadsheetCellDisplayValue(cell) === "") return false;
    return axis !== "column" || !mergeMap.has(cell.address);
  });
  if (candidates.length === 0) return axis === "column" ? DEFAULT_COLUMN_WIDTH : DEFAULT_ROW_HEIGHT;
  const probe = createSpreadsheetAutofitProbe(grid);
  if (axis === "column") {
    const width = candidates.reduce((maximum, cell) => {
      const element = grid?.querySelector<HTMLElement>(`[data-cell-address="${cell.address}"]`);
      const computed = spreadsheetComputedStyle(element);
      const computedFontSize = computed ? Number.parseFloat(computed.fontSize) : Number.NaN;
      const fontPixels = Number.isFinite(computedFontSize) && computedFontSize > 0 ? computedFontSize : (cell.style.font?.sizePt ?? 11) * 96 / 72;
      const measured = spreadsheetCellDisplayValue(cell).split("\n").reduce((lineMaximum, line) => Math.max(lineMaximum, measureSpreadsheetLineWidth(line, fontPixels, computed, probe, Boolean(cell.style.font?.bold))), 0);
      return Math.max(maximum, measured);
    }, 0);
    probe?.remove();
    // Eight pixels cover cell padding; the remainder keeps the border and
    // inset selection ring from obscuring the final glyph at fractional zoom.
    return clampSpreadsheetDimensionPixels("column", width + 16);
  }
  const height = candidates.reduce((maximum, cell) => {
    const element = grid?.querySelector<HTMLElement>(`[data-cell-address="${cell.address}"]`);
    const computed = spreadsheetComputedStyle(element);
    const address = parseCellAddress(cell.address)!;
    const availableWidth = Math.max(1, widthOf(sheet, address.column) - 8);
    const computedFontSize = computed ? Number.parseFloat(computed.fontSize) : Number.NaN;
    const fontPixels = Number.isFinite(computedFontSize) && computedFontSize > 0 ? computedFontSize : (cell.style.font?.sizePt ?? 11) * 96 / 72;
    const computedLineHeight = computed ? Number.parseFloat(computed.lineHeight) : Number.NaN;
    const lineHeight = Number.isFinite(computedLineHeight) && computedLineHeight > 0 ? Math.ceil(computedLineHeight) : Math.ceil(fontPixels * 1.2);
    const lines = spreadsheetCellDisplayValue(cell).split("\n").reduce((total, line) => total + (cell.style.alignment?.wrapText ? Math.max(1, Math.ceil(measureSpreadsheetLineWidth(line, fontPixels, computed, probe, Boolean(cell.style.font?.bold)) / availableWidth)) : 1), 0);
    return Math.max(maximum, lineHeight * Math.max(1, lines) + 4);
  }, 0);
  probe?.remove();
  return clampSpreadsheetDimensionPixels("row", height);
}

function estimateSpreadsheetLineWidth(line: string, fontPixels: number): number {
  return [...line].reduce((width, character) => {
    if (/\s/.test(character)) return width + fontPixels * 0.33;
    // Proportional fonts still commonly give digits tabular-width metrics.
    // Treating "1" as punctuation caused values such as 1212 to clip.
    if (/[ilI.,'`|!:;]/.test(character)) return width + fontPixels * 0.3;
    if (/[MW@#%&]/.test(character)) return width + fontPixels * 0.9;
    if (/[^\u0000-\u00ff]/.test(character)) return width + fontPixels;
    return width + fontPixels * 0.56;
  }, 0);
}

function createSpreadsheetAutofitProbe(grid: HTMLElement | null): HTMLSpanElement | null {
  const document = grid?.ownerDocument;
  if (!document?.body) return null;
  const probe = document.createElement("span");
  probe.setAttribute("aria-hidden", "true");
  Object.assign(probe.style, { position: "fixed", visibility: "hidden", pointerEvents: "none", whiteSpace: "pre", width: "max-content" });
  document.body.append(probe);
  return probe;
}

function spreadsheetComputedStyle(element: HTMLElement | null | undefined): CSSStyleDeclaration | null {
  return element?.ownerDocument.defaultView?.getComputedStyle(element) ?? null;
}

function measureSpreadsheetLineWidth(line: string, fontPixels: number, computed: CSSStyleDeclaration | null, probe: HTMLSpanElement | null, bold: boolean): number {
  if (computed && probe) {
    Object.assign(probe.style, {
      fontFamily: computed.fontFamily,
      fontSize: computed.fontSize,
      fontStyle: computed.fontStyle,
      fontWeight: computed.fontWeight,
      fontStretch: computed.fontStretch,
      fontVariant: computed.fontVariant,
      letterSpacing: computed.letterSpacing,
    });
    probe.textContent = line;
    const measured = probe.getBoundingClientRect().width;
    if (Number.isFinite(measured) && measured > 0) return measured;
  }
  return estimateSpreadsheetLineWidth(line, fontPixels) * (bold ? 1.08 : 1);
}

export function gridAxisOffset(values: number[], coordinate: number): number {
  const bounded = Math.max(0, coordinate);
  const whole = Math.floor(bounded);
  const fraction = bounded - whole;
  return values.slice(0, whole).reduce((total, value) => total + value, 0) + (values[whole] ?? 0) * fraction;
}

function frozenGridCellStyle(sheet: SpreadsheetWorksheet, rowHeights: number[], columnWidths: number[], row: number, column: number): CSSProperties {
  const frozenRow = row <= sheet.freeze.rows;
  const frozenColumn = column <= sheet.freeze.columns;
  if (!frozenRow && !frozenColumn) return {};
  return {
    position: "sticky",
    top: frozenRow ? COLUMN_HEADER_HEIGHT + gridAxisOffset(rowHeights, row - 1) : undefined,
    left: frozenColumn ? ROW_HEADER_WIDTH + gridAxisOffset(columnWidths, column - 1) : undefined,
    zIndex: frozenRow && frozenColumn ? 19 : 15,
  };
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

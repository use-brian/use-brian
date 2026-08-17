"use client";

/** Bounded Presentation table/chart data editors. [COMP:app-web/office-presentation-editor] */
import { useEffect, useState } from "react";
import { Dialog } from "@base-ui/react/dialog";
import { createPresentationChartObject, createPresentationTableObject, type PresentationObject } from "@use-brian/office-model";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useT } from "@/lib/i18n/client";

type Mode = "table" | "chart";

export function PresentationDataDialog({ mode, open, object, onClose, onApply }: { mode: Mode; open: boolean; object?: PresentationObject | null; onClose(): void; onApply(object: PresentationObject): void }) {
  const t = useT().office;
  const table = object?.kind === "table" ? object : null;
  const chart = object?.kind === "chart" ? object : null;
  const [rows, setRows] = useState(2);
  const [columns, setColumns] = useState(2);
  const [tableData, setTableData] = useState("");
  const [chartType, setChartType] = useState<"bar" | "line" | "pie" | "doughnut" | "scatter">("bar");
  const [title, setTitle] = useState("");
  const [altText, setAltText] = useState("");
  const [chartData, setChartData] = useState("Category,Series 1\nA,1\nB,2");
  const [error, setError] = useState("");
  useEffect(() => {
    if (!open) return;
    if (table) {
      setRows(table.rows.length); setColumns(Math.max(...table.rows.map((row) => row.cells.length)));
      setTableData(table.rows.map((row) => row.cells.map((cell) => cell.runs.map((run) => run.text).join("")).join("\t")).join("\n"));
    } else if (chart) {
      setChartType(chart.chartType); setTitle(chart.title); setAltText(chart.altText);
      setChartData([["Category", ...chart.series.map((series) => series.name)].join(","), ...chart.categories.map((category, index) => [category, ...chart.series.map((series) => String(series.values[index]))].join(","))].join("\n"));
    } else if (mode === "table") {
      setRows(2); setColumns(2); setTableData("");
    } else {
      setChartType("bar"); setTitle(""); setAltText(""); setChartData("Category,Series 1\nA,1\nB,2");
    }
    setError("");
  }, [open, object]);

  function apply() {
    try {
      if (mode === "table") {
        const next = createPresentationTableObject({ id: table?.id, rows, columns, geometry: table?.geometry ?? { xPt: 90, yPt: 90, widthPt: 540, heightPt: 260, rotationDeg: 0 }, createId: () => crypto.randomUUID() });
        const cells = tableData.split(/\r?\n/).map((row) => row.split("\t"));
        next.rows.forEach((row, rowIndex) => {
          const previousRow = table?.rows[rowIndex];
          if (previousRow) row.id = previousRow.id;
          row.cells.forEach((cell, cellIndex) => {
            const previous = previousRow?.cells[cellIndex];
            if (previous) { cell.id = previous.id; cell.runs = structuredClone(previous.runs); }
            cell.runs[0].text = cells[rowIndex]?.[cellIndex] ?? "";
          });
        });
        onApply(next); onClose(); return;
      }
      const matrix = chartData.trim().split(/\r?\n/).map((line) => line.split(",").map((cell) => cell.trim()));
      if (matrix.length < 2 || matrix[0].length < 2 || matrix.some((row) => row.length !== matrix[0].length)) throw new Error(t.chartDataInvalid);
      const categories = matrix.slice(1).map((row) => row[0]);
      const series = matrix[0].slice(1).map((name, column) => ({ name, values: matrix.slice(1).map((row) => {
        const raw = row[column + 1];
        return raw === "" ? Number.NaN : Number(raw);
      }) }));
      if (!title.trim() || !altText.trim()) throw new Error(t.chartRequiresTitleAndAlt);
      const next = createPresentationChartObject({ id: chart?.id, chartType, title: title.trim(), altText: altText.trim(), categories, series, geometry: chart?.geometry ?? { xPt: 90, yPt: 90, widthPt: 540, heightPt: 300, rotationDeg: 0 }, createId: () => crypto.randomUUID() });
      onApply(next); onClose();
    } catch (cause) { setError(cause instanceof Error ? cause.message : t.chartDataInvalid); }
  }

  return <Dialog.Root open={open} onOpenChange={(next) => !next && onClose()}><Dialog.Portal><Dialog.Backdrop className="fixed inset-0 z-50 bg-background/80 backdrop-blur-sm" /><Dialog.Popup className="fixed left-1/2 top-1/2 z-50 w-[calc(100%-2rem)] max-w-xl -translate-x-1/2 -translate-y-1/2 rounded-2xl border bg-background p-6 shadow-xl">
    <Dialog.Title className="text-base font-semibold">{mode === "table" ? table ? t.editTable : t.insertTable : chart ? t.editChart : t.insertChart}</Dialog.Title>
    <Dialog.Description className="mt-1 text-sm text-muted-foreground">{mode === "table" ? t.tableDataDescription : t.chartDataDescription}</Dialog.Description>
    {mode === "table" ? <div className="mt-4 grid grid-cols-2 gap-3"><NumberField label={t.rows} value={rows} onValue={setRows} /><NumberField label={t.columns} value={columns} onValue={setColumns} /><label className="col-span-2 text-xs font-medium">{t.tableData}<textarea value={tableData} onInput={(event) => setTableData(event.currentTarget.value)} onChange={() => undefined} rows={8} className="mt-1 w-full rounded border p-2 font-mono font-normal" /></label></div> : <div className="mt-4 grid gap-3">
      <Select value={chartType} onValueChange={(value) => value && setChartType(value as typeof chartType)}><SelectTrigger className="w-full" aria-label={t.chartType}><SelectValue /></SelectTrigger><SelectContent>{(["bar", "line", "pie", "doughnut", "scatter"] as const).map((value) => <SelectItem key={value} value={value}>{t[value]}</SelectItem>)}</SelectContent></Select>
      <label className="text-xs font-medium">{t.chartTitle}<input value={title} onInput={(event) => setTitle(event.currentTarget.value)} onChange={() => undefined} className="mt-1 h-9 w-full rounded border px-3 font-normal" /></label>
      <label className="text-xs font-medium">{t.altText}<input value={altText} onInput={(event) => setAltText(event.currentTarget.value)} onChange={() => undefined} className="mt-1 h-9 w-full rounded border px-3 font-normal" /></label>
      <label className="text-xs font-medium">{t.chartData}<textarea value={chartData} onInput={(event) => setChartData(event.currentTarget.value)} onChange={() => undefined} rows={8} className="mt-1 w-full rounded border p-2 font-mono font-normal" /></label>
    </div>}
    {error ? <p role="alert" className="mt-3 text-sm text-destructive">{error}</p> : null}
    <div className="mt-5 flex justify-end gap-2"><Button variant="outline" size="sm" onClick={onClose}>{t.cancelWorksheetAction}</Button><Button size="sm" onClick={apply}>{t.apply}</Button></div>
  </Dialog.Popup></Dialog.Portal></Dialog.Root>;
}

function NumberField({ label, value, onValue }: { label: string; value: number; onValue(value: number): void }) { return <label className="text-xs font-medium">{label}<input type="number" min={1} max={20} value={value} onInput={(event) => onValue(Math.max(1, Math.min(20, Number(event.currentTarget.value))))} onChange={() => undefined} className="mt-1 h-9 w-full rounded border px-3 font-normal" /></label>; }

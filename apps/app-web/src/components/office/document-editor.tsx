"use client";

/** Adaptive canonical Document editor; every mutation emits OfficeCommand. [COMP:app-web/office-document-editor] */
import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { Bold, Italic, List, Plus, Table2, Underline } from "lucide-react";
import {
  officeTableCellPlacements,
  officeTableResolvedColumnWidthsPt,
  type DocumentFlowNode,
  type DocumentSnapshot,
  type OfficeCommand,
  type OfficeRichTextRun,
  type OfficeTable,
  type OfficeTableBorder,
  type OfficeTableCell,
} from "@use-brian/office-model";
import { defaultRun, deleteCommand, insertDocumentCommand, propertyCommand, textCommand } from "@/lib/office/editor-commands";
import { useT } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";
import { getOfficeResourceObjectUrl } from "@/lib/office/api";

export function DocumentEditor({ snapshot, baseVersion, role, suggestMode, onCommand, onSelectTargets }: { snapshot: DocumentSnapshot; baseVersion: number; role: "view" | "comment" | "edit"; suggestMode: boolean; onCommand(command: OfficeCommand): void; onSelectTargets?(ids: string[]): void }) {
  const t = useT().office;
  const canChange = role === "edit" || role === "comment" && suggestMode;
  const section = snapshot.sections[0];
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = useMemo(() => section.nodes.find((node) => node.id === selectedId), [section.nodes, selectedId]);
  const emit = (command: OfficeCommand) => { if (canChange) onCommand(command); };
  const select = (id: string) => { setSelectedId(id); onSelectTargets?.([id]); };

  function add(kind: "paragraph" | "heading" | "table" | "pageBreak") {
    const id = crypto.randomUUID();
    const node: DocumentFlowNode = kind === "paragraph" ? { id, kind, runs: [defaultRun()], styleName: "Body", alignment: "start" }
      : kind === "heading" ? { id, kind, level: 2, runs: [defaultRun()], styleName: "Heading 2" }
      : kind === "table" ? { id, kind, headerRows: 1, rows: [{ id: crypto.randomUUID(), cells: [{ id: crypto.randomUUID(), runs: [defaultRun()], rowSpan: 1, colSpan: 1 }] }] }
      : { id, kind };
    emit(insertDocumentCommand(snapshot.artifactId, baseVersion, section.id, section.nodes.length, node));
  }

  function toggleStyle(field: "bold" | "italic" | "underline") {
    if (!selected || !("runs" in selected)) return;
    const runs = selected.runs.map((run) => ({ ...run, style: { ...run.style, [field]: !run.style[field] } }));
    emit(textCommand(snapshot.artifactId, baseVersion, selected.id, runs));
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-office-editor="document">
      <div className="sticky top-0 z-10 flex flex-wrap items-center gap-1 border-b bg-background/95 p-2 backdrop-blur" role="toolbar" aria-label={t.editorToolbar}>
        <button type="button" aria-label={t.bold} disabled={!canChange || !selected} onClick={() => toggleStyle("bold")} className="rounded p-2 hover:bg-muted disabled:opacity-40"><Bold className="size-4" /></button>
        <button type="button" aria-label={t.italic} disabled={!canChange || !selected} onClick={() => toggleStyle("italic")} className="rounded p-2 hover:bg-muted disabled:opacity-40"><Italic className="size-4" /></button>
        <button type="button" aria-label={t.underline} disabled={!canChange || !selected} onClick={() => toggleStyle("underline")} className="rounded p-2 hover:bg-muted disabled:opacity-40"><Underline className="size-4" /></button>
        <span className="mx-1 h-5 border-l" />
        <EditorButton label={t.addParagraph} disabled={!canChange} onClick={() => add("paragraph")} icon={<Plus className="size-4" />} />
        <EditorButton label={t.addHeading} disabled={!canChange} onClick={() => add("heading")} icon={<List className="size-4" />} />
        <EditorButton label={t.addTable} disabled={!canChange} onClick={() => add("table")} icon={<Table2 className="size-4" />} />
        <EditorButton label={t.addPageBreak} disabled={!canChange} onClick={() => add("pageBreak")} />
        {suggestMode ? <span className="ml-auto rounded-full bg-amber-100 px-2 py-1 text-xs text-amber-900">{t.suggesting}</span> : null}
      </div>
      <div data-office-document-scroll="true" className="min-h-0 flex-1 overflow-auto">
        <div className="mx-auto my-4 bg-white text-slate-950 shadow-sm" style={{ width: `min(${section.page.widthPt}px, calc(100% - 2rem))`, minHeight: `${section.page.heightPt}px`, paddingLeft: `${section.page.marginLeftPt}px`, paddingRight: `${section.page.marginRightPt}px`, paddingTop: "24px", paddingBottom: "24px", boxSizing: "border-box" }}>
          <div className="mb-10 flex items-center gap-2 pb-2" style={{ borderBottom: section.headerBorderBottom ? `${section.headerBorderBottom.widthPt}px solid ${section.headerBorderBottom.color}` : undefined }}>
            {section.headerImage ? <DocumentResourceImage artifactId={snapshot.artifactId} resourceId={section.headerImage.resourceId} alt={section.headerImage.altText} widthPt={section.headerImage.widthPt} heightPt={section.headerImage.heightPt} /> : null}
            <input aria-label={t.header} disabled={!canChange} value={section.header.map((run) => run.text).join("")} onChange={(event) => emit(propertyCommand(snapshot.artifactId, baseVersion, section.id, ["header"], runsWithText(section.header, event.target.value)))} style={richTextCss(section.header, section.headerAlignment)} className="w-full border-b border-transparent bg-transparent hover:border-slate-200 disabled:opacity-80" />
          </div>
          <div>
            {section.nodes.map((node) => <DocumentNode key={node.id} node={node} selected={selectedId === node.id} canChange={canChange} onSelect={() => select(node.id)} onText={(targetId, runs) => emit(textCommand(snapshot.artifactId, baseVersion, targetId, runs))} onProperty={(targetId, path, value) => emit(propertyCommand(snapshot.artifactId, baseVersion, targetId, path, value))} onDelete={() => emit(deleteCommand(snapshot.artifactId, baseVersion, node.id))} />)}
          </div>
          <div className="mt-12 pt-2" style={{ borderTop: section.footerBorderTop ? `${section.footerBorderTop.widthPt}px solid ${section.footerBorderTop.color}` : undefined }}><input aria-label={t.footer} disabled={!canChange} value={section.footer.map((run) => run.text).join("")} onChange={(event) => emit(propertyCommand(snapshot.artifactId, baseVersion, section.id, ["footer"], runsWithText(section.footer, event.target.value)))} style={richTextCss(section.footer, section.footerAlignment)} className="w-full border-t border-transparent bg-transparent pt-1 hover:border-slate-200 disabled:opacity-80" /></div>
        </div>
      </div>
    </div>
  );
}

function DocumentResourceImage({ artifactId, resourceId, alt, widthPt, heightPt }: { artifactId: string; resourceId: string; alt: string; widthPt: number; heightPt: number }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    void getOfficeResourceObjectUrl(artifactId, resourceId).then((url) => { if (active) setSrc(url); }).catch(() => undefined);
    return () => { active = false; };
  }, [artifactId, resourceId]);
  return src ? <img src={src} alt={alt} width={widthPt} height={heightPt} className="shrink-0 object-contain" style={{ width: `${widthPt}px`, height: `${heightPt}px` }} /> : <span aria-label={alt} className="shrink-0 rounded bg-slate-100" style={{ width: `${widthPt}px`, height: `${heightPt}px` }} />;
}

function DocumentNode({ node, selected, canChange, onSelect, onText, onProperty, onDelete }: { node: DocumentFlowNode; selected: boolean; canChange: boolean; onSelect(): void; onText(id: string, runs: OfficeRichTextRun[]): void; onProperty(id: string, path: string[], value: unknown): void; onDelete(): void }) {
  const t = useT().office;
  const frame = cn("relative rounded-sm outline outline-1 outline-transparent", selected && "outline-primary");
  if (node.kind === "paragraph" || node.kind === "heading") return <div className={frame} style={{ marginTop: `${node.spacingBeforePt ?? 0}pt`, marginBottom: `${node.spacingAfterPt ?? 8}pt` }} onClick={onSelect}><TextInput runs={node.runs} disabled={!canChange} style={richTextCss(node.runs, node.alignment, node.lineSpacingPt)} className={node.kind === "heading" ? "font-semibold" : undefined} onChange={(runs) => onText(node.id, runs)} /><DeleteButton show={selected && canChange} label={t.deleteObject} onClick={onDelete} /></div>;
  if (node.kind === "list") return <ol className={cn(frame, node.ordered ? "list-decimal" : "list-disc", "pl-6")} onClick={onSelect}>{node.items.map((item) => <li key={item.id}><TextInput runs={item.runs} disabled={!canChange} onChange={(runs) => onText(item.id, runs)} /></li>)}</ol>;
  if (node.kind === "table") return <div className={frame} onClick={onSelect}><DocumentTable node={node} canChange={canChange} onText={onText} /></div>;
  if (node.kind === "image") return <ObjectCard selected={selected} label={node.decorative ? t.decorativeImage : node.altText || t.image} onSelect={onSelect}><input aria-label={t.altText} disabled={!canChange} value={node.altText} onChange={(event) => onProperty(node.id, ["altText"], event.target.value)} className="w-full bg-transparent text-sm" /></ObjectCard>;
  if (node.kind === "chart") return <ObjectCard selected={selected} label={node.title} onSelect={onSelect}><p className="text-xs text-slate-500">{node.chartType} · {node.categories.length}</p></ObjectCard>;
  if (node.kind === "video") return <ObjectCard selected={selected} label={node.altText} onSelect={onSelect}><p className="text-xs text-slate-500">{t.video}</p></ObjectCard>;
  return <button type="button" onClick={onSelect} className={cn("my-6 flex w-full items-center gap-3 text-xs text-slate-400", selected && "text-primary")}><span className="h-px flex-1 bg-current" />{node.kind === "pageBreak" ? t.pageBreak : t.sectionBreak}<span className="h-px flex-1 bg-current" /></button>;
}

function tableBorderCss(border: OfficeTableBorder | undefined, fallback: string): string {
  if (!border) return fallback;
  if (border.style === "none" || border.widthPt === 0) return "none";
  const style = border.style === "dotted" ? "dotted" : border.style === "dashed" ? "dashed" : border.style === "double" ? "double" : "solid";
  return `${Math.max(0.5, border.widthPt)}px ${style} ${border.color}`;
}

function tableCellBorder(node: OfficeTable, cell: OfficeTableCell, placement: ReturnType<typeof officeTableCellPlacements>[number], edge: "top" | "right" | "bottom" | "left", columnCount: number): OfficeTableBorder | undefined {
  const direct = cell.borders?.[edge];
  if (direct) return direct;
  if (edge === "top") return placement.rowIndex === 0 ? node.borders?.top : node.borders?.insideHorizontal;
  if (edge === "bottom") return placement.rowIndex + cell.rowSpan >= node.rows.length ? node.borders?.bottom : node.borders?.insideHorizontal;
  if (edge === "left") return placement.startColumn === 0 ? node.borders?.left : node.borders?.insideVertical;
  return placement.endColumn >= columnCount ? node.borders?.right : node.borders?.insideVertical;
}

function DocumentTable({ node, canChange, onText }: { node: OfficeTable; canChange: boolean; onText(id: string, runs: OfficeRichTextRun[]): void }) {
  const availableWidth = node.widthPt ?? node.columnWidthsPt?.reduce((sum, width) => sum + width, 0) ?? 470;
  const widths = officeTableResolvedColumnWidthsPt(node, availableWidth);
  const placements = officeTableCellPlacements(node);
  const placementByCell = new Map(placements.map((placement) => [placement.cell.id, placement]));
  const canonicalBorders = Boolean(node.borders || node.rows.some((row) => row.cells.some((cell) => cell.borders)));
  const borderFallback = canonicalBorders ? "none" : "1px solid #cbd5e1";
  const alignmentStyle: CSSProperties = node.alignment === "center"
    ? { marginLeft: "auto", marginRight: "auto" }
    : node.alignment === "end"
      ? { marginLeft: "auto", marginRight: 0 }
      : { marginLeft: `${Math.max(0, node.indentPt ?? 0)}px`, marginRight: 0 };
  return (
    <table
      data-office-document-table={node.id}
      className="max-w-full border-collapse"
      style={{ width: node.widthPt || node.columnWidthsPt ? `${availableWidth}px` : "100%", tableLayout: node.layout === "autofit" && !node.columnWidthsPt ? "auto" : "fixed", ...alignmentStyle }}
    >
      <colgroup>{widths.map((width, index) => <col key={`${node.id}:column:${index}`} style={{ width: `${width}px` }} />)}</colgroup>
      <tbody>{node.rows.map((row, rowIndex) => <tr key={row.id} style={{ height: row.minHeightPt ? `${row.minHeightPt}px` : undefined }}>{row.cells.map((cell) => {
        const placement = placementByCell.get(cell.id);
        if (!placement) return null;
        const margins = cell.margins ?? node.margins;
        const header = rowIndex < node.headerRows;
        const inputStyle = richTextCss(cell.runs, cell.alignment);
        if (header && !cell.runs.some((run) => run.style.bold)) inputStyle.fontWeight = 700;
        inputStyle.overflowWrap = "anywhere";
        inputStyle.wordBreak = "break-word";
        inputStyle.whiteSpace = cell.wrapText === false ? "pre" : "pre-wrap";
        return <td
          key={cell.id}
          data-office-table-cell={cell.id}
          rowSpan={cell.rowSpan}
          colSpan={cell.colSpan}
          style={{
            borderTop: tableBorderCss(tableCellBorder(node, cell, placement, "top", widths.length), borderFallback),
            borderRight: tableBorderCss(tableCellBorder(node, cell, placement, "right", widths.length), borderFallback),
            borderBottom: tableBorderCss(tableCellBorder(node, cell, placement, "bottom", widths.length), borderFallback),
            borderLeft: tableBorderCss(tableCellBorder(node, cell, placement, "left", widths.length), borderFallback),
            backgroundColor: cell.fill ?? (header ? "#f8fafc" : "transparent"),
            verticalAlign: cell.verticalAlignment === "middle" ? "middle" : cell.verticalAlignment === "bottom" ? "bottom" : "top",
            paddingTop: `${margins?.topPt ?? 2}px`,
            paddingRight: `${margins?.rightPt ?? 2}px`,
            paddingBottom: `${margins?.bottomPt ?? 2}px`,
            paddingLeft: `${margins?.leftPt ?? 2}px`,
            minWidth: 0,
            overflow: "hidden",
          }}
        ><TextInput runs={cell.runs} disabled={!canChange} style={inputStyle} className="box-border min-w-0 max-w-full p-0" onChange={(runs) => onText(cell.id, runs)} /></td>;
      })}</tr>)}</tbody>
    </table>
  );
}

function TextInput({ runs, disabled, className, style, onChange }: { runs: OfficeRichTextRun[]; disabled: boolean; className?: string; style?: CSSProperties; onChange(runs: OfficeRichTextRun[]): void }) {
  return <textarea data-office-text-input rows={1} disabled={disabled} value={runs.map((run) => run.text).join("")} onChange={(event) => onChange(runsWithText(runs, event.target.value))} style={style} className={cn("block min-h-4 w-full resize-none overflow-hidden whitespace-pre-wrap bg-transparent outline-none [field-sizing:content]", className)} />;
}
function runsWithText(runs: OfficeRichTextRun[], text: string): OfficeRichTextRun[] { return runs.length ? [{ ...runs[0], text }] : [defaultRun(text)]; }
function richTextCss(runs: OfficeRichTextRun[], alignment: "start" | "center" | "end" | "justify" = "start", lineSpacingPt?: number): CSSProperties {
  const style = runs[0]?.style;
  return {
    color: style?.color,
    fontFamily: style?.fontFamily,
    fontSize: style ? `${style.fontSizePt}pt` : undefined,
    fontStyle: style?.italic ? "italic" : undefined,
    fontWeight: style?.bold ? 700 : 400,
    lineHeight: lineSpacingPt ? `${lineSpacingPt}pt` : 1.15,
    textAlign: alignment === "end" ? "right" : alignment === "center" ? "center" : alignment === "justify" ? "justify" : "left",
    textDecoration: [style?.underline ? "underline" : "", style?.strike ? "line-through" : ""].filter(Boolean).join(" ") || undefined,
  };
}
function EditorButton({ label, icon, disabled, onClick }: { label: string; icon?: React.ReactNode; disabled: boolean; onClick(): void }) { return <button type="button" disabled={disabled} onClick={onClick} className="inline-flex items-center gap-1 rounded px-2 py-1.5 text-xs hover:bg-muted disabled:opacity-40">{icon}{label}</button>; }
function DeleteButton({ show, label, onClick }: { show: boolean; label: string; onClick(): void }) { return show ? <button type="button" onClick={(event) => { event.stopPropagation(); onClick(); }} className="absolute -right-8 top-0 text-xs text-destructive">{label}</button> : null; }
function ObjectCard({ selected, label, onSelect, children }: { selected: boolean; label: string; onSelect(): void; children: React.ReactNode }) { return <div onClick={onSelect} className={cn("rounded border bg-slate-50 p-4", selected && "ring-2 ring-primary")}><p className="mb-2 font-medium">{label}</p>{children}</div>; }

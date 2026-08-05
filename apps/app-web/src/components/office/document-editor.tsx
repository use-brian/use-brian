"use client";

/** Adaptive canonical Document editor; every mutation emits OfficeCommand. [COMP:app-web/office-document-editor] */
import { useMemo, useState } from "react";
import { Bold, Italic, List, Plus, Table2, Underline } from "lucide-react";
import type { DocumentFlowNode, DocumentSnapshot, OfficeCommand, OfficeRichTextRun } from "@use-brian/office-model";
import { defaultRun, deleteCommand, insertDocumentCommand, propertyCommand, textCommand } from "@/lib/office/editor-commands";
import { useT } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";

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
      <div className="mx-auto my-4 min-h-[70rem] w-[min(50rem,calc(100%-2rem))] bg-white px-[9%] py-16 text-slate-950 shadow-sm" style={{ minHeight: `${section.page.heightPt}px` }}>
        <input aria-label={t.header} disabled={!canChange} value={section.header.map((run) => run.text).join("")} onChange={(event) => emit(propertyCommand(snapshot.artifactId, baseVersion, section.id, ["header"], runsWithText(section.header, event.target.value)))} className="mb-10 w-full border-b border-transparent bg-transparent text-xs text-slate-500 hover:border-slate-200 disabled:opacity-80" />
        <div className="space-y-3">
          {section.nodes.map((node) => <DocumentNode key={node.id} node={node} selected={selectedId === node.id} canChange={canChange} onSelect={() => select(node.id)} onText={(targetId, runs) => emit(textCommand(snapshot.artifactId, baseVersion, targetId, runs))} onProperty={(targetId, path, value) => emit(propertyCommand(snapshot.artifactId, baseVersion, targetId, path, value))} onDelete={() => emit(deleteCommand(snapshot.artifactId, baseVersion, node.id))} />)}
        </div>
        <input aria-label={t.footer} disabled={!canChange} value={section.footer.map((run) => run.text).join("")} onChange={(event) => emit(propertyCommand(snapshot.artifactId, baseVersion, section.id, ["footer"], runsWithText(section.footer, event.target.value)))} className="mt-12 w-full border-t border-transparent bg-transparent pt-2 text-xs text-slate-500 hover:border-slate-200 disabled:opacity-80" />
      </div>
    </div>
  );
}

function DocumentNode({ node, selected, canChange, onSelect, onText, onProperty, onDelete }: { node: DocumentFlowNode; selected: boolean; canChange: boolean; onSelect(): void; onText(id: string, runs: OfficeRichTextRun[]): void; onProperty(id: string, path: string[], value: unknown): void; onDelete(): void }) {
  const t = useT().office;
  const frame = cn("relative rounded-sm outline outline-1 outline-transparent", selected && "outline-primary");
  if (node.kind === "paragraph" || node.kind === "heading") return <div className={frame} onClick={onSelect}><TextInput runs={node.runs} disabled={!canChange} className={node.kind === "heading" ? `text-${Math.max(2, 5 - node.level)}xl font-semibold` : "leading-7"} onChange={(runs) => onText(node.id, runs)} /><DeleteButton show={selected && canChange} label={t.deleteObject} onClick={onDelete} /></div>;
  if (node.kind === "list") return <ol className={cn(frame, node.ordered ? "list-decimal" : "list-disc", "pl-6")} onClick={onSelect}>{node.items.map((item) => <li key={item.id}><TextInput runs={item.runs} disabled={!canChange} onChange={(runs) => onText(item.id, runs)} /></li>)}</ol>;
  if (node.kind === "table") return <div className={frame} onClick={onSelect}><table className="w-full border-collapse">{node.rows.map((row, rowIndex) => <tbody key={row.id}><tr>{row.cells.map((cell) => <td key={cell.id} className={cn("border border-slate-300 p-2", rowIndex < node.headerRows && "font-semibold")}><TextInput runs={cell.runs} disabled={!canChange} onChange={(runs) => onText(cell.id, runs)} /></td>)}</tr></tbody>)}</table></div>;
  if (node.kind === "image") return <ObjectCard selected={selected} label={node.decorative ? t.decorativeImage : node.altText || t.image} onSelect={onSelect}><input aria-label={t.altText} disabled={!canChange} value={node.altText} onChange={(event) => onProperty(node.id, ["altText"], event.target.value)} className="w-full bg-transparent text-sm" /></ObjectCard>;
  if (node.kind === "chart") return <ObjectCard selected={selected} label={node.title} onSelect={onSelect}><p className="text-xs text-slate-500">{node.chartType} · {node.categories.length}</p></ObjectCard>;
  if (node.kind === "video") return <ObjectCard selected={selected} label={node.altText} onSelect={onSelect}><p className="text-xs text-slate-500">{t.video}</p></ObjectCard>;
  return <button type="button" onClick={onSelect} className={cn("my-6 flex w-full items-center gap-3 text-xs text-slate-400", selected && "text-primary")}><span className="h-px flex-1 bg-current" />{node.kind === "pageBreak" ? t.pageBreak : t.sectionBreak}<span className="h-px flex-1 bg-current" /></button>;
}

function TextInput({ runs, disabled, className, onChange }: { runs: OfficeRichTextRun[]; disabled: boolean; className?: string; onChange(runs: OfficeRichTextRun[]): void }) {
  return <textarea rows={1} disabled={disabled} value={runs.map((run) => run.text).join("")} onChange={(event) => onChange(runsWithText(runs, event.target.value))} className={cn("block w-full resize-none overflow-hidden bg-transparent outline-none", className)} />;
}
function runsWithText(runs: OfficeRichTextRun[], text: string): OfficeRichTextRun[] { return runs.length ? [{ ...runs[0], text }] : [defaultRun(text)]; }
function EditorButton({ label, icon, disabled, onClick }: { label: string; icon?: React.ReactNode; disabled: boolean; onClick(): void }) { return <button type="button" disabled={disabled} onClick={onClick} className="inline-flex items-center gap-1 rounded px-2 py-1.5 text-xs hover:bg-muted disabled:opacity-40">{icon}{label}</button>; }
function DeleteButton({ show, label, onClick }: { show: boolean; label: string; onClick(): void }) { return show ? <button type="button" onClick={(event) => { event.stopPropagation(); onClick(); }} className="absolute -right-8 top-0 text-xs text-destructive">{label}</button> : null; }
function ObjectCard({ selected, label, onSelect, children }: { selected: boolean; label: string; onSelect(): void; children: React.ReactNode }) { return <div onClick={onSelect} className={cn("rounded border bg-slate-50 p-4", selected && "ring-2 ring-primary")}><p className="mb-2 font-medium">{label}</p>{children}</div>; }

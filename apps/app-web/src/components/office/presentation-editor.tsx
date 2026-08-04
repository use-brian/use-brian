"use client";

/** Brian-owned DOM/SVG Presentation canvas over canonical geometry. [COMP:app-web/office-presentation-editor] */
import { useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronUp, Plus, Shapes, Type } from "lucide-react";
import type { OfficeCommand, OfficeRichTextRun, PresentationObject, PresentationSnapshot } from "@use-brian/office-model";
import { addSlideCommand, defaultRun, deleteCommand, insertSlideObjectCommand, propertyCommand, reorderSlideCommand, textCommand } from "@/lib/office/editor-commands";
import { useT } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";

export function PresentationEditor({ snapshot, baseVersion, role, suggestMode, onCommand, onSelectTargets }: { snapshot: PresentationSnapshot; baseVersion: number; role: "view" | "comment" | "edit"; suggestMode: boolean; onCommand(command: OfficeCommand): void; onSelectTargets?(ids: string[]): void }) {
  const t = useT().office;
  const canChange = role === "edit" || role === "comment" && suggestMode;
  const [slideId, setSlideId] = useState(snapshot.slides[0].id);
  const [objectId, setObjectId] = useState<string | null>(null);
  const slide = snapshot.slides.find((candidate) => candidate.id === slideId) ?? snapshot.slides[0];
  const selected = useMemo(() => slide.objects.find((object) => object.id === objectId) ?? null, [objectId, slide.objects]);
  const scale = 100 / snapshot.slideSize.widthPt;
  const emit = (command: OfficeCommand) => { if (canChange) onCommand(command); };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.key === "Delete" || event.key === "Backspace") && selected && canChange && !(event.target instanceof HTMLInputElement) && !(event.target instanceof HTMLTextAreaElement)) emit(deleteCommand(snapshot.artifactId, baseVersion, selected.id));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  function selectObject(id: string) { setObjectId(id); onSelectTargets?.([id]); }
  function addText() {
    const object: PresentationObject = { id: crypto.randomUUID(), kind: "text", geometry: { xPt: 72, yPt: 72, widthPt: 360, heightPt: 72, rotationDeg: 0 }, locked: false, runs: [defaultRun(t.newText)], alignment: "start", verticalAlignment: "top" };
    emit(insertSlideObjectCommand(snapshot.artifactId, baseVersion, slide.id, slide.objects.length, object));
  }
  function addShape() {
    const object: PresentationObject = { id: crypto.randomUUID(), kind: "shape", geometry: { xPt: 90, yPt: 110, widthPt: 180, heightPt: 90, rotationDeg: 0 }, locked: false, shape: "roundedRectangle", fill: "#E2E8F0", stroke: "#64748B", strokeWidthPt: 1, text: [], altText: "" };
    emit(insertSlideObjectCommand(snapshot.artifactId, baseVersion, slide.id, slide.objects.length, object));
  }
  function addSlide() {
    const newId = crypto.randomUUID();
    emit(addSlideCommand(snapshot.artifactId, baseVersion, snapshot.slides.length, { id: newId, title: t.newSlide, masterId: snapshot.masters[0].id, layoutId: snapshot.layouts[0].id, objects: [], readingOrder: [], notes: [] }));
  }

  return (
    <div className="grid min-h-0 flex-1 grid-cols-[6.5rem_minmax(0,1fr)] lg:grid-cols-[10rem_minmax(0,1fr)_15rem]" data-office-editor="presentation">
      <nav className="overflow-y-auto border-r bg-muted/30 p-2" aria-label={t.slideRail}>
        {snapshot.slides.map((item, index) => <button key={item.id} type="button" onClick={() => { setSlideId(item.id); setObjectId(null); onSelectTargets?.([item.id]); }} className={cn("mb-2 block w-full rounded border bg-white p-1 text-left text-slate-900", item.id === slide.id && "ring-2 ring-primary")}><span className="text-[10px] text-slate-500">{index + 1}</span><span className="line-clamp-2 block text-xs">{item.title}</span></button>)}
        <button type="button" onClick={addSlide} disabled={!canChange} className="flex w-full items-center justify-center gap-1 rounded border border-dashed p-2 text-xs disabled:opacity-40"><Plus className="size-3" />{t.newSlide}</button>
      </nav>
      <div className="flex min-h-0 flex-col overflow-auto bg-muted/40">
        <div className="flex flex-wrap items-center gap-1 border-b bg-background p-2" role="toolbar" aria-label={t.editorToolbar}>
          <button type="button" onClick={addText} disabled={!canChange} className="inline-flex items-center gap-1 rounded px-2 py-1.5 text-xs hover:bg-muted disabled:opacity-40"><Type className="size-4" />{t.addText}</button>
          <button type="button" onClick={addShape} disabled={!canChange} className="inline-flex items-center gap-1 rounded px-2 py-1.5 text-xs hover:bg-muted disabled:opacity-40"><Shapes className="size-4" />{t.addShape}</button>
          <button type="button" aria-label={t.moveSlideUp} disabled={!canChange || snapshot.slides.indexOf(slide) === 0} onClick={() => emit(reorderSlideCommand(snapshot.artifactId, baseVersion, slide.id, Math.max(0, snapshot.slides.indexOf(slide) - 1)))} className="rounded p-2 disabled:opacity-30"><ChevronUp className="size-4" /></button>
          <button type="button" aria-label={t.moveSlideDown} disabled={!canChange || snapshot.slides.indexOf(slide) === snapshot.slides.length - 1} onClick={() => emit(reorderSlideCommand(snapshot.artifactId, baseVersion, slide.id, snapshot.slides.indexOf(slide) + 1))} className="rounded p-2 disabled:opacity-30"><ChevronDown className="size-4" /></button>
          {suggestMode ? <span className="ml-auto rounded-full bg-amber-100 px-2 py-1 text-xs text-amber-900">{t.suggesting}</span> : null}
        </div>
        <div className="flex flex-1 items-center justify-center p-4 lg:p-8">
          <div className="relative aspect-video w-full max-w-5xl overflow-hidden bg-white text-slate-950 shadow" style={{ aspectRatio: `${snapshot.slideSize.widthPt}/${snapshot.slideSize.heightPt}` }} onClick={() => setObjectId(null)}>
            {slide.objects.map((object) => <SlideObject key={object.id} object={object} selected={object.id === objectId} canChange={canChange} scale={scale} onSelect={() => selectObject(object.id)} onText={(targetId, runs) => emit(textCommand(snapshot.artifactId, baseVersion, targetId, runs))} onProperty={(targetId, path, value) => emit(propertyCommand(snapshot.artifactId, baseVersion, targetId, path, value))} />)}
          </div>
        </div>
        <label className="border-t bg-background p-3 text-xs font-medium">{t.speakerNotes}<textarea disabled={!canChange} value={slide.notes.map((run) => run.text).join("")} onChange={(event) => emit(propertyCommand(snapshot.artifactId, baseVersion, slide.id, ["notes"], runsWithText(slide.notes, event.target.value)))} className="mt-1 min-h-16 w-full resize-y rounded border p-2 font-normal" /></label>
      </div>
      <aside className="hidden overflow-y-auto border-l bg-background p-3 lg:block">
        <h2 className="text-sm font-semibold">{t.properties}</h2>
        {selected ? <GeometryInspector object={selected} disabled={!canChange} onProperty={(path, value) => emit(propertyCommand(snapshot.artifactId, baseVersion, selected.id, path, value))} onDelete={() => emit(deleteCommand(snapshot.artifactId, baseVersion, selected.id))} /> : <p className="mt-3 text-xs text-muted-foreground">{t.selectObject}</p>}
      </aside>
    </div>
  );
}

function SlideObject({ object, selected, canChange, scale, onSelect, onText, onProperty }: { object: PresentationObject; selected: boolean; canChange: boolean; scale: number; onSelect(): void; onText(id: string, runs: OfficeRichTextRun[]): void; onProperty(id: string, path: string[], value: unknown): void }) {
  const t = useT().office;
  const style: React.CSSProperties = { left: `${object.geometry.xPt * scale}%`, top: `${object.geometry.yPt * scale}%`, width: `${object.geometry.widthPt * scale}%`, height: `${object.geometry.heightPt * scale}%`, transform: `rotate(${object.geometry.rotationDeg}deg)` };
  const frame = cn("absolute overflow-hidden border border-transparent", selected && "border-primary ring-1 ring-primary");
  if (object.kind === "text") return <textarea onClick={(event) => { event.stopPropagation(); onSelect(); }} disabled={!canChange} value={object.runs.map((run) => run.text).join("")} onChange={(event) => onText(object.id, runsWithText(object.runs, event.target.value))} style={style} className={cn(frame, "resize-none bg-transparent p-1 outline-none")} />;
  if (object.kind === "shape") return <button type="button" onClick={(event) => { event.stopPropagation(); onSelect(); }} style={{ ...style, backgroundColor: object.fill, borderColor: object.stroke }} className={frame}>{object.text.map((run) => run.text).join("")}</button>;
  if (object.kind === "connector") return <button type="button" aria-label={t.connector} onClick={(event) => { event.stopPropagation(); onSelect(); }} style={style} className={cn(frame, "border-t-2")} />;
  if (object.kind === "table") return <div onClick={(event) => { event.stopPropagation(); onSelect(); }} style={style} className={cn(frame, "bg-white")}><table className="h-full w-full border-collapse text-[8px]">{object.rows.map((row) => <tbody key={row.id}><tr>{row.cells.map((cell) => <td key={cell.id} className="border p-1">{cell.runs.map((run) => run.text).join("")}</td>)}</tr></tbody>)}</table></div>;
  if (object.kind === "chart") return <button type="button" onClick={(event) => { event.stopPropagation(); onSelect(); }} style={style} className={cn(frame, "bg-slate-50 p-2 text-xs")}><strong>{object.title}</strong><span className="block text-slate-500">{object.chartType}</span></button>;
  if (object.kind === "image") return <button type="button" onClick={(event) => { event.stopPropagation(); onSelect(); }} style={style} className={cn(frame, "bg-slate-100 text-xs text-slate-500")}>{object.altText || t.image}</button>;
  return <button type="button" onClick={(event) => { event.stopPropagation(); onSelect(); }} style={style} className={cn(frame, "bg-slate-900 text-xs text-white")}>{t.video}</button>;
}

function GeometryInspector({ object, disabled, onProperty, onDelete }: { object: PresentationObject; disabled: boolean; onProperty(path: string[], value: unknown): void; onDelete(): void }) {
  const t = useT().office;
  const fields = [["xPt", t.x], ["yPt", t.y], ["widthPt", t.width], ["heightPt", t.height], ["rotationDeg", t.rotation]] as const;
  return <div className="mt-4 space-y-3">{fields.map(([key, label]) => <label key={key} className="block text-xs">{label}<input type="number" disabled={disabled} value={object.geometry[key]} onChange={(event) => onProperty(["geometry", key], Number(event.target.value))} className="mt-1 h-8 w-full rounded border px-2" /></label>)}<button type="button" disabled={disabled} onClick={onDelete} className="text-xs text-destructive disabled:opacity-40">{t.deleteObject}</button></div>;
}
function runsWithText(runs: OfficeRichTextRun[], text: string): OfficeRichTextRun[] { return runs.length ? [{ ...runs[0], text }] : [defaultRun(text)]; }

"use client";

/** Brian-owned DOM/SVG Presentation canvas over canonical geometry. [COMP:app-web/office-presentation-editor] */
import { useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronUp, Plus, Shapes, Type } from "lucide-react";
import type { OfficeCommand, OfficeRichTextRun, PresentationObject, PresentationSnapshot } from "@use-brian/office-model";
import { addSlideCommand, defaultRun, deleteCommand, insertSlideObjectCommand, propertyCommand, reorderSlideCommand, textCommand } from "@/lib/office/editor-commands";
import { useT } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";
import { PresentationGeometryToolbar, PresentationObjectFrame } from "./presentation-object-frame";
import { PresentationSlideVisual } from "./presentation-slide-visual";

export function PresentationEditor({ snapshot, baseVersion, role, suggestMode, onCommand, onSelectTargets }: { snapshot: PresentationSnapshot; baseVersion: number; role: "view" | "comment" | "edit"; suggestMode: boolean; onCommand(command: OfficeCommand): void; onSelectTargets?(ids: string[]): void }) {
  const t = useT().office;
  const canChange = role === "edit" || role === "comment" && suggestMode;
  const [slideId, setSlideId] = useState(snapshot.slides[0].id);
  const [objectId, setObjectId] = useState<string | null>(null);
  const [geometryPreview, setGeometryPreview] = useState<{ objectId: string; geometry: PresentationObject["geometry"] } | null>(null);
  const slide = snapshot.slides.find((candidate) => candidate.id === slideId) ?? snapshot.slides[0];
  const selected = useMemo(() => slide.objects.find((object) => object.id === objectId) ?? null, [objectId, slide.objects]);
  const selectedForToolbar = selected && geometryPreview?.objectId === selected.id ? { ...selected, geometry: geometryPreview.geometry } as PresentationObject : selected;
  const slideAspectRatio = `${snapshot.slideSize.widthPt} / ${snapshot.slideSize.heightPt}`;
  const emit = (command: OfficeCommand) => { if (canChange) onCommand(command); };

  useEffect(() => {
    if (!objectId) onSelectTargets?.([slide.id]);
  }, [objectId, onSelectTargets, slide.id]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.key === "Delete" || event.key === "Backspace") && selected && canChange && !selected.locked && !(event.target instanceof HTMLInputElement) && !(event.target instanceof HTMLTextAreaElement) && !(event.target instanceof HTMLElement && event.target.isContentEditable)) emit(deleteCommand(snapshot.artifactId, baseVersion, selected.id));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  function selectObject(id: string) { if (id !== objectId) setGeometryPreview(null); setObjectId(id); onSelectTargets?.([id]); }
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
  function updateSelectedGeometry(path: string[], value: unknown) {
    if (!selectedForToolbar || path[0] !== "geometry" || typeof value !== "number") return;
    const key = path[1] as keyof PresentationObject["geometry"];
    const geometry = { ...selectedForToolbar.geometry, [key]: value };
    setGeometryPreview({ objectId: selectedForToolbar.id, geometry });
    emit(propertyCommand(snapshot.artifactId, baseVersion, selectedForToolbar.id, path, value));
  }

  return (
    <div className="grid min-h-0 flex-1 grid-cols-[6.5rem_minmax(0,1fr)] lg:grid-cols-[10rem_minmax(0,1fr)]" data-office-editor="presentation" data-properties-open={selected ? "true" : "false"}>
      <nav className="overflow-y-auto border-r bg-muted/30 p-2" aria-label={t.slideRail}>
        {snapshot.slides.map((item, index) => <div key={item.id} data-slide-thumbnail="true" style={{ aspectRatio: slideAspectRatio }} className={cn("relative mb-2 w-full overflow-hidden rounded border bg-white text-slate-900", item.id === slide.id && "ring-2 ring-primary")}>
          <PresentationSlideVisual artifactId={snapshot.artifactId} slide={item} slideSize={snapshot.slideSize} className="pointer-events-none h-full w-full" />
          <span aria-hidden className="absolute left-1 top-1 z-20 rounded bg-background/80 px-1 text-[9px] leading-4 text-foreground shadow-sm">{index + 1}</span>
          <button type="button" aria-label={`${index + 1}: ${item.title}`} onClick={() => { setSlideId(item.id); setObjectId(null); setGeometryPreview(null); onSelectTargets?.([item.id]); }} className="absolute inset-0 z-30"><span className="sr-only">{item.title}</span></button>
        </div>)}
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
        {selectedForToolbar ? <PresentationGeometryToolbar object={selectedForToolbar} disabled={!canChange || selectedForToolbar.locked} onProperty={updateSelectedGeometry} onDelete={() => emit(deleteCommand(snapshot.artifactId, baseVersion, selectedForToolbar.id))} /> : null}
        <div className="flex flex-1 items-center justify-center p-4 lg:p-8">
          <div data-slide-canvas="true" data-slide-preview-canvas="true" className="relative w-full max-w-5xl overflow-hidden bg-white text-slate-950 shadow" style={{ aspectRatio: slideAspectRatio, containerType: "inline-size" }} onClick={() => { setObjectId(null); setGeometryPreview(null); }}>
            {slide.objects.map((object) => <PresentationObjectFrame key={object.id} artifactId={snapshot.artifactId} object={object} selected={object.id === objectId} canChange={canChange} slideSize={snapshot.slideSize} onSelect={() => selectObject(object.id)} onText={(targetId, runs) => emit(textCommand(snapshot.artifactId, baseVersion, targetId, runs))} onGeometryPreview={(targetId, geometry) => setGeometryPreview(geometry ? { objectId: targetId, geometry } : null)} onGeometry={(targetId, geometry) => emit(propertyCommand(snapshot.artifactId, baseVersion, targetId, ["geometry"], geometry))} />)}
          </div>
        </div>
        <label className="border-t bg-background p-3 text-xs font-medium">{t.speakerNotes}<textarea disabled={!canChange} value={slide.notes.map((run) => run.text).join("")} onChange={(event) => emit(propertyCommand(snapshot.artifactId, baseVersion, slide.id, ["notes"], runsWithText(slide.notes, event.target.value)))} className="mt-1 min-h-16 w-full resize-y rounded border p-2 font-normal" /></label>
      </div>
    </div>
  );
}
function runsWithText(runs: OfficeRichTextRun[], text: string): OfficeRichTextRun[] { return runs.length ? [{ ...runs[0], text }] : [defaultRun(text)]; }

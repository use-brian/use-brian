"use client";

/** Adaptive slide and multi-object editing over canonical commands. [COMP:app-web/office-presentation-editor] */
import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { ChevronDown, ChevronUp, Copy, MoreHorizontal, Plus, Shapes, Trash2, Type } from "lucide-react";
import {
  arrangePresentationObjects,
  clonePresentationObjects,
  clonePresentationSlide,
  type OfficeCommand,
  type OfficeRichTextRun,
  type PresentationObject,
  type PresentationSnapGuide,
  type PresentationSnapshot,
} from "@use-brian/office-model";
import {
  addSlideCommand,
  batchCommand,
  defaultRun,
  deleteCommand,
  deleteSlideCommand,
  insertSlideObjectCommand,
  propertyCommand,
  reorderSlideCommand,
  reorderSlideObjectCommand,
  textCommand,
} from "@/lib/office/editor-commands";
import { readPresentationClipboard, writePresentationClipboard } from "@/lib/office/presentation-clipboard";
import {
  objectsIntersectingPresentationMarquee,
  repairPresentationSelection,
  reorderedPresentationObjectIds,
  togglePresentationSelection,
} from "@/lib/office/presentation-selection";
import { confirmDialog } from "@/components/ui/confirm-dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useT } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";
import { PresentationGeometryToolbar, PresentationObjectFrame } from "./presentation-object-frame";
import { PresentationSlideVisual } from "./presentation-slide-visual";

type Geometry = PresentationObject["geometry"];
type Marquee = { startX: number; startY: number; x: number; y: number; width: number; height: number; baseIds: string[] };

function commandTargetIsTextInput(target: EventTarget | null): boolean {
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLElement && target.isContentEditable;
}

export function PresentationEditor({ snapshot, baseVersion, role, suggestMode, onCommand, onSelectTargets }: { snapshot: PresentationSnapshot; baseVersion: number; role: "view" | "comment" | "edit"; suggestMode: boolean; onCommand(command: OfficeCommand): void; onSelectTargets?(ids: string[]): void }) {
  const t = useT().office;
  const canChange = role === "edit" || role === "comment" && suggestMode;
  const rootRef = useRef<HTMLDivElement | null>(null);
  const railRef = useRef<HTMLElement | null>(null);
  const [slideId, setSlideId] = useState(snapshot.slides[0].id);
  const [selectedObjectIds, setSelectedObjectIds] = useState<string[]>([]);
  const [geometryPreview, setGeometryPreview] = useState<Map<string, Geometry>>(new Map());
  const [snapGuides, setSnapGuides] = useState<PresentationSnapGuide[]>([]);
  const [marquee, setMarquee] = useState<Marquee | null>(null);
  const [dragSlideId, setDragSlideId] = useState<string | null>(null);
  const [dragSlideIndex, setDragSlideIndex] = useState<number | null>(null);
  const slide = snapshot.slides.find((candidate) => candidate.id === slideId) ?? snapshot.slides[0];
  const selectedObjects = useMemo(() => selectedObjectIds.map((id) => slide.objects.find((object) => object.id === id)).filter((object): object is PresentationObject => Boolean(object)), [selectedObjectIds, slide.objects]);
  const selectionHasLocked = selectedObjects.some((object) => object.locked);
  const primary = selectedObjects[0] ?? null;
  const selectedForToolbar = primary && geometryPreview.has(primary.id) ? { ...primary, geometry: geometryPreview.get(primary.id)! } as PresentationObject : primary;
  const slideAspectRatio = `${snapshot.slideSize.widthPt} / ${snapshot.slideSize.heightPt}`;
  const emit = (command: OfficeCommand) => { if (canChange) onCommand(command); };

  useEffect(() => {
    setSelectedObjectIds((current) => repairPresentationSelection(current, slide.objects));
  }, [slide.id, slide.objects]);

  useEffect(() => {
    onSelectTargets?.(selectedObjectIds.length ? selectedObjectIds : [slide.id]);
  }, [onSelectTargets, selectedObjectIds, slide.id]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!rootRef.current || commandTargetIsTextInput(event.target) || !rootRef.current.contains(event.target as Node) && event.target !== document.body) return;
      const mod = event.metaKey || event.ctrlKey;
      if (event.key === "Escape") { setSelectedObjectIds([]); setGeometryPreview(new Map()); setMarquee(null); return; }
      if (mod && event.key.toLocaleLowerCase() === "a") {
        event.preventDefault();
        setSelectedObjectIds(slide.objects.filter((object) => !object.locked).map((object) => object.id));
        return;
      }
      if (mod && event.key.toLocaleLowerCase() === "d") { event.preventDefault(); duplicateSlide(); return; }
      if (mod && ["c", "x", "v"].includes(event.key.toLocaleLowerCase())) {
        event.preventDefault();
        const key = event.key.toLocaleLowerCase();
        if (key === "v") void paste();
        else void copy(key === "x");
        return;
      }
      if ((event.key === "Delete" || event.key === "Backspace") && canChange) {
        event.preventDefault();
        if (selectedObjects.length) deleteSelectedObjects();
        else void deleteCurrentSlide();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  function selectSlide(nextSlideId: string) {
    setSlideId(nextSlideId);
    setSelectedObjectIds([]);
    setGeometryPreview(new Map());
    setSnapGuides([]);
  }

  function selectObject(id: string, additive = false) {
    setGeometryPreview(new Map());
    setSelectedObjectIds((current) => additive ? togglePresentationSelection(current, id, true) : current.includes(id) && current.length > 1 ? current : [id]);
  }

  function addText() {
    const object: PresentationObject = { id: crypto.randomUUID(), kind: "text", geometry: { xPt: 72, yPt: 72, widthPt: 360, heightPt: 72, rotationDeg: 0 }, locked: false, runs: [defaultRun(t.newText)], alignment: "start", verticalAlignment: "top" };
    emit(insertSlideObjectCommand(snapshot.artifactId, baseVersion, slide.id, slide.objects.length, object));
    setSelectedObjectIds([object.id]);
  }

  function addShape() {
    const object: PresentationObject = { id: crypto.randomUUID(), kind: "shape", geometry: { xPt: 90, yPt: 110, widthPt: 180, heightPt: 90, rotationDeg: 0 }, locked: false, shape: "roundedRectangle", fill: "#E2E8F0", stroke: "#64748B", strokeWidthPt: 1, text: [], altText: "" };
    emit(insertSlideObjectCommand(snapshot.artifactId, baseVersion, slide.id, slide.objects.length, object));
    setSelectedObjectIds([object.id]);
  }

  function addSlide() {
    const newId = crypto.randomUUID();
    emit(addSlideCommand(snapshot.artifactId, baseVersion, snapshot.slides.length, { id: newId, title: t.newSlide, masterId: snapshot.masters[0].id, layoutId: snapshot.layouts[0].id, objects: [], readingOrder: [], notes: [] }));
    setSlideId(newId);
    setSelectedObjectIds([]);
  }

  function duplicateSlide() {
    if (!canChange) return;
    const duplicated = clonePresentationSlide(slide, () => crypto.randomUUID()).slide;
    duplicated.title = `${slide.title} ${t.copySuffix}`;
    const index = snapshot.slides.indexOf(slide) + 1;
    emit(addSlideCommand(snapshot.artifactId, baseVersion, index, duplicated));
    setSlideId(duplicated.id);
    setSelectedObjectIds([]);
  }

  async function deleteCurrentSlide() {
    if (!canChange || snapshot.slides.length === 1) return;
    const confirmed = await confirmDialog({ title: t.deleteSlide, description: t.deleteSlideDescription.replace("{slide}", slide.title), confirmLabel: t.deleteSlide, cancelLabel: t.cancelWorksheetAction, variant: "destructive" });
    if (!confirmed) return;
    const index = snapshot.slides.indexOf(slide);
    const next = snapshot.slides[Math.min(index + 1, snapshot.slides.length - 1)] ?? snapshot.slides[Math.max(0, index - 1)];
    emit(deleteSlideCommand(snapshot.artifactId, baseVersion, slide.id));
    if (next.id !== slide.id) setSlideId(next.id);
    setSelectedObjectIds([]);
  }

  function deleteSelectedObjects() {
    if (selectionHasLocked) return;
    const commands = selectedObjects.map((object) => deleteCommand(snapshot.artifactId, baseVersion, object.id));
    if (commands.length) emit(commands.length === 1 ? commands[0] : batchCommand(snapshot.artifactId, baseVersion, commands));
    setSelectedObjectIds([]);
  }

  async function copy(cut: boolean) {
    if (selectedObjects.length) {
      await writePresentationClipboard({ version: 1, artifactId: snapshot.artifactId, scope: "objects", sourceSlideId: slide.id, objects: selectedObjects });
      if (cut && canChange) deleteSelectedObjects();
      return;
    }
    await writePresentationClipboard({ version: 1, artifactId: snapshot.artifactId, scope: "slides", slides: [slide] });
    if (cut) await deleteCurrentSlide();
  }

  async function paste() {
    if (!canChange) return;
    const payload = await readPresentationClipboard(snapshot.artifactId);
    if (!payload) return;
    if (payload.scope === "slides") {
      let index = snapshot.slides.indexOf(slide) + 1;
      const commands = payload.slides.map((source) => addSlideCommand(snapshot.artifactId, baseVersion, index++, clonePresentationSlide(source, () => crypto.randomUUID()).slide));
      emit(commands.length === 1 ? commands[0] : batchCommand(snapshot.artifactId, baseVersion, commands));
      setSlideId((commands[0] as Extract<OfficeCommand, { kind: "addSlide" }>).slide.id);
      return;
    }
    const cloned = clonePresentationObjects(payload.objects, () => crypto.randomUUID());
    const commands = cloned.objects.map((object, index) => insertSlideObjectCommand(snapshot.artifactId, baseVersion, slide.id, slide.objects.length + index, object));
    emit(commands.length === 1 ? commands[0] : batchCommand(snapshot.artifactId, baseVersion, commands));
    setSelectedObjectIds(cloned.objects.map((object) => object.id));
  }

  function updateSelectedGeometry(path: string[], value: unknown) {
    if (!selectedForToolbar || path[0] !== "geometry" || typeof value !== "number") return;
    const key = path[1] as keyof Geometry;
    const geometry = { ...selectedForToolbar.geometry, [key]: value };
    setGeometryPreview(new Map([[selectedForToolbar.id, geometry]]));
    emit(propertyCommand(snapshot.artifactId, baseVersion, selectedForToolbar.id, path, value));
  }

  function previewSelection(targetId: string, geometry: Geometry | null) {
    if (!geometry) { setGeometryPreview(new Map()); setSnapGuides([]); return; }
    const target = slide.objects.find((object) => object.id === targetId);
    if (!target || selectionHasLocked && selectedObjectIds.includes(targetId)) return;
    const selected = selectedObjectIds.includes(targetId) ? selectedObjects : [target];
    const deltaX = geometry.xPt - target.geometry.xPt;
    const deltaY = geometry.yPt - target.geometry.yPt;
    setGeometryPreview(new Map(selected.map((object) => [object.id, object.id === targetId ? geometry : { ...object.geometry, xPt: object.geometry.xPt + deltaX, yPt: object.geometry.yPt + deltaY }])));
  }

  function commitSelectionGeometry(targetId: string, geometry: Geometry) {
    const target = slide.objects.find((object) => object.id === targetId);
    if (!target || selectionHasLocked && selectedObjectIds.includes(targetId)) return;
    const objects = selectedObjectIds.includes(targetId) ? selectedObjects : [target];
    const deltaX = geometry.xPt - target.geometry.xPt;
    const deltaY = geometry.yPt - target.geometry.yPt;
    const commands = objects.map((object) => propertyCommand(snapshot.artifactId, baseVersion, object.id, ["geometry"], object.id === targetId ? geometry : { ...object.geometry, xPt: object.geometry.xPt + deltaX, yPt: object.geometry.yPt + deltaY }));
    emit(commands.length === 1 ? commands[0] : batchCommand(snapshot.artifactId, baseVersion, commands));
    setGeometryPreview(new Map());
    setSnapGuides([]);
  }

  function previewSingleGeometry(targetId: string, geometry: Geometry | null) {
    setGeometryPreview(geometry ? new Map([[targetId, geometry]]) : new Map());
    if (!geometry) setSnapGuides([]);
  }

  function arrange(operation: Parameters<typeof arrangePresentationObjects>[1]) {
    if (selectionHasLocked) return;
    const arranged = arrangePresentationObjects(selectedObjects, operation, snapshot.slideSize);
    const commands = arranged.filter((object, index) => JSON.stringify(object.geometry) !== JSON.stringify(selectedObjects[index].geometry)).map((object) => propertyCommand(snapshot.artifactId, baseVersion, object.id, ["geometry"], object.geometry));
    if (commands.length) emit(commands.length === 1 ? commands[0] : batchCommand(snapshot.artifactId, baseVersion, commands));
  }

  function reorderObject(operation: "bringForward" | "bringToFront" | "sendBackward" | "sendToBack") {
    if (!selectedObjects.length || selectionHasLocked) return;
    const currentIds = slide.objects.map((object) => object.id);
    const targetIds = reorderedPresentationObjectIds(currentIds, selectedObjectIds, operation);
    const working = [...currentIds];
    const commands: OfficeCommand[] = [];
    targetIds.forEach((objectId, index) => {
      const from = working.indexOf(objectId);
      if (from === index) return;
      commands.push(reorderSlideObjectCommand(snapshot.artifactId, baseVersion, slide.id, objectId, index));
      working.splice(from, 1);
      working.splice(index, 0, objectId);
    });
    if (commands.length) emit(commands.length === 1 ? commands[0] : batchCommand(snapshot.artifactId, baseVersion, commands));
  }

  function marqueePoint(event: ReactPointerEvent<HTMLDivElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: (event.clientX - rect.left) / rect.width * snapshot.slideSize.widthPt, y: (event.clientY - rect.top) / rect.height * snapshot.slideSize.heightPt };
  }

  function startMarquee(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.currentTarget !== event.target || event.button !== 0) return;
    const point = marqueePoint(event);
    const baseIds = event.shiftKey ? selectedObjectIds : [];
    setSelectedObjectIds(baseIds);
    setMarquee({ startX: point.x, startY: point.y, x: point.x, y: point.y, width: 0, height: 0, baseIds });
    event.currentTarget.setPointerCapture?.(event.pointerId);
  }

  function updateMarquee(event: ReactPointerEvent<HTMLDivElement>) {
    if (!marquee) return;
    const point = marqueePoint(event);
    const next = { ...marquee, x: Math.min(marquee.startX, point.x), y: Math.min(marquee.startY, point.y), width: Math.abs(point.x - marquee.startX), height: Math.abs(point.y - marquee.startY) };
    setMarquee(next);
    const intersecting = objectsIntersectingPresentationMarquee(slide.objects, { xPt: next.x, yPt: next.y, widthPt: next.width, heightPt: next.height });
    setSelectedObjectIds([...new Set([...marquee.baseIds, ...intersecting])]);
  }

  function finishMarquee(event: ReactPointerEvent<HTMLDivElement>) {
    if (!marquee) return;
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    setMarquee(null);
  }

  function hoverSlide(index: number) {
    if (!dragSlideId) return;
    setDragSlideIndex(index);
  }

  function finishSlideDrag() {
    if (dragSlideId && dragSlideIndex !== null) emit(reorderSlideCommand(snapshot.artifactId, baseVersion, dragSlideId, dragSlideIndex));
    setDragSlideId(null);
    setDragSlideIndex(null);
  }

  return (
    <div ref={rootRef} className="grid min-h-0 flex-1 grid-cols-[6.5rem_minmax(0,1fr)] lg:grid-cols-[10rem_minmax(0,1fr)]" data-office-editor="presentation" data-properties-open={primary ? "true" : "false"} tabIndex={-1}>
      <nav ref={railRef} className="overflow-y-auto border-r bg-muted/30 p-2" aria-label={t.slideRail} onPointerMove={(event) => { if (!dragSlideId || !railRef.current) return; const rect = railRef.current.getBoundingClientRect(); if (event.clientY < rect.top + 32) railRef.current.scrollTop -= 16; if (event.clientY > rect.bottom - 32) railRef.current.scrollTop += 16; }} onPointerUp={finishSlideDrag}>
        {snapshot.slides.map((item, index) => <div key={item.id} data-slide-thumbnail="true" data-slide-insertion={dragSlideIndex === index ? "before" : undefined} style={{ aspectRatio: slideAspectRatio }} className={cn("relative mb-2 w-full overflow-hidden rounded border bg-white text-slate-900", item.id === slide.id && "ring-2 ring-primary", dragSlideIndex === index && "border-t-4 border-t-primary")} onPointerEnter={() => hoverSlide(index)}>
          <PresentationSlideVisual artifactId={snapshot.artifactId} slide={item} slideSize={snapshot.slideSize} className="pointer-events-none h-full w-full" />
          <span aria-hidden className="absolute left-1 top-1 z-20 rounded bg-background/80 px-1 text-[9px] leading-4 text-foreground shadow-sm">{index + 1}</span>
          <button type="button" aria-label={`${index + 1}: ${item.title}`} onPointerDown={(event) => { if (event.button !== 0) return; selectSlide(item.id); setDragSlideId(item.id); setDragSlideIndex(index); event.currentTarget.setPointerCapture?.(event.pointerId); }} onPointerUp={finishSlideDrag} className="absolute inset-0 z-30"><span className="sr-only">{item.title}</span></button>
        </div>)}
        <button type="button" onClick={addSlide} disabled={!canChange} className="flex w-full items-center justify-center gap-1 rounded border border-dashed p-2 text-xs disabled:opacity-40"><Plus className="size-3" />{t.newSlide}</button>
      </nav>
      <div className="flex min-h-0 flex-col overflow-auto bg-muted/40">
        <div className="flex flex-wrap items-center gap-1 border-b bg-background p-2" role="toolbar" aria-label={t.editorToolbar}>
          <button type="button" onClick={addText} disabled={!canChange} className="inline-flex items-center gap-1 rounded px-2 py-1.5 text-xs hover:bg-muted disabled:opacity-40"><Type className="size-4" />{t.addText}</button>
          <button type="button" onClick={addShape} disabled={!canChange} className="inline-flex items-center gap-1 rounded px-2 py-1.5 text-xs hover:bg-muted disabled:opacity-40"><Shapes className="size-4" />{t.addShape}</button>
          <button type="button" aria-label={t.moveSlideUp} disabled={!canChange || snapshot.slides.indexOf(slide) === 0} onClick={() => emit(reorderSlideCommand(snapshot.artifactId, baseVersion, slide.id, Math.max(0, snapshot.slides.indexOf(slide) - 1)))} className="rounded p-2 disabled:opacity-30"><ChevronUp className="size-4" /></button>
          <button type="button" aria-label={t.moveSlideDown} disabled={!canChange || snapshot.slides.indexOf(slide) === snapshot.slides.length - 1} onClick={() => emit(reorderSlideCommand(snapshot.artifactId, baseVersion, slide.id, snapshot.slides.indexOf(slide) + 1))} className="rounded p-2 disabled:opacity-30"><ChevronDown className="size-4" /></button>
          <button type="button" onClick={duplicateSlide} disabled={!canChange} className="inline-flex items-center gap-1 rounded px-2 py-1.5 text-xs hover:bg-muted disabled:opacity-40"><Copy className="size-3.5" />{t.duplicateSlide}</button>
          <button type="button" onClick={() => void deleteCurrentSlide()} disabled={!canChange || snapshot.slides.length === 1} title={snapshot.slides.length === 1 ? t.cannotDeleteFinalSlide : undefined} className="rounded p-2 text-destructive hover:bg-destructive/10 disabled:opacity-30" aria-label={t.deleteSlide}><Trash2 className="size-4" /></button>
          {selectedObjects.length ? <DropdownMenu><DropdownMenuTrigger render={<button type="button" className="inline-flex items-center gap-1 rounded px-2 py-1.5 text-xs hover:bg-muted"><MoreHorizontal className="size-4" />{t.arrange}</button>} /><DropdownMenuContent align="start">
            <DropdownMenuItem disabled={selectionHasLocked} onClick={() => reorderObject("bringToFront")}>{t.bringToFront}</DropdownMenuItem><DropdownMenuItem disabled={selectionHasLocked} onClick={() => reorderObject("bringForward")}>{t.bringForward}</DropdownMenuItem><DropdownMenuItem disabled={selectionHasLocked} onClick={() => reorderObject("sendBackward")}>{t.sendBackward}</DropdownMenuItem><DropdownMenuItem disabled={selectionHasLocked} onClick={() => reorderObject("sendToBack")}>{t.sendToBack}</DropdownMenuItem><DropdownMenuSeparator />
            {(["alignLeft", "alignCenter", "alignRight", "alignTop", "alignMiddle", "alignBottom", "distributeHorizontal", "distributeVertical", "centerOnSlide"] as const).map((operation) => <DropdownMenuItem key={operation} disabled={selectionHasLocked || operation.startsWith("distribute") && selectedObjects.length < 3} onClick={() => arrange(operation)}>{t[operation]}</DropdownMenuItem>)}
          </DropdownMenuContent></DropdownMenu> : null}
          <span className="ml-auto text-xs text-muted-foreground" aria-live="polite">{selectedObjects.length ? t.objectsSelected.replace("{count}", String(selectedObjects.length)) : t.slideSelected.replace("{slide}", slide.title)}</span>
          {suggestMode ? <span className="rounded-full bg-amber-100 px-2 py-1 text-xs text-amber-900">{t.suggesting}</span> : null}
        </div>
        {selectedForToolbar ? <PresentationGeometryToolbar object={selectedForToolbar} disabled={!canChange || selectionHasLocked} onProperty={updateSelectedGeometry} onDelete={deleteSelectedObjects} /> : null}
        <div className="flex flex-1 items-center justify-center p-4 lg:p-8">
          <div data-slide-canvas="true" data-slide-preview-canvas="true" className="relative w-full max-w-5xl overflow-hidden bg-white text-slate-950 shadow" style={{ aspectRatio: slideAspectRatio, containerType: "inline-size" }} onPointerDown={startMarquee} onPointerMove={updateMarquee} onPointerUp={finishMarquee}>
            {slide.objects.map((object) => <PresentationObjectFrame key={object.id} artifactId={snapshot.artifactId} object={object} externalGeometry={geometryPreview.get(object.id)} selected={selectedObjectIds.includes(object.id)} primary={primary?.id === object.id} canChange={canChange && !selectionHasLocked} slideSize={snapshot.slideSize} otherObjects={slide.objects.filter((candidate) => !selectedObjectIds.includes(candidate.id))} onSelect={(additive) => selectObject(object.id, additive)} onText={(targetId, runs) => emit(textCommand(snapshot.artifactId, baseVersion, targetId, runs))} onGeometryPreview={previewSingleGeometry} onGeometry={(targetId, geometry) => emit(propertyCommand(snapshot.artifactId, baseVersion, targetId, ["geometry"], geometry))} onMovePreview={previewSelection} onMove={commitSelectionGeometry} onSnapGuides={setSnapGuides} />)}
            {marquee ? <div data-selection-marquee="true" className="pointer-events-none absolute border border-primary bg-primary/10" style={{ left: `${marquee.x / snapshot.slideSize.widthPt * 100}%`, top: `${marquee.y / snapshot.slideSize.heightPt * 100}%`, width: `${marquee.width / snapshot.slideSize.widthPt * 100}%`, height: `${marquee.height / snapshot.slideSize.heightPt * 100}%` }} /> : null}
            {snapGuides.map((guide, index) => <span key={`${guide.axis}-${guide.positionPt}-${index}`} data-snap-guide={guide.source} className="pointer-events-none absolute z-50 bg-fuchsia-500" style={guide.axis === "x" ? { left: `${guide.positionPt / snapshot.slideSize.widthPt * 100}%`, top: 0, width: 1, height: "100%" } : { top: `${guide.positionPt / snapshot.slideSize.heightPt * 100}%`, left: 0, height: 1, width: "100%" }} />)}
          </div>
        </div>
        <label className="border-t bg-background p-3 text-xs font-medium">{t.speakerNotes}<textarea disabled={!canChange} value={slide.notes.map((run) => run.text).join("")} onChange={(event) => emit(propertyCommand(snapshot.artifactId, baseVersion, slide.id, ["notes"], runsWithText(slide.notes, event.target.value)))} className="mt-1 min-h-16 w-full resize-y rounded border p-2 font-normal" /></label>
      </div>
    </div>
  );
}

function runsWithText(runs: OfficeRichTextRun[], text: string): OfficeRichTextRun[] { return runs.length ? [{ ...runs[0], text }] : [defaultRun(text)]; }

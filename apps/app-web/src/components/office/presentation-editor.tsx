"use client";

/** Adaptive slide and multi-object editing over canonical commands. [COMP:app-web/office-presentation-editor] */
import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { ChevronDown, ChevronUp, Copy, ImagePlus, MoreHorizontal, Plus, Shapes, Table2, Trash2, Type, ChartColumn, Workflow } from "lucide-react";
import {
  arrangePresentationObjects,
  clonePresentationObjects,
  clonePresentationSlide,
  formatPresentationTextObject,
  type OfficeCommand,
  type OfficeRichTextRun,
  type PresentationObject,
  type PresentationSnapGuide,
  type PresentationSnapshot,
  type PresentationTextFormatting,
} from "@use-brian/office-model";
import {
  addSlideCommand,
  attachResourceCommand,
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
import { Checkbox } from "@/components/ui/checkbox";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useT } from "@/lib/i18n/client";
import { admitOfficeImageResource } from "@/lib/office/api";
import { cn } from "@/lib/utils";
import { PresentationGeometryToolbar, PresentationObjectFrame } from "./presentation-object-frame";
import { PresentationFormattingToolbar } from "./presentation-formatting-toolbar";
import { PresentationDataDialog } from "./presentation-data-dialog";
import { PresentationSlideVisual } from "./presentation-slide-visual";

type Geometry = PresentationObject["geometry"];
type Marquee = { startX: number; startY: number; x: number; y: number; width: number; height: number; baseIds: string[] };
type RailResize = { pointerId: number; startX: number; startWidth: number };

const PRESENTATION_SLIDE_RAIL_MIN_WIDTH = 112;
const PRESENTATION_SLIDE_RAIL_DEFAULT_WIDTH = 160;
const PRESENTATION_SLIDE_RAIL_MAX_WIDTH = 360;
const PRESENTATION_SLIDE_RAIL_KEYBOARD_STEP = 16;

function clampPresentationSlideRailWidth(width: number): number {
  return Math.max(PRESENTATION_SLIDE_RAIL_MIN_WIDTH, Math.min(PRESENTATION_SLIDE_RAIL_MAX_WIDTH, Math.round(width)));
}

function presentationSlideDropIndex(clientY: number, bounds: Array<{ top: number; height: number }>): number {
  if (!bounds.length) return 0;
  let nearest = 0;
  let distance = Number.POSITIVE_INFINITY;
  bounds.forEach((bound, index) => {
    const candidate = Math.abs(clientY - (bound.top + bound.height / 2));
    if (candidate < distance) { distance = candidate; nearest = index; }
  });
  return nearest;
}

function commandTargetIsTextInput(target: EventTarget | null): boolean {
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLElement && target.isContentEditable;
}

export function PresentationEditor({ snapshot, baseVersion, role, suggestMode, onCommand, onSelectTargets }: { snapshot: PresentationSnapshot; baseVersion: number; role: "view" | "comment" | "edit"; suggestMode: boolean; onCommand(command: OfficeCommand): void; onSelectTargets?(ids: string[]): void }) {
  const t = useT().office;
  const canChange = role === "edit" || role === "comment" && suggestMode;
  const rootRef = useRef<HTMLDivElement | null>(null);
  const railRef = useRef<HTMLElement | null>(null);
  const railResizeRef = useRef<RailResize | null>(null);
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const [slideId, setSlideId] = useState(snapshot.slides[0].id);
  const [selectedSlideIds, setSelectedSlideIds] = useState<string[]>([snapshot.slides[0].id]);
  const [selectedObjectIds, setSelectedObjectIds] = useState<string[]>([]);
  const [geometryPreview, setGeometryPreview] = useState<Map<string, Geometry>>(new Map());
  const [snapGuides, setSnapGuides] = useState<PresentationSnapGuide[]>([]);
  const [marquee, setMarquee] = useState<Marquee | null>(null);
  const [dragSlideId, setDragSlideId] = useState<string | null>(null);
  const [dragSlideIndex, setDragSlideIndex] = useState<number | null>(null);
  const [railWidth, setRailWidth] = useState(PRESENTATION_SLIDE_RAIL_DEFAULT_WIDTH);
  const [railResizing, setRailResizing] = useState(false);
  const [dataDialog, setDataDialog] = useState<"table" | "chart" | null>(null);
  const [imageBusy, setImageBusy] = useState(false);
  const [imageError, setImageError] = useState("");
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
    const live = new Set(snapshot.slides.map((item) => item.id));
    setSelectedSlideIds((current) => {
      const repaired = current.filter((id) => live.has(id));
      return repaired.length ? repaired : [slide.id];
    });
    if (!live.has(slideId)) setSlideId(snapshot.slides[0].id);
  }, [slide.id, slideId, snapshot.slides]);

  useEffect(() => {
    onSelectTargets?.(selectedObjectIds.length ? selectedObjectIds : selectedSlideIds.length ? selectedSlideIds : [slide.id]);
  }, [onSelectTargets, selectedObjectIds, selectedSlideIds, slide.id]);

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
        else void deleteSelectedSlides();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  function selectSlide(nextSlideId: string, additive = false) {
    setSlideId(nextSlideId);
    setSelectedSlideIds((current) => additive
      ? current.includes(nextSlideId) ? current.length === 1 ? current : current.filter((id) => id !== nextSlideId) : [...current, nextSlideId]
      : [nextSlideId]);
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

  function addShape(shape: Extract<PresentationObject, { kind: "shape" }>["shape"]) {
    const object: PresentationObject = { id: crypto.randomUUID(), kind: "shape", geometry: { xPt: 90, yPt: 110, widthPt: 180, heightPt: 90, rotationDeg: 0 }, locked: false, shape, fill: shape === "line" ? undefined : "#E2E8F0", stroke: "#64748B", strokeWidthPt: 1, text: [], altText: "" };
    emit(insertSlideObjectCommand(snapshot.artifactId, baseVersion, slide.id, slide.objects.length, object));
    setSelectedObjectIds([object.id]);
  }

  function addConnector(connector: "straight" | "elbow") {
    const object: PresentationObject = { id: crypto.randomUUID(), kind: "connector", geometry: { xPt: 120, yPt: 180, widthPt: 240, heightPt: 100, rotationDeg: 0 }, locked: false, connector, stroke: "#334155" };
    emit(insertSlideObjectCommand(snapshot.artifactId, baseVersion, slide.id, slide.objects.length, object));
    setSelectedObjectIds([object.id]);
  }

  async function addImage(file: File) {
    if (!canChange || imageBusy) return;
    setImageBusy(true); setImageError("");
    try {
      const admitted = await admitOfficeImageResource(snapshot.artifactId, snapshot.workspaceId, file);
      const maxWidth = snapshot.slideSize.widthPt * 0.6;
      const maxHeight = snapshot.slideSize.heightPt * 0.6;
      const scale = Math.min(maxWidth / admitted.widthPx, maxHeight / admitted.heightPx);
      const widthPt = admitted.widthPx * scale;
      const heightPt = admitted.heightPx * scale;
      const object: PresentationObject = { id: crypto.randomUUID(), kind: "image", geometry: { xPt: (snapshot.slideSize.widthPt - widthPt) / 2, yPt: (snapshot.slideSize.heightPt - heightPt) / 2, widthPt, heightPt, rotationDeg: 0 }, locked: false, resourceId: admitted.resource.id, altText: "", decorative: true };
      emit(batchCommand(snapshot.artifactId, baseVersion, [attachResourceCommand(snapshot.artifactId, baseVersion, admitted.resource), insertSlideObjectCommand(snapshot.artifactId, baseVersion, slide.id, slide.objects.length, object)]));
      setSelectedObjectIds([object.id]);
    } catch { setImageError(t.presentationImageAdmissionFailed); }
    finally { setImageBusy(false); if (imageInputRef.current) imageInputRef.current.value = ""; }
  }

  function moveReadingOrder(delta: -1 | 1) {
    if (selectedObjects.length !== 1 || selectionHasLocked) return;
    const index = slide.readingOrder.indexOf(selectedObjects[0].id);
    const next = Math.max(0, Math.min(slide.readingOrder.length - 1, index + delta));
    if (index === next) return;
    const readingOrder = [...slide.readingOrder];
    const [id] = readingOrder.splice(index, 1); readingOrder.splice(next, 0, id);
    emit(propertyCommand(snapshot.artifactId, baseVersion, slide.id, ["readingOrder"], readingOrder));
  }

  function readingOrderDisabledReason(delta: -1 | 1): string | undefined {
    if (selectedObjects.length !== 1) return t.readingOrderSingleSelection;
    if (selectionHasLocked) return t.readingOrderLocked;
    const index = slide.readingOrder.indexOf(selectedObjects[0].id);
    if (delta < 0 && index <= 0) return t.readingOrderFirst;
    if (delta > 0 && index >= slide.readingOrder.length - 1) return t.readingOrderLast;
    return undefined;
  }

  function updateAccessibility(path: "altText" | "decorative", value: string | boolean) {
    if (selectedObjects.length !== 1 || selectionHasLocked) return;
    const object = selectedObjects[0];
    if (path === "altText" && typeof value === "string" && !value.trim() && (object.kind === "chart" || object.kind === "image" && !object.decorative)) return;
    if (object.kind === "image" && path === "decorative" && value === false && !object.altText.trim()) return;
    const commands: OfficeCommand[] = [propertyCommand(snapshot.artifactId, baseVersion, object.id, [path], value)];
    if (object.kind === "image" && path === "decorative" && value === true) commands.push(propertyCommand(snapshot.artifactId, baseVersion, object.id, ["altText"], ""));
    emit(commands.length === 1 ? commands[0] : batchCommand(snapshot.artifactId, baseVersion, commands));
  }

  function applyDataObject(object: PresentationObject) {
    const previous = slide.objects.find((candidate) => candidate.id === object.id);
    if (previous && object.kind === "table") {
      const commands = [propertyCommand(snapshot.artifactId, baseVersion, previous.id, ["rows"], object.rows), propertyCommand(snapshot.artifactId, baseVersion, previous.id, ["columnWidthsPt"], object.columnWidthsPt)];
      emit(batchCommand(snapshot.artifactId, baseVersion, commands));
    }
    else if (previous && object.kind === "chart") {
      const commands = (["chartType", "title", "categories", "series", "altText"] as const).map((key) => propertyCommand(snapshot.artifactId, baseVersion, previous.id, [key], object[key]));
      emit(batchCommand(snapshot.artifactId, baseVersion, commands));
    } else emit(insertSlideObjectCommand(snapshot.artifactId, baseVersion, slide.id, slide.objects.length, object));
    setSelectedObjectIds([object.id]);
  }

  function formatSelectedText(formatting: PresentationTextFormatting) {
    if (!selectedObjects.length || selectionHasLocked) return;
    const commands = selectedObjects.map((object) => {
      const next = formatPresentationTextObject(object, formatting);
      const path = next.kind === "text" ? ["runs"] : ["text"];
      const values = next.kind === "text" ? next.runs : next.kind === "shape" ? next.text : [];
      const parts: OfficeCommand[] = [propertyCommand(snapshot.artifactId, baseVersion, next.id, path, values)];
      if (formatting.alignment !== undefined) parts.push(propertyCommand(snapshot.artifactId, baseVersion, next.id, ["alignment"], formatting.alignment));
      if (formatting.verticalAlignment !== undefined) parts.push(propertyCommand(snapshot.artifactId, baseVersion, next.id, ["verticalAlignment"], formatting.verticalAlignment));
      return parts;
    }).flat();
    emit(commands.length === 1 ? commands[0] : batchCommand(snapshot.artifactId, baseVersion, commands));
  }

  function formatSelectedProperty(path: string[], value: unknown) {
    if (!selectedObjects.length || selectionHasLocked) return;
    const commands = selectedObjects.map((object) => propertyCommand(snapshot.artifactId, baseVersion, object.id, path, value));
    emit(commands.length === 1 ? commands[0] : batchCommand(snapshot.artifactId, baseVersion, commands));
  }

  function addSlide() {
    const newId = crypto.randomUUID();
    emit(addSlideCommand(snapshot.artifactId, baseVersion, snapshot.slides.length, { id: newId, title: t.newSlide, masterId: snapshot.masters[0].id, layoutId: snapshot.layouts[0].id, objects: [], readingOrder: [], notes: [] }));
    setSlideId(newId);
    setSelectedSlideIds([newId]);
    setSelectedObjectIds([]);
  }

  function duplicateSlide() {
    if (!canChange) return;
    const duplicated = clonePresentationSlide(slide, () => crypto.randomUUID()).slide;
    duplicated.title = `${slide.title} ${t.copySuffix}`;
    const index = snapshot.slides.indexOf(slide) + 1;
    emit(addSlideCommand(snapshot.artifactId, baseVersion, index, duplicated));
    setSlideId(duplicated.id);
    setSelectedSlideIds([duplicated.id]);
    setSelectedObjectIds([]);
  }

  async function deleteSelectedSlides() {
    const selected = snapshot.slides.filter((item) => selectedSlideIds.includes(item.id));
    if (!canChange || !selected.length || selected.length >= snapshot.slides.length) return;
    const confirmed = await confirmDialog({ title: t.deleteSlide, description: t.deleteSlideDescription.replace("{slide}", slide.title), confirmLabel: t.deleteSlide, cancelLabel: t.cancelWorksheetAction, variant: "destructive" });
    if (!confirmed) return;
    const index = snapshot.slides.indexOf(slide);
    const selectedSet = new Set(selected.map((item) => item.id));
    const survivors = snapshot.slides.filter((item) => !selectedSet.has(item.id));
    const next = survivors.find((item) => snapshot.slides.indexOf(item) >= index) ?? survivors.at(-1)!;
    const commands = selected.map((item) => deleteSlideCommand(snapshot.artifactId, baseVersion, item.id));
    emit(commands.length === 1 ? commands[0] : batchCommand(snapshot.artifactId, baseVersion, commands));
    setSlideId(next.id);
    setSelectedSlideIds([next.id]);
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
    const slides = snapshot.slides.filter((item) => selectedSlideIds.includes(item.id));
    await writePresentationClipboard({ version: 1, artifactId: snapshot.artifactId, scope: "slides", slides: slides.length ? slides : [slide] });
    if (cut) await deleteSelectedSlides();
  }

  async function paste() {
    if (!canChange) return;
    const payload = await readPresentationClipboard(snapshot.artifactId);
    if (!payload) return;
    if (payload.scope === "slides") {
      let index = snapshot.slides.indexOf(slide) + 1;
      const commands = payload.slides.map((source) => addSlideCommand(snapshot.artifactId, baseVersion, index++, clonePresentationSlide(source, () => crypto.randomUUID()).slide));
      emit(commands.length === 1 ? commands[0] : batchCommand(snapshot.artifactId, baseVersion, commands));
      const pastedIds = commands.map((command) => (command as Extract<OfficeCommand, { kind: "addSlide" }>).slide.id);
      setSlideId(pastedIds[0]);
      setSelectedSlideIds(pastedIds);
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
    if (commands.length) emit(selectedObjects.length > 1 ? batchCommand(snapshot.artifactId, baseVersion, commands) : commands[0]);
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
    if (commands.length) emit(selectedObjects.length > 1 ? batchCommand(snapshot.artifactId, baseVersion, commands) : commands[0]);
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

  function updateSlideDrag(event: ReactPointerEvent<HTMLElement>) {
    if (!dragSlideId || !railRef.current) return;
    const thumbnails = [...railRef.current.querySelectorAll<HTMLElement>("[data-slide-thumbnail]")];
    setDragSlideIndex(presentationSlideDropIndex(event.clientY, thumbnails.map((thumbnail) => {
      const rect = thumbnail.getBoundingClientRect();
      return { top: rect.top, height: rect.height };
    })));
    const rect = railRef.current.getBoundingClientRect();
    if (event.clientY < rect.top + 32) railRef.current.scrollTop -= 16;
    if (event.clientY > rect.bottom - 32) railRef.current.scrollTop += 16;
  }

  function finishSlideDrag(event: ReactPointerEvent<HTMLElement>) {
    const sourceIndex = dragSlideId ? snapshot.slides.findIndex((item) => item.id === dragSlideId) : -1;
    if (dragSlideId && dragSlideIndex !== null && sourceIndex >= 0 && sourceIndex !== dragSlideIndex) emit(reorderSlideCommand(snapshot.artifactId, baseVersion, dragSlideId, dragSlideIndex));
    const captureTarget = event.target as HTMLElement;
    if (captureTarget.hasPointerCapture?.(event.pointerId)) captureTarget.releasePointerCapture?.(event.pointerId);
    setDragSlideId(null);
    setDragSlideIndex(null);
  }

  function cancelSlideDrag() {
    setDragSlideId(null);
    setDragSlideIndex(null);
  }

  function startRailResize(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    railResizeRef.current = { pointerId: event.pointerId, startX: event.clientX, startWidth: railWidth };
    setRailResizing(true);
    event.currentTarget.setPointerCapture?.(event.pointerId);
    event.preventDefault();
  }

  function updateRailResize(event: ReactPointerEvent<HTMLDivElement>) {
    const resize = railResizeRef.current;
    if (!resize || resize.pointerId !== event.pointerId) return;
    setRailWidth(clampPresentationSlideRailWidth(resize.startWidth + event.clientX - resize.startX));
  }

  function finishRailResize(event: ReactPointerEvent<HTMLDivElement>) {
    const resize = railResizeRef.current;
    if (!resize || resize.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture?.(event.pointerId);
    railResizeRef.current = null;
    setRailResizing(false);
  }

  function resizeRailByKeyboard(event: ReactKeyboardEvent<HTMLDivElement>) {
    let next: number | null = null;
    if (event.key === "ArrowLeft") next = railWidth - PRESENTATION_SLIDE_RAIL_KEYBOARD_STEP;
    if (event.key === "ArrowRight") next = railWidth + PRESENTATION_SLIDE_RAIL_KEYBOARD_STEP;
    if (event.key === "Home") next = PRESENTATION_SLIDE_RAIL_MIN_WIDTH;
    if (event.key === "End") next = PRESENTATION_SLIDE_RAIL_MAX_WIDTH;
    if (next === null) return;
    event.preventDefault();
    setRailWidth(clampPresentationSlideRailWidth(next));
  }

  return (
    <div ref={rootRef} className={cn("grid min-h-0 flex-1 grid-cols-[6.5rem_0_minmax(0,1fr)] md:grid-cols-[var(--presentation-slide-rail-width)_0.5rem_minmax(0,1fr)]", railResizing && "select-none")} style={{ "--presentation-slide-rail-width": `${railWidth}px` } as CSSProperties} data-office-editor="presentation" data-properties-open={primary ? "true" : "false"} tabIndex={-1}>
      <nav ref={railRef} data-slide-rail="true" className="overflow-y-auto border-r bg-muted/30 p-2 md:border-r-0" aria-label={t.slideRail} onPointerMove={updateSlideDrag} onPointerUp={finishSlideDrag} onPointerCancel={cancelSlideDrag}>
        {snapshot.slides.map((item, index) => {
          const sourceIndex = dragSlideId ? snapshot.slides.findIndex((candidate) => candidate.id === dragSlideId) : -1;
          const insertion = dragSlideIndex === index && sourceIndex !== index ? index < sourceIndex ? "before" : "after" : undefined;
          return <div key={item.id} data-slide-thumbnail="true" data-slide-index={index} data-slide-insertion={insertion} data-slide-dragging={dragSlideId === item.id ? "true" : undefined} style={{ aspectRatio: slideAspectRatio }} className={cn("relative mb-2 w-full overflow-hidden rounded border bg-white text-slate-900 transition-opacity", selectedSlideIds.includes(item.id) && "ring-2 ring-primary", dragSlideId === item.id && "opacity-55")}>
          <PresentationSlideVisual artifactId={snapshot.artifactId} slide={item} slideSize={snapshot.slideSize} className="pointer-events-none h-full w-full" />
          <span aria-hidden className="absolute left-1 top-1 z-20 rounded bg-background/80 px-1 text-[9px] leading-4 text-foreground shadow-sm">{index + 1}</span>
          {insertion ? <span aria-hidden data-slide-drop-indicator={insertion} className={cn("pointer-events-none absolute inset-x-0 z-40 h-1 bg-primary shadow-[0_0_0_1px_hsl(var(--background))]", insertion === "before" ? "top-0" : "bottom-0")} /> : null}
          <button type="button" aria-label={`${index + 1}: ${item.title}`} aria-pressed={selectedSlideIds.includes(item.id)} onPointerDown={(event) => { if (event.button !== 0) return; selectSlide(item.id, event.shiftKey); if (!event.shiftKey) { setDragSlideId(item.id); setDragSlideIndex(index); event.currentTarget.setPointerCapture?.(event.pointerId); event.preventDefault(); } }} className="absolute inset-0 z-30 cursor-grab touch-none active:cursor-grabbing"><span className="sr-only">{item.title}</span></button>
        </div>;
        })}
        <button type="button" onClick={addSlide} disabled={!canChange} className="flex w-full items-center justify-center gap-1 rounded border border-dashed p-2 text-xs disabled:opacity-40"><Plus className="size-3" />{t.newSlide}</button>
      </nav>
      <div role="separator" aria-label={t.resizeSlideRail} title={t.resizeSlideRail} aria-orientation="vertical" aria-valuemin={PRESENTATION_SLIDE_RAIL_MIN_WIDTH} aria-valuemax={PRESENTATION_SLIDE_RAIL_MAX_WIDTH} aria-valuenow={railWidth} tabIndex={0} data-slide-rail-resizer="true" data-resizing={railResizing ? "true" : "false"} onPointerDown={startRailResize} onPointerMove={updateRailResize} onPointerUp={finishRailResize} onPointerCancel={finishRailResize} onKeyDown={resizeRailByKeyboard} className="group hidden cursor-col-resize touch-none items-center justify-center border-r bg-muted/20 outline-none hover:bg-primary/10 focus-visible:bg-primary/10 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary md:flex">
        <span aria-hidden className="h-12 w-0.5 rounded-full bg-border transition-colors group-hover:bg-primary group-focus-visible:bg-primary" />
      </div>
      <div className="flex min-h-0 flex-col overflow-auto bg-muted/40">
        <div className="flex flex-wrap items-center gap-2 border-b bg-background p-1.5" role="toolbar" aria-label={t.editorToolbar}>
          <div role="group" aria-label={t.insert} data-toolbar-group="insert" className="flex max-w-full flex-wrap items-center gap-0.5 rounded-md border bg-muted/20 p-1">
            <strong className="shrink-0 px-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{t.insert}</strong>
            <button type="button" onClick={addText} disabled={!canChange} className="inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-1.5 text-xs hover:bg-muted disabled:opacity-40"><Type className="size-4" />{t.addText}</button>
            <DropdownMenu><DropdownMenuTrigger render={<button type="button" disabled={!canChange} className="inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-1.5 text-xs hover:bg-muted disabled:opacity-40"><Shapes className="size-4" />{t.addShape}</button>} /><DropdownMenuContent align="start">{(["rectangle", "roundedRectangle", "ellipse", "triangle", "line"] as const).map((shape) => <DropdownMenuItem key={shape} onClick={() => addShape(shape)}>{t[shape]}</DropdownMenuItem>)}</DropdownMenuContent></DropdownMenu>
            <DropdownMenu><DropdownMenuTrigger render={<button type="button" disabled={!canChange} className="inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-1.5 text-xs hover:bg-muted disabled:opacity-40"><Workflow className="size-4" />{t.addConnector}</button>} /><DropdownMenuContent align="start"><DropdownMenuItem onClick={() => addConnector("straight")}>{t.straightConnector}</DropdownMenuItem><DropdownMenuItem onClick={() => addConnector("elbow")}>{t.elbowConnector}</DropdownMenuItem></DropdownMenuContent></DropdownMenu>
            <button type="button" onClick={() => setDataDialog("table")} disabled={!canChange} className="inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-1.5 text-xs hover:bg-muted disabled:opacity-40"><Table2 className="size-4" />{primary?.kind === "table" ? t.editTable : t.insertTable}</button>
            <button type="button" onClick={() => setDataDialog("chart")} disabled={!canChange} className="inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-1.5 text-xs hover:bg-muted disabled:opacity-40"><ChartColumn className="size-4" />{primary?.kind === "chart" ? t.editChart : t.insertChart}</button>
            <input ref={imageInputRef} type="file" accept="image/png,image/jpeg" className="sr-only" aria-label={t.insertPresentationImage} onChange={(event) => { const file = event.target.files?.[0]; if (file) void addImage(file); }} />
            <button type="button" onClick={() => imageInputRef.current?.click()} disabled={!canChange || imageBusy} className="inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-1.5 text-xs hover:bg-muted disabled:opacity-40"><ImagePlus className="size-4" />{imageBusy ? t.uploadingImage : t.insertPresentationImage}</button>
          </div>
          <div role="group" aria-label={t.slideRail} data-toolbar-group="slides" className="flex max-w-full flex-wrap items-center gap-0.5 rounded-md border bg-muted/20 p-1">
            <strong className="shrink-0 px-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{t.slideRail}</strong>
            <button type="button" aria-label={t.moveSlideUp} title={t.moveSlideUp} disabled={!canChange || snapshot.slides.indexOf(slide) === 0} onClick={() => emit(reorderSlideCommand(snapshot.artifactId, baseVersion, slide.id, Math.max(0, snapshot.slides.indexOf(slide) - 1)))} className="inline-flex shrink-0 items-center gap-1 rounded px-2 py-1.5 text-xs hover:bg-muted disabled:opacity-30"><ChevronUp className="size-3.5" />{t.moveSlideUp}</button>
            <button type="button" aria-label={t.moveSlideDown} title={t.moveSlideDown} disabled={!canChange || snapshot.slides.indexOf(slide) === snapshot.slides.length - 1} onClick={() => emit(reorderSlideCommand(snapshot.artifactId, baseVersion, slide.id, snapshot.slides.indexOf(slide) + 1))} className="inline-flex shrink-0 items-center gap-1 rounded px-2 py-1.5 text-xs hover:bg-muted disabled:opacity-30"><ChevronDown className="size-3.5" />{t.moveSlideDown}</button>
            <button type="button" onClick={duplicateSlide} disabled={!canChange} className="inline-flex shrink-0 items-center gap-1 rounded px-2 py-1.5 text-xs hover:bg-muted disabled:opacity-40"><Copy className="size-3.5" />{t.duplicateSlide}</button>
            <button type="button" onClick={() => void deleteSelectedSlides()} disabled={!canChange || selectedSlideIds.length >= snapshot.slides.length} title={selectedSlideIds.length >= snapshot.slides.length ? t.cannotDeleteFinalSlide : t.deleteSlide} className="inline-flex shrink-0 items-center gap-1 rounded px-2 py-1.5 text-xs text-destructive hover:bg-destructive/10 disabled:opacity-30" aria-label={t.deleteSlide}><Trash2 className="size-3.5" />{t.deleteSlide}</button>
          </div>
          {selectedObjects.length ? <div role="group" aria-label={t.objectActions} data-toolbar-group="object" className="flex items-center gap-1 rounded-md border bg-muted/20 p-1">
            <strong className="shrink-0 px-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{t.objectActions}</strong>
            <DropdownMenu><DropdownMenuTrigger render={<button type="button" className="inline-flex items-center gap-1 rounded px-2 py-1.5 text-xs hover:bg-muted"><MoreHorizontal className="size-4" />{t.arrange}</button>} /><DropdownMenuContent align="start">
              <DropdownMenuItem disabled={selectionHasLocked} onClick={() => reorderObject("bringToFront")}>{t.bringToFront}</DropdownMenuItem><DropdownMenuItem disabled={selectionHasLocked} onClick={() => reorderObject("bringForward")}>{t.bringForward}</DropdownMenuItem><DropdownMenuItem disabled={selectionHasLocked} onClick={() => reorderObject("sendBackward")}>{t.sendBackward}</DropdownMenuItem><DropdownMenuItem disabled={selectionHasLocked} onClick={() => reorderObject("sendToBack")}>{t.sendToBack}</DropdownMenuItem><DropdownMenuSeparator />
              {(["alignLeft", "alignCenter", "alignRight", "alignTop", "alignMiddle", "alignBottom", "distributeHorizontal", "distributeVertical", "centerOnSlide"] as const).map((operation) => <DropdownMenuItem key={operation} disabled={selectionHasLocked || operation.startsWith("distribute") && selectedObjects.length < 3} onClick={() => arrange(operation)}>{t[operation]}</DropdownMenuItem>)}
            </DropdownMenuContent></DropdownMenu>
          </div> : null}
          <span className="ml-auto text-xs text-muted-foreground" aria-live="polite">{selectedObjects.length ? t.objectsSelected.replace("{count}", String(selectedObjects.length)) : t.slideSelected.replace("{slide}", slide.title)}</span>
          {suggestMode ? <span className="rounded-full bg-amber-100 px-2 py-1 text-xs text-amber-900">{t.suggesting}</span> : null}
        </div>
        {imageError ? <p role="alert" className="border-b bg-destructive/5 px-3 py-2 text-xs text-destructive">{imageError}</p> : null}
        {selectedObjects.length ? <PresentationFormattingToolbar objects={selectedObjects} disabled={!canChange || selectionHasLocked} onTextFormat={formatSelectedText} onProperty={formatSelectedProperty} /> : null}
        {primary ? <div role="toolbar" aria-label={t.accessibilityControls} className="flex flex-wrap items-center gap-2 border-b bg-background px-2 py-1.5">
          <strong className="shrink-0 text-xs font-semibold">{t.accessibilityControls}</strong>
          {primary.kind === "image" ? <label className="flex items-center gap-1 text-xs"><Checkbox checked={primary.decorative} disabled={!canChange || selectionHasLocked} onCheckedChange={(checked) => updateAccessibility("decorative", checked)} aria-label={t.decorativeImage} />{t.decorativeImage}</label> : null}
          {(primary.kind === "image" && !primary.decorative) || primary.kind === "shape" || primary.kind === "chart" ? <label className="flex items-center gap-1 text-xs">{t.altText}<input aria-label={t.altText} value={primary.altText ?? ""} disabled={!canChange || selectionHasLocked} onChange={(event) => updateAccessibility("altText", event.target.value)} className="h-7 min-w-48 rounded border px-2" /></label> : null}
          <button type="button" disabled={!canChange || Boolean(readingOrderDisabledReason(-1))} title={readingOrderDisabledReason(-1)} onClick={() => moveReadingOrder(-1)} className="rounded px-2 py-1 text-xs disabled:opacity-40">{t.readingOrderEarlier}</button>
          <button type="button" disabled={!canChange || Boolean(readingOrderDisabledReason(1))} title={readingOrderDisabledReason(1)} onClick={() => moveReadingOrder(1)} className="rounded px-2 py-1 text-xs disabled:opacity-40">{t.readingOrderLater}</button>
        </div> : null}
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
      <PresentationDataDialog mode={dataDialog ?? "table"} open={dataDialog !== null} object={dataDialog === "table" && primary?.kind === "table" ? primary : dataDialog === "chart" && primary?.kind === "chart" ? primary : null} onClose={() => setDataDialog(null)} onApply={applyDataObject} />
    </div>
  );
}

function runsWithText(runs: OfficeRichTextRun[], text: string): OfficeRichTextRun[] { return runs.length ? [{ ...runs[0], text }] : [defaultRun(text)]; }

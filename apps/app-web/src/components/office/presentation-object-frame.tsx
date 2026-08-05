"use client";

/** Google Slides-style direct manipulation for canonical Presentation geometry. [COMP:app-web/office-presentation-editor] */
import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import type {
  OfficeRichTextRun,
  PresentationObject,
  PresentationSnapshot,
} from "@use-brian/office-model";
import { useT } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";

type PresentationGeometry = PresentationObject["geometry"];
type SlideSize = PresentationSnapshot["slideSize"];
type ResizeHandle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";
type TransformMode = "move" | "rotate" | ResizeHandle;

const MIN_OBJECT_SIZE_PT = 12;
const RESIZE_HANDLES: Array<{ id: ResizeHandle; className: string; dimensions: "width" | "height" | "both" }> = [
  { id: "nw", className: "-left-1.5 -top-1.5 cursor-nwse-resize", dimensions: "both" },
  { id: "n", className: "left-1/2 -top-1.5 -translate-x-1/2 cursor-ns-resize", dimensions: "height" },
  { id: "ne", className: "-right-1.5 -top-1.5 cursor-nesw-resize", dimensions: "both" },
  { id: "e", className: "-right-1.5 top-1/2 -translate-y-1/2 cursor-ew-resize", dimensions: "width" },
  { id: "se", className: "-bottom-1.5 -right-1.5 cursor-nwse-resize", dimensions: "both" },
  { id: "s", className: "-bottom-1.5 left-1/2 -translate-x-1/2 cursor-ns-resize", dimensions: "height" },
  { id: "sw", className: "-bottom-1.5 -left-1.5 cursor-nesw-resize", dimensions: "both" },
  { id: "w", className: "-left-1.5 top-1/2 -translate-y-1/2 cursor-ew-resize", dimensions: "width" },
];

function roundPoint(value: number): number {
  return Math.round(value * 10) / 10;
}

export function moveOrResizePresentationGeometry(
  start: PresentationGeometry,
  mode: Exclude<TransformMode, "rotate">,
  deltaXPt: number,
  deltaYPt: number,
): PresentationGeometry {
  const dx = roundPoint(deltaXPt);
  const dy = roundPoint(deltaYPt);
  if (mode === "move") {
    return { ...start, xPt: roundPoint(start.xPt + dx), yPt: roundPoint(start.yPt + dy) };
  }

  let { xPt, yPt, widthPt, heightPt } = start;
  if (mode.includes("e")) widthPt = Math.max(MIN_OBJECT_SIZE_PT, start.widthPt + dx);
  if (mode.includes("s")) heightPt = Math.max(MIN_OBJECT_SIZE_PT, start.heightPt + dy);
  if (mode.includes("w")) {
    const nextWidth = Math.max(MIN_OBJECT_SIZE_PT, start.widthPt - dx);
    xPt = start.xPt + start.widthPt - nextWidth;
    widthPt = nextWidth;
  }
  if (mode.includes("n")) {
    const nextHeight = Math.max(MIN_OBJECT_SIZE_PT, start.heightPt - dy);
    yPt = start.yPt + start.heightPt - nextHeight;
    heightPt = nextHeight;
  }
  return {
    ...start,
    xPt: roundPoint(xPt),
    yPt: roundPoint(yPt),
    widthPt: roundPoint(widthPt),
    heightPt: roundPoint(heightPt),
  };
}

export function rotatePresentationGeometry(
  start: PresentationGeometry,
  pointerXPt: number,
  pointerYPt: number,
  snapToFifteenDegrees: boolean,
): PresentationGeometry {
  const centerX = start.xPt + start.widthPt / 2;
  const centerY = start.yPt + start.heightPt / 2;
  let rotationDeg = Math.atan2(pointerYPt - centerY, pointerXPt - centerX) * 180 / Math.PI + 90;
  if (snapToFifteenDegrees) rotationDeg = Math.round(rotationDeg / 15) * 15;
  while (rotationDeg > 180) rotationDeg -= 360;
  while (rotationDeg <= -180) rotationDeg += 360;
  return { ...start, rotationDeg: roundPoint(rotationDeg) };
}

export function nudgePresentationGeometry(
  start: PresentationGeometry,
  key: "ArrowLeft" | "ArrowRight" | "ArrowUp" | "ArrowDown",
  largeStep: boolean,
): PresentationGeometry {
  const amount = largeStep ? 10 : 1;
  const deltaX = key === "ArrowLeft" ? -amount : key === "ArrowRight" ? amount : 0;
  const deltaY = key === "ArrowUp" ? -amount : key === "ArrowDown" ? amount : 0;
  return moveOrResizePresentationGeometry(start, "move", deltaX, deltaY);
}

interface Interaction {
  pointerId: number;
  mode: TransformMode;
  startClientX: number;
  startClientY: number;
  startGeometry: PresentationGeometry;
  draftGeometry: PresentationGeometry;
  slideRect: DOMRect;
  moved: boolean;
}

export function PresentationObjectFrame({
  object,
  selected,
  canChange,
  slideSize,
  onSelect,
  onText,
  onGeometryPreview,
  onGeometry,
}: {
  object: PresentationObject;
  selected: boolean;
  canChange: boolean;
  slideSize: SlideSize;
  onSelect(): void;
  onText(id: string, runs: OfficeRichTextRun[]): void;
  onGeometryPreview(id: string, geometry: PresentationGeometry | null): void;
  onGeometry(id: string, geometry: PresentationGeometry): void;
}) {
  const t = useT().office;
  const editable = canChange && !object.locked;
  const [draftGeometry, setDraftGeometry] = useState<PresentationGeometry | null>(null);
  const [editingText, setEditingText] = useState(false);
  const interaction = useRef<Interaction | null>(null);
  const textAreaRef = useRef<HTMLTextAreaElement | null>(null);
  const geometry = draftGeometry ?? object.geometry;

  useEffect(() => {
    setDraftGeometry(null);
    onGeometryPreview(object.id, null);
  }, [object.geometry.xPt, object.geometry.yPt, object.geometry.widthPt, object.geometry.heightPt, object.geometry.rotationDeg]);

  useEffect(() => {
    if (!selected || object.kind !== "text") setEditingText(false);
  }, [object.kind, selected]);

  useEffect(() => {
    if (!editingText) return;
    textAreaRef.current?.focus();
    textAreaRef.current?.select();
  }, [editingText]);

  const style: CSSProperties = {
    left: `${geometry.xPt / slideSize.widthPt * 100}%`,
    top: `${geometry.yPt / slideSize.heightPt * 100}%`,
    width: `${geometry.widthPt / slideSize.widthPt * 100}%`,
    height: `${geometry.heightPt / slideSize.heightPt * 100}%`,
    transform: `rotate(${geometry.rotationDeg}deg)`,
  };
  const objectText = object.kind === "text"
    ? object.runs.map((run) => run.text).join("")
    : object.kind === "shape"
      ? object.text.map((run) => run.text).join("")
      : "";
  const objectLabel = objectText || (object.kind === "connector" ? t.connector : object.kind === "image" ? object.altText || t.image : object.kind === "video" ? t.video : object.kind === "chart" ? object.title : object.kind === "table" ? t.properties : t.addShape);

  function startTransform(event: ReactPointerEvent<HTMLElement>, mode: TransformMode) {
    event.stopPropagation();
    onSelect();
    if (!editable || editingText || event.button !== 0) return;
    const slide = event.currentTarget.closest<HTMLElement>("[data-slide-canvas='true']");
    if (!slide) return;
    event.preventDefault();
    event.currentTarget.focus();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    const startGeometry = draftGeometry ?? object.geometry;
    interaction.current = {
      pointerId: event.pointerId,
      mode,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startGeometry,
      draftGeometry: startGeometry,
      slideRect: slide.getBoundingClientRect(),
      moved: false,
    };
  }

  function updateTransform(event: ReactPointerEvent<HTMLElement>) {
    const current = interaction.current;
    if (!current || current.pointerId !== event.pointerId) return;
    const moved = current.moved || Math.abs(event.clientX - current.startClientX) > 2 || Math.abs(event.clientY - current.startClientY) > 2;
    if (!moved) return;
    event.preventDefault();
    const next = current.mode === "rotate"
      ? rotatePresentationGeometry(
          current.startGeometry,
          (event.clientX - current.slideRect.left) / current.slideRect.width * slideSize.widthPt,
          (event.clientY - current.slideRect.top) / current.slideRect.height * slideSize.heightPt,
          event.shiftKey,
        )
      : moveOrResizePresentationGeometry(
          current.startGeometry,
          current.mode,
          (event.clientX - current.startClientX) / current.slideRect.width * slideSize.widthPt,
          (event.clientY - current.startClientY) / current.slideRect.height * slideSize.heightPt,
        );
    current.moved = true;
    current.draftGeometry = next;
    setDraftGeometry(next);
    onGeometryPreview(object.id, next);
  }

  function finishTransform(event: ReactPointerEvent<HTMLElement>) {
    const current = interaction.current;
    if (!current || current.pointerId !== event.pointerId) return;
    interaction.current = null;
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (current.moved) onGeometry(object.id, current.draftGeometry);
    else setDraftGeometry(null);
  }

  function cancelTransform(event: ReactPointerEvent<HTMLElement>) {
    if (interaction.current?.pointerId !== event.pointerId) return;
    interaction.current = null;
    setDraftGeometry(null);
    onGeometryPreview(object.id, null);
  }

  function onFrameKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (editingText) return;
    if (object.kind === "text" && event.key === "Enter" && editable) {
      event.preventDefault();
      setEditingText(true);
      return;
    }
    if (!editable || !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    const next = nudgePresentationGeometry(geometry, event.key as "ArrowLeft" | "ArrowRight" | "ArrowUp" | "ArrowDown", event.shiftKey);
    setDraftGeometry(next);
    onGeometryPreview(object.id, next);
    onGeometry(object.id, next);
  }

  function handleLabel(dimensions: "width" | "height" | "both"): string {
    if (dimensions === "width") return `${t.properties}: ${t.width}`;
    if (dimensions === "height") return `${t.properties}: ${t.height}`;
    return `${t.properties}: ${t.width}, ${t.height}`;
  }

  return (
    <div
      data-slide-object={object.id}
      data-direct-manipulation="true"
      data-selected={selected ? "true" : "false"}
      role={editingText ? "group" : "button"}
      aria-label={objectLabel}
      aria-pressed={editingText ? undefined : selected}
      tabIndex={0}
      style={style}
      className={cn(
        "absolute touch-none overflow-visible border border-transparent outline-none",
        selected && "border-primary ring-1 ring-primary",
        editable && !editingText && "cursor-move",
        object.locked && "cursor-default",
      )}
      onPointerDown={(event) => startTransform(event, "move")}
      onPointerMove={updateTransform}
      onPointerUp={finishTransform}
      onPointerCancel={cancelTransform}
      onClick={(event) => { event.stopPropagation(); onSelect(); }}
      onDoubleClick={(event) => {
        if (object.kind !== "text" || !editable) return;
        event.stopPropagation();
        setEditingText(true);
      }}
      onKeyDown={onFrameKeyDown}
    >
      <div className="h-full w-full overflow-hidden">
        {renderObjectContent(object, objectText, t, editingText, textAreaRef, editable, onText, () => setEditingText(false))}
      </div>
      {selected && editable && !editingText ? <>
        <span aria-hidden className="pointer-events-none absolute left-1/2 top-[-1.4rem] h-[1.15rem] border-l border-primary" />
        <button
          type="button"
          data-rotate-handle="true"
          aria-label={t.rotation}
          className="absolute left-1/2 top-[-1.9rem] size-3 -translate-x-1/2 cursor-grab rounded-full border border-primary bg-background shadow-sm"
          onPointerDown={(event) => startTransform(event, "rotate")}
          onClick={(event) => event.stopPropagation()}
        />
        {RESIZE_HANDLES.map((handle) => <button
          key={handle.id}
          type="button"
          data-resize-handle={handle.id}
          aria-label={handleLabel(handle.dimensions)}
          className={cn("absolute size-3 rounded-sm border border-primary bg-background shadow-sm", handle.className)}
          onPointerDown={(event) => startTransform(event, handle.id)}
          onClick={(event) => event.stopPropagation()}
        />)}
      </> : null}
    </div>
  );
}

function renderObjectContent(
  object: PresentationObject,
  objectText: string,
  t: ReturnType<typeof useT>["office"],
  editingText: boolean,
  textAreaRef: React.RefObject<HTMLTextAreaElement | null>,
  editable: boolean,
  onText: (id: string, runs: OfficeRichTextRun[]) => void,
  finishTextEditing: () => void,
) {
  if (object.kind === "text") {
    return editingText
      ? <textarea
          ref={textAreaRef}
          data-slide-text-editor="true"
          value={objectText}
          onPointerDown={(event) => event.stopPropagation()}
          onChange={(event) => onText(object.id, runsWithText(object.runs, event.target.value))}
          onBlur={finishTextEditing}
          onKeyDown={(event) => { if (event.key === "Escape") event.currentTarget.blur(); }}
          className="h-full w-full resize-none bg-transparent p-1 outline-none"
        />
      : <div className="h-full w-full whitespace-pre-wrap p-1">{objectText}</div>;
  }
  if (object.kind === "shape") return <div style={{ backgroundColor: object.fill, borderColor: object.stroke }} className="flex h-full w-full items-center justify-center border">{objectText}</div>;
  if (object.kind === "connector") return <div aria-label={t.connector} style={{ borderColor: object.stroke }} className="mt-[1px] h-0 w-full border-t-2" />;
  if (object.kind === "table") return <table className="h-full w-full border-collapse bg-white text-[8px]"><tbody>{object.rows.map((row) => <tr key={row.id}>{row.cells.map((cell) => <td key={cell.id} className="border p-1">{cell.runs.map((run) => run.text).join("")}</td>)}</tr>)}</tbody></table>;
  if (object.kind === "chart") return <div className="h-full w-full bg-slate-50 p-2 text-xs"><strong>{object.title}</strong><span className="block text-slate-500">{object.chartType}</span></div>;
  if (object.kind === "image") return <div className="flex h-full w-full items-center justify-center bg-slate-100 text-xs text-slate-500">{object.altText || t.image}</div>;
  return <div className="flex h-full w-full items-center justify-center bg-slate-900 text-xs text-white">{t.video}</div>;
}

export function PresentationGeometryToolbar({
  object,
  disabled,
  onProperty,
  onDelete,
}: {
  object: PresentationObject;
  disabled: boolean;
  onProperty(path: string[], value: unknown): void;
  onDelete(): void;
}) {
  const t = useT().office;
  const fields = [["xPt", t.x], ["yPt", t.y], ["widthPt", t.width], ["heightPt", t.height], ["rotationDeg", t.rotation]] as const;
  return <div data-properties-toolbar="true" role="toolbar" aria-label={t.properties} className="flex min-h-11 items-center gap-3 overflow-x-auto border-b bg-background px-3 py-1.5">
    <strong className="shrink-0 text-xs font-semibold">{t.properties}</strong>
    {fields.map(([key, label]) => <label key={key} className="flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground">{label}<input type="number" disabled={disabled} value={object.geometry[key]} onChange={(event) => onProperty(["geometry", key], Number(event.target.value))} className="h-7 w-[4.5rem] rounded border bg-background px-2 text-xs text-foreground disabled:opacity-50" /></label>)}
    <button type="button" disabled={disabled} onClick={onDelete} className="ml-auto shrink-0 rounded px-2 py-1 text-xs text-destructive hover:bg-destructive/10 disabled:opacity-40">{t.deleteObject}</button>
  </div>;
}

function runsWithText(runs: OfficeRichTextRun[], text: string): OfficeRichTextRun[] {
  return runs.length ? [{ ...runs[0], text }] : [];
}

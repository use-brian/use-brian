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
import { getOfficeResourceObjectUrl } from "@/lib/office/api";
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
  artifactId,
  object,
  selected,
  canChange,
  slideSize,
  onSelect,
  onText,
  onGeometryPreview,
  onGeometry,
}: {
  artifactId: string;
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
        {editingText && object.kind === "text"
          ? <textarea
              ref={textAreaRef}
              data-slide-text-editor="true"
              value={objectText}
              style={{ ...richTextRunStyle(object.runs[0], slideSize), textAlign: object.alignment }}
              onPointerDown={(event) => event.stopPropagation()}
              onChange={(event) => onText(object.id, runsWithText(object.runs, event.target.value))}
              onBlur={() => setEditingText(false)}
              onKeyDown={(event) => { if (event.key === "Escape") event.currentTarget.blur(); }}
              className="h-full w-full resize-none bg-transparent outline-none"
            />
          : <PresentationObjectVisual artifactId={artifactId} object={object} slideSize={slideSize} />}
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

type PresentationRenderScale = "responsive" | "points";

function scaledPointSize(valuePt: number, slideSize: SlideSize, renderScale: PresentationRenderScale): string {
  return renderScale === "points" ? `${valuePt}px` : `${valuePt / slideSize.widthPt * 100}cqw`;
}

function richTextRunStyle(run: OfficeRichTextRun | undefined, slideSize: SlideSize, renderScale: PresentationRenderScale = "responsive"): CSSProperties {
  if (!run) return {};
  const decorations = [run.style.underline && "underline", run.style.strike && "line-through"].filter(Boolean).join(" ");
  const family = run.style.fontFamily;
  const fontFamily = /mono|courier|consolas/i.test(family)
    ? `${JSON.stringify(family)}, "SFMono-Regular", Menlo, Monaco, Consolas, monospace`
    : /serif|times|georgia|cambria/i.test(family)
      ? `${JSON.stringify(family)}, Georgia, "Times New Roman", serif`
      : /aptos/i.test(family)
        ? `${JSON.stringify(family)}, "Segoe UI", system-ui, Arial, Helvetica, sans-serif`
        : `${JSON.stringify(family)}, Arial, Helvetica, sans-serif`;
  return {
    color: run.style.color,
    backgroundColor: run.style.highlight,
    fontFamily,
    fontSize: scaledPointSize(run.style.fontSizePt, slideSize, renderScale),
    fontStyle: run.style.italic ? "italic" : "normal",
    fontWeight: run.style.bold ? 700 : 400,
    textDecoration: decorations || "none",
  };
}

function RichTextRuns({ runs, slideSize, renderScale }: { runs: OfficeRichTextRun[]; slideSize: SlideSize; renderScale: PresentationRenderScale }) {
  return <>{runs.map((run) => <span key={run.id} style={richTextRunStyle(run, slideSize, renderScale)}>{run.text}</span>)}</>;
}

function OfficeResourceImage({ artifactId, resourceId, alt, fallback }: { artifactId: string; resourceId: string; alt: string; fallback: string }) {
  const [source, setSource] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let active = true;
    setFailed(false);
    getOfficeResourceObjectUrl(artifactId, resourceId)
      .then((url) => { if (active) setSource(url); })
      .catch(() => { if (active) setFailed(true); });
    return () => { active = false; };
  }, [artifactId, resourceId]);

  if (!source) return <div data-office-resource-image={failed ? "failed" : "loading"} className="flex h-full w-full items-center justify-center bg-slate-100 text-[0.7rem] text-slate-500">{fallback}</div>;
  return <img data-office-resource-image="ready" src={source} alt={alt} draggable={false} className="block h-full w-full object-fill" />;
}

const CHART_COLORS = ["#34D3FF", "#14B8A6", "#FACC15", "#FB923C", "#F472B6", "#A78BFA"];

function chartPoint(index: number, count: number): number {
  return count <= 1 ? 500 : 60 + index / (count - 1) * 880;
}

function pieSlicePath(start: number, end: number, radius: number): string {
  const startX = 500 + radius * Math.cos(start);
  const startY = 250 + radius * Math.sin(start);
  const endX = 500 + radius * Math.cos(end);
  const endY = 250 + radius * Math.sin(end);
  const largeArc = end - start > Math.PI ? 1 : 0;
  return `M 500 250 L ${startX} ${startY} A ${radius} ${radius} 0 ${largeArc} 1 ${endX} ${endY} Z`;
}

function PresentationChartVisual({ object, slideSize, renderScale }: { object: Extract<PresentationObject, { kind: "chart" }>; slideSize: SlideSize; renderScale: PresentationRenderScale }) {
  const values = object.series.flatMap((series) => series.values);
  const maxValue = Math.max(1, ...values.map((value) => Math.abs(value)));
  const pieValues = object.series[0]?.values.map((value) => Math.max(0, value)) ?? [];
  const pieTotal = pieValues.reduce((sum, value) => sum + value, 0) || 1;
  let pieAngle = -Math.PI / 2;
  return <div data-presentation-chart={object.chartType} className="relative h-full w-full overflow-hidden">
    <strong className="absolute left-[3%] top-[1%] z-10 max-w-[94%] truncate" style={{ fontSize: scaledPointSize(12, slideSize, renderScale) }}>{object.title}</strong>
    <svg viewBox="0 0 1000 500" preserveAspectRatio="none" aria-label={object.altText} className="h-full w-full">
      {object.chartType === "bar" ? object.series.flatMap((series, seriesIndex) => series.values.map((value, valueIndex) => {
        const categoryCount = Math.max(1, object.categories.length);
        const groupWidth = 820 / categoryCount;
        const barWidth = groupWidth / Math.max(1, object.series.length) * 0.72;
        const height = Math.abs(value) / maxValue * 350;
        const x = 100 + valueIndex * groupWidth + seriesIndex * groupWidth / object.series.length;
        return <rect key={`${series.name}-${valueIndex}`} x={x} y={430 - height} width={barWidth} height={height} fill={CHART_COLORS[seriesIndex % CHART_COLORS.length]} />;
      })) : null}
      {object.chartType === "line" || object.chartType === "scatter" ? object.series.map((series, seriesIndex) => {
        const points = series.values.map((value, index) => `${chartPoint(index, series.values.length)},${430 - value / maxValue * 350}`).join(" ");
        return <g key={series.name}>
          {object.chartType === "line" ? <polyline points={points} fill="none" stroke={CHART_COLORS[seriesIndex % CHART_COLORS.length]} strokeWidth="8" vectorEffect="non-scaling-stroke" /> : null}
          {series.values.map((value, index) => <circle key={index} cx={chartPoint(index, series.values.length)} cy={430 - value / maxValue * 350} r="12" fill={CHART_COLORS[seriesIndex % CHART_COLORS.length]} />)}
        </g>;
      }) : null}
      {object.chartType === "pie" || object.chartType === "doughnut" ? pieValues.map((value, index) => {
        const start = pieAngle;
        pieAngle += value / pieTotal * Math.PI * 2;
        return <path key={index} d={pieSlicePath(start, pieAngle, 190)} fill={CHART_COLORS[index % CHART_COLORS.length]} />;
      }) : null}
      {object.chartType === "doughnut" ? <circle cx="500" cy="250" r="92" fill="white" /> : null}
    </svg>
  </div>;
}

export function PresentationObjectVisual({ artifactId, object, slideSize, renderScale = "responsive" }: { artifactId: string; object: PresentationObject; slideSize: SlideSize; renderScale?: PresentationRenderScale }) {
  const t = useT().office;
  if (object.kind === "text") {
    const justifyContent = object.verticalAlignment === "middle" ? "center" : object.verticalAlignment === "bottom" ? "flex-end" : "flex-start";
    return <div data-presentation-object-visual="text" className="flex h-full w-full flex-col whitespace-pre-wrap" style={{ justifyContent, textAlign: object.alignment, overflowWrap: "break-word", lineHeight: 1.05 }}><div className="w-full"><RichTextRuns runs={object.runs} slideSize={slideSize} renderScale={renderScale} /></div></div>;
  }
  if (object.kind === "shape") {
    if (object.shape === "triangle") return <div data-presentation-object-visual="shape" className="relative h-full w-full" style={{ backgroundColor: object.fill, clipPath: "polygon(50% 0, 100% 100%, 0 100%)" }} />;
    if (object.shape === "line") return <div data-presentation-object-visual="shape" className="relative h-full w-full"><span className="absolute left-0 top-1/2 w-full" style={{ borderTopColor: object.stroke, borderTopStyle: "solid", borderTopWidth: scaledPointSize(object.strokeWidthPt, slideSize, renderScale) }} /></div>;
    const justifyContent = object.verticalAlignment === "top" ? "flex-start" : object.verticalAlignment === "bottom" ? "flex-end" : "center";
    return <div data-presentation-object-visual="shape" style={{ backgroundColor: object.fill, borderColor: object.stroke, borderRadius: object.shape === "ellipse" ? "50%" : object.shape === "roundedRectangle" ? "8%" : undefined, borderStyle: object.stroke ? "solid" : undefined, borderWidth: object.stroke ? scaledPointSize(object.strokeWidthPt, slideSize, renderScale) : undefined, justifyContent, textAlign: object.alignment ?? "center" }} className="flex h-full w-full flex-col whitespace-pre-wrap"><RichTextRuns runs={object.text} slideSize={slideSize} renderScale={renderScale} /></div>;
  }
  if (object.kind === "connector") return <div data-presentation-object-visual="connector" aria-label={t.connector} className="relative h-full w-full"><span className="absolute left-0 top-1/2 w-full border-t" style={{ borderColor: object.stroke }} /></div>;
  if (object.kind === "table") return <table data-presentation-object-visual="table" className="h-full w-full table-fixed border-collapse bg-white"><tbody>{object.rows.map((row) => <tr key={row.id}>{row.cells.map((cell) => <td key={cell.id} rowSpan={cell.rowSpan} colSpan={cell.colSpan} className="overflow-hidden border border-slate-400 align-middle"><RichTextRuns runs={cell.runs} slideSize={slideSize} renderScale={renderScale} /></td>)}</tr>)}</tbody></table>;
  if (object.kind === "chart") return <PresentationChartVisual object={object} slideSize={slideSize} renderScale={renderScale} />;
  if (object.kind === "image") return <OfficeResourceImage artifactId={artifactId} resourceId={object.resourceId} alt={object.decorative ? "" : object.altText} fallback={object.altText || t.image} />;
  return <div data-presentation-object-visual="video" className="relative h-full w-full bg-slate-900"><OfficeResourceImage artifactId={artifactId} resourceId={object.posterResourceId} alt={object.altText} fallback={t.video} /><span aria-hidden className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 border-y-[0.6rem] border-l-[1rem] border-y-transparent border-l-white/90" /></div>;
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

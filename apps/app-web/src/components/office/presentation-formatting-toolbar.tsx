"use client";

/** Whole-object Presentation formatting controls. [COMP:app-web/office-presentation-editor] */
import { Bold, Italic, Link, Strikethrough, Underline } from "lucide-react";
import {
  commonPresentationTextFormatting,
  type PresentationObject,
  type PresentationTextFormatting,
} from "@use-brian/office-model";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useT } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";
import type { ReactNode } from "react";

const FONTS = ["Arial", "Aptos", "Calibri", "Georgia", "Times New Roman"];
const SHAPES = ["rectangle", "roundedRectangle", "ellipse", "triangle", "line"] as const;
const ALIGNMENTS = ["start", "center", "end", "justify"] as const;
const VERTICAL = ["top", "middle", "bottom"] as const;

function supportsText(object: PresentationObject): boolean { return object.kind === "text" || object.kind === "shape"; }
function colorIsValid(value: string): boolean { return /^#[0-9A-Fa-f]{6}(?:[0-9A-Fa-f]{2})?$/.test(value); }

export function PresentationFormattingToolbar({ objects, disabled, onTextFormat, onProperty }: {
  objects: PresentationObject[];
  disabled: boolean;
  onTextFormat(formatting: PresentationTextFormatting): void;
  onProperty(path: string[], value: unknown): void;
}) {
  const t = useT().office;
  const text = commonPresentationTextFormatting(objects);
  const shapes = objects.length > 0 && objects.every((object) => object.kind === "shape") ? objects as Array<Extract<PresentationObject, { kind: "shape" }>> : null;
  const connectors = objects.length > 0 && objects.every((object) => object.kind === "connector") ? objects as Array<Extract<PresentationObject, { kind: "connector" }>> : null;
  const common = <T,>(values: T[]): T | null => values.every((value) => value === values[0]) ? values[0] : null;
  const shape = shapes?.[0] ?? null;
  const connector = connectors?.[0] ?? null;
  const shapeKind = shapes ? common(shapes.map((item) => item.shape)) : null;
  const connectorKind = connectors ? common(connectors.map((item) => item.connector)) : null;
  if (!text && !shape && !connector) return null;
  const toggle = (key: "bold" | "italic" | "underline" | "strike") => onTextFormat({ [key]: !(text?.[key] === true) });
  const horizontalLabel = typeof text?.alignment === "string" ? t[text.alignment === "start" ? "alignLeft" : text.alignment === "end" ? "alignRight" : text.alignment === "center" ? "alignCenter" : "justify"] : t.mixedValue;
  const verticalLabel = typeof text?.verticalAlignment === "string" ? t[text.verticalAlignment === "top" ? "alignTop" : text.verticalAlignment === "middle" ? "alignMiddle" : "alignBottom"] : t.mixedValue;
  return <div data-presentation-formatting-toolbar="true" role="toolbar" aria-label={t.presentationFormatting} className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b bg-background px-2 py-1.5">
    <strong className="shrink-0 text-xs font-semibold">{t.presentationFormatting}</strong>
    {text ? <>
      <FormattingField label={t.fontFamily}><Select value={typeof text.fontFamily === "string" ? text.fontFamily : null} onValueChange={(value) => value && onTextFormat({ fontFamily: value })} disabled={disabled}>
        <SelectTrigger size="sm" className="w-28" aria-label={t.fontFamily}><SelectValue placeholder={t.mixedValue} /></SelectTrigger>
        <SelectContent>{FONTS.map((font) => <SelectItem key={font} value={font}>{font}</SelectItem>)}</SelectContent>
      </Select></FormattingField>
      <FormattingField label={t.fontSize}><input aria-label={t.fontSize} disabled={disabled} type="number" min={1} max={144} value={typeof text.fontSizePt === "number" ? text.fontSizePt : ""} placeholder={t.mixedValue} onInput={(event) => { const value = Number(event.currentTarget.value); if (value >= 1 && value <= 144) onTextFormat({ fontSizePt: value }); }} onChange={() => undefined} className="h-7 w-16 rounded border bg-background px-2 text-xs" /></FormattingField>
      <div role="group" aria-label={t.presentationFormatting} className="flex items-center gap-0.5">{([['bold', Bold, t.bold], ['italic', Italic, t.italic], ['underline', Underline, t.underline], ['strike', Strikethrough, t.strike]] as const).map(([key, Icon, label]) => <button key={key} type="button" aria-label={label} title={label} aria-pressed={text[key] === true} disabled={disabled} onClick={() => toggle(key)} className={cn("rounded p-1.5 hover:bg-muted disabled:opacity-40", text[key] === true && "bg-muted")}><Icon className="size-3.5" /></button>)}</div>
      <FormattingField label={t.textColor}><input aria-label={t.textColor} disabled={disabled} value={typeof text.color === "string" ? text.color : ""} placeholder={t.mixedValue} onInput={(event) => { if (colorIsValid(event.currentTarget.value)) onTextFormat({ color: event.currentTarget.value.toUpperCase() }); }} onChange={() => undefined} className="h-7 w-24 rounded border bg-background px-2 text-xs" /></FormattingField>
      <FormattingField label={t.hyperlink} grow><Link className="size-3.5 text-muted-foreground" /><input aria-label={t.hyperlink} disabled={disabled} value={typeof text.href === "string" ? text.href : ""} placeholder="https://" onInput={(event) => { const value = event.currentTarget.value.trim(); if (!value || /^(https:|mailto:)/.test(value)) onTextFormat({ href: value || null }); }} onChange={() => undefined} className="h-7 min-w-28 flex-1 rounded border bg-background px-2 text-xs" /></FormattingField>
      <FormattingField label={t.horizontalAlignment}><Select value={typeof text.alignment === "string" ? text.alignment : null} onValueChange={(value) => value && onTextFormat({ alignment: value as PresentationTextFormatting["alignment"] })} disabled={disabled}>
        <SelectTrigger size="sm" aria-label={t.horizontalAlignment}><SelectValue>{horizontalLabel}</SelectValue></SelectTrigger><SelectContent>{ALIGNMENTS.map((value) => <SelectItem key={value} value={value}>{t[value === "start" ? "alignLeft" : value === "end" ? "alignRight" : value === "center" ? "alignCenter" : "justify"]}</SelectItem>)}</SelectContent>
      </Select></FormattingField>
      <FormattingField label={t.verticalAlignment}><Select value={typeof text.verticalAlignment === "string" ? text.verticalAlignment : null} onValueChange={(value) => value && onTextFormat({ verticalAlignment: value as PresentationTextFormatting["verticalAlignment"] })} disabled={disabled}>
        <SelectTrigger size="sm" aria-label={t.verticalAlignment}><SelectValue>{verticalLabel}</SelectValue></SelectTrigger><SelectContent>{VERTICAL.map((value) => <SelectItem key={value} value={value}>{t[value === "top" ? "alignTop" : value === "middle" ? "alignMiddle" : "alignBottom"]}</SelectItem>)}</SelectContent>
      </Select></FormattingField>
    </> : null}
    {shape && shapes ? <>
      <FormattingField label={t.shapeKind}><Select value={shapeKind} onValueChange={(value) => value && onProperty(["shape"], value)} disabled={disabled}><SelectTrigger size="sm" aria-label={t.shapeKind}><SelectValue>{shapeKind ? t[shapeKind] : t.mixedValue}</SelectValue></SelectTrigger><SelectContent>{SHAPES.map((value) => <SelectItem key={value} value={value}>{t[value]}</SelectItem>)}</SelectContent></Select></FormattingField>
      <FormattingField label={t.fillColor}><ColorField label={t.fillColor} value={common(shapes.map((item) => item.fill ?? "")) ?? ""} disabled={disabled} onValue={(value) => onProperty(["fill"], value)} /></FormattingField>
      <FormattingField label={t.strokeColor}><ColorField label={t.strokeColor} value={common(shapes.map((item) => item.stroke ?? "")) ?? ""} disabled={disabled} onValue={(value) => onProperty(["stroke"], value)} /></FormattingField>
      <FormattingField label={t.strokeWidth}><input aria-label={t.strokeWidth} disabled={disabled} type="number" min={0} max={100} step={0.5} value={common(shapes.map((item) => item.strokeWidthPt)) ?? ""} placeholder={t.mixedValue} onInput={(event) => { const value = Number(event.currentTarget.value); if (value >= 0 && value <= 100) onProperty(["strokeWidthPt"], value); }} onChange={() => undefined} className="h-7 w-16 rounded border bg-background px-2 text-xs" /></FormattingField>
    </> : null}
    {connector && connectors ? <>
      <FormattingField label={t.connectorKind}><Select value={connectorKind} onValueChange={(value) => value && onProperty(["connector"], value)} disabled={disabled}><SelectTrigger size="sm" aria-label={t.connectorKind}><SelectValue>{connectorKind ? connectorKind === "straight" ? t.straightConnector : t.elbowConnector : t.mixedValue}</SelectValue></SelectTrigger><SelectContent><SelectItem value="straight">{t.straightConnector}</SelectItem><SelectItem value="elbow">{t.elbowConnector}</SelectItem></SelectContent></Select></FormattingField>
      <FormattingField label={t.strokeColor}><ColorField label={t.strokeColor} value={common(connectors.map((item) => item.stroke)) ?? ""} disabled={disabled} onValue={(value) => onProperty(["stroke"], value)} /></FormattingField>
    </> : null}
  </div>;
}

function FormattingField({ label, grow = false, children }: { label: string; grow?: boolean; children: ReactNode }) {
  return <div role="group" aria-label={label} data-formatting-field={label} className={cn("flex min-w-0 items-center gap-1.5", grow && "min-w-48 flex-1")}>
    <span className="shrink-0 text-[10px] font-medium text-muted-foreground">{label}</span>
    {children}
  </div>;
}

function ColorField({ label, value, disabled, onValue }: { label: string; value: string; disabled: boolean; onValue(value: string): void }) {
  return <input aria-label={label} disabled={disabled} value={value} placeholder="#RRGGBB" onInput={(event) => { if (colorIsValid(event.currentTarget.value)) onValue(event.currentTarget.value.toUpperCase()); }} onChange={() => undefined} className="h-7 w-24 rounded border bg-background px-2 text-xs" />;
}

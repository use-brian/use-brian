"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { OfficeTemplateRoutingDraftSchema, officeTemplateLockedTokenNames, officeTemplateTokenDiagnostics, type DocumentSnapshot, type SpreadsheetSnapshot, type OfficeTemplateField, type OfficeTemplateRoutingDraft } from "@use-brian/office-model";
import { Skeleton } from "@/components/skeleton";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { format, useT } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";
import type { TemplateRoutingInspectorState } from "./template-routing-inspector";
import { reconcileTokenRouting, tokenTargetLocations } from "./token-template-routing";

const TYPES: OfficeTemplateField["type"][] = ["plainText", "number", "date"];
const inputClass = "min-h-8 max-sm:min-h-11 w-full rounded border bg-background px-2 text-base md:text-sm";

/** Literal DOCX/XLSX fields. The live snapshot is the binding authority. */
export function TokenTemplateRoutingInspector({ snapshot, selectedTargetIds, initialRouting, onStateChange, saveRouting, saveConfirmed }: {
  saveConfirmed: boolean;
  saveRouting: (draft: OfficeTemplateRoutingDraft) => Promise<OfficeTemplateRoutingDraft>;
  snapshot: DocumentSnapshot | SpreadsheetSnapshot;
  selectedTargetIds: string[];
  initialRouting: OfficeTemplateRoutingDraft;
  onStateChange?: (state: TemplateRoutingInspectorState) => void;
}) {
  const t = useT().office;
  const [routing, setRouting] = useState<OfficeTemplateRoutingDraft | null>(initialRouting ?? null);
  const [saved, setSaved] = useState(initialRouting ? JSON.stringify(initialRouting) : "");
  const [status, setStatus] = useState<"loading" | "ready" | "saving" | "saved" | "loadFailed" | "saveFailed">(initialRouting ? "ready" : "loading");
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  // Snapshot updates are the collaboration signal, including edits from peers.
  // Metadata follows names; renames get fresh optional defaults, never mappings
  // or instructions silently borrowed from the previous token in that cell.
  useEffect(() => {
    setRouting((current) => current ? reconcileTokenRouting(current, snapshot, t.routingTokenDefaultInstruction) : current);
  }, [snapshot, routing, t.routingTokenDefaultInstruction]);

  const dirty = Boolean(routing && JSON.stringify(routing) !== saved);
  useEffect(() => { if (saveConfirmed && !dirty && status === "ready") setStatus("saved"); }, [saveConfirmed, dirty, status]);
  const locked = useMemo(() => officeTemplateLockedTokenNames(snapshot, routing?.fields), [snapshot, routing]);
  const valid = Boolean(routing && OfficeTemplateRoutingDraftSchema.safeParse(routing).success && !officeTemplateTokenDiagnostics(snapshot, routing.fields).length && routing.fields.every((field) => field.label.trim() && field.aiInstruction.trim()));
  useEffect(() => {
    onStateChange?.({ ready: valid && status !== "loading" && status !== "loadFailed", dirty, saving: status === "saving" });
  }, [dirty, valid, status, onStateChange]);

  function updateField(id: string, patch: Partial<Pick<OfficeTemplateField, "label" | "required" | "type" | "maxLength" | "aiInstruction">>) {
    setRouting((current) => current ? { ...current, fields: current.fields.map((field) => field.id === id ? { ...field, ...patch } : field) } : current);
    setStatus("ready");
  }

  async function save() {
    if (!routing || !valid || !dirty || status === "saving") return;
    const submitted = routing;
    setStatus("saving");
    try {
      const response = await saveRouting(submitted);
      if (!alive.current) return;
      // Content may change while PUT is in flight. Never overwrite newer bindings
      // or mark them saved just because the old request completed successfully.
      setRouting((current) => current === submitted ? response : current);
      setSaved(JSON.stringify(response));
      setStatus("saved");
    } catch {
      if (alive.current) setStatus("saveFailed");
    }
  }

  if (status === "loading") return <div data-template-routing="loading" aria-busy="true" aria-label={t.routingLoading} className="space-y-3 p-3"><Skeleton className="h-8 w-2/3" /><Skeleton className="h-24 w-full" /><Skeleton className="h-48 w-full" /></div>;
  if (!routing || status === "loadFailed") return <div className="space-y-3 p-3" data-template-routing="failed"><p role="alert" className="text-sm text-destructive">{t.routingLoadFailed}</p></div>;

  return <div data-template-routing="ready" className="space-y-4 p-3 text-sm">
    <h2 className="font-semibold">{t.routingTokenTitle}</h2>
    <p className="text-muted-foreground">{t.routingTokenSyntax}</p>
    <p className="text-muted-foreground">{t.routingTokenNames}</p>
    {snapshot.family === "spreadsheet" ? <p className="rounded border bg-muted/30 p-3">{t.routingTokenAppend}</p> : null}
    {!routing.fields.length ? <p role="alert" className="rounded border border-dashed p-3">{t.routingTokenEmpty}</p> : null}
    {locked.length ? <p role="alert" className="rounded border border-destructive p-3 text-destructive">{format(t.routingTokenLocked, { names: locked.join(", ") })}</p> : null}
    {routing.fields.length > 0 && !valid && !locked.length ? <p role="alert" className="text-destructive">{t.routingTokenInvalid}</p> : null}
    <fieldset disabled={status === "saving"} className="min-w-0 space-y-3">
      <legend className="sr-only">{t.routingFields}</legend>
      {routing.fields.map((field) => {
        const selected = field.targetIds.some((id) => selectedTargetIds.includes(id));
        const locations = tokenTargetLocations(snapshot, field.targetIds);
        return <section key={field.id} aria-label={field.name} data-template-routing-field={selected ? "selected" : "mapped"} className={cn("min-w-0 space-y-3 rounded-lg border p-3", selected && "border-blue-500 bg-blue-50/50")}>
          <code className="block break-all font-semibold">{`{{${field.name}}}`}</code>
          <p className="break-words text-xs text-muted-foreground">{locations.length ? locations.join(", ") : selected ? t.routingMappedToSelection : format(t.routingMappedObjects, { count: field.targetIds.length })}</p>
          <label className="block space-y-1"><span>{t.routingFieldLabel}</span><input maxLength={200} value={field.label} onChange={(event) => updateField(field.id, { label: event.target.value })} className={inputClass} /></label>
          <div className="space-y-1"><span>{t.routingFieldType}</span><Select value={field.type} onValueChange={(value) => { if (TYPES.includes(value as OfficeTemplateField["type"])) updateField(field.id, { type: value as OfficeTemplateField["type"] }); }} disabled={status === "saving"}>
            <SelectTrigger aria-label={t.routingFieldType} className="max-sm:min-h-11 w-full text-base md:text-sm">{t.routingFieldTypes[field.type]}</SelectTrigger>
            <SelectContent>{TYPES.map((type) => <SelectItem key={type} value={type} className="min-h-8 max-sm:min-h-11">{t.routingFieldTypes[type]}</SelectItem>)}</SelectContent>
          </Select></div>
          <label className="flex min-h-8 max-sm:min-h-11 cursor-pointer items-center gap-2"><Checkbox checked={field.required} disabled={status === "saving"} onCheckedChange={(required) => updateField(field.id, { required })} aria-label={t.routingRequired} /><span>{t.routingRequired}</span></label>
          <label className="block space-y-1"><span>{t.routingTokenMaxLength}</span><input type="number" inputMode="numeric" min={1} max={1_000_000} step={1} value={field.maxLength ?? ""} onChange={(event) => updateField(field.id, { maxLength: event.target.value === "" ? undefined : Number(event.target.value) })} className={inputClass} /><span className="block text-xs text-muted-foreground">{t.routingTokenMaxLengthHelp}</span></label>
          <label className="block space-y-1"><span>{t.routingInstruction}</span><textarea maxLength={4_000} value={field.aiInstruction} onChange={(event) => updateField(field.id, { aiInstruction: event.target.value })} className={cn(inputClass, "min-h-24 py-2")} /></label>
        </section>;
      })}
    </fieldset>
    <div className="sticky bottom-0 -mx-3 space-y-2 border-t bg-background px-3 py-3">
      <p role="status" className={cn("text-xs", status === "saveFailed" ? "text-destructive" : "text-muted-foreground")}>{status === "saveFailed" ? t.routingSaveFailed : dirty ? t.routingUnsaved : status === "saved" ? t.routingSaved : t.routingTokenReview}</p>
      <button type="button" disabled={!valid || !dirty || status === "saving"} onClick={() => void save()} className="min-h-8 max-sm:min-h-11 w-full rounded bg-action px-3 font-medium text-action-foreground disabled:opacity-50">{status === "saving" ? t.routingSaving : t.routingSave}</button>
    </div>
  </div>;
}

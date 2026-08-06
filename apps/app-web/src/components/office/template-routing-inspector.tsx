"use client";

import { useEffect, useMemo, useState } from "react";
import { Check, Route, Sparkles, Trash2 } from "lucide-react";
import { presentationTextCapacity, type OfficeTemplateField, type OfficeTemplateRoutingDraft, type OfficeTemplateSlideRecipe, type PresentationObject, type PresentationSnapshot } from "@use-brian/office-model";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { format, useT } from "@/lib/i18n/client";
import { getOfficeTemplateRouting, saveOfficeTemplateRouting, type OfficeTemplateSlideRole } from "@/lib/office/api";
import { cn } from "@/lib/utils";

const ROLES: OfficeTemplateSlideRole[] = ["cover", "agenda", "section", "narrative", "comparison", "metrics", "timeline", "process", "caseStudy", "team", "quote", "closing", "appendix"];
const TEXT_TYPES: OfficeTemplateField["type"][] = ["plainText", "richText", "bulletList", "date", "number"];
const RECIPE_NAME_MAX_LENGTH = 200;

export function templateRecipeName(title: string, slideIndex: number): string {
  const normalized = title.replace(/\s+/g, " ").trim();
  if (!normalized) return `Slide ${slideIndex + 1}`;
  if (normalized.length <= RECIPE_NAME_MAX_LENGTH) return normalized;
  return `${normalized.slice(0, RECIPE_NAME_MAX_LENGTH - 3).trimEnd()}...`;
}

export type TemplateRoutingInspectorState = { ready: boolean; dirty: boolean; saving: boolean };

export function recipeForSelectedTargets(routing: OfficeTemplateRoutingDraft, snapshot: PresentationSnapshot, targetIds: string[]): OfficeTemplateSlideRecipe | undefined {
  const targets = new Set(targetIds);
  const direct = routing.slideRecipes.find((recipe) => targets.has(recipe.slideId));
  if (direct) return direct;
  const fields = new Map(routing.fields.map((field) => [field.id, field]));
  const mapped = routing.slideRecipes.find((recipe) => recipe.fieldIds.some((fieldId) => fields.get(fieldId)?.targetIds.some((targetId) => targets.has(targetId))));
  if (mapped) return mapped;
  const selectedSlide = snapshot.slides.find((slide) => slide.objects.some((object) => targets.has(object.id)));
  return selectedSlide ? routing.slideRecipes.find((recipe) => recipe.slideId === selectedSlide.id) : undefined;
}

function objectForTargets(snapshot: PresentationSnapshot, targetIds: string[]): PresentationObject | undefined {
  const targets = new Set(targetIds);
  return snapshot.slides.flatMap((slide) => slide.objects).find((object) => targets.has(object.id));
}

function allowedFieldTypes(object: PresentationObject | undefined, current: OfficeTemplateField["type"]): OfficeTemplateField["type"][] {
  if (!object) return [current];
  if (object.kind === "text" || object.kind === "shape" && object.text.length > 0) return TEXT_TYPES;
  if (object.kind === "image") return ["image"];
  if (object.kind === "table") return ["table"];
  if (object.kind === "chart") return ["chartData"];
  if (object.kind === "video") return ["video"];
  return [current];
}

function fieldTypeForObject(object: PresentationObject): OfficeTemplateField["type"] | null {
  if (object.kind === "text" || object.kind === "shape" && object.text.length > 0) return "richText";
  if (object.kind === "image") return "image";
  if (object.kind === "table") return "table";
  if (object.kind === "chart") return "chartData";
  if (object.kind === "video") return "video";
  return null;
}

function selectedObjectLabel(object: PresentationObject): string {
  if (object.kind === "text") return object.runs.map((run) => run.text).join(" ").trim().slice(0, 80) || "Text";
  if (object.kind === "shape") return object.text.map((run) => run.text).join(" ").trim().slice(0, 80) || "Shape";
  if (object.kind === "chart") return object.title;
  if (object.kind === "image") return object.altText || "Image";
  if (object.kind === "video") return object.altText || "Video";
  if (object.kind === "table") return "Table";
  return "Content";
}

export function TemplateRoutingInspector({ templateId, snapshot, selectedTargetIds, initialRouting, onStateChange }: {
  templateId: string;
  snapshot: PresentationSnapshot;
  selectedTargetIds: string[];
  initialRouting?: OfficeTemplateRoutingDraft;
  onStateChange?: (state: TemplateRoutingInspectorState) => void;
}) {
  const t = useT().office;
  const [routing, setRouting] = useState<OfficeTemplateRoutingDraft | null>(initialRouting ?? null);
  const [activeRecipeId, setActiveRecipeId] = useState<string | null>(initialRouting?.slideRecipes[0]?.id ?? null);
  const [status, setStatus] = useState<"loading" | "ready" | "dirty" | "saving" | "saved" | "failed">(initialRouting ? "ready" : "loading");

  useEffect(() => {
    if (initialRouting) return;
    let active = true;
    setStatus("loading");
    void getOfficeTemplateRouting(templateId).then((value) => {
      if (!active) return;
      setRouting(value);
      setActiveRecipeId(value.slideRecipes[0]?.id ?? null);
      setStatus("ready");
    }).catch(() => { if (active) setStatus("failed"); });
    return () => { active = false; };
  }, [initialRouting, templateId]);

  useEffect(() => {
    if (!routing) return;
    const selected = recipeForSelectedTargets(routing, snapshot, selectedTargetIds);
    if (selected) setActiveRecipeId(selected.id);
  }, [routing, selectedTargetIds, snapshot]);

  useEffect(() => {
    if (!routing) return;
    const existing = new Map(routing.slideRecipes.map((candidate) => [candidate.slideId, candidate]));
    const fieldsById = new Map(routing.fields.map((field) => [field.id, field]));
    let changed = false;
    const nextRecipes = snapshot.slides.map((slide, index) => {
      const name = templateRecipeName(slide.title, index);
      const current = existing.get(slide.id);
      if (!current) {
        changed = true;
        return {
          id: crypto.randomUUID(),
          slideId: slide.id,
          name,
          role: index === 0 ? "cover" as const : index === snapshot.slides.length - 1 ? "closing" as const : "narrative" as const,
          whenToUse: t.routingNewSlideWhenToUse,
          whenNotToUse: t.routingNewSlideWhenNotToUse,
          enabled: false,
          repeatable: false,
          minUses: 0,
          maxUses: 1,
          fieldIds: [],
          confidence: 0,
          inference: t.routingNewSlideInference,
          reviewed: false,
        };
      }
      const objectIds = new Set(slide.objects.map((object) => object.id));
      const fieldIds = current.fieldIds.filter((fieldId) => fieldsById.get(fieldId)?.targetIds.every((targetId) => objectIds.has(targetId)));
      if (current.name === name && fieldIds.length === current.fieldIds.length) return current;
      changed = true;
      return { ...current, name, fieldIds, inference: t.routingChangedSlideInference, reviewed: false };
    });
    if (nextRecipes.length !== routing.slideRecipes.length || nextRecipes.some((candidate, index) => candidate.id !== routing.slideRecipes[index]?.id)) changed = true;
    if (!changed) return;
    const keptFieldIds = new Set(nextRecipes.flatMap((candidate) => candidate.fieldIds));
    setRouting({ ...routing, fields: routing.fields.filter((field) => keptFieldIds.has(field.id)), slideRecipes: nextRecipes });
    setActiveRecipeId((current) => nextRecipes.some((candidate) => candidate.id === current) ? current : nextRecipes[0]?.id ?? null);
    setStatus("dirty");
  }, [routing, snapshot.slides, t.routingChangedSlideInference, t.routingNewSlideInference, t.routingNewSlideWhenNotToUse, t.routingNewSlideWhenToUse]);

  useEffect(() => {
    onStateChange?.({ ready: Boolean(routing) && status !== "failed" && status !== "loading", dirty: status === "dirty", saving: status === "saving" });
  }, [onStateChange, routing, status]);

  const recipe = routing?.slideRecipes.find((candidate) => candidate.id === activeRecipeId) ?? routing?.slideRecipes[0];
  const selectedObject = useMemo(() => objectForTargets(snapshot, selectedTargetIds), [selectedTargetIds, snapshot]);
  const fields = recipe && routing ? recipe.fieldIds.map((fieldId) => routing.fields.find((field) => field.id === fieldId)).filter((field): field is OfficeTemplateField => Boolean(field)) : [];
  const selectedField = selectedObject ? fields.find((field) => field.targetIds.includes(selectedObject.id)) : undefined;

  function updateRecipe(patch: Partial<OfficeTemplateSlideRecipe>) {
    if (!routing || !recipe) return;
    setRouting({ ...routing, slideRecipes: routing.slideRecipes.map((candidate) => candidate.id === recipe.id ? { ...candidate, ...patch, reviewed: true } : candidate) });
    setStatus("dirty");
  }

  function updateField(fieldId: string, patch: Partial<OfficeTemplateField>) {
    if (!routing || !recipe) return;
    setRouting({
      ...routing,
      fields: routing.fields.map((field) => field.id === fieldId ? { ...field, ...patch } : field),
      slideRecipes: routing.slideRecipes.map((candidate) => candidate.id === recipe.id ? { ...candidate, reviewed: true } : candidate),
    });
    setStatus("dirty");
  }

  function removeField(fieldId: string) {
    if (!routing || !recipe) return;
    setRouting({
      ...routing,
      fields: routing.fields.filter((field) => field.id !== fieldId),
      slideRecipes: routing.slideRecipes.map((candidate) => candidate.id === recipe.id ? { ...candidate, fieldIds: candidate.fieldIds.filter((id) => id !== fieldId), reviewed: true } : candidate),
    });
    setStatus("dirty");
  }

  function addSelectedObject() {
    if (!routing || !recipe || !selectedObject || selectedObject.locked || selectedField) return;
    const type = fieldTypeForObject(selectedObject);
    if (!type) return;
    const fieldId = crypto.randomUUID();
    const nextNumber = recipe.fieldIds.length + 1;
    const maxLength = presentationTextCapacity(selectedObject);
    const field: OfficeTemplateField = {
      id: fieldId,
      name: `${recipe.role.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}.content-${nextNumber}`,
      label: selectedObjectLabel(selectedObject),
      type,
      required: false,
      repeating: false,
      minItems: 0,
      maxItems: 1,
      ...(maxLength ? { maxLength } : {}),
      targetIds: [selectedObject.id],
      aiInstruction: t.routingDefaultInstruction,
      locked: false,
    };
    setRouting({
      ...routing,
      fields: [...routing.fields, field],
      slideRecipes: routing.slideRecipes.map((candidate) => candidate.id === recipe.id ? { ...candidate, fieldIds: [...candidate.fieldIds, fieldId], reviewed: true } : candidate),
    });
    setStatus("dirty");
  }

  async function save() {
    if (!routing || (status !== "dirty" && status !== "failed")) return;
    setStatus("saving");
    try {
      setRouting(await saveOfficeTemplateRouting(templateId, routing));
      setStatus("saved");
    } catch {
      setStatus("failed");
    }
  }

  if (status === "loading") return <div data-template-routing="loading" className="p-3 text-xs text-muted-foreground">{t.routingLoading}</div>;
  if (!routing || !recipe) return <div data-template-routing="failed" className="p-3 text-xs text-destructive">{t.routingLoadFailed}</div>;

  return (
    <div data-template-routing="ready" className="space-y-4 p-3 text-xs">
      <div className="space-y-1">
        <div className="flex items-center gap-2"><Route className="size-4 text-blue-600" aria-hidden /><h2 className="font-semibold">{t.routingTitle}</h2></div>
        <p className="text-muted-foreground">{t.routingDescription}</p>
      </div>

      <div className="rounded-lg border bg-muted/30 p-2.5">
        <p className="font-medium">{recipe.name}</p>
        <p className="mt-1 text-[11px] text-muted-foreground">{t.routingSelectSlide}</p>
        {!recipe.reviewed ? <p className="mt-1 text-[11px] font-medium text-amber-700">{t.routingNeedsReview}</p> : null}
      </div>

      <label className="block space-y-1.5"><span className="font-medium">{t.routingRole}</span>
        <Select value={recipe.role} onValueChange={(value) => { if (value) updateRecipe({ role: value as OfficeTemplateSlideRole }); }}>
          <SelectTrigger className="w-full">{t.routingRoles[recipe.role]}</SelectTrigger>
          <SelectContent>{ROLES.map((role) => <SelectItem key={role} value={role}>{t.routingRoles[role]}</SelectItem>)}</SelectContent>
        </Select>
      </label>

      <div className="space-y-2">
        <label className="flex items-center gap-2"><input type="checkbox" checked={recipe.enabled} onChange={(event) => updateRecipe({ enabled: event.target.checked, minUses: event.target.checked ? recipe.minUses : 0 })} /><span>{t.routingUseAutomatically}</span></label>
        <label className="flex items-center gap-2"><input type="checkbox" checked={recipe.repeatable} onChange={(event) => updateRecipe({ repeatable: event.target.checked, minUses: event.target.checked ? recipe.minUses : Math.min(1, recipe.minUses), maxUses: event.target.checked ? Math.max(2, recipe.maxUses) : 1 })} /><span>{t.routingRepeatable}</span></label>
        {recipe.enabled ? <label className="flex items-center justify-between gap-3"><span>{t.routingMinUses}</span><input type="number" min={0} max={recipe.maxUses} value={recipe.minUses} onChange={(event) => updateRecipe({ minUses: Math.max(0, Math.min(recipe.maxUses, Number(event.target.value) || 0)) })} className="h-8 w-20 rounded border bg-background px-2" /></label> : null}
        {recipe.repeatable ? <label className="flex items-center justify-between gap-3"><span>{t.routingMaxUses}</span><input type="number" min={Math.max(1, recipe.minUses)} max={100} value={recipe.maxUses} onChange={(event) => updateRecipe({ maxUses: Math.max(Math.max(1, recipe.minUses), Math.min(100, Number(event.target.value) || 1)) })} className="h-8 w-20 rounded border bg-background px-2" /></label> : null}
      </div>

      <label className="block space-y-1.5"><span className="font-medium">{t.routingWhenToUse}</span><textarea value={recipe.whenToUse} onChange={(event) => updateRecipe({ whenToUse: event.target.value })} className="min-h-20 w-full rounded border bg-background p-2" /></label>
      <label className="block space-y-1.5"><span className="font-medium">{t.routingWhenNotToUse}</span><textarea value={recipe.whenNotToUse} onChange={(event) => updateRecipe({ whenNotToUse: event.target.value })} className="min-h-16 w-full rounded border bg-background p-2" /></label>

      <div className="rounded-lg border border-blue-200 bg-blue-50/60 p-2.5 text-blue-950">
        <div className="flex items-center gap-1.5 font-medium"><Sparkles className="size-3.5" aria-hidden />{format(t.routingConfidence, { value: Math.round(recipe.confidence * 100) })}</div>
        <p className="mt-1 text-[11px] leading-relaxed"><span className="font-medium">{t.routingInference}: </span>{recipe.inference}</p>
      </div>

      <section className="space-y-2">
        <h3 className="font-semibold">{t.routingFields}</h3>
        {fields.length === 0 ? <p className="rounded border border-dashed p-3 text-muted-foreground">{t.routingNoFields}</p> : fields.map((field) => {
          const targetObject = snapshot.slides.flatMap((slide) => slide.objects).find((object) => field.targetIds.includes(object.id));
          const options = allowedFieldTypes(targetObject, field.type);
          const selected = Boolean(selectedObject && field.targetIds.includes(selectedObject.id));
          return <div key={field.id} data-template-routing-field={selected ? "selected" : "mapped"} className={cn("space-y-2 rounded-lg border p-2.5", selected && "border-blue-500 bg-blue-50/50")}>
            <input aria-label={t.routingFieldLabel} value={field.label} onChange={(event) => updateField(field.id, { label: event.target.value })} className="h-8 w-full rounded border bg-background px-2 font-medium" />
            <Select value={field.type} onValueChange={(value) => { if (value) updateField(field.id, { type: value as OfficeTemplateField["type"] }); }} disabled={options.length === 1}>
              <SelectTrigger aria-label={t.routingFieldType} className="w-full">{t.routingFieldTypes[field.type]}</SelectTrigger>
              <SelectContent>{options.map((type) => <SelectItem key={type} value={type}>{t.routingFieldTypes[type]}</SelectItem>)}</SelectContent>
            </Select>
            <label className="flex items-center gap-2"><input type="checkbox" checked={field.required} onChange={(event) => updateField(field.id, { required: event.target.checked })} /><span>{t.routingRequired}</span></label>
            <label className="block space-y-1"><span>{t.routingInstruction}</span><textarea value={field.aiInstruction} onChange={(event) => updateField(field.id, { aiInstruction: event.target.value })} className="min-h-16 w-full rounded border bg-background p-2" /></label>
            <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground"><span>{selected ? t.routingMappedToSelection : format(t.routingMappedObjects, { count: field.targetIds.length })}</span><button type="button" onClick={() => removeField(field.id)} aria-label={t.routingRemoveField} title={t.routingRemoveField} className="rounded p-1 text-destructive hover:bg-destructive/10"><Trash2 className="size-3.5" /></button></div>
          </div>;
        })}
        {selectedObject && !selectedField ? selectedObject.locked ? <p className="rounded border p-2 text-muted-foreground">{t.routingLockedSelection}</p> : fieldTypeForObject(selectedObject) ? <button type="button" onClick={addSelectedObject} className="w-full rounded border border-dashed px-3 py-2 font-medium hover:bg-muted">{t.routingAddSelected}</button> : null : null}
      </section>

      <div className="sticky bottom-0 -mx-3 flex items-center justify-between gap-2 border-t bg-background px-3 py-3">
        <span className={cn("text-[11px]", status === "failed" ? "text-destructive" : "text-muted-foreground")}>{status === "dirty" ? t.routingUnsaved : status === "saved" ? <span className="inline-flex items-center gap-1"><Check className="size-3" />{t.routingSaved}</span> : status === "failed" ? t.routingSaveFailed : null}</span>
        <button type="button" disabled={status !== "dirty" && status !== "failed"} onClick={() => void save()} className="rounded bg-action px-3 py-2 font-medium text-action-foreground disabled:opacity-50">{status === "saving" ? t.routingSaving : t.routingSave}</button>
      </div>
    </div>
  );
}

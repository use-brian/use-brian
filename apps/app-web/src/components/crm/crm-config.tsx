"use client";

import { useEffect, useState, type ReactNode } from "react";
import { Dialog } from "@base-ui/react/dialog";
import { Archive, ArrowDown, ArrowUp, Plus, RotateCcw, Save, Settings2, Star, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { confirmDialog } from "@/components/ui/confirm-dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  applyCrmFieldPreset,
  CRM_PRESET_IDS,
  createCrmField,
  archiveCrmField,
  createCrmPipeline,
  createCrmPipelineStage,
  fetchCrmConfig,
  reorderCrmFields,
  reorderCrmPipelineStages,
  reorderCrmPipelines,
  restoreCrmField,
  updateCrmField,
  updateCrmPipeline,
  updateCrmPipelineStage,
  type CrmConfig,
  type CrmFieldDefinition,
  type CrmPipeline,
  type CrmPipelineStage,
  type CrmFieldType,
  type CrmStageCategory,
  type CrmPresetId,
} from "@/lib/api/crm";
import { useT } from "@/lib/i18n/client";
import { crmFieldKeyFromLabel } from "@/lib/crm-r2";

export function CrmConfigDialog({
  workspaceId,
  open,
  onOpenChange,
  onChanged,
}: {
  workspaceId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChanged?: () => void;
}) {
  const t = useT().crmPage.r2;
  const [config, setConfig] = useState<CrmConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fieldKind, setFieldKind] = useState<"person" | "company" | "deal">("deal");
  const [fieldType, setFieldType] = useState<CrmFieldType>("text");
  const [pipelineName, setPipelineName] = useState("");
  const [addingPipeline, setAddingPipeline] = useState(false);
  const [stagePipelineId, setStagePipelineId] = useState<string | null>(null);
  const [stageName, setStageName] = useState("");
  const [stageCategory, setStageCategory] = useState<CrmStageCategory>("open");
  const [stageProbability, setStageProbability] = useState("50");
  const [fieldLabel, setFieldLabel] = useState("");
  const [fieldOptions, setFieldOptions] = useState("");
  const [referenceKinds, setReferenceKinds] = useState<Array<"person" | "company" | "deal">>(["company"]);
  const [presetResult, setPresetResult] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);

  async function reload() {
    setLoading(true);
    setError(null);
    try {
      setConfig(await fetchCrmConfig(workspaceId, true));
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    if (open) void reload().catch((cause) => setError(cause instanceof Error ? cause.message : t.configFailed));
  }, [open, workspaceId]);

  async function addPipeline() {
    const name = pipelineName.trim();
    if (!name || busy) return;
    setBusy(true);
    try {
      await createCrmPipeline(workspaceId, name);
      setPipelineName("");
      setAddingPipeline(false);
      await reload();
      onChanged?.();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t.configFailed);
    } finally {
      setBusy(false);
    }
  }

  async function addStage(pipelineId: string) {
    const name = stageName.trim();
    const probability = Number(stageProbability);
    if (!name || busy || !Number.isFinite(probability) || probability < 0 || probability > 100) return;
    setBusy(true);
    try {
      await createCrmPipelineStage(workspaceId, pipelineId, {
        name,
        category: stageCategory,
        probability,
      });
      setStagePipelineId(null);
      setStageName("");
      setStageCategory("open");
      setStageProbability("50");
      await reload();
      onChanged?.();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t.configFailed);
    } finally {
      setBusy(false);
    }
  }

  async function addField() {
    const label = fieldLabel.trim();
    if (!label) return;
    const suggested = crmFieldKeyFromLabel(label);
    if (!suggested || busy) return;
    const choices = fieldType === "single_select" || fieldType === "multi_select" ? fieldOptions : "";
    if ((fieldType === "single_select" || fieldType === "multi_select") && !choices.trim()) return;
    if (fieldType === "entity_reference" && referenceKinds.length === 0) return;
    setBusy(true);
    try {
      await createCrmField(workspaceId, {
        entityKind: fieldKind,
        fieldKey: suggested,
        label,
        fieldType,
        options: fieldType === "entity_reference"
          ? referenceKinds
          : choices.split(",").map((option) => option.trim()).filter(Boolean),
      });
      setFieldLabel("");
      setFieldOptions("");
      await reload();
      onChanged?.();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t.configFailed);
    } finally {
      setBusy(false);
    }
  }

  async function applyPreset(presetId: CrmPresetId) {
    if (busy) return;
    setBusy(true);
    setError(null);
    setPresetResult(null);
    try {
      const result = await applyCrmFieldPreset(workspaceId, presetId);
      setPresetResult(t.presetResult
        .replace("{created}", String(result.created.length + result.revived.length))
        .replace("{skipped}", String(result.skipped.length))
        .replace("{conflicts}", String(result.conflicts.length)));
      await reload();
      onChanged?.();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t.configFailed);
    } finally {
      setBusy(false);
    }
  }

  async function mutate(action: () => Promise<unknown>) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await action();
      await reload();
      onChanged?.();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t.configFailed);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-50 bg-background/80 backdrop-blur-sm" />
        <Dialog.Popup className="fixed left-1/2 top-1/2 z-50 flex max-h-[85vh] w-[calc(100%-2rem)] max-w-3xl -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-2xl border border-border bg-background shadow-xl">
          <div className="flex items-center justify-between border-b border-border px-5 py-4">
            <div>
              <Dialog.Title className="flex items-center gap-2 text-base font-semibold"><Settings2 className="size-4" aria-hidden />{t.configTitle}</Dialog.Title>
              <Dialog.Description className="mt-1 text-xs text-muted-foreground">{t.configDescription}</Dialog.Description>
            </div>
            <Button size="icon-sm" variant="ghost" onClick={() => onOpenChange(false)} aria-label={t.close}><X aria-hidden /></Button>
          </div>
          <div className="min-h-0 flex-1 space-y-6 overflow-y-auto p-5">
            {loading && !config && <div className="text-sm text-muted-foreground">{t.configLoading}</div>}
            {error && <div className="flex items-center justify-between gap-3 rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive"><span>{error}</span><Button size="xs" variant="ghost" onClick={() => void reload().catch((cause) => setError(cause instanceof Error ? cause.message : t.configFailed))}>{t.retry}</Button></div>}
            <section>
              <div className="mb-3 flex items-center justify-between">
                <div><h3 className="text-sm font-semibold">{t.pipelines}</h3><p className="text-xs text-muted-foreground">{t.pipelinesHelp}</p></div>
                <Button size="sm" variant="outline" onClick={() => setAddingPipeline((value) => !value)}><Plus aria-hidden />{t.addPipeline}</Button>
              </div>
              {addingPipeline && (
                <div className="mb-3 flex flex-wrap items-end gap-2 rounded-xl border border-border bg-muted/20 p-3">
                  <ConfigInput label={t.pipelineName} value={pipelineName} onChange={setPipelineName} />
                  <Button size="sm" disabled={busy || !pipelineName.trim()} onClick={() => void addPipeline()}>{busy ? t.saving : t.add}</Button>
                  <Button size="sm" variant="ghost" onClick={() => setAddingPipeline(false)}>{t.cancel}</Button>
                </div>
              )}
              <div className="space-y-3">
                {config?.pipelines.map((pipeline) => (
                  <PipelineConfigRow
                    key={pipeline.id}
                    workspaceId={workspaceId}
                    pipeline={pipeline}
                    livePipelines={config.pipelines.filter((candidate) => !candidate.archivedAt)}
                    busy={busy}
                    onMutate={mutate}
                  >
                    {!pipeline.archivedAt && stagePipelineId === pipeline.id && (
                      <div className="mt-3 grid gap-2 rounded-lg border border-border bg-muted/20 p-3 sm:grid-cols-[minmax(0,1fr)_140px_100px_auto]">
                        <ConfigInput label={t.stageName} value={stageName} onChange={setStageName} />
                        <label className="text-xs"><span className="mb-1 block text-muted-foreground">{t.stageCategory}</span>
                          <Select value={stageCategory} onValueChange={(value) => {
                            const category = value as CrmStageCategory;
                            setStageCategory(category);
                            setStageProbability(category === "won" ? "100" : category === "lost" ? "0" : "50");
                          }}>
                            <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                            <SelectContent>{(["open", "won", "lost"] as const).map((category) => <SelectItem key={category} value={category}>{t.stageCategories[category]}</SelectItem>)}</SelectContent>
                          </Select>
                        </label>
                        <ConfigInput label={t.stageProbability} type="number" value={stageProbability} onChange={setStageProbability} />
                        <Button className="self-end" size="sm" disabled={busy || !stageName.trim()} onClick={() => void addStage(pipeline.id)}>{busy ? t.saving : t.add}</Button>
                      </div>
                    )}
                    {!pipeline.archivedAt ? (
                      <Button className="mt-2" size="xs" variant="ghost" onClick={() => setStagePipelineId((current) => current === pipeline.id ? null : pipeline.id)}><Plus aria-hidden />{t.addStage}</Button>
                    ) : null}
                  </PipelineConfigRow>
                ))}
              </div>
            </section>

            <section className="border-t border-border pt-5">
              <div className="mb-5">
                <div className="mb-3"><h3 className="text-sm font-semibold">{t.fieldPresets}</h3><p className="text-xs text-muted-foreground">{t.fieldPresetsHelp}</p></div>
                <div className="grid gap-2 sm:grid-cols-3">
                  {CRM_PRESET_IDS.map((presetId) => (
                    <div key={presetId} className="rounded-xl border border-border p-3">
                      <div className="text-xs font-medium">{t.presetNames[presetId]}</div>
                      <div className="mt-1 min-h-8 text-[11px] text-muted-foreground">{t.presetDescriptions[presetId]}</div>
                      <Button className="mt-3" size="xs" variant="outline" disabled={busy} onClick={() => void applyPreset(presetId)}>{t.applyPreset}</Button>
                    </div>
                  ))}
                </div>
                {presetResult && <div className="mt-2 text-xs text-muted-foreground">{presetResult}</div>}
              </div>
              <div className="mb-3"><h3 className="text-sm font-semibold">{t.customFields}</h3><p className="text-xs text-muted-foreground">{t.fieldsHelp}</p></div>
              <div className="mb-3 grid gap-2 rounded-xl border border-border bg-muted/20 p-3 sm:grid-cols-2 lg:grid-cols-[150px_150px_minmax(0,1fr)_auto]">
                <Select value={fieldKind} onValueChange={(value) => setFieldKind(value as typeof fieldKind)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="person">{t.kindContact}</SelectItem>
                    <SelectItem value="company">{t.kindCompany}</SelectItem>
                    <SelectItem value="deal">{t.kindDeal}</SelectItem>
                  </SelectContent>
                </Select>
                <Select value={fieldType} onValueChange={(value) => setFieldType(value as CrmFieldType)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {(["text", "number", "date", "boolean", "single_select", "multi_select", "entity_reference"] as CrmFieldType[]).map((type) => (
                      <SelectItem key={type} value={type}>{t.fieldTypes[type]}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <ConfigInput label={t.fieldLabel} value={fieldLabel} onChange={setFieldLabel} />
                <Button className="self-end" size="sm" disabled={busy || !fieldLabel.trim()} onClick={() => void addField()}><Plus aria-hidden />{t.addField}</Button>
                {(fieldType === "single_select" || fieldType === "multi_select") && (
                  <div className="sm:col-span-2 lg:col-span-4">
                    <ConfigInput label={t.fieldOptions} value={fieldOptions} onChange={setFieldOptions} placeholder={t.fieldOptionsPlaceholder} />
                  </div>
                )}
                {fieldType === "entity_reference" && (
                  <div className="sm:col-span-2 lg:col-span-4">
                    <div className="mb-1 text-xs text-muted-foreground">{t.referenceTargets}</div>
                    <div className="flex flex-wrap gap-2">{(["person", "company", "deal"] as const).map((target) => (
                      <Button key={target} size="xs" variant={referenceKinds.includes(target) ? "default" : "outline"} onClick={() => setReferenceKinds((current) => current.includes(target) ? current.filter((item) => item !== target) : [...current, target])}>
                        {target === "person" ? t.kindContact : target === "company" ? t.kindCompany : t.kindDeal}
                      </Button>
                    ))}</div>
                  </div>
                )}
              </div>
              <div className="grid gap-2 sm:grid-cols-2">
                {config?.fields.map((field) => (
                  <FieldConfigRow
                    key={field.id}
                    workspaceId={workspaceId}
                    field={field}
                    liveFields={config.fields.filter((candidate) =>
                      !candidate.archivedAt && candidate.entityKind === field.entityKind)}
                    busy={busy}
                    onMutate={mutate}
                  />
                ))}
                {config?.fields.length === 0 && <div className="text-xs text-muted-foreground">{t.noFields}</div>}
              </div>
            </section>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function PipelineConfigRow({ workspaceId, pipeline, livePipelines, busy, onMutate, children }: {
  workspaceId: string;
  pipeline: CrmPipeline;
  livePipelines: CrmPipeline[];
  busy: boolean;
  onMutate: (action: () => Promise<unknown>) => Promise<void>;
  children: ReactNode;
}) {
  const t = useT().crmPage.r2;
  const [name, setName] = useState(pipeline.name);
  useEffect(() => setName(pipeline.name), [pipeline.name]);
  const index = livePipelines.findIndex((candidate) => candidate.id === pipeline.id);
  async function move(offset: number) {
    const next = [...livePipelines];
    const target = index + offset;
    if (index < 0 || target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    await onMutate(() => reorderCrmPipelines(workspaceId, next.map((row) => row.id)));
  }
  return (
    <div className={pipeline.archivedAt ? "rounded-xl border border-dashed border-border p-3 opacity-75" : "rounded-xl border border-border p-3"}>
      <div className="flex flex-wrap items-center gap-2">
        <input
          value={name}
          disabled={busy || Boolean(pipeline.archivedAt)}
          aria-label={t.pipelineName}
          onChange={(event) => setName(event.target.value)}
          className="h-8 min-w-36 flex-1 rounded-md border border-border bg-background px-2 text-sm font-medium outline-none"
        />
        {pipeline.isDefault ? <span className="text-[10px] text-muted-foreground">{t.defaultPipeline}</span> : null}
        {!pipeline.archivedAt ? (
          <>
            <Button size="icon-xs" variant="ghost" disabled={busy || index <= 0} aria-label={t.moveUp} onClick={() => void move(-1)}><ArrowUp aria-hidden /></Button>
            <Button size="icon-xs" variant="ghost" disabled={busy || index === livePipelines.length - 1} aria-label={t.moveDown} onClick={() => void move(1)}><ArrowDown aria-hidden /></Button>
            <Button size="icon-xs" variant="ghost" disabled={busy || name.trim() === pipeline.name || !name.trim()} aria-label={t.save} onClick={() => void onMutate(() => updateCrmPipeline(workspaceId, pipeline.id, { name: name.trim() }))}><Save aria-hidden /></Button>
            {!pipeline.isDefault ? <Button size="icon-xs" variant="ghost" disabled={busy} aria-label={t.makeDefault} onClick={() => void (async () => {
              const confirmed = await confirmDialog({ title: t.makeDefaultTitle, description: t.makeDefaultDescription.replace("{name}", pipeline.name), confirmLabel: t.makeDefault, cancelLabel: t.cancel });
              if (confirmed) await onMutate(() => updateCrmPipeline(workspaceId, pipeline.id, { isDefault: true }));
            })()}><Star aria-hidden /></Button> : null}
            <Button size="icon-xs" variant="ghost" disabled={busy || pipeline.isDefault} aria-label={t.archivePipeline} onClick={() => void (async () => {
              const confirmed = await confirmDialog({ title: t.archivePipelineTitle, description: t.archivePipelineDescription.replace("{name}", pipeline.name), confirmLabel: t.archive, cancelLabel: t.cancel, variant: "destructive" });
              if (confirmed) await onMutate(() => updateCrmPipeline(workspaceId, pipeline.id, { archived: true }));
            })()}><Archive aria-hidden /></Button>
          </>
        ) : (
          <Button size="xs" variant="outline" disabled={busy} onClick={() => void onMutate(() => updateCrmPipeline(workspaceId, pipeline.id, { archived: false }))}><RotateCcw aria-hidden />{t.restore}</Button>
        )}
      </div>
      {!pipeline.archivedAt ? (
        <div className="mt-2 space-y-2">
          {pipeline.stages.map((stage) => (
            <StageConfigRow
              key={stage.id}
              workspaceId={workspaceId}
              pipelineId={pipeline.id}
              stage={stage}
              liveStages={pipeline.stages.filter((candidate) => !candidate.archivedAt)}
              busy={busy}
              onMutate={onMutate}
            />
          ))}
          {pipeline.stages.length === 0 ? <span className="text-xs text-muted-foreground">{t.noStages}</span> : null}
        </div>
      ) : null}
      {children}
    </div>
  );
}

function StageConfigRow({ workspaceId, pipelineId, stage, liveStages, busy, onMutate }: {
  workspaceId: string;
  pipelineId: string;
  stage: CrmPipelineStage;
  liveStages: CrmPipelineStage[];
  busy: boolean;
  onMutate: (action: () => Promise<unknown>) => Promise<void>;
}) {
  const t = useT().crmPage.r2;
  const [name, setName] = useState(stage.name);
  const [category, setCategory] = useState<CrmStageCategory>(stage.category);
  const [probability, setProbability] = useState(String(stage.probability));
  const [requiredFields, setRequiredFields] = useState(stage.requiredFields.join(", "));
  useEffect(() => {
    setName(stage.name);
    setCategory(stage.category);
    setProbability(String(stage.probability));
    setRequiredFields(stage.requiredFields.join(", "));
  }, [stage]);
  const index = liveStages.findIndex((candidate) => candidate.id === stage.id);
  async function move(offset: number) {
    const next = [...liveStages];
    const target = index + offset;
    if (index < 0 || target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    await onMutate(() => reorderCrmPipelineStages(workspaceId, pipelineId, next.map((row) => row.id)));
  }
  const changed = name.trim() !== stage.name || category !== stage.category
    || Number(probability) !== stage.probability
    || requiredFields !== stage.requiredFields.join(", ");
  return (
    <div className={stage.archivedAt ? "grid gap-2 rounded-lg border border-dashed border-border p-2 opacity-75 sm:grid-cols-[minmax(0,1fr)_120px_80px_minmax(0,1fr)_auto]" : "grid gap-2 rounded-lg border border-border p-2 sm:grid-cols-[minmax(0,1fr)_120px_80px_minmax(0,1fr)_auto]"}>
      <input value={name} disabled={busy || Boolean(stage.archivedAt)} aria-label={t.stageName} onChange={(event) => setName(event.target.value)} className="h-8 rounded-md border border-border bg-background px-2 text-xs" />
      <Select value={category} disabled={busy || Boolean(stage.archivedAt)} onValueChange={(value) => setCategory(value as CrmStageCategory)}><SelectTrigger className="h-8"><SelectValue /></SelectTrigger><SelectContent>{(["open", "won", "lost"] as const).map((value) => <SelectItem key={value} value={value}>{t.stageCategories[value]}</SelectItem>)}</SelectContent></Select>
      <input type="number" min={0} max={100} value={probability} disabled={busy || Boolean(stage.archivedAt)} aria-label={t.stageProbability} onChange={(event) => setProbability(event.target.value)} className="h-8 rounded-md border border-border bg-background px-2 text-xs" />
      <input value={requiredFields} disabled={busy || Boolean(stage.archivedAt)} aria-label={t.requiredFields} placeholder={t.requiredFieldsPlaceholder} onChange={(event) => setRequiredFields(event.target.value)} className="h-8 rounded-md border border-border bg-background px-2 text-xs" />
      <div className="flex items-center justify-end gap-1">
        {!stage.archivedAt ? <>
          <Button size="icon-xs" variant="ghost" disabled={busy || index <= 0} aria-label={t.moveUp} onClick={() => void move(-1)}><ArrowUp aria-hidden /></Button>
          <Button size="icon-xs" variant="ghost" disabled={busy || index === liveStages.length - 1} aria-label={t.moveDown} onClick={() => void move(1)}><ArrowDown aria-hidden /></Button>
          <Button size="icon-xs" variant="ghost" disabled={busy || !changed || !name.trim()} aria-label={t.save} onClick={() => void onMutate(() => updateCrmPipelineStage(workspaceId, stage.id, { name: name.trim(), category, probability: Number(probability), requiredFields: requiredFields.split(",").map((value) => value.trim()).filter(Boolean) }))}><Save aria-hidden /></Button>
          <Button size="icon-xs" variant="ghost" disabled={busy} aria-label={t.archiveStage} onClick={() => void (async () => {
            const confirmed = await confirmDialog({ title: t.archiveStageTitle, description: t.archiveStageDescription.replace("{name}", stage.name), confirmLabel: t.archive, cancelLabel: t.cancel, variant: "destructive" });
            if (confirmed) await onMutate(() => updateCrmPipelineStage(workspaceId, stage.id, { archived: true }));
          })()}><Archive aria-hidden /></Button>
        </> : <Button size="xs" variant="outline" disabled={busy} onClick={() => void onMutate(() => updateCrmPipelineStage(workspaceId, stage.id, { archived: false }))}><RotateCcw aria-hidden />{t.restore}</Button>}
      </div>
    </div>
  );
}

function FieldConfigRow({ workspaceId, field, liveFields, busy, onMutate }: {
  workspaceId: string;
  field: CrmFieldDefinition;
  liveFields: CrmFieldDefinition[];
  busy: boolean;
  onMutate: (action: () => Promise<unknown>) => Promise<void>;
}) {
  const t = useT().crmPage.r2;
  const [label, setLabel] = useState(field.label);
  const [options, setOptions] = useState(field.options.join(", "));
  const [required, setRequired] = useState(field.isRequired);
  useEffect(() => {
    setLabel(field.label);
    setOptions(field.options.join(", "));
    setRequired(field.isRequired);
  }, [field]);
  const index = liveFields.findIndex((candidate) => candidate.id === field.id);
  async function move(offset: number) {
    const next = [...liveFields];
    const target = index + offset;
    if (index < 0 || target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    await onMutate(() => reorderCrmFields(workspaceId, field.entityKind, next.map((row) => row.id)));
  }
  const changed = label.trim() !== field.label || options !== field.options.join(", ") || required !== field.isRequired;
  return (
    <div className={field.archivedAt ? "rounded-lg border border-dashed border-border p-3 opacity-75" : "rounded-lg border border-border p-3"}>
      <div className="flex items-center gap-2">
        <input value={label} disabled={busy || Boolean(field.archivedAt)} aria-label={t.fieldLabel} onChange={(event) => setLabel(event.target.value)} className="h-8 min-w-0 flex-1 rounded-md border border-border bg-background px-2 text-xs font-medium" />
        {!field.archivedAt ? <>
          <Button size="icon-xs" variant="ghost" disabled={busy || index <= 0} aria-label={t.moveUp} onClick={() => void move(-1)}><ArrowUp aria-hidden /></Button>
          <Button size="icon-xs" variant="ghost" disabled={busy || index === liveFields.length - 1} aria-label={t.moveDown} onClick={() => void move(1)}><ArrowDown aria-hidden /></Button>
          <Button size="icon-xs" variant="ghost" disabled={busy || !changed || !label.trim()} aria-label={t.save} onClick={() => void onMutate(() => updateCrmField(workspaceId, field.id, { label: label.trim(), options: options.split(",").map((value) => value.trim()).filter(Boolean), isRequired: required }))}><Save aria-hidden /></Button>
          <Button size="icon-xs" variant="ghost" disabled={busy} aria-label={t.archiveField} onClick={() => void (async () => {
            const confirmed = await confirmDialog({ title: t.archiveFieldTitle, description: t.archiveFieldDescription.replace("{name}", field.label), confirmLabel: t.archive, cancelLabel: t.cancel, variant: "destructive" });
            if (confirmed) await onMutate(() => archiveCrmField(workspaceId, field.id));
          })()}><Trash2 aria-hidden /></Button>
        </> : <Button size="xs" variant="outline" disabled={busy} onClick={() => void onMutate(() => restoreCrmField(workspaceId, field.id))}><RotateCcw aria-hidden />{t.restore}</Button>}
      </div>
      <div className="mt-1 text-[10px] text-muted-foreground">{field.entityKind === "person" ? t.kindContact : field.entityKind === "company" ? t.kindCompany : t.kindDeal} · {t.fieldTypes[field.fieldType]} · {field.fieldKey}</div>
      {!field.archivedAt ? <div className="mt-2 flex items-center gap-2">
        {field.options.length > 0 || field.fieldType === "single_select" || field.fieldType === "multi_select" || field.fieldType === "entity_reference" ? <input value={options} aria-label={t.fieldOptions} onChange={(event) => setOptions(event.target.value)} className="h-8 min-w-0 flex-1 rounded-md border border-border bg-background px-2 text-xs" /> : <span className="flex-1" />}
        <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground"><Checkbox checked={required} onCheckedChange={(checked) => setRequired(Boolean(checked))} />{t.requiredField}</label>
      </div> : null}
    </div>
  );
}

function ConfigInput({ label, value, onChange, placeholder, type = "text" }: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  type?: "text" | "number";
}) {
  return (
    <label className="min-w-0 text-xs">
      <span className="mb-1 block text-muted-foreground">{label}</span>
      <input
        type={type}
        min={type === "number" ? 0 : undefined}
        max={type === "number" ? 100 : undefined}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        className="h-9 w-full rounded-lg border border-border bg-background px-3 text-sm outline-none"
      />
    </label>
  );
}

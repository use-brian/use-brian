"use client";

import { useEffect, useState } from "react";
import { Dialog } from "@base-ui/react/dialog";
import { Plus, Settings2, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { confirmDialog } from "@/components/ui/confirm-dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  createCrmField,
  archiveCrmField,
  createCrmPipeline,
  createCrmPipelineStage,
  fetchCrmConfig,
  type CrmConfig,
  type CrmFieldType,
  type CrmStageCategory,
} from "@/lib/api/crm";
import { useT } from "@/lib/i18n/client";

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
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);

  async function reload() {
    setLoading(true);
    setError(null);
    try {
      setConfig(await fetchCrmConfig(workspaceId));
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
    const suggested = label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 63);
    if (!suggested || busy) return;
    const choices = fieldType === "single_select" || fieldType === "multi_select" ? fieldOptions : "";
    if ((fieldType === "single_select" || fieldType === "multi_select") && !choices.trim()) return;
    setBusy(true);
    try {
      await createCrmField(workspaceId, {
        entityKind: fieldKind,
        fieldKey: suggested,
        label,
        fieldType,
        options: choices.split(",").map((option) => option.trim()).filter(Boolean),
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
                  <div key={pipeline.id} className="rounded-xl border border-border p-3">
                    <div className="flex items-center justify-between gap-2">
                      <div className="text-sm font-medium">{pipeline.name}{pipeline.isDefault ? <span className="ml-2 text-[10px] text-muted-foreground">{t.defaultPipeline}</span> : null}</div>
                      <Button size="xs" variant="ghost" onClick={() => setStagePipelineId((current) => current === pipeline.id ? null : pipeline.id)}><Plus aria-hidden />{t.addStage}</Button>
                    </div>
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {pipeline.stages.map((stage) => (
                        <span key={stage.id} className="rounded-full border border-border bg-muted/30 px-2 py-1 text-[11px]">
                          {stage.name} · {stage.probability}% · {t.stageCategories[stage.category]}
                        </span>
                      ))}
                      {pipeline.stages.length === 0 && <span className="text-xs text-muted-foreground">{t.noStages}</span>}
                    </div>
                    {stagePipelineId === pipeline.id && (
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
                  </div>
                ))}
              </div>
            </section>

            <section className="border-t border-border pt-5">
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
                    {(["text", "number", "date", "boolean", "single_select", "multi_select"] as CrmFieldType[]).map((type) => (
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
              </div>
              <div className="grid gap-2 sm:grid-cols-2">
                {config?.fields.map((field) => (
                  <div key={field.id} className="flex items-center justify-between gap-2 rounded-lg border border-border px-3 py-2">
                    <div className="min-w-0">
                      <div className="truncate text-xs font-medium">{field.label}</div>
                      <div className="mt-0.5 truncate text-[10px] text-muted-foreground">{field.entityKind === "person" ? t.kindContact : field.entityKind === "company" ? t.kindCompany : t.kindDeal} · {t.fieldTypes[field.fieldType]}</div>
                    </div>
                    <Button size="icon-xs" variant="ghost" aria-label={t.archiveField} onClick={() => void (async () => {
                      const confirmed = await confirmDialog({
                        title: t.archiveFieldTitle,
                        description: t.archiveFieldDescription.replace("{name}", field.label),
                        confirmLabel: t.archive,
                        cancelLabel: t.cancel,
                        variant: "destructive",
                      });
                      if (!confirmed) return;
                      try {
                        await archiveCrmField(workspaceId, field.id);
                        await reload();
                        onChanged?.();
                      } catch (cause) {
                        setError(cause instanceof Error ? cause.message : t.configFailed);
                      }
                    })()}><Trash2 aria-hidden /></Button>
                  </div>
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

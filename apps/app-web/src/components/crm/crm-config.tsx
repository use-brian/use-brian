"use client";

import { useEffect, useState } from "react";
import { Dialog } from "@base-ui/react/dialog";
import { Plus, Settings2, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { confirmDialog } from "@/components/ui/confirm-dialog";
import { promptDialog } from "@/components/ui/prompt-dialog";
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
}: {
  workspaceId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useT().crmPage.r2;
  const [config, setConfig] = useState<CrmConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fieldKind, setFieldKind] = useState<"person" | "company" | "deal">("deal");
  const [fieldType, setFieldType] = useState<CrmFieldType>("text");

  async function reload() {
    setConfig(await fetchCrmConfig(workspaceId));
  }
  useEffect(() => {
    if (open) void reload().catch((cause) => setError(cause instanceof Error ? cause.message : t.configFailed));
  }, [open, workspaceId]);

  async function addPipeline() {
    const name = await promptDialog({
      title: t.addPipeline,
      placeholder: t.pipelineName,
      confirmLabel: t.add,
      cancelLabel: t.cancel,
    });
    if (!name) return;
    try {
      await createCrmPipeline(workspaceId, name);
      await reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t.configFailed);
    }
  }

  async function addStage(pipelineId: string) {
    const name = await promptDialog({ title: t.addStage, placeholder: t.stageName, confirmLabel: t.next, cancelLabel: t.cancel });
    if (!name) return;
    const categoryRaw = await promptDialog({
      title: t.stageCategory,
      description: t.stageCategoryHelp,
      defaultValue: "open",
      placeholder: "open / won / lost",
      confirmLabel: t.next,
      cancelLabel: t.cancel,
    });
    if (!categoryRaw || !["open", "won", "lost"].includes(categoryRaw)) return;
    const probabilityRaw = await promptDialog({
      title: t.stageProbability,
      defaultValue: categoryRaw === "won" ? "100" : categoryRaw === "lost" ? "0" : "50",
      placeholder: "0-100",
      confirmLabel: t.add,
      cancelLabel: t.cancel,
    });
    const probability = Number(probabilityRaw);
    if (!Number.isFinite(probability) || probability < 0 || probability > 100) return;
    try {
      await createCrmPipelineStage(workspaceId, pipelineId, {
        name,
        category: categoryRaw as CrmStageCategory,
        probability,
      });
      await reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t.configFailed);
    }
  }

  async function addField() {
    const label = await promptDialog({ title: t.addField, placeholder: t.fieldLabel, confirmLabel: t.next, cancelLabel: t.cancel });
    if (!label) return;
    const suggested = label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 63);
    const key = await promptDialog({ title: t.fieldKey, defaultValue: suggested, placeholder: "field_key", confirmLabel: t.add, cancelLabel: t.cancel });
    if (!key) return;
    const choices = fieldType === "single_select" || fieldType === "multi_select"
      ? await promptDialog({
          title: t.fieldOptions,
          description: t.fieldOptionsHelp,
          placeholder: t.fieldOptionsPlaceholder,
          confirmLabel: t.add,
          cancelLabel: t.cancel,
        })
      : null;
    if ((fieldType === "single_select" || fieldType === "multi_select") && !choices?.trim()) return;
    try {
      await createCrmField(workspaceId, {
        entityKind: fieldKind,
        fieldKey: key,
        label,
        fieldType,
        options: choices?.split(",").map((option) => option.trim()).filter(Boolean),
      });
      await reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t.configFailed);
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
            {error && <div className="rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive">{error}</div>}
            <section>
              <div className="mb-3 flex items-center justify-between">
                <div><h3 className="text-sm font-semibold">{t.pipelines}</h3><p className="text-xs text-muted-foreground">{t.pipelinesHelp}</p></div>
                <Button size="sm" variant="outline" onClick={() => void addPipeline()}><Plus aria-hidden />{t.addPipeline}</Button>
              </div>
              <div className="space-y-3">
                {config?.pipelines.map((pipeline) => (
                  <div key={pipeline.id} className="rounded-xl border border-border p-3">
                    <div className="flex items-center justify-between gap-2">
                      <div className="text-sm font-medium">{pipeline.name}{pipeline.isDefault ? <span className="ml-2 text-[10px] text-muted-foreground">{t.defaultPipeline}</span> : null}</div>
                      <Button size="xs" variant="ghost" onClick={() => void addStage(pipeline.id)}><Plus aria-hidden />{t.addStage}</Button>
                    </div>
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {pipeline.stages.map((stage) => (
                        <span key={stage.id} className="rounded-full border border-border bg-muted/30 px-2 py-1 text-[11px]">
                          {stage.name} · {stage.probability}% · {t.stageCategories[stage.category]}
                        </span>
                      ))}
                      {pipeline.stages.length === 0 && <span className="text-xs text-muted-foreground">{t.noStages}</span>}
                    </div>
                  </div>
                ))}
              </div>
            </section>

            <section className="border-t border-border pt-5">
              <div className="mb-3"><h3 className="text-sm font-semibold">{t.customFields}</h3><p className="text-xs text-muted-foreground">{t.fieldsHelp}</p></div>
              <div className="mb-3 flex flex-wrap items-center gap-2">
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
                <Button size="sm" onClick={() => void addField()}><Plus aria-hidden />{t.addField}</Button>
              </div>
              <div className="grid gap-2 sm:grid-cols-2">
                {config?.fields.map((field) => (
                  <div key={field.id} className="flex items-center justify-between gap-2 rounded-lg border border-border px-3 py-2">
                    <div className="min-w-0">
                      <div className="truncate text-xs font-medium">{field.label}</div>
                      <div className="mt-0.5 truncate text-[10px] text-muted-foreground">{field.entityKind} · {field.fieldKey} · {t.fieldTypes[field.fieldType]}</div>
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

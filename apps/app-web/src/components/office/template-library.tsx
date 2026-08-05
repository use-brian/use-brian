"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Dialog } from "@base-ui/react/dialog";
import { Plus, Upload, X } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { useT } from "@/lib/i18n/client";
import { createOfficeTemplate, getOfficeJob, importOfficeTemplateDraft, listOfficeTemplates, transitionOfficeTemplateLifecycle, uploadOfficeSource, type OfficeFamily } from "@/lib/office/api";
import { OfficeTopbar } from "./office-topbar";

export type OfficeStarterTemplate = "general-presentation" | "letterhead";

export function readOfficeStarterTemplate(searchParams: Pick<URLSearchParams, "get">): OfficeStarterTemplate | null {
  const starter = searchParams.get("starter");
  return starter === "general-presentation" || starter === "letterhead" ? starter : null;
}

export function officeTemplateNameFromFile(fileName: string): string {
  return fileName.replace(/\.(docx|pptx)$/i, "").trim() || fileName;
}

async function waitForTemplateImport(jobId: string): Promise<void> {
  for (let attempt = 0; attempt < 160; attempt += 1) {
    const job = await getOfficeJob(jobId);
    if (job.status === "completed") return;
    if (job.status === "failed" || job.status === "cancelled") throw new Error("office_template_import_failed");
    await new Promise((resolve) => setTimeout(resolve, 750));
  }
  throw new Error("office_template_import_timeout");
}

export function OfficeTemplateLibrary({ workspaceId, templateId }: { workspaceId: string; templateId?: string }) {
  const copy = useT();
  const t = copy.office;
  const router = useRouter();
  const searchParams = useSearchParams();
  const starterTemplate = readOfficeStarterTemplate(searchParams);
  const starterFamily: OfficeFamily = starterTemplate === "general-presentation" ? "presentation" : "document";
  const starterName = starterTemplate === "general-presentation" ? t.starterPresentationTitle : starterTemplate === "letterhead" ? t.starterLetterheadTitle : "";
  const starterDescription = starterTemplate === "general-presentation" ? t.starterPresentationInstructions : starterTemplate === "letterhead" ? t.starterLetterheadInstructions : "";
  const [templates, setTemplates] = useState<Array<Record<string, unknown>> | null>(null);
  const [creating, setCreating] = useState(starterTemplate !== null);
  const [family, setFamily] = useState<OfficeFamily>(starterFamily);
  const [name, setName] = useState(starterName);
  const [description, setDescription] = useState(starterDescription);
  const [importOpen, setImportOpen] = useState(false);
  const [importFile, setImportFile] = useState<File | null>(null);
  const [importName, setImportName] = useState("");
  const [importDescription, setImportDescription] = useState("");
  const [importState, setImportState] = useState<"idle" | "working" | "failed">("idle");
  const [purgeConfirmation, setPurgeConfirmation] = useState("");
  const templatesHref = `/w/${workspaceId}/office/templates`;

  useEffect(() => { void listOfficeTemplates(workspaceId).then(setTemplates).catch(() => setTemplates([])); }, [workspaceId]);
  useEffect(() => {
    if (!starterTemplate) return;
    setFamily(starterFamily);
    setName(starterName);
    setDescription(starterDescription);
    setCreating(true);
  }, [starterDescription, starterFamily, starterName, starterTemplate]);
  const selected = templateId ? templates?.find((template) => template.id === templateId) : undefined;
  const selectedName = selected ? String(selected.name ?? t.templateTitle) : null;

  async function submitTemplate(event: React.FormEvent) {
    event.preventDefault();
    const created = await createOfficeTemplate({ workspaceId, family, name, description });
    setCreating(false);
    router.push(`/w/${workspaceId}/office/${created.draftArtifactId}?templateId=${created.id}`);
  }

  function openBlankTemplate() {
    router.replace(templatesHref, { scroll: false });
    setFamily("document");
    setName("");
    setDescription("");
    setCreating(true);
  }

  function closeTemplate() {
    setCreating(false);
    if (starterTemplate) router.replace(templatesHref, { scroll: false });
  }

  function openTemplateImport() {
    setImportFile(null);
    setImportName("");
    setImportDescription("");
    setImportState("idle");
    setImportOpen(true);
  }

  function closeTemplateImport() {
    if (importState === "working") return;
    setImportOpen(false);
  }

  async function submitTemplateImport(event: React.FormEvent) {
    event.preventDefault();
    if (!importFile) return;
    setImportState("working");
    try {
      const source = await uploadOfficeSource(workspaceId, importFile);
      const created = await createOfficeTemplate({ workspaceId, family: source.family, name: importName, description: importDescription });
      const job = await importOfficeTemplateDraft({ templateId: created.id, workspaceId, draftArtifactId: created.draftArtifactId, fileId: source.fileId });
      await waitForTemplateImport(job.jobId);
      setImportOpen(false);
      router.push(`/w/${workspaceId}/office/${created.draftArtifactId}?templateId=${created.id}`);
    } catch {
      setImportState("failed");
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <OfficeTopbar
        workspaceId={workspaceId}
        breadcrumbs={selectedName ? [{ label: t.templates, href: templatesHref }, { label: selectedName }] : [{ label: t.templates }]}
        right={
          <div className="flex items-center gap-2">
            <button type="button" onClick={openTemplateImport} aria-label={t.importTemplateAction} className="inline-flex h-8 items-center gap-1.5 rounded-md border bg-background px-2.5 text-sm font-medium">
              <Upload className="size-4" aria-hidden /><span className="hidden sm:inline">{t.importTemplateAction}</span>
            </button>
            <button type="button" onClick={openBlankTemplate} className="inline-flex h-8 items-center gap-1.5 rounded-md bg-action px-2.5 text-sm font-medium text-action-foreground">
              <Plus className="size-4" aria-hidden /><span className="hidden sm:inline">{t.newTemplate}</span>
            </button>
          </div>
        }
      />
      <main className="mx-auto w-full max-w-5xl overflow-y-auto p-4 sm:p-8">
        <h1 className="text-2xl font-semibold">{selectedName ?? t.templateTitle}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t.templateDescription}</p>

        {selected ? <div className="mt-5 space-y-3 rounded-md bg-amber-50 p-3 text-sm text-amber-950"><p>{t.templateMode}</p><div className="flex flex-wrap gap-2">{selected.lifecycleState === "admitted" ? <button type="button" onClick={() => void transitionOfficeTemplateLifecycle(String(selected.id), "deprecate", "Deprecated from template library")} className="rounded border border-amber-900 px-3 py-2">{t.deprecateTemplate}</button> : selected.lifecycleState === "deprecated" || selected.lifecycleState === "trash" || selected.lifecycleState === "retained" ? <button type="button" onClick={() => void transitionOfficeTemplateLifecycle(String(selected.id), "restore", "Restored from template library")} className="rounded border border-amber-900 px-3 py-2">{t.restore}</button> : null}{selected.lifecycleState !== "trash" && selected.lifecycleState !== "retained" && selected.lifecycleState !== "purged" ? <button type="button" onClick={() => void transitionOfficeTemplateLifecycle(String(selected.id), "trash", "Moved to Trash from template library")} className="rounded border border-destructive px-3 py-2 text-destructive">{t.moveToTrash}</button> : null}</div>{selected.lifecycleState === "trash" || selected.lifecycleState === "retained" ? <div className="space-y-2"><input value={purgeConfirmation} onChange={(event) => setPurgeConfirmation(event.target.value)} placeholder={String(selected.name)} className="h-9 w-full rounded border px-2" /><button type="button" disabled={purgeConfirmation !== String(selected.name)} onClick={() => void transitionOfficeTemplateLifecycle(String(selected.id), "purge", "Permanent template deletion confirmed by exact name")} className="rounded bg-destructive px-3 py-2 text-destructive-foreground disabled:opacity-50">{t.deletePermanently}</button></div> : null}</div> : null}

        {templates === null ? <p className="py-16 text-center text-sm text-muted-foreground">{t.loading}</p> : templates.length === 0 ? <p className="mt-8 rounded-xl border border-dashed p-12 text-center text-sm text-muted-foreground">{t.noTemplates}</p> : (
          <div className="mt-8 grid gap-3 sm:grid-cols-2">{templates.map((template) => <Link key={String(template.id)} href={`${templatesHref}/${String(template.id)}`} className="rounded-xl border p-4"><h2 className="font-medium">{String(template.name)}</h2><p className="mt-2 text-sm text-muted-foreground">{String(template.description ?? "")}</p></Link>)}</div>
        )}
      </main>

      <Dialog.Root open={creating} onOpenChange={(open) => { if (open) setCreating(true); else closeTemplate(); }}>
        <Dialog.Portal>
          <Dialog.Backdrop className="fixed inset-0 z-[80] bg-foreground/35 backdrop-blur-[1px]" />
          <Dialog.Popup className="fixed inset-x-4 top-1/2 z-[81] mx-auto w-auto max-w-lg -translate-y-1/2 rounded-2xl border bg-background p-6 shadow-2xl outline-none">
            <div className="flex items-start justify-between gap-4">
              <div>
                <Dialog.Title className="text-lg font-semibold">{t.newTemplate}</Dialog.Title>
                <Dialog.Description className="mt-1 text-sm text-muted-foreground">{t.newTemplateDescription}</Dialog.Description>
              </div>
              <button type="button" aria-label={t.closeTemplateAria} title={t.closeTemplateAria} onClick={closeTemplate} className="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"><X className="size-4" aria-hidden /></button>
            </div>
            <form className="mt-5 grid gap-3" onSubmit={(event) => void submitTemplate(event)}>
              <Select value={family} onValueChange={(value) => { if (value) setFamily(value as OfficeFamily); }}><SelectTrigger aria-label={t.family} className="h-9 w-full">{family === "document" ? t.document : t.presentation}</SelectTrigger><SelectContent><SelectItem value="document">{t.document}</SelectItem><SelectItem value="presentation">{t.presentation}</SelectItem></SelectContent></Select>
              <input required value={name} onChange={(event) => setName(event.target.value)} placeholder={t.templateName} className="h-9 rounded border px-2" />
              <textarea required value={description} onChange={(event) => setDescription(event.target.value)} placeholder={t.templateInstructions} className="min-h-24 rounded border p-2" />
              <div className="mt-2 flex justify-end gap-2 border-t pt-4">
                <button type="button" onClick={closeTemplate} className="h-9 rounded border px-3 text-sm font-medium">{copy.common.cancel}</button>
                <button type="submit" className="h-9 rounded bg-action px-3 text-sm font-medium text-action-foreground">{t.create}</button>
              </div>
            </form>
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>

      <Dialog.Root open={importOpen} onOpenChange={(open) => { if (open) setImportOpen(true); else closeTemplateImport(); }}>
        <Dialog.Portal>
          <Dialog.Backdrop className="fixed inset-0 z-[80] bg-foreground/35 backdrop-blur-[1px]" />
          <Dialog.Popup className="fixed inset-x-4 top-1/2 z-[81] mx-auto w-auto max-w-lg -translate-y-1/2 rounded-2xl border bg-background p-6 shadow-2xl outline-none">
            <div className="flex items-start justify-between gap-4">
              <div>
                <Dialog.Title className="text-lg font-semibold">{t.importTemplateTitle}</Dialog.Title>
                <Dialog.Description className="mt-1 text-sm text-muted-foreground">{t.importTemplateDescription}</Dialog.Description>
              </div>
              <button type="button" disabled={importState === "working"} aria-label={t.closeTemplateAria} title={t.closeTemplateAria} onClick={closeTemplateImport} className="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"><X className="size-4" aria-hidden /></button>
            </div>
            <form className="mt-5 grid gap-3" onSubmit={(event) => void submitTemplateImport(event)}>
              <input type="file" accept=".docx,.pptx,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.presentationml.presentation" disabled={importState === "working"} onChange={(event) => {
                const file = event.target.files?.[0] ?? null;
                setImportFile(file);
                if (file) setImportName(officeTemplateNameFromFile(file.name));
                setImportState("idle");
              }} className="block w-full rounded border text-sm file:mr-3 file:border-0 file:border-r file:bg-muted file:px-3 file:py-2 file:text-sm file:font-medium" />
              {importFile ? <p className="text-xs text-muted-foreground">{importFile.name.toLowerCase().endsWith(".pptx") ? t.presentation : t.document}</p> : <p className="text-xs text-muted-foreground">{t.chooseTemplateFile}</p>}
              <input required disabled={importState === "working"} value={importName} onChange={(event) => setImportName(event.target.value)} placeholder={t.templateName} className="h-9 rounded border px-2 disabled:opacity-60" />
              <textarea required disabled={importState === "working"} value={importDescription} onChange={(event) => setImportDescription(event.target.value)} placeholder={t.templateInstructions} className="min-h-24 rounded border p-2 disabled:opacity-60" />
              {importState === "failed" ? <p role="alert" className="text-sm text-destructive">{t.importTemplateFailed}</p> : null}
              <div className="mt-2 flex justify-end gap-2 border-t pt-4">
                <button type="button" disabled={importState === "working"} onClick={closeTemplateImport} className="h-9 rounded border px-3 text-sm font-medium disabled:opacity-50">{copy.common.cancel}</button>
                <button type="submit" disabled={!importFile || importState === "working"} className="h-9 rounded bg-action px-3 text-sm font-medium text-action-foreground disabled:opacity-50">{importState === "working" ? t.importTemplateWorking : t.importTemplateAction}</button>
              </div>
            </form>
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}

"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Dialog } from "@base-ui/react/dialog";
import { FileText, Presentation, Sparkles, Upload, X } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { useT } from "@/lib/i18n/client";
import { createOfficeTemplate, getOfficeJob, importOfficeTemplateDraft, listOfficeTemplates, transitionOfficeTemplateLifecycle, uploadOfficeSource, type OfficeArtifact, type OfficeFamily, type OfficeTemplate } from "@/lib/office/api";
import { OfficeCardPreview } from "./office-card-preview";
import { OfficeTopbar } from "./office-topbar";

export type OfficeStarterTemplate = "general-presentation" | "letterhead";

/** Backward-compatible only: old deep links now prefill the single Generate path. */
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
  const choosingForArtifact = searchParams.get("intent") === "use";
  const [templates, setTemplates] = useState<OfficeTemplate[] | null>(null);
  const [generateOpen, setGenerateOpen] = useState(starterTemplate !== null);
  const [family, setFamily] = useState<OfficeFamily>(starterTemplate === "general-presentation" ? "presentation" : "document");
  const [name, setName] = useState("");
  const [guidance, setGuidance] = useState("");
  const [generateState, setGenerateState] = useState<"idle" | "working" | "failed">("idle");
  const [uploadOpen, setUploadOpen] = useState(false);
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploadName, setUploadName] = useState("");
  const [uploadGuidance, setUploadGuidance] = useState("");
  const [uploadState, setUploadState] = useState<"idle" | "working" | "failed">("idle");
  const [purgeConfirmation, setPurgeConfirmation] = useState("");
  const templatesHref = `/w/${workspaceId}/office/templates`;

  useEffect(() => { void listOfficeTemplates(workspaceId).then(setTemplates).catch(() => setTemplates([])); }, [workspaceId]);
  useEffect(() => {
    if (!starterTemplate) return;
    applyStarter(starterTemplate);
    setGenerateOpen(true);
  // The localized starter copy is stable for the lifetime of this route.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [starterTemplate]);

  const selected = templateId ? templates?.find((template) => template.id === templateId) : undefined;
  const selectedName = selected?.name ?? null;

  function applyStarter(starter: OfficeStarterTemplate) {
    if (starter === "general-presentation") {
      setFamily("presentation");
      setName(t.starterPresentationTitle);
      setGuidance(t.starterPresentationInstructions);
    } else {
      setFamily("document");
      setName(t.starterLetterheadTitle);
      setGuidance(t.starterLetterheadInstructions);
    }
    setGenerateState("idle");
  }

  function openGenerate() {
    router.replace(templatesHref, { scroll: false });
    setFamily("document");
    setName("");
    setGuidance("");
    setGenerateState("idle");
    setGenerateOpen(true);
  }

  function closeGenerate() {
    if (generateState === "working") return;
    setGenerateOpen(false);
    if (starterTemplate) router.replace(templatesHref, { scroll: false });
  }

  async function submitGuidedTemplate(event: React.FormEvent) {
    event.preventDefault();
    setGenerateState("working");
    try {
      const created = await createOfficeTemplate({ workspaceId, family, name, description: guidance, creationMethod: "guided" });
      setGenerateOpen(false);
      router.push(`/w/${workspaceId}/office/${created.draftArtifactId}?templateId=${created.id}`);
    } catch {
      setGenerateState("failed");
    }
  }

  function openTemplateUpload() {
    setUploadFile(null);
    setUploadName("");
    setUploadGuidance("");
    setUploadState("idle");
    setUploadOpen(true);
  }

  function closeTemplateUpload() {
    if (uploadState === "working") return;
    setUploadOpen(false);
  }

  async function submitTemplateUpload(event: React.FormEvent) {
    event.preventDefault();
    if (!uploadFile) return;
    setUploadState("working");
    try {
      const source = await uploadOfficeSource(workspaceId, uploadFile);
      const created = await createOfficeTemplate({ workspaceId, family: source.family, name: uploadName, description: uploadGuidance, creationMethod: "upload" });
      const job = await importOfficeTemplateDraft({ templateId: created.id, workspaceId, draftArtifactId: created.draftArtifactId, fileId: source.fileId });
      await waitForTemplateImport(job.jobId);
      setUploadOpen(false);
      router.push(`/w/${workspaceId}/office/${created.draftArtifactId}?templateId=${created.id}`);
    } catch {
      setUploadState("failed");
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <OfficeTopbar
        workspaceId={workspaceId}
        breadcrumbs={selectedName ? [{ label: t.templates, href: templatesHref }, { label: selectedName }] : [{ label: t.templates }]}
        right={
          <div className="flex items-center gap-2">
            <button type="button" onClick={openTemplateUpload} aria-label={t.uploadTemplateAction} className="inline-flex h-8 items-center gap-1.5 rounded-md border bg-background px-2.5 text-sm font-medium">
              <Upload className="size-4" aria-hidden /><span className="hidden sm:inline">{t.uploadTemplateAction}</span>
            </button>
            <button type="button" onClick={openGenerate} className="inline-flex h-8 items-center gap-1.5 rounded-md bg-action px-2.5 text-sm font-medium text-action-foreground">
              <Sparkles className="size-4" aria-hidden /><span className="hidden sm:inline">{t.generateTemplateAction}</span>
            </button>
          </div>
        }
      />
      <main className="mx-auto w-full max-w-5xl overflow-y-auto p-4 sm:p-8">
        <h1 className="text-2xl font-semibold">{selectedName ?? (choosingForArtifact ? t.chooseTemplateTitle : t.templateTitle)}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{choosingForArtifact ? t.chooseTemplateDescription : t.templateDescription}</p>

        {selected ? <div className="mt-5 space-y-3 rounded-md border p-3 text-sm"><p>{t.templateMode}</p><div className="flex flex-wrap gap-2">{selected.lifecycleState === "admitted" ? <button type="button" onClick={() => void transitionOfficeTemplateLifecycle(String(selected.id), "deprecate", "Deprecated from template library")} className="rounded border px-3 py-2">{t.deprecateTemplate}</button> : selected.lifecycleState === "deprecated" || selected.lifecycleState === "trash" || selected.lifecycleState === "retained" ? <button type="button" onClick={() => void transitionOfficeTemplateLifecycle(String(selected.id), "restore", "Restored from template library")} className="rounded border px-3 py-2">{t.restore}</button> : null}{selected.lifecycleState !== "trash" && selected.lifecycleState !== "retained" ? <button type="button" onClick={() => void transitionOfficeTemplateLifecycle(String(selected.id), "trash", "Moved to Trash from template library")} className="rounded border border-destructive px-3 py-2 text-destructive">{t.moveToTrash}</button> : null}</div>{selected.lifecycleState === "trash" || selected.lifecycleState === "retained" ? <div className="space-y-2"><input value={purgeConfirmation} onChange={(event) => setPurgeConfirmation(event.target.value)} placeholder={String(selected.name)} className="h-9 w-full rounded border px-2" /><button type="button" disabled={purgeConfirmation !== String(selected.name)} onClick={() => void transitionOfficeTemplateLifecycle(String(selected.id), "purge", "Permanent template deletion confirmed by exact name")} className="rounded bg-destructive px-3 py-2 text-destructive-foreground disabled:opacity-50">{t.deletePermanently}</button></div> : null}</div> : null}

        {templates === null ? <p className="py-16 text-center text-sm text-muted-foreground">{t.loading}</p> : templates.length === 0 ? (
          <section className="mt-8 rounded-xl border border-dashed p-8 text-center">
            <h2 className="font-medium">{t.noTemplates}</h2>
            <p className="mt-1 text-sm text-muted-foreground">{t.templateEmptyBody}</p>
            <div className="mt-5 flex flex-wrap justify-center gap-2">
              <button type="button" onClick={openTemplateUpload} className="inline-flex h-9 items-center gap-2 rounded-md border px-3 text-sm font-medium"><Upload className="size-4" aria-hidden />{t.uploadTemplateAction}</button>
              <button type="button" onClick={openGenerate} className="inline-flex h-9 items-center gap-2 rounded-md bg-action px-3 text-sm font-medium text-action-foreground"><Sparkles className="size-4" aria-hidden />{t.generateTemplateAction}</button>
            </div>
          </section>
        ) : (
          <div className="mt-8 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">{templates.map((template) => <OfficeTemplateCard key={template.id} workspaceId={workspaceId} template={template} />)}</div>
        )}
      </main>

      <Dialog.Root open={generateOpen} onOpenChange={(open) => { if (open) setGenerateOpen(true); else closeGenerate(); }}>
        <Dialog.Portal>
          <Dialog.Backdrop className="fixed inset-0 z-[80] bg-foreground/35 backdrop-blur-[1px]" />
          <Dialog.Popup className="fixed inset-x-4 top-1/2 z-[81] mx-auto w-auto max-w-lg -translate-y-1/2 rounded-2xl border bg-background p-6 shadow-2xl outline-none">
            <div className="flex items-start justify-between gap-4">
              <div><Dialog.Title className="text-lg font-semibold">{t.generateTemplateTitle}</Dialog.Title><Dialog.Description className="mt-1 text-sm text-muted-foreground">{t.generateTemplateDescription}</Dialog.Description></div>
              <button type="button" disabled={generateState === "working"} aria-label={t.closeTemplateAria} title={t.closeTemplateAria} onClick={closeGenerate} className="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"><X className="size-4" aria-hidden /></button>
            </div>
            <div className="mt-4"><p className="text-xs font-medium text-muted-foreground">{t.guidedExamples}</p><div className="mt-2 flex flex-wrap gap-2"><button type="button" onClick={() => applyStarter("general-presentation")} className="rounded-full border px-3 py-1.5 text-xs">{t.starterPresentationTitle}</button><button type="button" onClick={() => applyStarter("letterhead")} className="rounded-full border px-3 py-1.5 text-xs">{t.starterLetterheadTitle}</button></div></div>
            <form className="mt-5 grid gap-3" onSubmit={(event) => void submitGuidedTemplate(event)}>
              <Select value={family} onValueChange={(value) => { if (value) setFamily(value as OfficeFamily); }}><SelectTrigger aria-label={t.family} className="h-9 w-full">{family === "document" ? t.document : t.presentation}</SelectTrigger><SelectContent><SelectItem value="document">{t.document}</SelectItem><SelectItem value="presentation">{t.presentation}</SelectItem></SelectContent></Select>
              <input required disabled={generateState === "working"} value={name} onChange={(event) => setName(event.target.value)} placeholder={t.templateName} className="h-9 rounded border px-2 disabled:opacity-60" />
              <textarea required disabled={generateState === "working"} value={guidance} onChange={(event) => setGuidance(event.target.value)} placeholder={t.templateInstructions} className="min-h-28 rounded border p-2 disabled:opacity-60" />
              {generateState === "failed" ? <p role="alert" className="text-sm text-destructive">{t.generateTemplateFailed}</p> : null}
              <div className="mt-2 flex justify-end gap-2 border-t pt-4"><button type="button" disabled={generateState === "working"} onClick={closeGenerate} className="h-9 rounded border px-3 text-sm font-medium disabled:opacity-50">{copy.common.cancel}</button><button type="submit" disabled={generateState === "working" || !name.trim() || !guidance.trim()} className="h-9 rounded bg-action px-3 text-sm font-medium text-action-foreground disabled:opacity-50">{generateState === "working" ? t.generatingTemplate : t.generateDraft}</button></div>
            </form>
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>

      <Dialog.Root open={uploadOpen} onOpenChange={(open) => { if (open) setUploadOpen(true); else closeTemplateUpload(); }}>
        <Dialog.Portal>
          <Dialog.Backdrop className="fixed inset-0 z-[80] bg-foreground/35 backdrop-blur-[1px]" />
          <Dialog.Popup className="fixed inset-x-4 top-1/2 z-[81] mx-auto w-auto max-w-lg -translate-y-1/2 rounded-2xl border bg-background p-6 shadow-2xl outline-none">
            <div className="flex items-start justify-between gap-4">
              <div><Dialog.Title className="text-lg font-semibold">{t.uploadTemplateTitle}</Dialog.Title><Dialog.Description className="mt-1 text-sm text-muted-foreground">{t.uploadTemplateDescription}</Dialog.Description></div>
              <button type="button" disabled={uploadState === "working"} aria-label={t.closeTemplateAria} title={t.closeTemplateAria} onClick={closeTemplateUpload} className="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"><X className="size-4" aria-hidden /></button>
            </div>
            <form className="mt-5 grid gap-3" onSubmit={(event) => void submitTemplateUpload(event)}>
              <input type="file" accept=".docx,.pptx,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.presentationml.presentation" disabled={uploadState === "working"} onChange={(event) => { const file = event.target.files?.[0] ?? null; setUploadFile(file); if (file) setUploadName(officeTemplateNameFromFile(file.name)); setUploadState("idle"); }} className="block w-full rounded border text-sm file:mr-3 file:border-0 file:border-r file:bg-muted file:px-3 file:py-2 file:text-sm file:font-medium" />
              {uploadFile ? <p className="text-xs text-muted-foreground">{uploadFile.name.toLowerCase().endsWith(".pptx") ? t.presentation : t.document}</p> : <p className="text-xs text-muted-foreground">{t.chooseTemplateFile}</p>}
              <input required disabled={uploadState === "working"} value={uploadName} onChange={(event) => setUploadName(event.target.value)} placeholder={t.templateName} className="h-9 rounded border px-2 disabled:opacity-60" />
              <textarea required disabled={uploadState === "working"} value={uploadGuidance} onChange={(event) => setUploadGuidance(event.target.value)} placeholder={t.templateInstructions} className="min-h-24 rounded border p-2 disabled:opacity-60" />
              {uploadState === "failed" ? <p role="alert" className="text-sm text-destructive">{t.importTemplateFailed}</p> : null}
              <div className="mt-2 flex justify-end gap-2 border-t pt-4"><button type="button" disabled={uploadState === "working"} onClick={closeTemplateUpload} className="h-9 rounded border px-3 text-sm font-medium disabled:opacity-50">{copy.common.cancel}</button><button type="submit" disabled={!uploadFile || uploadState === "working" || !uploadName.trim() || !uploadGuidance.trim()} className="h-9 rounded bg-action px-3 text-sm font-medium text-action-foreground disabled:opacity-50">{uploadState === "working" ? t.importTemplateWorking : t.uploadTemplateAction}</button></div>
            </form>
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}

export function OfficeTemplateCard({ workspaceId, template }: { workspaceId: string; template: OfficeTemplate }) {
  const t = useT().office;
  const document = template.family === "document";
  const Icon = document ? FileText : Presentation;
  const previewArtifact: OfficeArtifact = { artifactId: template.draftArtifactId ?? "", family: template.family, mode: "template", title: template.name, version: template.currentVersionId ? 1 : 0, lifecycleState: "active", role: "edit" };
  const canUse = template.lifecycleState === "admitted" && Boolean(template.currentVersionId);
  const canEdit = template.lifecycleState === "draft" && Boolean(template.draftArtifactId);

  return (
    <article data-office-template-card={template.family} className="group overflow-hidden rounded-xl border bg-card transition-colors hover:border-foreground/30">
      <Link href={`/w/${workspaceId}/office/templates/${template.id}`} aria-label={template.name}>
        <div className="relative"><OfficeCardPreview artifact={previewArtifact} /><span data-office-template-family={template.family} className={document ? "absolute left-3 top-3 inline-flex items-center gap-1.5 rounded-md bg-blue-600 px-2 py-1 text-xs font-semibold text-white shadow-sm" : "absolute left-3 top-3 inline-flex items-center gap-1.5 rounded-md bg-amber-500 px-2 py-1 text-xs font-semibold text-amber-950 shadow-sm"}><Icon className="size-3.5" aria-hidden /><span>{document ? t.document : t.presentation}</span></span></div>
        <div className="px-4 pt-4"><h2 className="line-clamp-2 font-medium group-hover:underline">{template.name}</h2><p className="mt-2 line-clamp-2 min-h-10 text-sm text-muted-foreground">{template.description}</p></div>
      </Link>
      <div className="p-4 pt-3">
        {canUse ? <Link href={`/w/${workspaceId}/office/new?templateId=${encodeURIComponent(template.id)}&templateVersionId=${encodeURIComponent(String(template.currentVersionId))}`} className="inline-flex h-9 w-full items-center justify-center rounded-md bg-action px-3 text-sm font-medium text-action-foreground">{t.useTemplate}</Link> : canEdit ? <Link href={`/w/${workspaceId}/office/${template.draftArtifactId}?templateId=${template.id}`} className="inline-flex h-9 w-full items-center justify-center rounded-md border px-3 text-sm font-medium">{t.editTemplate}</Link> : <p className="text-xs text-muted-foreground">{t.templateUnavailable}</p>}
      </div>
    </article>
  );
}

"use client";

import { Checkbox } from "@/components/ui/checkbox";
import { officeInputClassName, officeTextareaClassName, officeDialogBackdropClassName, officeDialogClassName, officeFamilyBadgeClassName } from "@/components/office/office-chrome";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Dialog } from "@base-ui/react/dialog";
import { FileSpreadsheet, FileText, FileUp, Presentation, Sparkles, Upload, X } from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { useT } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";
import { useFileDrop } from "@/lib/use-file-drop";
import { awaitOfficeJob } from "@/lib/office/job-stream";
import { createOfficeTemplate, retryOfficeTemplateImport, type OfficeImportDiagnostic, importOfficeTemplateDraft, listOfficeTemplates, transitionOfficeTemplateLifecycle, uploadOfficeSource, type OfficeArtifact, type OfficeFamily, type OfficeTemplate } from "@/lib/office/api";
import { invalidateSurfaceCache, markSurfaceCacheStale } from "@/lib/surface-cache";
import { invalidateOfficeList, officeArtifactCacheKey, officeSnapshotCacheKey, officeTemplateListCacheKey } from "@/lib/surface-prefetch";
import { useOfficeMetadataResource } from "@/lib/office/surface-cache";
import { useOptionalWorkspaceContext } from "@/lib/workspace-context";
import { GridSurfaceSkeleton } from "@/components/chrome/surface-skeleton";
import { OfficeCardPreview } from "./office-card-preview";
import { OfficeTopbar } from "./office-topbar";

export type OfficeStarterTemplate = "general-presentation" | "letterhead" | "invoice";

/** Backward-compatible only: old deep links now prefill the single Generate path. */
export function readOfficeStarterTemplate(searchParams: Pick<URLSearchParams, "get">): OfficeStarterTemplate | null {
  const starter = searchParams.get("starter");
  return starter === "general-presentation" || starter === "letterhead" || starter === "invoice" ? starter : null;
}

export function officeTemplateNameFromFile(fileName: string): string {
  return fileName.replace(/\.(docx|pptx|xlsx)$/i, "").trim() || fileName;
}

export function officeTemplateFamilyFromFileName(fileName: string): OfficeFamily | null {
  const normalized = fileName.trim().toLowerCase();
  if (normalized.endsWith(".docx")) return "document";
  if (normalized.endsWith(".pptx")) return "presentation";
  if (normalized.endsWith(".xlsx")) return "spreadsheet";
  return null;
}

class TemplateImportError extends Error {
  constructor(readonly diagnostics: OfficeImportDiagnostic[]) { super("office_template_import_failed"); }
}

/** Await the import job's settled frame on its stream (no poll, no wall-clock cap). */
async function waitForTemplateImport(jobId: string): Promise<void> {
  const job = await awaitOfficeJob(jobId);
  if (job.status === "completed") return;
  throw new TemplateImportError(job.importDiagnostics ?? []);
}

export function OfficeTemplateLibrary(props: { workspaceId: string; templateId?: string }) {
  const workspace = useOptionalWorkspaceContext();
  const viewerId = workspace?.me.id ?? '';
  const previous = useRef({workspaceId: props.workspaceId, viewerId});
  useLayoutEffect(() => {
    const old = previous.current;
    if (old.workspaceId !== props.workspaceId || old.viewerId !== viewerId)
      invalidateSurfaceCache(officeTemplateListCacheKey(old.workspaceId, old.viewerId));
    previous.current = {workspaceId: props.workspaceId, viewerId};
  }, [props.workspaceId, viewerId]);
  return <OfficeTemplateLibraryForViewer key={`${props.workspaceId}:${workspace?.me.id ?? ''}`} {...props} />;
}

function OfficeTemplateLibraryForViewer({ workspaceId, templateId }: { workspaceId: string; templateId?: string }) {
  const copy = useT();
  const t = copy.office;
  const router = useRouter();
  const searchParams = useSearchParams();
  const pathname = usePathname();
  const routeSearch = searchParams.toString();
  const starterTemplate = readOfficeStarterTemplate(searchParams);
  const choosingForArtifact = searchParams.get("intent") === "use";
  const workspace = useOptionalWorkspaceContext();
  const viewerId = workspace?.workspaceId === workspaceId ? workspace.me.id : '';
  const cacheKey = officeTemplateListCacheKey(workspaceId, viewerId);
  const list = useOfficeMetadataResource(viewerId ? cacheKey : null, viewerId, () => listOfficeTemplates(workspaceId));
  const templates = list.data ?? null;
  const mutationLock = useRef(false);
  const mutationScope = useRef<object | null>(null);
  const creationScope = useRef<object | null>(null);
  const [mutationPending, setMutationPending] = useState(false);
  const [mutationFailed, setMutationFailed] = useState(false);
  const [generateOpen, setGenerateOpen] = useState(starterTemplate !== null);
  const [family, setFamily] = useState<OfficeFamily>(starterTemplate === "general-presentation" ? "presentation" : starterTemplate === "invoice" ? "spreadsheet" : "document");
  const [name, setName] = useState("");
  const [guidance, setGuidance] = useState("");
  const [website, setWebsite] = useState("");
  const [noWebsite, setNoWebsite] = useState(false);
  const [generateState, setGenerateState] = useState<"idle" | "working" | "failed">("idle");
  const uploadAttempt = useRef<{ source?: { fileId: string; family: OfficeFamily }; file?: File; created?: { id: string; draftArtifactId: string }; failedJobId?: string; jobId?: string }>({});
  const [uploadDiagnostics, setUploadDiagnostics] = useState<OfficeImportDiagnostic[]>([]);
  const [recoveringUpload, setRecoveringUpload] = useState(false);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploadName, setUploadName] = useState("");
  const [uploadGuidance, setUploadGuidance] = useState("");
  const [uploadState, setUploadState] = useState<"idle" | "working" | "invalid" | "failed">("idle");
  const [purgeConfirmation, setPurgeConfirmation] = useState("");
  const uploadInputRef = useRef<HTMLInputElement>(null);
  const templatesHref = `/w/${workspaceId}/office/templates`;

  const selectUploadFiles = useCallback((fileList: FileList | File[]) => {
    const file = Array.from(fileList)[0] ?? null;
    if (!file) return;
    if (!officeTemplateFamilyFromFileName(file.name)) {
      setUploadFile(null);
      setUploadName("");
      setUploadState("invalid");
      return;
    }
    setUploadFile(file);
    setUploadName(officeTemplateNameFromFile(file.name));
    setUploadState("idle");
  }, []);
  const uploadDrop = useFileDrop(selectUploadFiles, { disabled: uploadState === "working" });

  useEffect(() => { markSurfaceCacheStale(cacheKey); }, [cacheKey]);
  // A new token on every route entry also handles A -> B -> A and Strict Mode.
  // Layout cleanup revokes UI ownership before a late promise can navigate.
  useLayoutEffect(() => {
    mutationScope.current = {};
    creationScope.current = {};
    mutationLock.current = false;
    setMutationPending(false);
    setPurgeConfirmation("");
    setMutationFailed(false);
    return () => { mutationScope.current = null; creationScope.current = null; };
  }, [workspaceId, viewerId, templateId, pathname, routeSearch]);

  const hasProjection = templates !== null;
  useLayoutEffect(() => {
    if (!hasProjection) {
      mutationScope.current = null;
      mutationLock.current = false;
      setMutationPending(false);
      setPurgeConfirmation("");
      setMutationFailed(false);
    } else if (!mutationScope.current) mutationScope.current = {};
  }, [hasProjection]);

  async function transition(action: "deprecate" | "restore" | "trash" | "purge", reason: string) {
    const scope = mutationScope.current;
    if (!templateId || !scope || mutationLock.current) return;
    mutationLock.current = true;
    setMutationPending(true);
    setMutationFailed(false);
    try {
      await transitionOfficeTemplateLifecycle(templateId, action, reason);
      invalidateSurfaceCache(cacheKey);
      invalidateOfficeList(workspaceId);
      const draftId = templates?.find((template) => template.id === templateId)?.draftArtifactId;
      if (draftId) {
        invalidateSurfaceCache(officeArtifactCacheKey(workspaceId, draftId, viewerId));
        invalidateSurfaceCache(officeSnapshotCacheKey(workspaceId, draftId, viewerId));
      }
      if (mutationScope.current !== scope) return;
      setPurgeConfirmation("");
      if (action === "purge") router.replace(templatesHref);
    } catch {
      if (mutationScope.current === scope) setMutationFailed(true);
    } finally {
      if (mutationScope.current === scope) {
        mutationLock.current = false;
        setMutationPending(false);
      }
    }
  }
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
    } else if (starter === "letterhead") {
      setFamily("document");
      setName(t.starterLetterheadTitle);
      setGuidance(t.starterLetterheadInstructions);
    } else {
      setFamily("spreadsheet");
      setName(t.starterInvoiceTitle);
      setGuidance(t.starterInvoiceInstructions);
    }
    setGenerateState("idle");
  }

  function openGenerate() {
    router.replace(templatesHref, { scroll: false });
    setFamily("document");
    setName("");
    setGuidance("");
    setWebsite("");
    setNoWebsite(false);
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
    const scope = creationScope.current;
    if (!scope) return;
    setGenerateState("working");
    try {
      const created = await createOfficeTemplate({
        workspaceId,
        family,
        name,
        description: guidance,
        creationMethod: "guided",
        canonicalWebsite: noWebsite ? undefined : website,
        companyHasNoWebsite: noWebsite,
      });
      if (creationScope.current !== scope) return;
      setGenerateOpen(false);
      router.push(`/w/${workspaceId}/office/${created.draftArtifactId}?templateId=${created.id}`);
    } catch {
      if (creationScope.current === scope) setGenerateState("failed");
    }
  }

  function openTemplateUpload() {
    uploadAttempt.current = {};
    setRecoveringUpload(false);
    setUploadDiagnostics([]);
    setUploadFile(null);
    setUploadName("");
    setUploadGuidance("");
    setUploadState("idle");
    if (uploadInputRef.current) uploadInputRef.current.value = "";
    setUploadOpen(true);
  }

  function openTemplateRecovery(template: OfficeTemplate) {
    if (!template.importState || !template.draftArtifactId) return;
    uploadAttempt.current = { source: { fileId: template.importState.fileId, family: template.family }, created: { id: template.id, draftArtifactId: template.draftArtifactId }, failedJobId: template.importState.jobId };
    setRecoveringUpload(true);
    setUploadFile(null);
    setUploadName(template.name);
    setUploadGuidance(template.description);
    setUploadDiagnostics(template.importState.diagnostics);
    setUploadState("failed");
    setUploadOpen(true);
  }

  function closeTemplateUpload() {
    if (uploadState === "working") return;
    setUploadOpen(false);
  }

  async function submitTemplateUpload(event: React.FormEvent) {
    event.preventDefault();
    const scope = creationScope.current;
    if ((!uploadFile && !uploadAttempt.current.source) || !scope || uploadState === "working") return;
    setUploadState("working");
    const attempt = uploadAttempt.current;
    try {
      if (uploadFile && uploadFile !== attempt.file) {
        const source = await uploadOfficeSource(workspaceId, uploadFile);
        if (creationScope.current !== scope) return;
        if (attempt.created && attempt.source?.family !== source.family) throw new Error("office_template_family_mismatch");
        attempt.source = source;
        attempt.file = uploadFile;
      }
      if (!attempt.source) throw new Error("office_upload_missing");
      if (!attempt.created) {
        attempt.created = await createOfficeTemplate({ workspaceId, family: attempt.source.family, name: uploadName, description: uploadGuidance, creationMethod: "upload" });
      }
      if (creationScope.current !== scope) return;
      const created = attempt.created;
      if (attempt.failedJobId) {
        const retried = await retryOfficeTemplateImport({ templateId: created.id, workspaceId, artifactId: created.draftArtifactId, failedJobId: attempt.failedJobId, fileId: attempt.source.fileId });
        attempt.jobId = retried.jobId;
        attempt.failedJobId = undefined;
      } else if (!attempt.jobId) {
        attempt.jobId = (await importOfficeTemplateDraft({ templateId: created.id, workspaceId, draftArtifactId: created.draftArtifactId, fileId: attempt.source.fileId })).jobId;
      }
      if (creationScope.current !== scope) return;
      await waitForTemplateImport(attempt.jobId);
      if (creationScope.current !== scope) return;
      invalidateSurfaceCache(cacheKey);
      setUploadOpen(false);
      router.push(`/w/${workspaceId}/office/${created.draftArtifactId}?templateId=${created.id}`);
    } catch (cause) {
      if (creationScope.current !== scope) return;
      if (cause instanceof TemplateImportError) {
        attempt.failedJobId = attempt.jobId;
        setUploadDiagnostics(cause.diagnostics);
      }
      setRecoveringUpload(Boolean(attempt.created));
      setUploadState("failed");
      invalidateSurfaceCache(cacheKey);
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <OfficeTopbar
        workspaceId={workspaceId}
        breadcrumbs={selectedName ? [{ label: t.templates, href: templatesHref }, { label: selectedName }] : [{ label: t.templates }]}
        right={
          <div className="flex items-center gap-2">
            <button type="button" onClick={openTemplateUpload} aria-label={t.uploadTemplateAction} className={buttonVariants({ variant: "outline" })}>
              <Upload className="size-4" aria-hidden /><span className="hidden sm:inline">{t.uploadTemplateAction}</span>
            </button>
            <button type="button" onClick={openGenerate} aria-label={t.generateTemplateAction} className={buttonVariants({ variant: "default" })}>
              <Sparkles className="size-4" aria-hidden /><span className="hidden sm:inline">{t.generateTemplateAction}</span>
            </button>
          </div>
        }
      />
      <main className="mx-auto w-full max-w-5xl overflow-y-auto p-4 sm:p-8">
        <h1 className="text-2xl font-semibold">{choosingForArtifact ? t.chooseTemplateTitle : t.templateTitle}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{choosingForArtifact ? t.chooseTemplateDescription : t.templateDescription}</p>

        {templates === null ? list.error ? <div className="py-16 text-center text-sm">
          <p role="alert" className="text-destructive">{t.loadFailed}</p>
          <button type="button" disabled={list.revalidating} onClick={() => void list.refresh()} className={buttonVariants({ variant: "outline", size: "sm", className: "mt-3" })}>{copy.chat.retry}</button>
        </div> : <GridSurfaceSkeleton chrome={false} padded={false} /> : templates.length === 0 ? (
          <section className="mt-8 rounded-xl border border-dashed p-8 text-center">
            <h2 className="font-medium">{t.noTemplates}</h2>
            <p className="mt-1 text-sm text-muted-foreground">{t.templateEmptyBody}</p>
            <div className="mt-5 flex flex-wrap justify-center gap-2">
              <button type="button" onClick={openTemplateUpload} className={buttonVariants({ variant: "outline" })}><Upload className="size-4" aria-hidden />{t.uploadTemplateAction}</button>
              <button type="button" onClick={openGenerate} aria-label={t.generateTemplateAction} className={buttonVariants({ variant: "default" })}><Sparkles className="size-4" aria-hidden />{t.generateTemplateAction}</button>
            </div>
          </section>
        ) : (
          <div className="mt-8 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">{templates.map((template) => <OfficeTemplateCard key={template.id} workspaceId={workspaceId} template={template} />)}</div>
        )}
      </main>

      <Dialog.Root open={Boolean(selected) && !uploadOpen} onOpenChange={(open) => { if (!open) router.replace(templatesHref, { scroll: false }); }}>
        <Dialog.Portal>
          <Dialog.Backdrop className={officeDialogBackdropClassName} />
          <Dialog.Popup className={`${officeDialogClassName} sm:max-w-lg`}>
            {selected ? <>
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0"><Dialog.Title className="break-words text-lg font-semibold">{selected.name}</Dialog.Title><Dialog.Description className="mt-1 text-sm text-muted-foreground">{selected.description || t.templateDescription}</Dialog.Description></div>
                <Button variant="ghost" size="icon" className="max-sm:size-11" aria-label={t.closeTemplateAria} onClick={() => router.replace(templatesHref, { scroll: false })}><X aria-hidden /></Button>
              </div>
              <div className="mt-5 overflow-hidden rounded-xl border bg-muted/20"><OfficeCardPreview workspaceId={workspaceId} artifact={{ artifactId: selected.draftArtifactId ?? "", family: selected.family, mode: "template", title: selected.name, version: selected.currentVersionId ? 1 : 0, lifecycleState: "active", role: "edit" }} /></div>
              <p className="mt-3 text-xs text-muted-foreground">{familyLabel(t, selected.family)}</p>
              {selected.importState?.status === "failed" || selected.importState?.status === "cancelled" ? <div role="alert" className="mt-3 space-y-2"><p className="text-destructive">{t.importTemplateFailed}</p><Button onClick={() => openTemplateRecovery(selected)}>{t.retryTemplateImport}</Button></div> : null}
              <div className="mt-4 flex flex-wrap gap-2">
                {selected.lifecycleState === "admitted" && selected.currentVersionId ? <Link className={buttonVariants()} href={`/w/${workspaceId}/office/new?templateId=${encodeURIComponent(selected.id)}&templateVersionId=${encodeURIComponent(selected.currentVersionId)}`}>{t.useTemplate}</Link> : selected.lifecycleState === "draft" && selected.draftArtifactId ? <Link className={buttonVariants()} href={`/w/${workspaceId}/office/${selected.draftArtifactId}?templateId=${selected.id}`}>{t.editTemplate}</Link> : null}
                {selected.lifecycleState === "deprecated" || selected.lifecycleState === "trash" || selected.lifecycleState === "retained" ? <Button disabled={mutationPending} onClick={() => void transition("restore", "Restored from template library")}>{t.restore}</Button> : null}
              </div>
              <div className="mt-5 space-y-3 border-t pt-4">
                <div className="flex flex-wrap gap-2">
                  {selected.lifecycleState === "admitted" ? <Button variant="outline" disabled={mutationPending} onClick={() => void transition("deprecate", "Deprecated from template library")}>{t.deprecateTemplate}</Button> : null}
                  {selected.lifecycleState !== "trash" && selected.lifecycleState !== "retained" ? <Button variant="destructive" disabled={mutationPending} onClick={() => void transition("trash", "Moved to Trash from template library")}>{t.moveToTrash}</Button> : null}
                </div>
                {selected.lifecycleState === "trash" || selected.lifecycleState === "retained" ? <div className="space-y-2">
                  <label htmlFor="office-template-purge" className="block text-xs text-muted-foreground">{t.typeTitleToDelete}</label>
                  <p className="break-words rounded-lg bg-muted px-3 py-2 font-mono text-xs">{selected.name}</p>
                  <input id="office-template-purge" value={purgeConfirmation} onChange={(event) => setPurgeConfirmation(event.target.value)} placeholder={String(selected.name)} autoComplete="off" className={`${officeInputClassName} w-full`} />
                  <Button variant="destructive" disabled={mutationPending || purgeConfirmation !== selected.name} onClick={() => void transition("purge", "Permanent template deletion confirmed by exact name")}>{t.deletePermanently}</Button>
                </div> : null}
                {mutationFailed ? <p role="alert" className="text-sm text-destructive">{t.lifecycleFailed}</p> : null}
              </div>
            </> : null}
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>

      <Dialog.Root open={generateOpen} onOpenChange={(open) => { if (open) setGenerateOpen(true); else closeGenerate(); }}>
        <Dialog.Portal>
          <Dialog.Backdrop className={officeDialogBackdropClassName} />
          <Dialog.Popup className={`${officeDialogClassName} sm:max-w-lg`}>
            <div className="flex items-start justify-between gap-4">
              <div><Dialog.Title className="text-lg font-semibold">{t.generateTemplateTitle}</Dialog.Title><Dialog.Description className="mt-1 text-sm text-muted-foreground">{t.generateTemplateDescription}</Dialog.Description></div>
              <button type="button" disabled={generateState === "working"} aria-label={t.closeTemplateAria} title={t.closeTemplateAria} onClick={closeGenerate} className={buttonVariants({ variant: "ghost", size: "icon", className: "max-sm:size-11" })}><X className="size-4" aria-hidden /></button>
            </div>
            <div className="mt-4"><p className="text-xs font-medium text-muted-foreground">{t.guidedExamples}</p><div className="mt-2 flex flex-wrap gap-2"><button type="button" onClick={() => applyStarter("general-presentation")} className={buttonVariants({ variant: "outline", size: "sm" })}>{t.starterPresentationTitle}</button><button type="button" onClick={() => applyStarter("letterhead")} className={buttonVariants({ variant: "outline", size: "sm" })}>{t.starterLetterheadTitle}</button><button type="button" onClick={() => applyStarter("invoice")} className={buttonVariants({ variant: "outline", size: "sm" })}>{t.starterInvoiceTitle}</button></div></div>
            <form className="mt-5 grid gap-3" onSubmit={(event) => void submitGuidedTemplate(event)}>
              <Select value={family} onValueChange={(value) => { if (value) setFamily(value as OfficeFamily); }}><SelectTrigger aria-label={t.family} className="max-md:min-h-11 h-9 w-full">{familyLabel(t, family)}</SelectTrigger><SelectContent><SelectItem value="document">{t.document}</SelectItem><SelectItem value="presentation">{t.presentation}</SelectItem><SelectItem value="spreadsheet">{t.spreadsheet}</SelectItem></SelectContent></Select>
              <label className="grid gap-1.5 text-sm font-medium"><span>{t.templateName}</span><input required disabled={generateState === "working"} value={name} onChange={(event) => setName(event.target.value)} placeholder={t.templateName} className={officeInputClassName} /></label>
              <label className="grid gap-1.5 text-sm font-medium"><span>{t.templateInstructions}</span><textarea required disabled={generateState === "working"} value={guidance} onChange={(event) => setGuidance(event.target.value)} placeholder={t.templateInstructions} className={`${officeTextareaClassName} min-h-28`} /></label>
              <label className="text-sm font-medium">{t.website}<input type="url" required={!noWebsite} disabled={generateState === "working" || noWebsite} value={website} onChange={(event) => setWebsite(event.target.value)} placeholder={t.websitePlaceholder} className={`${officeInputClassName} mt-2 w-full`} /></label>
              <label className="flex items-center gap-2 text-sm max-md:min-h-11 cursor-pointer"><Checkbox disabled={generateState === "working"} checked={noWebsite} onCheckedChange={(checked) => setNoWebsite(checked)} />{t.noWebsite}</label>
              {generateState === "failed" ? <p role="alert" className="text-sm text-destructive">{t.generateTemplateFailed}</p> : null}
              <div className="mt-2 flex justify-end gap-2 border-t pt-4"><button type="button" disabled={generateState === "working"} onClick={closeGenerate} className={buttonVariants({ variant: "outline" })}>{copy.common.cancel}</button><button type="submit" disabled={generateState === "working" || !name.trim() || !guidance.trim() || (!noWebsite && !website.trim())} className={buttonVariants({ variant: "default" })}>{generateState === "working" ? t.generatingTemplate : t.generateDraft}</button></div>
            </form>
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>

      <Dialog.Root open={uploadOpen} onOpenChange={(open) => { if (open) setUploadOpen(true); else closeTemplateUpload(); }}>
        <Dialog.Portal>
          <Dialog.Backdrop className={officeDialogBackdropClassName} />
          <Dialog.Popup className={`${officeDialogClassName} sm:max-w-xl`}>
            <div className="flex items-start justify-between gap-4">
              <div><Dialog.Title className="text-lg font-semibold">{t.uploadTemplateTitle}</Dialog.Title><Dialog.Description className="mt-1 text-sm text-muted-foreground">{t.uploadTemplateDescription}</Dialog.Description></div>
              <button type="button" disabled={uploadState === "working"} aria-label={t.closeTemplateAria} title={t.closeTemplateAria} onClick={closeTemplateUpload} className={buttonVariants({ variant: "ghost", size: "icon", className: "max-sm:size-11" })}><X className="size-4" aria-hidden /></button>
            </div>
            <form className="mt-5 grid gap-3" onSubmit={(event) => void submitTemplateUpload(event)}>
              <button
                {...uploadDrop.dropProps}
                type="button"
                disabled={uploadState === "working"}
                onClick={() => uploadInputRef.current?.click()}
                aria-label={uploadFile ? t.uploadReplaceHint : t.chooseTemplateFile}
                data-office-template-dropzone={uploadDrop.isDragging ? "active" : uploadFile ? "selected" : "empty"}
                className={cn(
                  "group relative flex min-h-44 w-full flex-col items-center justify-center rounded-2xl border border-dashed px-6 py-7 text-center outline-none transition-all focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60",
                  uploadDrop.isDragging
                    ? "scale-[1.01] border-primary bg-primary/[0.06] shadow-sm"
                    : uploadFile
                      ? "border-foreground/20 bg-muted/35 hover:border-foreground/35 hover:bg-muted/55"
                      : "border-border bg-muted/20 hover:border-foreground/30 hover:bg-muted/40",
                )}
              >
                {uploadDrop.isDragging ? (
                  <>
                    <span className="grid size-12 place-items-center rounded-2xl bg-primary/10 text-primary"><FileUp className="size-6" aria-hidden /></span>
                    <span className="mt-4 text-sm font-semibold text-primary">{t.uploadDropActive}</span>
                  </>
                ) : uploadFile ? (
                  <>
                    <span className={uploadFile.name.toLowerCase().endsWith(".pptx") ? "grid size-12 place-items-center rounded-2xl bg-amber-500/15 text-amber-700" : uploadFile.name.toLowerCase().endsWith(".xlsx") ? "grid size-12 place-items-center rounded-2xl bg-emerald-500/15 text-emerald-700" : "grid size-12 place-items-center rounded-2xl bg-blue-500/15 text-blue-700"}>
                      {uploadFile.name.toLowerCase().endsWith(".pptx") ? <Presentation className="size-6" aria-hidden /> : uploadFile.name.toLowerCase().endsWith(".xlsx") ? <FileSpreadsheet className="size-6" aria-hidden /> : <FileText className="size-6" aria-hidden />}
                    </span>
                    <span className="mt-4 max-w-full truncate text-sm font-semibold text-foreground">{uploadFile.name}</span>
                    <span className="mt-1 text-xs text-muted-foreground">{familyLabel(t, officeTemplateFamilyFromFileName(uploadFile.name) ?? "document")}</span>
                    <span className="mt-3 text-xs font-medium text-primary group-hover:underline">{t.uploadReplaceHint}</span>
                  </>
                ) : (
                  <>
                    <span className="grid size-12 place-items-center rounded-2xl bg-foreground/[0.06] text-foreground"><FileUp className="size-6" aria-hidden /></span>
                    <span className="mt-4 text-sm font-semibold text-foreground">{t.uploadDropTitle}</span>
                    <span className="mt-1 text-sm text-muted-foreground">{t.uploadDropBody}</span>
                    <span className="mt-3 rounded-full border bg-background px-2.5 py-1 text-[11px] font-medium text-muted-foreground">{t.uploadDropFormats}</span>
                  </>
                )}
              </button>
              <input
                ref={uploadInputRef}
                type="file"
                accept=".docx,.pptx,.xlsx,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.presentationml.presentation,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                disabled={uploadState === "working"}
                onChange={(event) => { if (event.target.files) selectUploadFiles(event.target.files); event.target.value = ""; }}
                className="sr-only"
                tabIndex={-1}
                aria-hidden
              />
              {uploadState === "invalid" ? <p role="alert" className="text-sm text-destructive">{t.uploadInvalidFile}</p> : null}
              <label className="grid gap-1.5 text-sm font-medium"><span>{t.templateName}</span><input required disabled={uploadState === "working"} value={uploadName} onChange={(event) => setUploadName(event.target.value)} placeholder={t.templateName} className={officeInputClassName} /></label>
              <label className="grid gap-1.5 text-sm font-medium"><span>{t.templateInstructions}</span><textarea required disabled={uploadState === "working"} value={uploadGuidance} onChange={(event) => setUploadGuidance(event.target.value)} placeholder={t.templateInstructions} className={`${officeTextareaClassName} min-h-24`} /></label>
              {uploadState === "failed" ? <div role="alert" className="text-sm text-destructive"><p>{t.importTemplateFailed}</p>{uploadDiagnostics.map((item, index) => <p key={index}>{t.importDiagnostics[item.reason]}{item.part ? ` (${item.part})` : ""}</p>)}</div> : null}
              <div className="mt-2 flex justify-end gap-2 border-t pt-4"><button type="button" disabled={uploadState === "working"} onClick={closeTemplateUpload} className={buttonVariants({ variant: "outline" })}>{copy.common.cancel}</button><button type="submit" disabled={(!uploadFile && !recoveringUpload) || uploadState === "working" || !uploadName.trim() || !uploadGuidance.trim()} className={buttonVariants({ variant: "default" })}>{uploadState === "working" ? t.importTemplateWorking : recoveringUpload ? t.retryTemplateImport : t.uploadTemplateAction}</button></div>
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
  const presentation = template.family === "presentation";
  const Icon = document ? FileText : presentation ? Presentation : FileSpreadsheet;
  const previewArtifact: OfficeArtifact = { artifactId: template.draftArtifactId ?? "", family: template.family, mode: "template", title: template.name, version: template.currentVersionId ? 1 : 0, lifecycleState: "active", role: "edit" };
  const importFailed = template.importState?.status === "failed" || template.importState?.status === "cancelled";
  const canUse = template.lifecycleState === "admitted" && Boolean(template.currentVersionId);
  const canEdit = template.lifecycleState === "draft" && Boolean(template.draftArtifactId);

  return (
    <article data-office-template-card={template.family} className="group overflow-hidden rounded-xl border bg-card transition-colors hover:border-foreground/30">
      <Link href={`/w/${workspaceId}/office/templates/${template.id}`} aria-label={template.name}>
        <div className="relative">{importFailed ? <div className="flex min-h-40 items-center justify-center p-6 pt-12 text-sm text-destructive">{t.importTemplateFailed}</div> : <OfficeCardPreview workspaceId={workspaceId} artifact={previewArtifact} />}<span data-office-template-family={template.family} className={officeFamilyBadgeClassName}><Icon className="size-3.5" aria-hidden /><span>{familyLabel(t, template.family)}</span></span></div>
        <div className="px-4 pt-4"><h2 className="line-clamp-2 font-medium group-hover:underline">{template.name}</h2><p className="mt-2 line-clamp-2 min-h-10 text-sm text-muted-foreground">{template.description}</p></div>
      </Link>
      <div className="p-4 pt-3">
        {canUse ? <Link href={`/w/${workspaceId}/office/new?templateId=${encodeURIComponent(template.id)}&templateVersionId=${encodeURIComponent(String(template.currentVersionId))}`} className={buttonVariants({ variant: "outline", className: "w-full" })}>{t.useTemplate}</Link> : importFailed ? <Link href={`/w/${workspaceId}/office/templates/${template.id}`} className={buttonVariants({ variant: "outline", className: "w-full" })}>{t.retryTemplateImport}</Link> : canEdit ? <Link href={`/w/${workspaceId}/office/${template.draftArtifactId}?templateId=${template.id}`} className={buttonVariants({ variant: "outline", className: "w-full" })}>{t.editTemplate}</Link> : <p className="text-xs text-muted-foreground">{t.templateUnavailable}</p>}
      </div>
    </article>
  );
}

function familyLabel(t: ReturnType<typeof useT>["office"], family: OfficeFamily): string { return family === "document" ? t.document : family === "presentation" ? t.presentation : t.spreadsheet; }

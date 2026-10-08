"use client";

import { buttonVariants } from "@/components/ui/button";
import { officeInputClassName, officeTextareaClassName, officeIconButtonClassName, officeDialogBackdropClassName, officeDialogClassName, officeFamilyBadgeClassName } from "@/components/office/office-chrome";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Dialog } from "@base-ui/react/dialog";
import { FileSpreadsheet, FileText, Presentation, X } from "lucide-react";
import { APP_LEVEL_ASSISTANT_ID } from "@use-brian/shared";
import { confirmDialog } from "@/components/ui/confirm-dialog";
import { OfficeScopePicker, type OfficeCreationScope } from "./office-scope-picker";
import { OfficeTopbar } from "./office-topbar";
import { OfficeCardPreview } from "./office-card-preview";
import { useT } from "@/lib/i18n/client";
import { format } from "@/lib/i18n/format";
import { useOptionalWorkspaceContext } from "@/lib/workspace-context";
import { officeMetadataRemaining } from "@/lib/office/metadata";
import { useOfficeMetadataResource } from "@/lib/office/surface-cache";
import { officeTemplateListCacheKey } from "@/lib/surface-prefetch";
import { invalidateSurfaceCache, readSurfaceCache } from "@/lib/surface-cache";
import { createOfficeArtifact, getOfficeCapabilities, listOfficeTemplates, OfficeApiError, type OfficeArtifact, type OfficeTemplate } from "@/lib/office/api";

type UsableOfficeTemplate = OfficeTemplate & { currentVersionId: string };

export function usableOfficeTemplates(templates: OfficeTemplate[]): UsableOfficeTemplate[] {
  return templates.filter((template): template is UsableOfficeTemplate => template.lifecycleState === "admitted" && Boolean(template.currentVersionId));
}

function createFromTemplateHref(workspaceId: string, template: UsableOfficeTemplate): string {
  return `/w/${workspaceId}/office/new?templateId=${encodeURIComponent(template.id)}&templateVersionId=${encodeURIComponent(template.currentVersionId)}`;
}

export function OfficeTemplatePicker({
  workspaceId,
  templates,
  failed,
  onSelect,
}: {
  workspaceId: string;
  templates: UsableOfficeTemplate[] | null;
  failed: boolean;
  onSelect: (template: UsableOfficeTemplate) => void;
}) {
  const t = useT().office;
  return (
    <div>
      <h1 className="pr-10 text-xl font-semibold tracking-tight sm:text-2xl">{t.chooseTemplateTitle}</h1>
      <Link href={`/w/${workspaceId}/office/new?mode=prompt`} className={buttonVariants({ variant: "outline", className: "mt-4" })}>{t.promptDocument}</Link>
      <p className="mt-2 text-sm text-muted-foreground">{t.chooseTemplateDescription}</p>
      {failed ? <p role="alert" className="py-16 text-center text-sm text-destructive">{t.loadFailed}</p> : templates === null ? <p className="py-16 text-center text-sm text-muted-foreground">{t.loading}</p> : templates.length === 0 ? (
        <section className="mt-6 rounded-2xl border border-dashed px-6 py-12 text-center">
          <h2 className="font-medium">{t.noTemplates}</h2>
          <p className="mx-auto mt-1 max-w-lg text-sm text-muted-foreground">{t.templateEmptyBody}</p>
          <Link href={`/w/${workspaceId}/office/templates`} className={buttonVariants({ className: "mt-5" })}>{t.templates}</Link>
        </section>
      ) : (
        <div className="mt-6 grid gap-4 sm:grid-cols-2">
          {templates.map((template) => {
            const document = template.family === "document";
            const presentation = template.family === "presentation";
            const Icon = document ? FileText : presentation ? Presentation : FileSpreadsheet;
            const previewArtifact: OfficeArtifact = { artifactId: template.draftArtifactId ?? "", family: template.family, mode: "template", title: template.name, version: 1, lifecycleState: "active", role: "edit" };
            return (
              <button key={template.id} type="button" data-office-template-choice={template.family} onClick={() => onSelect(template)} className="group min-w-0 overflow-hidden rounded-xl border bg-card text-left transition-colors hover:border-foreground/25 hover:bg-muted/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                <div className="relative pointer-events-none"><OfficeCardPreview workspaceId={workspaceId} artifact={previewArtifact} /><span className={officeFamilyBadgeClassName}><Icon className="size-3.5" aria-hidden /><span>{document ? t.document : presentation ? t.presentation : t.spreadsheet}</span></span></div>
                <span className="block px-4 pt-4 font-medium group-hover:underline">{template.name}</span>
                <span className="block min-h-10 px-4 pt-2 text-sm text-muted-foreground">{template.description}</span>
                <span className={buttonVariants({ variant: "outline", className: "m-4 mt-3" })}>{t.useTemplate}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function OfficeCreateForm({
  workspaceId,
  template,
  onCancel,
  onChangeTemplate,
  onDirtyChange,
  canUseTemplate,
}: {
  workspaceId: string;
  template: OfficeTemplate | null;
  onCancel: () => void;
  onChangeTemplate: () => void;
  onDirtyChange?: (dirty: boolean) => void;
  canUseTemplate: () => boolean;
}) {
  const copy = useT();
  const t = copy.office;
  const router = useRouter();
  const [scope, setScope] = useState<OfficeCreationScope | null>(null);
  const [outcome, setOutcome] = useState("");
  const [audience, setAudience] = useState("");
  const [additionalContext, setAdditionalContext] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<"failed" | "unavailable" | "provenance" | null>(null);
  const [generationAvailable, setGenerationAvailable] = useState<boolean | null>(null);
  const dirty = Boolean(outcome || audience || additionalContext);
  const alive = useRef(false);
  useLayoutEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const fields = [
    { id: "office-create-outcome", label: t.outcome, value: outcome, limit: 4_000, setValue: setOutcome, placeholder: t.outcomePlaceholder, required: true },
    { id: "office-create-audience", label: t.audience, value: audience, limit: 1_000, setValue: setAudience, placeholder: t.audiencePlaceholder, required: true },
    { id: "office-create-context", label: t.additionalContext, value: additionalContext, limit: 4_000, setValue: setAdditionalContext, placeholder: t.additionalContextPlaceholder, required: false },
  ];
  const invalidFields = fields.some((field) => field.value.length > field.limit || (field.required && !field.value.trim()));

  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  useEffect(() => {
    if (!dirty) return;
    const warnBeforeUnload = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warnBeforeUnload);
    return () => window.removeEventListener("beforeunload", warnBeforeUnload);
  }, [dirty]);

  useEffect(() => {
    let active = true;
    void getOfficeCapabilities()
      .then((capabilities) => {
        if (!active) return;
        const available = capabilities.generationAvailable && capabilities.generationFamilies.includes(template?.family ?? "document");
        setGenerationAvailable(available);
        if (!available) setError("unavailable");
      })
      .catch(() => {
        if (!active) return;
        setGenerationAvailable(false);
        setError("failed");
      });
    return () => { active = false; };
  }, [template?.family]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!alive.current || !canUseTemplate() || busy || generationAvailable !== true || invalidFields || !scope) return;
    setBusy(true);
    setError(null);
    try {
      const created = await createOfficeArtifact({
        workspaceId,
        assistantId: APP_LEVEL_ASSISTANT_ID,
        family: template?.family ?? "document",
        ...scope,
        outcome,
        audience,
        additionalContext: template ? additionalContext.trim() || undefined : undefined,
        templateId: template ? String(template.currentVersionId) : undefined,
        idempotencyKey: crypto.randomUUID(),
      });
      if (alive.current && canUseTemplate()) router.push(`/w/${workspaceId}/office/${created.artifactId}`);
    } catch (cause) {
      if (!alive.current) return;
      setError(cause instanceof OfficeApiError && cause.message === "office_generation_unavailable" ? "unavailable" : cause instanceof OfficeApiError && cause.message === "office_admission_provenance_required" ? "provenance" : "failed");
      setBusy(false);
    }
  }

  return <div>
    <h1 className="pr-10 text-xl font-semibold tracking-tight sm:text-2xl">{template ? format(t.createFromTemplate, { template: template.name }) : t.promptDocument}</h1>
    <p className="mt-2 text-sm text-muted-foreground">{template ? t.templateFirstCreateDescription : t.promptDocumentDescription}</p>
    {template ? <div className="mt-5 flex flex-wrap items-center gap-3 rounded-lg border bg-muted/30 p-3 text-sm"><span className="font-medium">{template.name}</span><span className="text-muted-foreground">{template.family === "document" ? t.document : template.family === "presentation" ? t.presentation : t.spreadsheet}</span><button type="button" onClick={onChangeTemplate} className={buttonVariants({ variant: "ghost", size: "sm", className: "ml-auto" })}>{t.browseTemplates}</button></div> : null}
    <form onSubmit={submit} className="mt-8 space-y-6">
      <OfficeScopePicker workspaceId={workspaceId} onChange={setScope} />
      {fields.filter(field => template || field.id !== "office-create-context").map((field) => {
        const tooLong = field.value.length > field.limit;
        const props = { id: field.id, required: field.required, value: field.value, onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => field.setValue(event.target.value), placeholder: field.placeholder, "aria-invalid": tooLong, "aria-describedby": `${field.id}-help` };
        return <div key={field.id}>
          <label htmlFor={field.id} className="block text-sm font-medium">{field.label}</label>
          {field.id === "office-create-audience"
            ? <input {...props} className={`${officeInputClassName} mt-2 w-full`} />
            : <textarea {...props} className={`${officeTextareaClassName} mt-2 min-h-32 w-full`} />}
          <p id={`${field.id}-help`} role={tooLong ? "alert" : undefined} className={tooLong ? "mt-1 text-sm text-destructive" : "mt-1 text-xs text-muted-foreground"}>
            {format(tooLong ? t.createFieldTooLong : t.createCharacterCount, { field: field.label, count: field.value.length, limit: field.limit })}
          </p>
        </div>;
      })}
          {error ? <p role="alert" className="text-sm text-destructive">{error === "unavailable" ? t.createUnavailable : error === "provenance" ? t.departmentGenerationUnavailable : t.createFailed}</p> : null}
      <div className="flex justify-end gap-2 border-t pt-5">
        <button type="button" onClick={onCancel} className={buttonVariants({ variant: "outline", size: "sm" })}>{copy.common.cancel}</button>
        <button type="submit" disabled={generationAvailable !== true || busy || invalidFields || !scope} className={buttonVariants({ variant: "default", size: "sm" })}>{busy ? t.generating : t.generate}</button>
      </div>
    </form>
  </div>;
}

function useTemplateChoices(workspaceId: string): { templates: UsableOfficeTemplate[] | null; selected: UsableOfficeTemplate | null; prompt: boolean; failed: boolean; canUseTemplate: (candidate?: OfficeTemplate) => boolean } {
  const searchParams = useSearchParams();
  const prompt = searchParams.get("mode") === "prompt";
  const templateId = searchParams.get("templateId");
  const templateVersionId = searchParams.get("templateVersionId");
  const workspace = useOptionalWorkspaceContext();
  const viewerId = workspace?.workspaceId === workspaceId ? workspace.me.id : "";
  const read = useOfficeMetadataResource(viewerId ? officeTemplateListCacheKey(workspaceId, viewerId) : null, viewerId, () => listOfficeTemplates(workspaceId));
  const templates = read.data ? usableOfficeTemplates(read.data) : null;
  const failed = read.error !== undefined && !read.data;
  const selected = templates?.find((candidate) => candidate.id === templateId && candidate.currentVersionId === templateVersionId) ?? null;
  const canUseTemplate = (candidate: OfficeTemplate | null = selected) => {
    if (!viewerId) return false;
    if (!candidate) return prompt;
    const current = readSurfaceCache<OfficeTemplate[]>(officeTemplateListCacheKey(workspaceId, viewerId)).data;
    return officeMetadataRemaining(current, viewerId) > 0 && Boolean(current?.some(row => JSON.stringify(row) === JSON.stringify(candidate)));
  };
  return { templates, selected, prompt, failed, canUseTemplate };
}

function useCreationIdentity(workspaceId: string) {
  const workspace = useOptionalWorkspaceContext();
  const viewerId = workspace?.workspaceId === workspaceId ? workspace.me.id : "";
  const key = officeTemplateListCacheKey(workspaceId, viewerId);
  const previous = useRef(key);
  useLayoutEffect(() => {
    if (previous.current !== key) invalidateSurfaceCache(previous.current);
    previous.current = key;
  }, [key]);
  return key;
}

function useCreationNavigation(template: UsableOfficeTemplate | null) {
  const scope = useRef<object | null>(null);
  const signature = JSON.stringify(template);
  useLayoutEffect(() => { scope.current = {}; return () => { scope.current = null; }; }, [signature]);
  return scope;
}

export function OfficeCreate({ workspaceId }: { workspaceId: string }) {
  const identity = useCreationIdentity(workspaceId);
  return <OfficeCreateSurface key={identity} workspaceId={workspaceId}/>;
}

function OfficeCreateSurface({ workspaceId }: { workspaceId: string }) {
  const copy = useT();
  const t = copy.office;
  const router = useRouter();
  const [dirty, setDirty] = useState(false);
  const base = `/w/${workspaceId}/office`;
  const { templates, selected: template, prompt, failed, canUseTemplate } = useTemplateChoices(workspaceId);
  const navigation = useCreationNavigation(template);
  useLayoutEffect(() => { if (!template) setDirty(false); }, [template]);

  async function close() {
    const started = navigation.current;
    if (dirty) {
      const discard = await confirmDialog({
        title: t.discardCreate,
        description: t.discardCreateBody,
        confirmLabel: t.discardCreate,
        cancelLabel: copy.common.cancel,
        variant: "destructive",
      });
      if (!discard || !started || started !== navigation.current) return;
    }
    router.push(base);
  }

  function selectTemplate(next: UsableOfficeTemplate) {
    if (!canUseTemplate(next)) return;
    router.replace(createFromTemplateHref(workspaceId, next), { scroll: false });
  }

  async function changeTemplate() {
    const started = navigation.current;
    if (dirty) {
      const discard = await confirmDialog({
        title: t.discardCreate,
        description: t.discardCreateBody,
        confirmLabel: t.discardCreate,
        cancelLabel: copy.common.cancel,
        variant: "destructive",
      });
      if (!discard || !started || started !== navigation.current) return;
    }
    setDirty(false);
    router.replace(`${base}/new`, { scroll: false });
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <OfficeTopbar
        workspaceId={workspaceId}
        breadcrumbs={[{ label: t.files, href: base }, { label: t.newArtifact }]}
        right={<button type="button" onClick={() => void close()} className={buttonVariants({ variant: "outline", size: "sm" })}>{t.files}</button>}
      />
      <main className={template || prompt ? "mx-auto w-full max-w-2xl overflow-y-auto p-4 sm:p-8" : "mx-auto w-full max-w-5xl overflow-y-auto p-4 sm:p-8"}>
        {template || prompt ? <OfficeCreateForm key={JSON.stringify(template)} workspaceId={workspaceId} template={template} canUseTemplate={canUseTemplate} onCancel={() => void close()} onChangeTemplate={() => void changeTemplate()} onDirtyChange={setDirty} /> : <OfficeTemplatePicker workspaceId={workspaceId} templates={templates} failed={failed} onSelect={selectTemplate} />}
      </main>
    </div>
  );
}

export function OfficeCreateDialog({ workspaceId }: { workspaceId: string }) {
  const identity = useCreationIdentity(workspaceId);
  return <OfficeCreateDialogSurface key={identity} workspaceId={workspaceId}/>;
}

function OfficeCreateDialogSurface({ workspaceId }: { workspaceId: string }) {
  const copy = useT();
  const t = copy.office;
  const router = useRouter();
  const [dirty, setDirty] = useState(false);
  const base = `/w/${workspaceId}/office`;
  const { templates, selected: template, prompt, failed, canUseTemplate } = useTemplateChoices(workspaceId);
  const navigation = useCreationNavigation(template);
  useLayoutEffect(() => { if (!template) setDirty(false); }, [template]);

  async function close() {
    const started = navigation.current;
    if (dirty) {
      const discard = await confirmDialog({
        title: t.discardCreate,
        description: t.discardCreateBody,
        confirmLabel: t.discardCreate,
        cancelLabel: copy.common.cancel,
        variant: "destructive",
      });
      if (!discard || !started || started !== navigation.current) return;
    }
    router.back();
  }

  function selectTemplate(next: UsableOfficeTemplate) {
    if (!canUseTemplate(next)) return;
    router.replace(createFromTemplateHref(workspaceId, next), { scroll: false });
  }

  async function changeTemplate() {
    const started = navigation.current;
    if (dirty) {
      const discard = await confirmDialog({
        title: t.discardCreate,
        description: t.discardCreateBody,
        confirmLabel: t.discardCreate,
        cancelLabel: copy.common.cancel,
        variant: "destructive",
      });
      if (!discard || !started || started !== navigation.current) return;
    }
    setDirty(false);
    router.replace(`${base}/new`, { scroll: false });
  }

  return (
    <Dialog.Root open onOpenChange={(open) => { if (!open) void close(); }}>
      <Dialog.Portal>
        <Dialog.Backdrop className={officeDialogBackdropClassName} />
        <Dialog.Popup className={`${officeDialogClassName} ${template || prompt ? "sm:max-w-2xl" : "sm:max-w-5xl"}`}>
          <Dialog.Title className="sr-only">{template ? format(t.createFromTemplate, { template: template.name }) : prompt ? t.promptDocument : t.chooseTemplateTitle}</Dialog.Title>
          <Dialog.Description className="sr-only">{template ? t.templateFirstCreateDescription : prompt ? t.promptDocumentDescription : t.chooseTemplateDescription}</Dialog.Description>
          <button type="button" onClick={() => void close()} aria-label={t.closeCreateAria} title={t.closeCreateAria} className={`${officeIconButtonClassName} absolute right-4 top-4`}>
            <X className="size-4" aria-hidden />
          </button>
          {template || prompt ? <OfficeCreateForm key={JSON.stringify(template)} workspaceId={workspaceId} template={template} canUseTemplate={canUseTemplate} onCancel={() => void close()} onChangeTemplate={() => void changeTemplate()} onDirtyChange={setDirty} /> : <OfficeTemplatePicker workspaceId={workspaceId} templates={templates} failed={failed} onSelect={selectTemplate} />}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

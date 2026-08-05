"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Dialog } from "@base-ui/react/dialog";
import { FileText, Presentation, X } from "lucide-react";
import { APP_LEVEL_ASSISTANT_ID } from "@use-brian/shared";
import { confirmDialog } from "@/components/ui/confirm-dialog";
import { OfficeTopbar } from "./office-topbar";
import { OfficeCardPreview } from "./office-card-preview";
import { useT } from "@/lib/i18n/client";
import { format } from "@/lib/i18n/format";
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
      <h1 className="text-2xl font-semibold">{t.chooseTemplateTitle}</h1>
      <p className="mt-2 text-sm text-muted-foreground">{t.chooseTemplateDescription}</p>
      {failed ? <p role="alert" className="py-16 text-center text-sm text-destructive">{t.loadFailed}</p> : templates === null ? <p className="py-16 text-center text-sm text-muted-foreground">{t.loading}</p> : templates.length === 0 ? (
        <section className="mt-6 rounded-2xl border border-dashed px-6 py-12 text-center">
          <h2 className="font-medium">{t.noTemplates}</h2>
          <p className="mx-auto mt-1 max-w-lg text-sm text-muted-foreground">{t.templateEmptyBody}</p>
          <Link href={`/w/${workspaceId}/office/templates`} className="mt-5 inline-flex h-9 items-center rounded-md bg-action px-4 text-sm font-medium text-action-foreground">{t.templates}</Link>
        </section>
      ) : (
        <div className="mt-6 grid gap-4 sm:grid-cols-2">
          {templates.map((template) => {
            const document = template.family === "document";
            const Icon = document ? FileText : Presentation;
            const previewArtifact: OfficeArtifact = { artifactId: template.draftArtifactId ?? "", family: template.family, mode: "template", title: template.name, version: 1, lifecycleState: "active", role: "edit" };
            return (
              <button key={template.id} type="button" data-office-template-choice={template.family} onClick={() => onSelect(template)} className="group overflow-hidden rounded-xl border bg-card text-left transition-all hover:-translate-y-0.5 hover:border-foreground/30 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                <div className="relative pointer-events-none"><OfficeCardPreview artifact={previewArtifact} /><span className={document ? "absolute left-3 top-3 inline-flex items-center gap-1.5 rounded-md bg-blue-600 px-2 py-1 text-xs font-semibold text-white shadow-sm" : "absolute left-3 top-3 inline-flex items-center gap-1.5 rounded-md bg-amber-500 px-2 py-1 text-xs font-semibold text-amber-950 shadow-sm"}><Icon className="size-3.5" aria-hidden /><span>{document ? t.document : t.presentation}</span></span></div>
                <span className="block px-4 pt-4 font-medium group-hover:underline">{template.name}</span>
                <span className="block min-h-10 px-4 pt-2 text-sm text-muted-foreground">{template.description}</span>
                <span className="m-4 mt-3 inline-flex h-9 items-center justify-center rounded-md bg-action px-3 text-sm font-medium text-action-foreground">{t.useTemplate}</span>
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
}: {
  workspaceId: string;
  template: OfficeTemplate;
  onCancel: () => void;
  onChangeTemplate: () => void;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const copy = useT();
  const t = copy.office;
  const router = useRouter();
  const [outcome, setOutcome] = useState("");
  const [audience, setAudience] = useState("");
  const [website, setWebsite] = useState("");
  const [noWebsite, setNoWebsite] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<"failed" | "unavailable" | null>(null);
  const [generationAvailable, setGenerationAvailable] = useState<boolean | null>(null);
  const dirty = Boolean(outcome || audience || website || noWebsite);

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
        setGenerationAvailable(capabilities.generationAvailable);
        if (!capabilities.generationAvailable) setError("unavailable");
      })
      .catch(() => {
        if (!active) return;
        setGenerationAvailable(false);
        setError("failed");
      });
    return () => { active = false; };
  }, []);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const created = await createOfficeArtifact({
        workspaceId,
        assistantId: APP_LEVEL_ASSISTANT_ID,
        family: template.family,
        outcome,
        audience,
        canonicalWebsite: noWebsite || !website ? undefined : website,
        companyHasNoWebsite: noWebsite,
        templateId: String(template.currentVersionId),
        idempotencyKey: crypto.randomUUID(),
      });
      router.push(`/w/${workspaceId}/office/${created.artifactId}`);
    } catch (cause) {
      setError(cause instanceof OfficeApiError && cause.message === "office_generation_unavailable" ? "unavailable" : "failed");
      setBusy(false);
    }
  }

  return <div>
    <h1 className="text-2xl font-semibold">{format(t.createFromTemplate, { template: template.name })}</h1>
    <p className="mt-2 text-sm text-muted-foreground">{t.templateFirstCreateDescription}</p>
    <div className="mt-5 flex items-center gap-3 rounded-lg border bg-muted/30 p-3 text-sm"><span className="font-medium">{template.name}</span><span className="text-muted-foreground">{template.family === "document" ? t.document : t.presentation}</span><button type="button" onClick={onChangeTemplate} className="ml-auto rounded-md px-2 py-1 font-medium text-primary hover:bg-background">{t.browseTemplates}</button></div>
    <form onSubmit={submit} className="mt-8 space-y-6">
          <label className="block text-sm font-medium">{t.outcome}<textarea required value={outcome} onChange={(event) => setOutcome(event.target.value)} placeholder={t.outcomePlaceholder} className="mt-2 min-h-32 w-full rounded-md border bg-background p-3 font-normal" /></label>
          <label className="block text-sm font-medium">{t.audience}<input required value={audience} onChange={(event) => setAudience(event.target.value)} placeholder={t.audiencePlaceholder} className="mt-2 h-10 w-full rounded-md border bg-background px-3 font-normal" /></label>
          <label className="block text-sm font-medium">{t.website}<input type="url" disabled={noWebsite} value={website} onChange={(event) => setWebsite(event.target.value)} placeholder={t.websitePlaceholder} className="mt-2 h-10 w-full rounded-md border bg-background px-3 font-normal disabled:opacity-50" /></label>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={noWebsite} onChange={(event) => setNoWebsite(event.target.checked)} />{t.noWebsite}</label>
          {error ? <p role="alert" className="text-sm text-destructive">{error === "unavailable" ? t.createUnavailable : t.createFailed}</p> : null}
      <div className="flex justify-end gap-2 border-t pt-5">
        <button type="button" onClick={onCancel} className="h-10 rounded-md border px-4 text-sm font-medium">{copy.common.cancel}</button>
        <button type="submit" disabled={generationAvailable !== true || busy || !outcome.trim() || !audience.trim() || (!noWebsite && !website)} className="h-10 rounded-md bg-action px-5 text-sm font-medium text-action-foreground disabled:opacity-50">{busy ? t.generating : t.generate}</button>
      </div>
    </form>
  </div>;
}

function useTemplateChoices(workspaceId: string): { templates: UsableOfficeTemplate[] | null; selected: UsableOfficeTemplate | null; failed: boolean } {
  const searchParams = useSearchParams();
  const templateId = searchParams.get("templateId");
  const templateVersionId = searchParams.get("templateVersionId");
  const [templates, setTemplates] = useState<UsableOfficeTemplate[] | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true;
    setFailed(false);
    void listOfficeTemplates(workspaceId).then((rows) => {
      if (!active) return;
      setTemplates(usableOfficeTemplates(rows));
    }).catch(() => {
      if (active) { setTemplates([]); setFailed(true); }
    });
    return () => { active = false; };
  }, [workspaceId]);
  const selected = templates?.find((candidate) => candidate.id === templateId && candidate.currentVersionId === templateVersionId) ?? null;
  return { templates, selected, failed };
}

export function OfficeCreate({ workspaceId }: { workspaceId: string }) {
  const copy = useT();
  const t = copy.office;
  const router = useRouter();
  const [dirty, setDirty] = useState(false);
  const base = `/w/${workspaceId}/office`;
  const { templates, selected: template, failed } = useTemplateChoices(workspaceId);

  async function close() {
    if (dirty) {
      const discard = await confirmDialog({
        title: t.discardCreate,
        description: t.discardCreateBody,
        confirmLabel: t.discardCreate,
        cancelLabel: copy.common.cancel,
        variant: "destructive",
      });
      if (!discard) return;
    }
    router.push(base);
  }

  function selectTemplate(next: UsableOfficeTemplate) {
    router.replace(createFromTemplateHref(workspaceId, next), { scroll: false });
  }

  async function changeTemplate() {
    if (dirty) {
      const discard = await confirmDialog({
        title: t.discardCreate,
        description: t.discardCreateBody,
        confirmLabel: t.discardCreate,
        cancelLabel: copy.common.cancel,
        variant: "destructive",
      });
      if (!discard) return;
    }
    setDirty(false);
    router.replace(`${base}/new`, { scroll: false });
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <OfficeTopbar
        workspaceId={workspaceId}
        breadcrumbs={[{ label: t.files, href: base }, { label: t.newArtifact }]}
        right={<button type="button" onClick={() => void close()} className="inline-flex h-8 items-center rounded-md border px-2.5 text-sm font-medium">{t.files}</button>}
      />
      <main className={template ? "mx-auto w-full max-w-2xl p-4 sm:p-8" : "mx-auto w-full max-w-5xl p-4 sm:p-8"}>
        {template ? <OfficeCreateForm workspaceId={workspaceId} template={template} onCancel={() => void close()} onChangeTemplate={() => void changeTemplate()} onDirtyChange={setDirty} /> : <OfficeTemplatePicker workspaceId={workspaceId} templates={templates} failed={failed} onSelect={selectTemplate} />}
      </main>
    </div>
  );
}

export function OfficeCreateDialog({ workspaceId }: { workspaceId: string }) {
  const copy = useT();
  const t = copy.office;
  const router = useRouter();
  const [dirty, setDirty] = useState(false);
  const base = `/w/${workspaceId}/office`;
  const { templates, selected: template, failed } = useTemplateChoices(workspaceId);

  async function close() {
    if (dirty) {
      const discard = await confirmDialog({
        title: t.discardCreate,
        description: t.discardCreateBody,
        confirmLabel: t.discardCreate,
        cancelLabel: copy.common.cancel,
        variant: "destructive",
      });
      if (!discard) return;
    }
    router.back();
  }

  function selectTemplate(next: UsableOfficeTemplate) {
    router.replace(createFromTemplateHref(workspaceId, next), { scroll: false });
  }

  async function changeTemplate() {
    if (dirty) {
      const discard = await confirmDialog({
        title: t.discardCreate,
        description: t.discardCreateBody,
        confirmLabel: t.discardCreate,
        cancelLabel: copy.common.cancel,
        variant: "destructive",
      });
      if (!discard) return;
    }
    setDirty(false);
    router.replace(`${base}/new`, { scroll: false });
  }

  return (
    <Dialog.Root open onOpenChange={(open) => { if (!open) void close(); }}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-50 bg-background/80 backdrop-blur-sm" />
        <Dialog.Popup className={template ? "fixed inset-0 z-50 h-dvh w-full overflow-y-auto bg-background p-5 outline-none sm:inset-auto sm:left-1/2 sm:top-1/2 sm:h-auto sm:max-h-[calc(100vh-2rem)] sm:w-[calc(100%-2rem)] sm:max-w-2xl sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-2xl sm:border sm:p-8 sm:shadow-xl" : "fixed inset-0 z-50 h-dvh w-full overflow-y-auto bg-background p-5 outline-none sm:inset-auto sm:left-1/2 sm:top-1/2 sm:h-auto sm:max-h-[calc(100vh-2rem)] sm:w-[calc(100%-2rem)] sm:max-w-5xl sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-2xl sm:border sm:p-8 sm:shadow-xl"}>
          <Dialog.Title className="sr-only">{template ? format(t.createFromTemplate, { template: template.name }) : t.chooseTemplateTitle}</Dialog.Title>
          <Dialog.Description className="sr-only">{template ? t.templateFirstCreateDescription : t.chooseTemplateDescription}</Dialog.Description>
          <button type="button" onClick={() => void close()} aria-label={t.closeCreateAria} title={t.closeCreateAria} className="absolute right-4 top-4 inline-flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground">
            <X className="size-4" aria-hidden />
          </button>
          {template ? <OfficeCreateForm workspaceId={workspaceId} template={template} onCancel={() => void close()} onChangeTemplate={() => void changeTemplate()} onDirtyChange={setDirty} /> : <OfficeTemplatePicker workspaceId={workspaceId} templates={templates} failed={failed} onSelect={selectTemplate} />}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

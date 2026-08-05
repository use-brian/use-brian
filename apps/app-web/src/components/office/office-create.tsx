"use client";

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Dialog } from "@base-ui/react/dialog";
import { X } from "lucide-react";
import { APP_LEVEL_ASSISTANT_ID } from "@use-brian/shared";
import { confirmDialog } from "@/components/ui/confirm-dialog";
import { OfficeTopbar } from "./office-topbar";
import { useT } from "@/lib/i18n/client";
import { format } from "@/lib/i18n/format";
import { createOfficeArtifact, getOfficeCapabilities, listOfficeTemplates, OfficeApiError, type OfficeTemplate } from "@/lib/office/api";

function OfficeCreateForm({
  workspaceId,
  template,
  onCancel,
  onDirtyChange,
}: {
  workspaceId: string;
  template: OfficeTemplate;
  onCancel: () => void;
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
    <div className="mt-5 flex items-center gap-3 rounded-lg border bg-muted/30 p-3 text-sm"><span className="font-medium">{template.name}</span><span className="text-muted-foreground">{template.family === "document" ? t.document : t.presentation}</span></div>
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

function useSelectedTemplate(workspaceId: string): OfficeTemplate | null | undefined {
  const searchParams = useSearchParams();
  const router = useRouter();
  const templateId = searchParams.get("templateId");
  const templateVersionId = searchParams.get("templateVersionId");
  const [template, setTemplate] = useState<OfficeTemplate | null | undefined>();
  useEffect(() => {
    if (!templateId || !templateVersionId) {
      setTemplate(null);
      router.replace(`/w/${workspaceId}/office/templates?intent=use`);
      return;
    }
    let active = true;
    void listOfficeTemplates(workspaceId).then((templates) => {
      if (!active) return;
      const selected = templates.find((candidate) => candidate.id === templateId && candidate.lifecycleState === "admitted" && candidate.currentVersionId === templateVersionId) ?? null;
      setTemplate(selected);
      if (!selected) router.replace(`/w/${workspaceId}/office/templates?intent=use`);
    }).catch(() => {
      if (active) setTemplate(null);
    });
    return () => { active = false; };
  }, [router, templateId, templateVersionId, workspaceId]);
  return template;
}

export function OfficeCreate({ workspaceId }: { workspaceId: string }) {
  const copy = useT();
  const t = copy.office;
  const router = useRouter();
  const [dirty, setDirty] = useState(false);
  const templatesHref = `/w/${workspaceId}/office/templates?intent=use`;
  const template = useSelectedTemplate(workspaceId);

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
    router.push(templatesHref);
  }

  if (!template) return <div className="flex min-h-0 flex-1 flex-col"><OfficeTopbar workspaceId={workspaceId} breadcrumbs={[{ label: t.newArtifact }]} /><p className="m-auto text-sm text-muted-foreground">{t.choosingTemplate}</p></div>;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <OfficeTopbar
        workspaceId={workspaceId}
        breadcrumbs={[{ label: t.templates, href: `/w/${workspaceId}/office/templates` }, { label: t.newArtifact }]}
        right={<button type="button" onClick={() => void close()} className="inline-flex h-8 items-center rounded-md border px-2.5 text-sm font-medium">{t.backToTemplates}</button>}
      />
      <main className="mx-auto w-full max-w-2xl p-4 sm:p-8">
        <OfficeCreateForm workspaceId={workspaceId} template={template} onCancel={() => void close()} onDirtyChange={setDirty} />
      </main>
    </div>
  );
}

export function OfficeCreateDialog({ workspaceId }: { workspaceId: string }) {
  const copy = useT();
  const t = copy.office;
  const router = useRouter();
  const [dirty, setDirty] = useState(false);
  const template = useSelectedTemplate(workspaceId);

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

  if (!template) return null;

  return (
    <Dialog.Root open onOpenChange={(open) => { if (!open) void close(); }}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-50 bg-background/80 backdrop-blur-sm" />
        <Dialog.Popup className="fixed inset-0 z-50 h-dvh w-full overflow-y-auto bg-background p-5 outline-none sm:inset-auto sm:left-1/2 sm:top-1/2 sm:h-auto sm:max-h-[calc(100vh-2rem)] sm:w-[calc(100%-2rem)] sm:max-w-2xl sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-2xl sm:border sm:p-8 sm:shadow-xl">
          <Dialog.Title className="sr-only">{format(t.createFromTemplate, { template: template.name })}</Dialog.Title>
          <Dialog.Description className="sr-only">{t.templateFirstCreateDescription}</Dialog.Description>
          <button type="button" onClick={() => void close()} aria-label={t.closeCreateAria} title={t.closeCreateAria} className="absolute right-4 top-4 inline-flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground">
            <X className="size-4" aria-hidden />
          </button>
          <OfficeCreateForm workspaceId={workspaceId} template={template} onCancel={() => void close()} onDirtyChange={setDirty} />
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

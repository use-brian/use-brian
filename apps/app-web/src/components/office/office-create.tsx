"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Dialog } from "@base-ui/react/dialog";
import { X } from "lucide-react";
import { APP_LEVEL_ASSISTANT_ID } from "@use-brian/shared";
import { confirmDialog } from "@/components/ui/confirm-dialog";
import { OfficeTopbar } from "./office-topbar";
import { useT } from "@/lib/i18n/client";
import { createOfficeArtifact, type OfficeFamily } from "@/lib/office/api";
import { cn } from "@/lib/utils";

function OfficeCreateForm({
  workspaceId,
  onCancel,
  onDirtyChange,
}: {
  workspaceId: string;
  onCancel: () => void;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const copy = useT();
  const t = copy.office;
  const router = useRouter();
  const [family, setFamily] = useState<OfficeFamily>("document");
  const [outcome, setOutcome] = useState("");
  const [audience, setAudience] = useState("");
  const [website, setWebsite] = useState("");
  const [noWebsite, setNoWebsite] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const dirty = family !== "document" || Boolean(outcome || audience || website || noWebsite);

  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  useEffect(() => {
    if (!dirty) return;
    const warnBeforeUnload = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warnBeforeUnload);
    return () => window.removeEventListener("beforeunload", warnBeforeUnload);
  }, [dirty]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(false);
    try {
      const created = await createOfficeArtifact({
        workspaceId,
        assistantId: APP_LEVEL_ASSISTANT_ID,
        family,
        outcome,
        audience,
        canonicalWebsite: noWebsite || !website ? undefined : website,
        companyHasNoWebsite: noWebsite,
        idempotencyKey: crypto.randomUUID(),
      });
      router.push(`/w/${workspaceId}/office/${created.artifactId}`);
    } catch {
      setError(true);
      setBusy(false);
    }
  }

  return <div>
    <h1 className="text-2xl font-semibold">{t.newTitle}</h1>
    <p className="mt-2 text-sm text-muted-foreground">{t.newDescription}</p>
    <form onSubmit={submit} className="mt-8 space-y-6">
      <fieldset>
        <legend className="mb-2 text-sm font-medium">{t.family}</legend>
        <div className="grid grid-cols-2 gap-2">
          {(["document", "presentation"] as const).map((item) => <button key={item} type="button" onClick={() => setFamily(item)} className={cn("rounded-lg border p-4 text-left text-sm", family === item && "border-primary ring-1 ring-primary")}>{item === "document" ? t.document : t.presentation}</button>)}
        </div>
      </fieldset>
      <label className="block text-sm font-medium">{t.outcome}<textarea required value={outcome} onChange={(event) => setOutcome(event.target.value)} placeholder={t.outcomePlaceholder} className="mt-2 min-h-32 w-full rounded-md border bg-background p-3 font-normal" /></label>
      <label className="block text-sm font-medium">{t.audience}<input required value={audience} onChange={(event) => setAudience(event.target.value)} placeholder={t.audiencePlaceholder} className="mt-2 h-10 w-full rounded-md border bg-background px-3 font-normal" /></label>
      <label className="block text-sm font-medium">{t.website}<input type="url" disabled={noWebsite} value={website} onChange={(event) => setWebsite(event.target.value)} placeholder={t.websitePlaceholder} className="mt-2 h-10 w-full rounded-md border bg-background px-3 font-normal disabled:opacity-50" /></label>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={noWebsite} onChange={(event) => setNoWebsite(event.target.checked)} />{t.noWebsite}</label>
      {error ? <p role="alert" className="text-sm text-destructive">{t.createFailed}</p> : null}
      <div className="flex justify-end gap-2 border-t pt-5">
        <button type="button" onClick={onCancel} className="h-10 rounded-md border px-4 text-sm font-medium">{copy.common.cancel}</button>
        <button type="submit" disabled={busy || !outcome.trim() || !audience.trim() || (!noWebsite && !website)} className="h-10 rounded-md bg-primary px-5 text-sm font-medium text-primary-foreground disabled:opacity-50">{busy ? t.generating : t.generate}</button>
      </div>
    </form>
  </div>;
}

export function OfficeCreate({ workspaceId }: { workspaceId: string }) {
  const copy = useT();
  const t = copy.office;
  const router = useRouter();
  const [dirty, setDirty] = useState(false);
  const officeHref = `/w/${workspaceId}/office`;

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
    router.push(officeHref);
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <OfficeTopbar
        workspaceId={workspaceId}
        breadcrumbs={[{ label: t.create }]}
        right={<button type="button" onClick={() => void close()} className="inline-flex h-8 items-center rounded-md border px-2.5 text-sm font-medium">{t.backToOffice}</button>}
      />
      <main className="mx-auto w-full max-w-2xl p-4 sm:p-8">
        <OfficeCreateForm workspaceId={workspaceId} onCancel={() => void close()} onDirtyChange={setDirty} />
      </main>
    </div>
  );
}

export function OfficeCreateDialog({ workspaceId }: { workspaceId: string }) {
  const copy = useT();
  const t = copy.office;
  const router = useRouter();
  const [dirty, setDirty] = useState(false);

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

  return (
    <Dialog.Root open onOpenChange={(open) => { if (!open) void close(); }}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-50 bg-background/80 backdrop-blur-sm" />
        <Dialog.Popup className="fixed inset-0 z-50 h-dvh w-full overflow-y-auto bg-background p-5 outline-none sm:inset-auto sm:left-1/2 sm:top-1/2 sm:h-auto sm:max-h-[calc(100vh-2rem)] sm:w-[calc(100%-2rem)] sm:max-w-2xl sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-2xl sm:border sm:p-8 sm:shadow-xl">
          <Dialog.Title className="sr-only">{t.newTitle}</Dialog.Title>
          <Dialog.Description className="sr-only">{t.newDescription}</Dialog.Description>
          <button type="button" onClick={() => void close()} aria-label={t.closeCreateAria} title={t.closeCreateAria} className="absolute right-4 top-4 inline-flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground">
            <X className="size-4" aria-hidden />
          </button>
          <OfficeCreateForm workspaceId={workspaceId} onCancel={() => void close()} onDirtyChange={setDirty} />
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { APP_LEVEL_ASSISTANT_ID } from "@use-brian/shared";
import { OperatorTopbar } from "@/components/operator/operator-topbar";
import { useT } from "@/lib/i18n/client";
import { createOfficeArtifact, type OfficeFamily } from "@/lib/office/api";
import { cn } from "@/lib/utils";

export function OfficeCreate({ workspaceId }: { workspaceId: string }) {
  const t = useT().office;
  const router = useRouter();
  const [family, setFamily] = useState<OfficeFamily>("document");
  const [outcome, setOutcome] = useState("");
  const [audience, setAudience] = useState("");
  const [website, setWebsite] = useState("");
  const [noWebsite, setNoWebsite] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);

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

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <OperatorTopbar app="office" />
      <main className="mx-auto w-full max-w-2xl p-4 sm:p-8">
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
          <button type="submit" disabled={busy || !outcome.trim() || !audience.trim() || (!noWebsite && !website)} className="h-10 rounded-md bg-primary px-5 text-sm font-medium text-primary-foreground disabled:opacity-50">{busy ? t.generating : t.generate}</button>
        </form>
      </main>
    </div>
  );
}

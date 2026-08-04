"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { OperatorTopbar } from "@/components/operator/operator-topbar";
import { useT } from "@/lib/i18n/client";
import { createOfficeTemplate, listOfficeTemplates, type OfficeFamily } from "@/lib/office/api";

export function OfficeTemplateLibrary({ workspaceId, templateId }: { workspaceId: string; templateId?: string }) {
  const t = useT().office;
  const router = useRouter();
  const [templates, setTemplates] = useState<Array<Record<string, unknown>> | null>(null);
  const [creating, setCreating] = useState(false);
  const [family, setFamily] = useState<OfficeFamily>("document");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  useEffect(() => { void listOfficeTemplates(workspaceId).then(setTemplates).catch(() => setTemplates([])); }, [workspaceId]);
  const selected = templateId ? templates?.find((template) => template.id === templateId) : undefined;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <OperatorTopbar app="office" />
      <main className="mx-auto w-full max-w-5xl p-4 sm:p-8">
        <Link href={`/w/${workspaceId}/office`} className="text-sm text-muted-foreground hover:underline">{t.backToOffice}</Link>
        <h1 className="mt-5 text-2xl font-semibold">{selected ? String(selected.name ?? t.templateTitle) : t.templateTitle}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t.templateDescription}</p>
        {!selected ? <div className="mt-5"><button type="button" onClick={() => setCreating((value) => !value)} className="rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground">{t.newTemplate}</button>{creating ? <form className="mt-4 grid gap-3 rounded-xl border p-4" onSubmit={(event) => { event.preventDefault(); void createOfficeTemplate({ workspaceId, family, name, description }).then((created) => router.push(`/w/${workspaceId}/office/${created.draftArtifactId}?templateId=${created.id}`)); }}><select aria-label={t.family} value={family} onChange={(event) => setFamily(event.target.value as OfficeFamily)} className="h-9 rounded border bg-background px-2"><option value="document">{t.document}</option><option value="presentation">{t.presentation}</option></select><input required value={name} onChange={(event) => setName(event.target.value)} placeholder={t.templateName} className="h-9 rounded border px-2" /><textarea required value={description} onChange={(event) => setDescription(event.target.value)} placeholder={t.templateInstructions} className="min-h-20 rounded border p-2" /><button type="submit" className="w-fit rounded bg-primary px-3 py-2 text-sm text-primary-foreground">{t.create}</button></form> : null}</div> : <p className="mt-5 rounded-md bg-amber-50 p-3 text-sm text-amber-950">{t.templateMode}</p>}
        {templates === null ? <p className="py-16 text-center text-sm text-muted-foreground">{t.loading}</p> : templates.length === 0 ? <p className="mt-8 rounded-xl border border-dashed p-12 text-center text-sm text-muted-foreground">{t.noTemplates}</p> : (
          <div className="mt-8 grid gap-3 sm:grid-cols-2">{templates.map((template) => <Link key={String(template.id)} href={`/w/${workspaceId}/office/templates/${String(template.id)}`} className="rounded-xl border p-4"><h2 className="font-medium">{String(template.name)}</h2><p className="mt-2 text-sm text-muted-foreground">{String(template.description ?? "")}</p></Link>)}</div>
        )}
      </main>
    </div>
  );
}

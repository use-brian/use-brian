"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { OperatorTopbar } from "@/components/operator/operator-topbar";
import { useT } from "@/lib/i18n/client";
import { listOfficeTemplates } from "@/lib/office/api";

export function OfficeTemplateLibrary({ workspaceId, templateId }: { workspaceId: string; templateId?: string }) {
  const t = useT().office;
  const [templates, setTemplates] = useState<Array<Record<string, unknown>> | null>(null);
  useEffect(() => { void listOfficeTemplates(workspaceId).then(setTemplates).catch(() => setTemplates([])); }, [workspaceId]);
  const selected = templateId ? templates?.find((template) => template.id === templateId) : undefined;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <OperatorTopbar app="office" />
      <main className="mx-auto w-full max-w-5xl p-4 sm:p-8">
        <Link href={`/w/${workspaceId}/office`} className="text-sm text-muted-foreground hover:underline">{t.backToOffice}</Link>
        <h1 className="mt-5 text-2xl font-semibold">{selected ? String(selected.name ?? t.templateTitle) : t.templateTitle}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t.templateDescription}</p>
        {templates === null ? <p className="py-16 text-center text-sm text-muted-foreground">{t.loading}</p> : templates.length === 0 ? <p className="mt-8 rounded-xl border border-dashed p-12 text-center text-sm text-muted-foreground">{t.noTemplates}</p> : (
          <div className="mt-8 grid gap-3 sm:grid-cols-2">{templates.map((template) => <Link key={String(template.id)} href={`/w/${workspaceId}/office/templates/${String(template.id)}`} className="rounded-xl border p-4"><h2 className="font-medium">{String(template.name)}</h2><p className="mt-2 text-sm text-muted-foreground">{String(template.description ?? "")}</p></Link>)}</div>
        )}
      </main>
    </div>
  );
}

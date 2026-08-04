"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Upload } from "lucide-react";
import { APP_LEVEL_ASSISTANT_ID } from "@use-brian/shared";
import { listOfficeTemplates, startOfficeImport, uploadOfficeSource } from "@/lib/office/api";
import { useT } from "@/lib/i18n/client";

export function OfficeImport({ workspaceId }: { workspaceId: string }) {
  const t = useT().office;
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [templates, setTemplates] = useState<Array<Record<string, unknown>>>([]);
  const [templateVersionId, setTemplateVersionId] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (open) void listOfficeTemplates(workspaceId).then(setTemplates); }, [open, workspaceId]);
  async function upload(file: File) {
    setBusy(true);
    try {
      const source = await uploadOfficeSource(workspaceId, file);
      const template = templates.find((row) => row.currentVersionId === templateVersionId && row.family === source.family);
      if (!template) throw new Error("office_template_required");
      const created = await startOfficeImport({ workspaceId, assistantId: APP_LEVEL_ASSISTANT_ID, family: source.family, sourceFileId: source.fileId, title: file.name.replace(/\.(docx|pptx)$/i, ""), templateVersionId });
      router.push(`/w/${workspaceId}/office/${created.artifactId}`);
    } finally { setBusy(false); }
  }
  return <div className="relative"><button type="button" onClick={() => setOpen((value) => !value)} className="inline-flex h-9 items-center gap-2 rounded-md border px-3 text-sm font-medium"><Upload className="size-4" />{t.importFile}</button>{open ? <div className="absolute right-0 top-11 z-30 w-72 rounded-lg border bg-popover p-3 shadow-lg"><label className="block text-xs font-medium">{t.importTemplate}<select value={templateVersionId} onChange={(event) => setTemplateVersionId(event.target.value)} className="mt-1 h-9 w-full rounded border bg-background px-2"><option value="">{t.selectTemplate}</option>{templates.filter((row) => row.currentVersionId).map((row) => <option key={String(row.id)} value={String(row.currentVersionId)}>{String(row.name)}</option>)}</select></label><label className="mt-3 block cursor-pointer rounded-md bg-primary px-3 py-2 text-center text-sm text-primary-foreground aria-disabled:opacity-50" aria-disabled={busy || !templateVersionId}>{busy ? t.importing : t.chooseDocxPptx}<input type="file" accept=".docx,.pptx" disabled={busy || !templateVersionId} className="sr-only" onChange={(event) => { const file = event.target.files?.[0]; if (file) void upload(file); }} /></label></div> : null}</div>;
}

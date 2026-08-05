"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Upload } from "lucide-react";
import { APP_LEVEL_ASSISTANT_ID } from "@use-brian/shared";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
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
  const selectedTemplate = templates.find((row) => String(row.currentVersionId) === templateVersionId);
  return <div className="relative"><button type="button" aria-label={t.importFile} title={t.importFile} onClick={() => setOpen((value) => !value)} className="inline-flex size-8 items-center justify-center gap-2 rounded-md border text-sm font-medium sm:w-auto sm:px-2.5"><Upload className="size-4" /><span className="hidden sm:inline">{t.importFile}</span></button>{open ? <div className="absolute right-0 top-10 z-30 w-72 rounded-lg border bg-popover p-3 shadow-lg"><div className="text-xs font-medium"><span>{t.importTemplate}</span><Select value={templateVersionId || null} onValueChange={(value) => setTemplateVersionId(value ?? "")}><SelectTrigger aria-label={t.importTemplate} className="mt-1 h-9 w-full">{selectedTemplate ? String(selectedTemplate.name) : t.selectTemplate}</SelectTrigger><SelectContent>{templates.filter((row) => row.currentVersionId).map((row) => <SelectItem key={String(row.id)} value={String(row.currentVersionId)}>{String(row.name)}</SelectItem>)}</SelectContent></Select></div><label className="mt-3 block cursor-pointer rounded-md bg-primary px-3 py-2 text-center text-sm text-primary-foreground aria-disabled:opacity-50" aria-disabled={busy || !templateVersionId}>{busy ? t.importing : t.chooseDocxPptx}<input type="file" accept=".docx,.pptx" disabled={busy || !templateVersionId} className="sr-only" onChange={(event) => { const file = event.target.files?.[0]; if (file) void upload(file); }} /></label></div> : null}</div>;
}

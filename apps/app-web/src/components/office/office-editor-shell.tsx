"use client";

import { useEffect, useState } from "react";
import { FileText, Presentation } from "lucide-react";
import { OperatorTopbar } from "@/components/operator/operator-topbar";
import { OfficeJobActivity } from "./job-activity";
import { useT } from "@/lib/i18n/client";
import { getOfficeArtifact, type OfficeArtifact } from "@/lib/office/api";

export function OfficeEditorShell({ artifactId }: { workspaceId: string; artifactId: string }) {
  const t = useT().office;
  const [artifact, setArtifact] = useState<OfficeArtifact | null | undefined>();
  useEffect(() => { void getOfficeArtifact(artifactId).then(setArtifact).catch(() => setArtifact(null)); }, [artifactId]);
  if (artifact === undefined) return <div className="flex flex-1 flex-col"><OperatorTopbar app="office" /><p className="m-auto text-sm text-muted-foreground">{t.editorLoading}</p></div>;
  if (artifact === null) return <div className="flex flex-1 flex-col"><OperatorTopbar app="office" /><p className="m-auto text-sm text-destructive">{t.editorFailed}</p></div>;
  const Icon = artifact.family === "document" ? FileText : Presentation;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <OperatorTopbar app="office" center={<div className="flex min-w-0 items-center gap-2 px-2"><Icon className="size-4 shrink-0" aria-hidden /><span className="truncate text-sm font-medium">{artifact.title}</span></div>} />
      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <main className="min-h-0 flex-1 overflow-auto bg-muted/30 p-4 sm:p-8">
          <div className={artifact.family === "document" ? "mx-auto min-h-[70rem] max-w-[50rem] border bg-white p-12 text-slate-950 shadow-sm" : "mx-auto aspect-video max-w-5xl border bg-white p-12 text-slate-950 shadow-sm"} data-office-family={artifact.family} data-office-version={artifact.version}>
            <h1 className="text-3xl font-semibold">{artifact.title}</h1>
            <p className="mt-4 text-sm text-slate-500">{artifact.job?.status === "completed" ? t.completed : artifact.job?.status === "failed" ? t.failed : t.running}</p>
          </div>
        </main>
        {artifact.job ? <OfficeJobActivity jobId={artifact.job.id} /> : null}
      </div>
    </div>
  );
}

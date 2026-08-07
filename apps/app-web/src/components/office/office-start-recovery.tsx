"use client";

/** Recovery surface for an empty Office shell whose job was never admitted. [COMP:app-web/office-start-recovery] */
import Link from "next/link";
import { FileSpreadsheet, FileText, Presentation, TriangleAlert } from "lucide-react";
import { OperatorTopbar } from "@/components/operator/operator-topbar";
import { useT } from "@/lib/i18n/client";
import type { OfficeFamily } from "@/lib/office/api";

export function OfficeStartRecovery({
  workspaceId,
  title,
  family,
  canTrash,
  state,
  onTrash,
}: {
  workspaceId: string;
  title: string;
  family: OfficeFamily;
  canTrash: boolean;
  state: "idle" | "moving" | "failed";
  onTrash(): void;
}) {
  const t = useT().office;
  const Icon = family === "document" ? FileText : family === "presentation" ? Presentation : FileSpreadsheet;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <OperatorTopbar app="office" center={<div className="flex min-w-0 items-center gap-2 px-2"><Icon className="size-4 shrink-0" aria-hidden /><span className="truncate text-sm font-medium">{title}</span></div>} />
      <main className="m-auto w-full max-w-lg p-6">
        <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-6">
          <TriangleAlert className="size-6 text-destructive" aria-hidden />
          <h1 className="mt-4 text-lg font-semibold">{t.startFailedTitle}</h1>
          <p className="mt-2 text-sm text-muted-foreground">{t.startFailedBody}</p>
          {state === "failed" ? <p role="alert" className="mt-3 text-sm text-destructive">{t.recoveryFailed}</p> : null}
          <div className="mt-6 flex flex-wrap gap-2">
            <Link href={`/w/${workspaceId}/office`} className="inline-flex h-9 items-center rounded-md border px-3 text-sm font-medium">{t.backToOffice}</Link>
            {canTrash ? <button type="button" disabled={state === "moving"} className="h-9 rounded-md bg-destructive px-3 text-sm font-medium text-destructive-foreground disabled:opacity-50" onClick={onTrash}>{state === "moving" ? t.movingToTrash : t.moveToTrash}</button> : null}
          </div>
        </div>
      </main>
    </div>
  );
}

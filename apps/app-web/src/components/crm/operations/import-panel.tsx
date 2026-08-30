"use client";

/** Server-backed preflight, confirmation, and resumable CRM import controls. */

import { useEffect, useRef, useState } from "react";
import { Download, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { confirmDialog } from "@/components/ui/confirm-dialog";
import {
  cancelCrmImport,
  confirmCrmImport,
  downloadCrmImportErrors,
  dryRunCrmImport,
  resumeCrmImport,
  type CrmProductionImportJob,
} from "@/lib/api/crm";
import { storeFiles } from "@/lib/api/ingest";
import type { CrmImportKind } from "@/lib/crm-r2";
import { useT } from "@/lib/i18n/client";

export function CrmProductionImportPanel({
  workspaceId,
  file,
  kind,
  mapping,
  ready,
  onImported,
}: {
  workspaceId: string;
  file: File | null;
  kind: CrmImportKind;
  mapping: Record<number, string | null>;
  ready: boolean;
  onImported: () => void;
}) {
  const t = useT().crmPage.r2;
  const [busy, setBusy] = useState(false);
  const [job, setJob] = useState<CrmProductionImportJob | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [sampleErrors, setSampleErrors] = useState<Array<{ row: number; message: string }>>([]);
  const cancelRequested = useRef(false);

  useEffect(() => {
    setJob(null);
    setMessage(null);
    setSampleErrors([]);
    cancelRequested.current = false;
  }, [file, kind, mapping]);

  async function downloadErrors() {
    if (!job) return;
    const blob = await downloadCrmImportErrors(workspaceId, job.id);
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `crm-import-${job.id}-errors.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  async function cancel() {
    cancelRequested.current = true;
    if (!job) return;
    try {
      const cancelled = await cancelCrmImport(workspaceId, job.id);
      setJob(cancelled);
      setMessage(t.importCancelled);
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : t.importFailed);
    }
  }

  async function run() {
    if (!file || !ready) return;
    setBusy(true);
    setMessage(t.importPreflight);
    setSampleErrors([]);
    cancelRequested.current = false;
    try {
      const stored = (await storeFiles(workspaceId, [file]))[0];
      if (!stored?.ok || !stored.fileId) throw new Error(stored?.error ?? t.importFailed);
      const input = {
        stagedFileId: stored.fileId,
        entityKind: kind,
        mapping: { columns: Object.fromEntries(Object.entries(mapping).map(([index, target]) => [String(index), target])) },
      } as const;
      const dryRun = await dryRunCrmImport(workspaceId, input);
      setSampleErrors(dryRun.sampleErrors.map((error) => ({ row: error.row, message: error.message })));
      const confirmed = await confirmDialog({
        title: t.importConfirmTitle,
        description: t.importConfirmDescription
          .replace("{rows}", String(dryRun.totalRows))
          .replace("{bytes}", String(dryRun.bytes))
          .replace("{valid}", String(dryRun.validRows))
          .replace("{failed}", String(dryRun.failedRows)),
        confirmLabel: t.importConfirm,
        cancelLabel: t.cancel,
      });
      if (!confirmed) {
        setMessage(null);
        return;
      }
      let current = await confirmCrmImport(workspaceId, {
        ...input,
        dryRunHash: dryRun.dryRunHash,
        confirmed: true,
      });
      setJob(current);
      while (!cancelRequested.current && (current.status === "ready" || current.status === "paused")) {
        setMessage(t.importProgress
          .replace("{processed}", String(current.processedRows))
          .replace("{total}", String(current.totalRows)));
        current = await resumeCrmImport(workspaceId, current.id);
        setJob(current);
      }
      if (current.status === "completed") {
        setMessage(t.importResult
          .replace("{created}", String(current.succeededRows))
          .replace("{failed}", String(current.failedRows)));
        onImported();
      } else if (current.status === "cancelled") {
        setMessage(t.importCancelled);
      }
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : t.importFailed);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      {job && (
        <div className="text-xs text-muted-foreground">
          {t.importProgress
            .replace("{processed}", String(job.processedRows))
            .replace("{total}", String(job.totalRows))}
        </div>
      )}
      {message && <div className="text-xs">{message}</div>}
      {sampleErrors.length > 0 && (
        <div className="max-h-32 space-y-1 overflow-y-auto rounded-lg border border-destructive/30 bg-destructive/5 p-2 text-xs text-destructive">
          {sampleErrors.map((failure, index) => (
            <div key={`${failure.row}-${index}`}>
              {t.importRowError.replace("{row}", String(failure.row)).replace("{error}", failure.message)}
            </div>
          ))}
        </div>
      )}
      <div className="flex justify-end gap-2">
        {busy && job && (
          <Button variant="outline" onClick={() => void cancel()}>
            <X aria-hidden /> {t.importCancel}
          </Button>
        )}
        {job?.failedRows ? (
          <Button variant="outline" onClick={() => void downloadErrors()}>
            <Download aria-hidden /> {t.importErrorsDownload}
          </Button>
        ) : null}
        <Button disabled={busy || !file || !ready} onClick={() => void run()}>
          {busy ? t.importing : t.importAction}
        </Button>
      </div>
    </div>
  );
}

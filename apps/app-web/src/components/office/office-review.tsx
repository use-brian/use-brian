"use client";

import { useId, useState } from "react";
import { Download, Eye, MonitorPlay, Trash2, Undo2, X } from "lucide-react";
import { columnIndexToName, parseCellAddress, type OfficeArtifactSnapshot, type SpreadsheetSnapshot } from "@use-brian/office-model";
import type { OfficeArtifact } from "@/lib/office/api";
import { readOfficeReleasedFile, releaseOfficeArtifact, reviewOfficeRelease, transitionOfficeLifecycle, type OfficeReleaseInput, type OfficeReleaseReceipt } from "@/lib/office/api";
import { useT } from "@/lib/i18n/client";
import type { Dictionary } from "@/lib/i18n/dictionaries";

type OfficeCopy = Dictionary["office"];

export function officeReleaseIssueMessage(issue: { code: string; message: string }, t: OfficeCopy): string {
  const messages: Record<string, string> = {
    "presentation.converter_unavailable": t.presentationPdfConverterUnavailable,
    "presentation.timeout": t.presentationPdfTimeout,
    "presentation.invalid_pdf": t.presentationPdfInvalid,
    "presentation.page_count_mismatch": t.presentationPdfPageCountMismatch,
  };
  return messages[issue.code] ?? issue.message;
}

/** Focused file actions. Advanced release/derivative/offline machinery remains
 * behind the API contract, but the editor exposes only the normal file tasks. */
export function OfficeReview({ artifact, artifactId, workspaceId, snapshot, onLifecycle, onPresent, offlineCopy = false }: { artifact: OfficeArtifact; artifactId: string; workspaceId: string; snapshot?: OfficeArtifactSnapshot; selectedObjectIds: string[]; onLifecycle(artifact: OfficeArtifact): void; onPresent?(): void; offlineCopy?: boolean }) {
  const t = useT().office;
  const [receipt, setReceipt] = useState<OfficeReleaseReceipt | null>(null);
  const [busy, setBusy] = useState(false);
  const [pendingFormat, setPendingFormat] = useState<"native" | "pdf">("native");
  const [pdfPreview, setPdfPreview] = useState<{ url: string; filename: string } | null>(null);
  const [purgeConfirmation, setPurgeConfirmation] = useState("");
  const purgeInputId = useId();
  const purgeTitleId = `${purgeInputId}-title`;

  const releaseInput = (format: "native" | "pdf"): OfficeReleaseInput => {
    const input: OfficeReleaseInput = { expectedVersion: artifact.version, action: "export", destination: { sensitivity: "internal", external: false }, format };
    if (format !== "pdf" || snapshot?.family !== "spreadsheet") return input;
    const sheet = invoiceSheet(snapshot);
    return { ...input, spreadsheetPdf: { sheetId: sheet.id, printArea: sheet.print.printArea ?? usedPrintArea(snapshot, sheet.id), calculationMode: "automatic", expectedPageCount: 1, preset: sheet.name.toLocaleLowerCase() === "invoice" ? "invoice" : "worksheet" } };
  };

  async function startRelease(format: "native" | "pdf") {
    setBusy(true);
    setPendingFormat(format);
    try {
      const reviewed = await reviewOfficeRelease(artifactId, releaseInput(format));
      setReceipt(reviewed);
      if (reviewed.status === "ready") await completeRelease(reviewed, format);
    } finally {
      setBusy(false);
    }
  }

  async function completeRelease(reviewed = receipt, format = pendingFormat) {
    setBusy(true);
    try {
      const acknowledgement = reviewed?.warnings.length ? { version: artifact.version, action: "export" as const, codes: reviewed.warnings.map((warning) => warning.code) } : undefined;
      const released = await releaseOfficeArtifact(artifactId, { ...releaseInput(format), acknowledgement });
      setReceipt(released.receipt);
      if (released.receipt.status !== "ready" || !released.fileId) return;
      if (format === "pdf") {
        const blob = await readOfficeReleasedFile(workspaceId, released.fileId);
        if (pdfPreview) URL.revokeObjectURL(pdfPreview.url);
        setPdfPreview({ url: URL.createObjectURL(blob), filename: safeFilename(artifact.title, "pdf") });
      } else await deliverReleasedFile({ workspaceId, fileId: released.fileId, title: artifact.title, family: artifact.family });
    } finally {
      setBusy(false);
    }
  }

  return <div className="space-y-5 p-4 text-sm">
    {offlineCopy ? <p className="rounded border border-amber-300 bg-amber-50 p-3 text-xs text-amber-950">{t.offlineWaiting}</p> : null}
    <section className="space-y-3">
      <div><h3 className="font-medium">{t.fileActions}</h3><p className="mt-1 text-xs text-muted-foreground">{t.fileActionsDescription}</p></div>
      <button type="button" disabled={busy || offlineCopy} onClick={() => void startRelease("native")} className="flex h-9 w-full items-center justify-center gap-2 rounded-md bg-action px-3 font-medium text-action-foreground disabled:opacity-50"><Download className="size-4" aria-hidden />{artifact.family === "spreadsheet" ? t.downloadXlsx : t.downloadFile}</button>
      {artifact.family === "spreadsheet" ? <button type="button" disabled={busy || offlineCopy || snapshot?.family !== "spreadsheet"} onClick={() => void startRelease("pdf")} className="flex h-9 w-full items-center justify-center gap-2 rounded-md border px-3 font-medium disabled:opacity-50"><Eye className="size-4" aria-hidden />{t.previewInvoicePdf}</button> : null}
      {artifact.family === "presentation" ? <button type="button" disabled={busy || offlineCopy || snapshot?.family !== "presentation"} onClick={() => void startRelease("pdf")} className="flex h-9 w-full items-center justify-center gap-2 rounded-md border px-3 font-medium disabled:opacity-50"><Eye className="size-4" aria-hidden />{t.previewPresentationPdf}</button> : null}
      {artifact.family === "presentation" ? <button type="button" disabled={offlineCopy} onClick={onPresent} className="flex h-9 w-full items-center justify-center gap-2 rounded-md border px-3 font-medium disabled:opacity-50"><MonitorPlay className="size-4" aria-hidden />{t.present}</button> : null}
      {receipt ? <div className="space-y-2 rounded border p-3"><strong>{receipt.status === "blocked" ? t.releaseBlocked : receipt.status === "needs_ack" ? t.releaseWarnings : t.releaseReady}</strong>{[...receipt.blocks, ...receipt.warnings].map((issue) => <p key={`${issue.code}-${issue.subjectId ?? "artifact"}`} className="text-xs text-muted-foreground">{officeReleaseIssueMessage(issue, t)}</p>)}{receipt.status === "needs_ack" ? <button type="button" disabled={busy || offlineCopy} onClick={() => void completeRelease()} className="rounded bg-action px-3 py-2 text-action-foreground disabled:opacity-50">{t.acknowledgeRelease}</button> : null}</div> : null}
    </section>
    <section className="space-y-2 border-t pt-4">
      {artifact.lifecycleState === "active" ? <button type="button" disabled={offlineCopy} onClick={() => void transitionOfficeLifecycle(artifactId, "trash", "Moved to Trash from Office file actions").then(onLifecycle)} className="flex items-center gap-2 rounded px-2 py-1.5 text-destructive disabled:opacity-50"><Trash2 className="size-4" aria-hidden />{t.moveToTrash}</button> : artifact.lifecycleState === "archived" || artifact.lifecycleState === "trash" || artifact.lifecycleState === "retained" ? <button type="button" disabled={offlineCopy} onClick={() => void transitionOfficeLifecycle(artifactId, artifact.lifecycleState === "archived" ? "unarchive" : "restore", "Restored from Office file actions").then(onLifecycle)} className="flex items-center gap-2 rounded px-2 py-1.5 disabled:opacity-50"><Undo2 className="size-4" aria-hidden />{t.restore}</button> : null}
      {artifact.lifecycleState === "trash" || artifact.lifecycleState === "retained" ? <div className="space-y-2 rounded border border-destructive/40 p-3">
        <label htmlFor={purgeInputId} className="block text-xs text-muted-foreground">{t.typeTitleToDelete}</label>
        <p id={purgeTitleId} className="whitespace-pre-wrap break-words rounded bg-muted px-2 py-1.5 font-mono text-xs text-foreground select-text">{artifact.title}</p>
        <input id={purgeInputId} aria-describedby={purgeTitleId} value={purgeConfirmation} onChange={(event) => setPurgeConfirmation(event.target.value)} placeholder={t.titleConfirmationPlaceholder} autoComplete="off" autoCapitalize="off" spellCheck={false} className="h-9 w-full min-w-0 rounded border px-2" />
        <button type="button" disabled={offlineCopy || purgeConfirmation !== artifact.title} onClick={() => void transitionOfficeLifecycle(artifactId, "purge", "Permanent deletion confirmed by exact title").then(onLifecycle)} className="w-full whitespace-normal rounded bg-destructive px-3 py-2 text-destructive-foreground disabled:opacity-50">{t.deletePermanently}</button>
      </div> : null}
    </section>
    {pdfPreview ? <div role="dialog" aria-modal="true" aria-label={t.pdfPreview} className="fixed inset-0 z-[100] flex flex-col bg-background/95 p-4 backdrop-blur-sm lg:p-8">
      <div className="mx-auto flex w-full max-w-5xl items-center gap-3 border-b bg-background p-3"><h2 className="font-semibold">{t.pdfPreview}</h2><a href={pdfPreview.url} download={pdfPreview.filename} className="ml-auto inline-flex h-9 items-center gap-2 rounded-md bg-action px-3 font-medium text-action-foreground"><Download className="size-4" />{t.downloadPdf}</a><button type="button" aria-label={t.closePdfPreview} onClick={() => { URL.revokeObjectURL(pdfPreview.url); setPdfPreview(null); }} className="rounded p-2 hover:bg-muted"><X className="size-5" /></button></div>
      <iframe src={pdfPreview.url} title={t.pdfPreview} className="mx-auto min-h-0 w-full max-w-5xl flex-1 border bg-white" />
    </div> : null}
  </div>;
}

async function deliverReleasedFile(params: { workspaceId: string; fileId: string; title: string; family: OfficeArtifact["family"] }): Promise<void> {
  const blob = await readOfficeReleasedFile(params.workspaceId, params.fileId);
  const extension = params.family === "document" ? "docx" : params.family === "presentation" ? "pptx" : "xlsx";
  const filename = safeFilename(params.title, extension);
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function invoiceSheet(snapshot: SpreadsheetSnapshot): SpreadsheetSnapshot["worksheets"][number] {
  return snapshot.worksheets.find((sheet) => sheet.name.toLocaleLowerCase() === "invoice") ?? snapshot.worksheets.find((sheet) => sheet.id === snapshot.activeSheetId) ?? snapshot.worksheets[0];
}

function usedPrintArea(snapshot: SpreadsheetSnapshot, sheetId: string): string {
  const sheet = snapshot.worksheets.find((item) => item.id === sheetId) ?? snapshot.worksheets[0];
  let maxRow = 1;
  let maxColumn = 1;
  for (const cell of sheet.cells) {
    const parsed = parseCellAddress(cell.address);
    if (!parsed) continue;
    maxRow = Math.max(maxRow, parsed.row);
    maxColumn = Math.max(maxColumn, parsed.column);
  }
  return `A1:${columnIndexToName(maxColumn)}${maxRow}`;
}

function safeFilename(title: string, extension: string): string { return `${title.replace(/[\\/:*?"<>|]+/g, "-")}.${extension}`; }

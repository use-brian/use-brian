"use client";

import { useState } from "react";
import { Download, MonitorPlay, Trash2, Undo2 } from "lucide-react";
import type { OfficeArtifact } from "@/lib/office/api";
import { readOfficeReleasedFile, releaseOfficeArtifact, reviewOfficeRelease, transitionOfficeLifecycle, type OfficeReleaseInput, type OfficeReleaseReceipt } from "@/lib/office/api";
import { useT } from "@/lib/i18n/client";

/** Focused file actions. Advanced release/derivative/offline machinery remains
 * behind the API contract, but the editor exposes only the normal file tasks. */
export function OfficeReview({ artifact, artifactId, workspaceId, onLifecycle, offlineCopy = false }: { artifact: OfficeArtifact; artifactId: string; workspaceId: string; selectedObjectIds: string[]; onLifecycle(artifact: OfficeArtifact): void; offlineCopy?: boolean }) {
  const t = useT().office;
  const [receipt, setReceipt] = useState<OfficeReleaseReceipt | null>(null);
  const [pendingAction, setPendingAction] = useState<"export" | "present" | null>(null);
  const [busy, setBusy] = useState(false);
  const [purgeConfirmation, setPurgeConfirmation] = useState("");

  const inputFor = (action: "export" | "present"): OfficeReleaseInput => ({
    expectedVersion: artifact.version,
    action,
    destination: { sensitivity: "internal", external: false },
  });

  async function startRelease(action: "export" | "present") {
    setBusy(true);
    setPendingAction(action);
    try {
      const reviewed = await reviewOfficeRelease(artifactId, inputFor(action));
      setReceipt(reviewed);
      if (reviewed.status === "ready") await completeRelease(action, reviewed);
    } finally {
      setBusy(false);
    }
  }

  async function completeRelease(action: "export" | "present", reviewed = receipt) {
    setBusy(true);
    try {
      const acknowledgement = reviewed?.warnings.length ? { version: artifact.version, action, codes: reviewed.warnings.map((warning) => warning.code) } : undefined;
      const released = await releaseOfficeArtifact(artifactId, { ...inputFor(action), acknowledgement });
      setReceipt(released.receipt);
      await deliverReleasedFile({ workspaceId, fileId: released.fileId, title: artifact.title, family: artifact.family, action });
    } finally {
      setBusy(false);
    }
  }

  return <div className="space-y-5 p-4 text-sm">
    {offlineCopy ? <p className="rounded border border-amber-300 bg-amber-50 p-3 text-xs text-amber-950">{t.offlineWaiting}</p> : null}
    <section className="space-y-3">
      <div><h3 className="font-medium">{t.fileActions}</h3><p className="mt-1 text-xs text-muted-foreground">{t.fileActionsDescription}</p></div>
      <button type="button" disabled={busy || offlineCopy} onClick={() => void startRelease("export")} className="flex h-9 w-full items-center justify-center gap-2 rounded-md bg-action px-3 font-medium text-action-foreground disabled:opacity-50"><Download className="size-4" aria-hidden />{t.downloadFile}</button>
      {artifact.family === "presentation" ? <button type="button" disabled={busy || offlineCopy} onClick={() => void startRelease("present")} className="flex h-9 w-full items-center justify-center gap-2 rounded-md border px-3 font-medium disabled:opacity-50"><MonitorPlay className="size-4" aria-hidden />{t.present}</button> : null}
      {receipt ? <div className="space-y-2 rounded border p-3"><strong>{receipt.status === "blocked" ? t.releaseBlocked : receipt.status === "needs_ack" ? t.releaseWarnings : t.releaseReady}</strong>{[...receipt.blocks, ...receipt.warnings].map((issue) => <p key={`${issue.code}-${issue.subjectId ?? "artifact"}`} className="text-xs text-muted-foreground">{issue.message}</p>)}{receipt.status === "needs_ack" && pendingAction ? <button type="button" disabled={busy || offlineCopy} onClick={() => void completeRelease(pendingAction)} className="rounded bg-action px-3 py-2 text-action-foreground disabled:opacity-50">{t.acknowledgeRelease}</button> : null}</div> : null}
    </section>
    <section className="space-y-2 border-t pt-4">
      {artifact.lifecycleState === "active" ? <button type="button" disabled={offlineCopy} onClick={() => void transitionOfficeLifecycle(artifactId, "trash", "Moved to Trash from Office file actions").then(onLifecycle)} className="flex items-center gap-2 rounded px-2 py-1.5 text-destructive disabled:opacity-50"><Trash2 className="size-4" aria-hidden />{t.moveToTrash}</button> : artifact.lifecycleState === "archived" || artifact.lifecycleState === "trash" || artifact.lifecycleState === "retained" ? <button type="button" disabled={offlineCopy} onClick={() => void transitionOfficeLifecycle(artifactId, artifact.lifecycleState === "archived" ? "unarchive" : "restore", "Restored from Office file actions").then(onLifecycle)} className="flex items-center gap-2 rounded px-2 py-1.5 disabled:opacity-50"><Undo2 className="size-4" aria-hidden />{t.restore}</button> : null}
      {artifact.lifecycleState === "trash" || artifact.lifecycleState === "retained" ? <div className="space-y-2 rounded border border-destructive/40 p-3"><label className="block text-xs text-muted-foreground">{t.typeTitleToDelete}</label><input value={purgeConfirmation} onChange={(event) => setPurgeConfirmation(event.target.value)} placeholder={artifact.title} className="h-9 w-full rounded border px-2" /><button type="button" disabled={offlineCopy || purgeConfirmation !== artifact.title} onClick={() => void transitionOfficeLifecycle(artifactId, "purge", "Permanent deletion confirmed by exact title").then(onLifecycle)} className="rounded bg-destructive px-3 py-2 text-destructive-foreground disabled:opacity-50">{t.deletePermanently}</button></div> : null}
    </section>
  </div>;
}

async function deliverReleasedFile(params: { workspaceId: string; fileId: string; title: string; family: OfficeArtifact["family"]; action: "export" | "present" }): Promise<void> {
  const blob = await readOfficeReleasedFile(params.workspaceId, params.fileId);
  const extension = params.family === "document" ? "docx" : "pptx";
  const filename = `${params.title.replace(/[\\/:*?"<>|]+/g, "-")}.${extension}`;
  const url = URL.createObjectURL(blob);
  if (params.action === "present") window.open(url, "_blank", "noopener,noreferrer");
  else {
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
  }
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

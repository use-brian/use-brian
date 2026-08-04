"use client";

import { useMemo, useState } from "react";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import type { OfficeArtifact } from "@/lib/office/api";
import { createOfficeDerivative, createOfficeOfflinePackage, readOfficeReleasedFile, releaseOfficeArtifact, reviewOfficeRelease, transitionOfficeLifecycle, type OfficeReleaseInput, type OfficeReleaseReceipt } from "@/lib/office/api";
import { encryptOfficePackage, getOrCreateOfficeDeviceKey, saveOfflinePackage, type OfficeOfflineStatus } from "@/lib/office/offline";
import { useT } from "@/lib/i18n/client";

export function OfficeReview({ artifact, artifactId, workspaceId, selectedObjectIds, onLifecycle, offlineCopy = false }: { artifact: OfficeArtifact; artifactId: string; workspaceId: string; selectedObjectIds: string[]; onLifecycle(artifact: OfficeArtifact): void; offlineCopy?: boolean }) {
  const t = useT().office;
  const [action, setAction] = useState<OfficeReleaseInput["action"]>("export");
  const [sensitivity, setSensitivity] = useState<"public" | "internal" | "confidential">("internal");
  const [external, setExternal] = useState(false);
  const [receipt, setReceipt] = useState<OfficeReleaseReceipt | null>(null);
  const [busy, setBusy] = useState(false);
  const [derivativeTitle, setDerivativeTitle] = useState(`${artifact.title} — ${t.derivative}`);
  const [offline, setOffline] = useState<OfficeOfflineStatus>("synced");
  const [purgeConfirmation, setPurgeConfirmation] = useState("");
  const baseInput = useMemo<OfficeReleaseInput>(() => ({ expectedVersion: artifact.version, action, destination: { sensitivity, external } }), [action, artifact.version, external, sensitivity]);
  const runReview = async () => { setBusy(true); try { setReceipt(await reviewOfficeRelease(artifactId, baseInput)); } finally { setBusy(false); } };
  const runRelease = async () => {
    setBusy(true);
    try {
      const acknowledgement = receipt?.warnings.length ? { version: artifact.version, action, codes: receipt.warnings.map((warning) => warning.code) } : undefined;
      const released = await releaseOfficeArtifact(artifactId, { ...baseInput, acknowledgement });
      setReceipt(released.receipt);
      await deliverReleasedFile({ workspaceId, fileId: released.fileId, title: artifact.title, family: artifact.family, action });
    } finally { setBusy(false); }
  };
  const pinOffline = async () => {
    setOffline("syncing");
    try {
      const deviceId = localStorage.getItem("office-device-id") ?? crypto.randomUUID();
      localStorage.setItem("office-device-id", deviceId);
      const remote = await createOfficeOfflinePackage(artifactId, { deviceId, pinned: true, expectedVersion: artifact.version });
      const deviceKey = await getOrCreateOfficeDeviceKey();
      const encrypted = await encryptOfficePackage({ artifactId, version: artifact.version, manifest: remote.manifest, payload: remote.payload, signature: remote.signature, pinned: true, deviceSecret: deviceKey });
      await saveOfflinePackage(encrypted);
      setOffline("saved_device");
    } catch { setOffline("sync_failed"); }
  };
  return <div className="space-y-5 p-4 text-sm">
    {offlineCopy ? <p className="rounded border border-amber-300 bg-amber-50 p-3 text-xs text-amber-950">{t.offlineWaiting}</p> : null}
    <section className="space-y-3">
      <h3 className="font-medium">{t.reviewRelease}</h3>
      <Select value={action} onValueChange={(value) => { if (value) setAction(value as OfficeReleaseInput["action"]); }}><SelectTrigger aria-label={t.releaseAction} className="h-9 w-full">{{ export: t.export, share: t.share, present: t.present, send: t.send, publish: t.publish }[action]}</SelectTrigger><SelectContent><SelectItem value="export">{t.export}</SelectItem><SelectItem value="share">{t.share}</SelectItem><SelectItem value="present">{t.present}</SelectItem><SelectItem value="send">{t.send}</SelectItem><SelectItem value="publish">{t.publish}</SelectItem></SelectContent></Select>
      <Select value={sensitivity} onValueChange={(value) => { if (value) setSensitivity(value as typeof sensitivity); }}><SelectTrigger aria-label={t.destinationSensitivity} className="h-9 w-full">{{ public: t.public, internal: t.internal, confidential: t.confidential }[sensitivity]}</SelectTrigger><SelectContent><SelectItem value="public">{t.public}</SelectItem><SelectItem value="internal">{t.internal}</SelectItem><SelectItem value="confidential">{t.confidential}</SelectItem></SelectContent></Select>
      <label className="flex items-center gap-2"><input type="checkbox" checked={external} onChange={(event) => setExternal(event.target.checked)} />{t.externalDestination}</label>
      <div className="flex gap-2"><button type="button" disabled={busy || offlineCopy} onClick={() => void runReview()} className="rounded border px-3 py-2 disabled:opacity-50">{t.review}</button>{receipt && receipt.status !== "blocked" ? <button type="button" disabled={busy || offlineCopy} onClick={() => void runRelease()} className="rounded bg-primary px-3 py-2 text-primary-foreground disabled:opacity-50">{receipt.status === "needs_ack" ? t.acknowledgeRelease : t.release}</button> : null}</div>
      {receipt ? <div className="space-y-2 rounded border p-3"><strong>{receipt.status === "blocked" ? t.releaseBlocked : receipt.status === "needs_ack" ? t.releaseWarnings : t.releaseReady}</strong>{[...receipt.blocks, ...receipt.warnings].map((issue) => <p key={issue.code} className="text-xs text-muted-foreground">{issue.message}</p>)}</div> : null}
    </section>
    <section className="space-y-2 border-t pt-4"><h3 className="font-medium">{t.derivative}</h3><input value={derivativeTitle} onChange={(event) => setDerivativeTitle(event.target.value)} className="h-9 w-full rounded border px-2" /><button type="button" disabled={busy || offlineCopy || !derivativeTitle.trim()} onClick={() => { setBusy(true); void createOfficeDerivative(artifactId, { title: derivativeTitle, sensitivity, selectedObjectIds }).finally(() => setBusy(false)); }} className="rounded border px-3 py-2 disabled:opacity-50">{t.createDerivative}</button><p className="text-xs text-muted-foreground">{t.derivativeHint}</p></section>
    <section className="space-y-2 border-t pt-4"><h3 className="font-medium">{t.offlineAccess}</h3><button type="button" disabled={offlineCopy} onClick={() => void pinOffline()} className="rounded border px-3 py-2 disabled:opacity-50">{t.availableOffline}</button><p className="text-xs text-muted-foreground">{offline === "saved_device" ? t.savedDevice : offline === "syncing" ? t.syncing : offline === "sync_failed" ? t.syncFailed : t.synced}</p></section>
    <section className="space-y-2 border-t pt-4"><h3 className="font-medium">{t.lifecycle}</h3><div className="flex flex-wrap gap-2">{artifact.lifecycleState === "active" ? <><button type="button" disabled={offlineCopy} onClick={() => void transitionOfficeLifecycle(artifactId, "archive", "Archived from Office review").then(onLifecycle)} className="rounded border px-3 py-2 disabled:opacity-50">{t.archive}</button><button type="button" disabled={offlineCopy} onClick={() => void transitionOfficeLifecycle(artifactId, "trash", "Moved to Trash from Office review").then(onLifecycle)} className="rounded border px-3 py-2 text-destructive disabled:opacity-50">{t.moveToTrash}</button></> : artifact.lifecycleState === "archived" || artifact.lifecycleState === "trash" || artifact.lifecycleState === "retained" ? <button type="button" disabled={offlineCopy} onClick={() => void transitionOfficeLifecycle(artifactId, artifact.lifecycleState === "archived" ? "unarchive" : "restore", "Restored from Office lifecycle").then(onLifecycle)} className="rounded border px-3 py-2 disabled:opacity-50">{t.restore}</button> : null}</div>{artifact.lifecycleState === "trash" || artifact.lifecycleState === "retained" ? <div className="space-y-2 rounded border border-destructive/40 p-3"><label className="block text-xs text-muted-foreground">{t.typeTitleToDelete}</label><input value={purgeConfirmation} onChange={(event) => setPurgeConfirmation(event.target.value)} placeholder={artifact.title} className="h-9 w-full rounded border px-2" /><button type="button" disabled={offlineCopy || purgeConfirmation !== artifact.title} onClick={() => void transitionOfficeLifecycle(artifactId, "purge", "Permanent deletion confirmed by exact title").then(onLifecycle)} className="rounded bg-destructive px-3 py-2 text-destructive-foreground disabled:opacity-50">{t.deletePermanently}</button></div> : null}</section>
  </div>;
}

async function deliverReleasedFile(params: { workspaceId: string; fileId: string; title: string; family: OfficeArtifact["family"]; action: OfficeReleaseInput["action"] }): Promise<void> {
  const blob = await readOfficeReleasedFile(params.workspaceId, params.fileId);
  const extension = params.family === "document" ? "docx" : "pptx";
  const filename = `${params.title.replace(/[\\/:*?"<>|]+/g, "-")}.${extension}`;
  const file = new File([blob], filename, { type: blob.type });
  if (["share", "send", "publish"].includes(params.action) && navigator.share && (!navigator.canShare || navigator.canShare({ files: [file] }))) {
    await navigator.share({ title: params.title, files: [file] });
    return;
  }
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

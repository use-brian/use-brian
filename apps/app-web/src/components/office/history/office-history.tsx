"use client";

/** Immutable Office version list, preview, naming, copy and restore. [COMP:app-web/office-history-sharing] */
import { useEffect, useState } from "react";
import type { OfficeArtifactSnapshot } from "@use-brian/office-model";
import { copyOfficeVersion, listOfficeVersions, nameOfficeVersion, previewOfficeVersion, restoreOfficeVersion, type OfficeVersion } from "@/lib/office/api";
import { useT } from "@/lib/i18n/client";
import { confirmDialog } from "@/components/ui/confirm-dialog";
import { promptDialog } from "@/components/ui/prompt-dialog";
import { OfficeCardPreviewCanvas } from "../office-card-preview";

export function OfficeHistory({ artifactId, artifactTitle, currentVersion, canEdit, onRestored, onCopied }: { artifactId: string; artifactTitle: string; currentVersion: number; canEdit: boolean; onRestored?(): void | Promise<void>; onCopied?(artifactId: string): void }) {
  const t = useT().office;
  const [versions, setVersions] = useState<OfficeVersion[]>([]);
  const [preview, setPreview] = useState<OfficeArtifactSnapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const headVersion = versions[0]?.version ?? currentVersion;
  const reload = () => listOfficeVersions(artifactId).then(setVersions).catch(() => setVersions([]));
  useEffect(() => { void reload(); setPreview(null); }, [artifactId]);

  async function name(version: OfficeVersion) {
    const summary = await promptDialog({ title: t.nameVersion, description: t.nameVersionDescription, defaultValue: version.summary, placeholder: t.versionNamePlaceholder, confirmLabel: t.saveName, cancelLabel: t.cancel });
    if (!summary) return;
    await nameOfficeVersion(artifactId, version.id, summary); await reload();
  }

  async function copy(version: OfficeVersion) {
    const title = await promptDialog({ title: t.copyVersion, description: t.copyVersionDescription, defaultValue: `${artifactTitle} ${t.copySuffix}`, confirmLabel: t.copyVersion, cancelLabel: t.cancel });
    if (!title) return;
    const copied = await copyOfficeVersion(artifactId, version.id, title); onCopied?.(copied.artifactId);
  }

  async function restore(version: OfficeVersion) {
    const confirmed = await confirmDialog({ title: t.restoreVersion, description: t.restoreVersionDescription.replace("{version}", String(version.version)), confirmLabel: t.restoreVersion, cancelLabel: t.cancel });
    if (!confirmed) return;
    setBusy(true);
    try { await restoreOfficeVersion(artifactId, version.id, headVersion, t.restoreVersionSummary.replace("{version}", String(version.version))); await reload(); setPreview(null); await onRestored?.(); } finally { setBusy(false); }
  }

  return <section aria-label={t.versionHistory} className="space-y-3">
    <h2 className="text-sm font-semibold">{t.versionHistory}</h2>
    {preview ? <div className="space-y-2 rounded-lg border p-2" data-office-version-preview="readonly"><p className="text-xs font-medium">{t.readOnlyPreview}</p><div className="max-h-64 overflow-hidden rounded border"><OfficeCardPreviewCanvas snapshot={preview} /></div><button type="button" onClick={() => setPreview(null)} className="text-xs text-muted-foreground hover:underline">{t.closePreview}</button></div> : null}
    <div className="space-y-2">{versions.map((version) => <article key={version.id} className="rounded-lg border p-3"><div className="flex items-start justify-between gap-2"><div><p className="text-xs font-medium">{t.versionNumber.replace("{version}", String(version.version))}</p><p className="text-xs text-muted-foreground">{version.summary || t.unnamedVersion}</p><time className="text-[11px] text-muted-foreground" dateTime={version.createdAt}>{new Date(version.createdAt).toLocaleString()}</time></div><span className="rounded bg-muted px-1.5 py-0.5 text-[10px]">{versionOriginLabel(version.origin, t)}</span></div><div className="mt-2 flex flex-wrap gap-2"><button type="button" onClick={() => void previewOfficeVersion(artifactId, version.id).then(setPreview)} className="text-xs hover:underline">{t.preview}</button><button type="button" onClick={() => void copy(version)} className="text-xs hover:underline">{t.copyVersion}</button>{canEdit ? <><button type="button" onClick={() => void name(version)} className="text-xs hover:underline">{t.nameVersion}</button><button type="button" disabled={busy || version.version === headVersion} onClick={() => void restore(version)} className="text-xs hover:underline disabled:opacity-50">{t.restoreVersion}</button></> : null}</div></article>)}</div>
    {versions.length === 0 ? <p className="text-xs text-muted-foreground">{t.noVersions}</p> : null}
  </section>;
}

function versionOriginLabel(origin: string, t: ReturnType<typeof useT>["office"]): string {
  return { manual: t.versionOriginManual, ai: t.versionOriginAi, import: t.versionOriginImport, offline: t.versionOriginOffline, restore: t.versionOriginRestore, generation: t.versionOriginGeneration }[origin] ?? t.versionOriginOther;
}

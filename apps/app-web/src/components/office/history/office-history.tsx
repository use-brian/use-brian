"use client";

/** Immutable Office version list, preview, naming, copy and restore. [COMP:app-web/office-history-sharing] */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { OfficeArtifactSnapshot } from "@use-brian/office-model";
import { copyOfficeVersion, listOfficeVersions, nameOfficeVersion, previewOfficeVersion, restoreOfficeVersion, OfficeApiError, type OfficeVersion } from "@/lib/office/api";
import { useT } from "@/lib/i18n/client";
import { confirmDialog } from "@/components/ui/confirm-dialog";
import { promptDialog } from "@/components/ui/prompt-dialog";
import { Skeleton } from "@/components/skeleton";
import { useOfficeMetadataResource, useOfficePanelIdentity } from "@/lib/office/surface-cache";
import { officeMetadataRemaining } from "@/lib/office/metadata";
import { officePanelCacheKey } from "@/lib/surface-prefetch";
import { invalidateSurfaceCache, readSurfaceCache } from "@/lib/surface-cache";
import { OfficeCardPreviewCanvas } from "../office-card-preview";

type OfficeHistoryProps = { artifactId: string; artifactTitle: string; currentVersion: number; canEdit: boolean; onRestored?(): void | Promise<void>; onCopied?(artifactId: string): void };

export function OfficeHistory(props: OfficeHistoryProps) {
  const t = useT().office;
  const {prefix, viewerId} = useOfficePanelIdentity();
  const cacheKey = officePanelCacheKey(prefix, "versions", props.artifactId);
  const read = useOfficeMetadataResource(cacheKey, viewerId, () => listOfficeVersions(props.artifactId));
  if (!read.data || !cacheKey) return <section aria-label={t.versionHistory} className="space-y-3"><h2 className="text-sm font-semibold">{t.versionHistory}</h2>{read.error ? <p role="alert" className="text-xs text-destructive">{t.loadFailed}</p> : <Skeleton className="h-24 w-full"/>}</section>;
  return <OfficeHistoryContent key={cacheKey} {...props} versions={read.data} cacheKey={cacheKey} viewerId={viewerId} refresh={read.refresh}/>;
}

function OfficeHistoryContent({artifactId, artifactTitle, currentVersion, canEdit, onRestored, onCopied, versions, cacheKey, viewerId, refresh}: OfficeHistoryProps & {versions: OfficeVersion[]; cacheKey: string; viewerId: string; refresh: () => Promise<OfficeVersion[] | undefined>}) {
  const t = useT().office;
  const [preview, setPreview] = useState<{versionId: string; snapshot: OfficeArtifactSnapshot} | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const lifetime = useRef<AbortController | null>(null);
  const pendingAction = useRef<{versionId: string; controller: AbortController} | null>(null);
  useLayoutEffect(() => { const owner = new AbortController(); lifetime.current = owner; return () => {owner.abort(); pendingAction.current?.controller.abort(); pendingAction.current = null; lifetime.current = null;}; }, []);
  const headVersion = versions[0]?.version ?? currentVersion;
  useLayoutEffect(() => {
    const pending = pendingAction.current;
    if (pending && !versions.some(row => row.id === pending.versionId)) pending.controller.abort();
  }, [versions]);
  useEffect(() => { if (preview && !versions.some(version => version.id === preview.versionId)) setPreview(null); }, [versions, preview]);

  async function run(version: OfficeVersion, action: (current: () => boolean, signal: AbortSignal) => Promise<void>) {
    const owner = lifetime.current;
    if (pendingAction.current) return;
    const controller = new AbortController();
    const current = () => {
      const data = readSurfaceCache<OfficeVersion[]>(cacheKey).data;
      return Boolean(owner && owner === lifetime.current && !owner.signal.aborted && !controller.signal.aborted && officeMetadataRemaining(data, viewerId) > 0 && data?.some(row => row.id === version.id));
    };
    if (!owner || !current() || busy) return;
    pendingAction.current = {versionId: version.id, controller};
    setBusy(true);setFailed(false);
    try { await action(current, controller.signal); }
    catch (error) {
      if (current()) {
        if (error instanceof OfficeApiError && [401,403,404].includes(error.status)) invalidateSurfaceCache(cacheKey);
        else setFailed(true);
      }
    } finally {
      if (pendingAction.current?.controller === controller) pendingAction.current = null;
      if (owner === lifetime.current && !owner.signal.aborted) setBusy(false);
    }
  }

  async function reload(current: () => boolean) {
    if (!current()) return;
    if (readSurfaceCache(cacheKey).revalidating) {await refresh();if (!current()) return;}
    await refresh();
  }

  function showPreview(version: OfficeVersion) {
    return run(version, async current => {
      const snapshot = await previewOfficeVersion(artifactId, version.id);
      if (current()) setPreview({versionId:version.id,snapshot});
    });
  }

  function name(version: OfficeVersion) {
    return run(version, async (current, signal) => {
      const summary = await promptDialog({ title: t.nameVersion, description: t.nameVersionDescription, defaultValue: version.summary, placeholder: t.versionNamePlaceholder, confirmLabel: t.saveName, cancelLabel: t.cancel, signal });
      if (!summary || !current()) return;
      await nameOfficeVersion(artifactId, version.id, summary);
      await reload(current);
    });
  }

  function copy(version: OfficeVersion) {
    return run(version, async (current, signal) => {
      const title = await promptDialog({ title: t.copyVersion, description: t.copyVersionDescription, defaultValue: `${artifactTitle} ${t.copySuffix}`, confirmLabel: t.copyVersion, cancelLabel: t.cancel, signal });
      if (!title || !current()) return;
      const copied = await copyOfficeVersion(artifactId, version.id, title);
      if (current()) onCopied?.(copied.artifactId);
    });
  }

  function restore(version: OfficeVersion) {
    return run(version, async (current, signal) => {
      const confirmed = await confirmDialog({ title: t.restoreVersion, description: t.restoreVersionDescription.replace("{version}", String(version.version)), confirmLabel: t.restoreVersion, cancelLabel: t.cancel, signal });
      if (!confirmed || !current()) return;
      await restoreOfficeVersion(artifactId, version.id, headVersion, t.restoreVersionSummary.replace("{version}", String(version.version)));
      await reload(current);
      if (current()) {setPreview(null);await onRestored?.();}
    });
  }

  return <section aria-label={t.versionHistory} className="space-y-3">
    <h2 className="text-sm font-semibold">{t.versionHistory}</h2>
    {preview && versions.some(row => row.id === preview.versionId) ? <div className="space-y-2 rounded-lg border p-2" data-office-version-preview="readonly"><p className="text-xs font-medium">{t.readOnlyPreview}</p><div className="max-h-64 overflow-hidden rounded border"><OfficeCardPreviewCanvas snapshot={preview.snapshot} /></div><button type="button" onClick={() => setPreview(null)} className="text-xs text-muted-foreground hover:underline">{t.closePreview}</button></div> : null}
    <div className="space-y-2">{versions.map((version) => <article key={version.id} className="rounded-lg border p-3"><div className="flex items-start justify-between gap-2"><div><p className="text-xs font-medium">{t.versionNumber.replace("{version}", String(version.version))}</p><p className="text-xs text-muted-foreground">{version.summary || t.unnamedVersion}</p><time className="text-[11px] text-muted-foreground" dateTime={version.createdAt}>{new Date(version.createdAt).toLocaleString()}</time></div><span className="rounded bg-muted px-1.5 py-0.5 text-[10px]">{versionOriginLabel(version.origin, t)}</span></div><div className="mt-2 flex flex-wrap gap-2"><button type="button" disabled={busy} onClick={() => void showPreview(version)} className="min-h-11 px-1 text-xs hover:underline sm:min-h-0">{t.preview}</button><button type="button" disabled={busy} onClick={() => void copy(version)} className="min-h-11 px-1 text-xs hover:underline sm:min-h-0">{t.copyVersion}</button>{canEdit ? <><button type="button" disabled={busy} onClick={() => void name(version)} className="min-h-11 px-1 text-xs hover:underline sm:min-h-0">{t.nameVersion}</button><button type="button" disabled={busy || version.version === headVersion} onClick={() => void restore(version)} className="min-h-11 px-1 text-xs hover:underline disabled:opacity-50 sm:min-h-0">{t.restoreVersion}</button></> : null}</div></article>)}</div>
    {failed ? <p role="alert" className="text-xs text-destructive">{t.loadFailed}</p> : null}
    {versions.length === 0 ? <p className="text-xs text-muted-foreground">{t.noVersions}</p> : null}
  </section>;
}

function versionOriginLabel(origin: string, t: ReturnType<typeof useT>["office"]): string {
  return { manual: t.versionOriginManual, ai: t.versionOriginAi, import: t.versionOriginImport, offline: t.versionOriginOffline, restore: t.versionOriginRestore, generation: t.versionOriginGeneration }[origin] ?? t.versionOriginOther;
}

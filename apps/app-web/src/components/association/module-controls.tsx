"use client";

/** Module controls inside Association; a one-line read-only note in assistant settings. [COMP:app-web/association] */
import Link from "next/link";
import { useState } from "react";
import type { WorkspaceModuleAction } from "@use-brian/shared";
import { useT } from "@/lib/i18n/client";
import { AssociationApiError, changeAssociationModule, getAssociationModuleSnapshot, type AssociationModuleSnapshot } from "@/lib/api/association";
import { associationModuleCacheKey } from "@/lib/surface-prefetch";
import { mutateSurfaceCache, useCachedResource } from "@/lib/surface-cache";
import { requestHomeAppsRefresh } from "@/lib/home-apps-events";
import { Button } from "@/components/ui/button";
import { confirmDialog } from "@/components/ui/confirm-dialog";
import { ListSurfaceSkeleton } from "@/components/chrome/surface-skeleton";

export function useAssociationModule(workspaceId: string) {
  return useCachedResource(workspaceId ? associationModuleCacheKey(workspaceId) : null,
    () => getAssociationModuleSnapshot(workspaceId));
}

/** Read-only module state for the assistant's Association tool grants; never the admin panel. */
export function AssociationModuleNote({ workspaceId }: { workspaceId: string }) {
  const t = useT().associationPage;
  const { data, error } = useAssociationModule(workspaceId);
  if (!data && !error) return null;
  return <p className="text-xs text-muted-foreground" data-association-module-note>
    {data ? `${t.moduleStateLabel}: ${t.states[data.module.state]}. ${t.savedPermissions}` : t.loadFailed}
  </p>;
}

export function AssociationModuleControls({ workspaceId }: { workspaceId: string }) {
  const t = useT().associationPage;
  const { data, error, refresh } = useAssociationModule(workspaceId);
  const [pending, setPending] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  async function act(action: WorkspaceModuleAction) {
    if (!data?.canManage || error || pending) return;
    const expectedVersion = data.module.version;
    const descriptions = { enable: t.enableConfirm, request_disable: t.disableConfirm, finish_disable: t.finishConfirm };
    const labels = { enable: t.enable, request_disable: t.disable, finish_disable: t.finish };
    setPending(true);
    try {
      if (!await confirmDialog({ title: labels[action], description: descriptions[action], confirmLabel: labels[action], cancelLabel: t.cancel })) return;
      setSaveError(null);
      const changed = await changeAssociationModule(workspaceId, action, expectedVersion);
      if (changed.module.workspaceId !== workspaceId) throw new AssociationApiError("invalid_response", 502);
      mutateSurfaceCache<AssociationModuleSnapshot>(associationModuleCacheKey(workspaceId), previous => ({ ...previous, module: changed.module }));
      requestHomeAppsRefresh(workspaceId);
    } catch (failure) {
      setSaveError(failure instanceof AssociationApiError && failure.code === "module_drain_pending" ? t.pendingOrders
        : failure instanceof AssociationApiError && failure.code === "stale_module_version" ? t.stale : t.saveFailed);
      await refresh();
    } finally { setPending(false); }
  }
  return <section className="my-4 space-y-3 rounded-xl border border-border p-4" data-association-module>
    <h2 className="font-semibold">{t.moduleTitle}</h2>
    <p className="text-sm text-muted-foreground">{t.moduleDescription}</p>
    {!data && !error && <ListSurfaceSkeleton rows={2} />}
    {data && <>
      <p role="status" className="text-sm font-medium">{t.states[data.module.state]}</p>
      <p className="text-sm text-muted-foreground">{t.stateDescriptions[data.module.state]}</p>
      {data.canManage && <div className="flex flex-wrap gap-2">
        {data.module.state === "disabled" && <Button className="min-h-11" disabled={pending || !!error} onClick={() => void act("enable")}>{t.enable}</Button>}
        {data.module.state === "enabled" && <Button className="min-h-11" variant="outline" disabled={pending || !!error} onClick={() => void act("request_disable")}>{t.disable}</Button>}
        {data.module.state === "draining" && <Button className="min-h-11" variant="outline" disabled={pending || !!error} onClick={() => void act("finish_disable")}>{t.finish}</Button>}
      </div>}
      {!data.canManage && <p className="text-sm text-muted-foreground">{t.ownerOnly}</p>}
      <Link className="inline-flex min-h-11 items-center text-sm text-primary underline" href={`/w/${workspaceId}/association?section=orders`}>{t.history}</Link>
    </>}
    {(error || saveError) && <p role="alert" className="text-sm text-destructive">{saveError ?? t.loadFailed}</p>}
    <Button className="min-h-11" variant="ghost" disabled={pending} onClick={() => { setSaveError(null); void refresh(); }}>{t.refresh}</Button>
  </section>;
}

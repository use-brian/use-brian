"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/skeleton";
import { promptDialog } from "@/components/ui/prompt-dialog";
import { confirmDialog } from "@/components/ui/confirm-dialog";
import { useT } from "@/lib/i18n/client";
import { projectHarnessApi, HarnessApiError, harnessScopeKey, type HarnessScope, type EngineeringNode, type ProjectHarnessApi } from "@/lib/api/project-harness";
import { useLeasedResource, isAuthoritativeSurfaceDenial } from "@/lib/offline/surface-content-cache";
import { invalidateSurfaceCache, markSurfaceCacheStale, SurfaceCacheEvictionError } from "@/lib/surface-cache";
import { projectHarnessCacheKey } from "@/lib/surface-prefetch";
import { currentOfflineWriteAuthority } from "@/lib/offline/application-write-authority";
import { scopeArchived } from "./harness-model";
import { HarnessScopePanel } from "./harness-scope-panel";

export type HarnessContext = {
  workspaceId: string; projectId: string; viewerId: string; owner: boolean; participant: boolean; archived: boolean;
  api: ProjectHarnessApi; busy: boolean;
  mutate: (work: () => Promise<unknown>) => Promise<boolean>;
  protect: <T>(work: () => Promise<T>) => Promise<T>;
};
export const harnessInputClass = "max-sm:min-h-11 w-full min-w-0 rounded-md border border-border bg-background p-2 text-base";
export function HarnessSkeleton() { return <div aria-busy="true" className="space-y-3"><Skeleton className="h-11 w-full" /><Skeleton className="h-48 w-full" /></div>; }

/** Only mounted for shared projects. All reads have renewable authority leases. */
export function ProjectHarness(props: { workspaceId: string; projectId: string; viewerId: string; owner: boolean; participant: boolean; archived: boolean }) {
  const t = useT().projectHarness;
  const [scope, setScope] = useState<HarnessScope>({ kind: "project" });
  const [busy, setBusy] = useState(false);
  const locked = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [denied, setDenied] = useState(false);
  const prefix = projectHarnessCacheKey(props.workspaceId, props.projectId, props.viewerId);
  const api = projectHarnessApi(props.workspaceId, props.projectId);
  // Capture routing identity, but re-read live auth before every deferred write.
  const origin = currentOfflineWriteAuthority(props.workspaceId)?.apiOrigin;
  const identityKey = JSON.stringify([prefix, origin]);
  const mounted = useRef(false);
  const liveIdentity = useRef(identityKey);
  liveIdentity.current = identityKey;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const protect = useCallback(async <T,>(work: () => Promise<T>): Promise<T> => {
    try { return await work(); } catch (cause) {
      if (isAuthoritativeSurfaceDenial(cause)) {
        if (mounted.current && liveIdentity.current === identityKey) setDenied(true);
        throw new SurfaceCacheEvictionError(cause);
      }
      throw cause;
    }
  }, [identityKey]);
  useEffect(() => { if (denied) invalidateSurfaceCache(prefix); }, [denied, prefix]);
  const tree = useLeasedResource(denied ? null : projectHarnessCacheKey(props.workspaceId, props.projectId, props.viewerId, "tree"), () => protect(api.tree));
  // New response objects do not revoke modal authority. Actual node/version/status
  // changes, loss of the content lease, context changes and revocation do.
  const nodeVersions = (nodes: EngineeringNode[]) => nodes.map(n => [n.id, n.productId, n.revision, n.status, n.name]).sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  const modalKey = JSON.stringify([identityKey, denied, props.owner, props.participant, props.archived, harnessScopeKey(scope),
    tree.data ? [nodeVersions(tree.data.products), nodeVersions(tree.data.components)] : null]);
  const live = useRef({ modalKey, writable: false, owner: false });
  live.current = { modalKey, writable: !!tree.data && !denied && !props.archived && props.participant, owner: props.owner };
  const modalAuthority = useRef<AbortController | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    modalAuthority.current = controller;
    return () => controller.abort();
  }, [modalKey]);
  function currentContext() {
    const authority = currentOfflineWriteAuthority(props.workspaceId);
    return mounted.current && liveIdentity.current === identityKey && authority?.viewerId === props.viewerId
      && authority.workspaceId === props.workspaceId && authority.apiOrigin === origin;
  }
  function currentModal(signal: AbortSignal | undefined) {
    return !!signal && !signal.aborted && live.current.modalKey === modalKey && live.current.owner && currentContext();
  }
  async function mutate(work: () => Promise<unknown>): Promise<boolean> {
    if (locked.current || !currentContext() || !live.current.writable) return false;
    locked.current = true; setBusy(true); setError(null);
    try {
      await work();
      markSurfaceCacheStale(prefix);
      return currentContext();
    } catch (cause) {
      if (!currentContext()) return false;
      // An operation-specific 403 does not revoke read access. Revalidate reads
      // independently; only their authoritative denial may evict the surface.
      if (cause instanceof HarnessApiError && cause.status === 403) setError(t.operationDenied);
      else if (isAuthoritativeSurfaceDenial(cause)) setDenied(true);
      else setError(cause instanceof HarnessApiError && cause.status === 409 ? t.conflict : t.failed);
      markSurfaceCacheStale(prefix);
      return false;
    } finally { locked.current = false; if (mounted.current && liveIdentity.current === identityKey) setBusy(false); }
  }
  async function create(productId?: string) {
    const signal = modalAuthority.current?.signal;
    if (!currentModal(signal)) return;
    const name = await promptDialog({ signal, title: productId ? t.createComponent : t.createProduct, placeholder: t.name, confirmLabel: t.save, cancelLabel: t.cancel });
    if (name?.trim() && currentModal(signal)) await mutate(() => productId ? api.createComponent(productId, name.trim()) : api.createProduct(name.trim()));
  }
  async function rename(node: EngineeringNode, target: Exclude<HarnessScope, { kind: "project" }>) {
    const signal = modalAuthority.current?.signal;
    if (!currentModal(signal)) return;
    const name = await promptDialog({ signal, title: t.rename, placeholder: t.name, defaultValue: node.name, confirmLabel: t.save, cancelLabel: t.cancel });
    if (name?.trim() && currentModal(signal)) await mutate(() => api.updateNode(target, { expectedRevision: node.revision, name: name.trim() }));
  }
  async function archive(node: EngineeringNode, target: Exclude<HarnessScope, { kind: "project" }>) {
    const signal = modalAuthority.current?.signal;
    if (!currentModal(signal)) return;
    const label = node.status === "active" ? t.archive : t.restore;
    if (await confirmDialog({ signal, title: label, description: node.name, confirmLabel: label, cancelLabel: t.cancel }) && currentModal(signal))
      await mutate(() => api.updateNode(target, { expectedRevision: node.revision, status: node.status === "active" ? "archived" : "active" }));
  }
  function nodeRow(node: EngineeringNode, target: Exclude<HarnessScope, { kind: "project" }>, parentArchived: boolean) {
    return <div className="flex min-w-0 flex-wrap items-center gap-2">
      <Button variant={harnessScopeKey(scope) === harnessScopeKey(target) ? "secondary" : "ghost"} className="max-sm:min-h-11 max-w-full whitespace-normal break-words text-left" onClick={() => setScope(target)} aria-pressed={harnessScopeKey(scope) === harnessScopeKey(target)}>{node.name}</Button>
      <span className="text-xs text-muted-foreground">{t.revision}: {node.revision}{node.status === "archived" ? ` · ${t.archived}` : ""}</span>
      {props.owner && !props.archived && !parentArchived ? <>
        {node.status === "active" && <Button variant="outline" className="max-sm:min-h-11" disabled={busy} onClick={() => void rename(node, target)}>{t.rename}</Button>}
        <Button variant="outline" className="max-sm:min-h-11" disabled={busy} onClick={() => void archive(node, target)}>{node.status === "active" ? t.archive : t.restore}</Button>
      </> : null}
    </div>;
  }
  const context: HarnessContext = { ...props, archived: props.archived || (tree.data ? scopeArchived(tree.data, scope) : true), api, busy, mutate, protect };
  return <section className="min-w-0 space-y-4 rounded-xl border border-border p-3 sm:p-4" aria-label={t.title}>
    <h2 className="font-semibold">{t.title}</h2>
    <p className="text-sm text-muted-foreground">{t.ownerOnly}</p>
    {props.archived && <p>{t.archived}</p>}
    {denied ? <p role="alert">{t.denied}</p> : <>
      {!!(error || tree.error) && <p role="alert">{error || t.failed}</p>}
      <Button variant="outline" className="max-sm:min-h-11" disabled={busy} onClick={() => { markSurfaceCacheStale(prefix); void tree.refresh(); }}>{t.retry}</Button>
      {!tree.data ? <HarnessSkeleton /> : <>
        <nav aria-label={t.title} className="space-y-3">
          <Button className="max-sm:min-h-11" variant={scope.kind === "project" ? "secondary" : "ghost"} aria-pressed={scope.kind === "project"} onClick={() => setScope({ kind: "project" })}>{t.project}</Button>
          {props.owner && !props.archived && <Button variant="outline" className="max-sm:min-h-11" disabled={busy} onClick={() => void create()}>{t.createProduct}</Button>}
          {!tree.data.products.length && <p className="text-sm text-muted-foreground">{t.empty}</p>}
          {tree.data.products.map(product => <div key={product.id} className="min-w-0 space-y-2 border-l border-border pl-2 sm:pl-4">
            <span className="text-xs text-muted-foreground">{t.product}</span>
            {nodeRow(product, { kind: "product", productId: product.id }, false)}
            {props.owner && !props.archived && product.status === "active" && <Button variant="outline" className="max-sm:min-h-11" disabled={busy} onClick={() => void create(product.id)}>{t.createComponent}</Button>}
            {tree.data!.components.filter(c => c.productId === product.id).map(component => <div key={component.id} className="min-w-0 border-l border-border pl-2 sm:pl-4">
              <span className="text-xs text-muted-foreground">{t.component}</span>
              {nodeRow(component, { kind: "component", productId: product.id, componentId: component.id }, product.status === "archived")}
            </div>)}
          </div>)}
        </nav>
        <HarnessScopePanel key={harnessScopeKey(scope)} context={context} scope={scope} />
      </>}
    </>}
  </section>;
}

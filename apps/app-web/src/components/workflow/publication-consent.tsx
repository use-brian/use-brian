"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { confirmDialog } from "@/components/ui/confirm-dialog";
import { Skeleton } from "@/components/skeleton";
import { useT } from "@/lib/i18n/client";
import type { WorkflowFull } from "@/lib/api/workflow";
import { approveWorkflowPublicationConsent, getWorkflowPublicationConsents, revokeWorkflowPublicationConsent } from "@/lib/api/workflow-publication-consent";
import { invalidateSurfaceCache, seedSurfaceCache, useCachedResource } from "@/lib/surface-cache";
import { workflowPublicationConsentCacheKey } from "@/lib/surface-prefetch";
import { WORKFLOW_REFRESH_EVENT, type WorkflowRefreshDetail } from "@/lib/workflow-events";

/** [COMP:app-web/workflow-publication-consent] Metadata only, never editable workflow JSON. */
export function WorkflowPublicationConsent({ workflow, dirty }: { workflow: WorkflowFull; dirty: boolean }) {
  const c = useT().workflowPublicationConsent;
  const key = workflowPublicationConsentCacheKey(workflow.workspaceId, workflow.id);
  const resource = useCachedResource(key, () => getWorkflowPublicationConsents(workflow.id));
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [now, setNow] = useState(Date.now);
  const pending = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const savedVersion = useRef({ key, updatedAt: workflow.updatedAt });
  const data = resource.data;
  const versionMatches = data?.workflowUpdatedAt === workflow.updatedAt;
  const unavailable = !data || !!resource.error || resource.revalidating;
  const blocked = !data?.canManage || !versionMatches || unavailable || failed;
  const latest = useRef({ dirty, blocked, unavailable });
  latest.current = { dirty, blocked, unavailable };

  useEffect(() => {
    const invalidate = () => {
      generation.current++;
      pending.current?.abort();
      invalidateSurfaceCache(key);
    };
    const onRefresh = (event: Event) => {
      const detail = (event as CustomEvent<WorkflowRefreshDetail>).detail;
      if (detail?.workspaceId && detail.workspaceId !== workflow.workspaceId) return;
      if (detail?.primitive === "workflow_run") return;
      if (detail?.rowId && detail.rowId !== workflow.id) return;
      invalidate();
    };
    const onVisible = () => { if (document.visibilityState === "visible") invalidate(); };
    window.addEventListener(WORKFLOW_REFRESH_EVENT, onRefresh);
    document.addEventListener("visibilitychange", onVisible);
    if (savedVersion.current.key !== key || savedVersion.current.updatedAt !== workflow.updatedAt) {
      savedVersion.current = { key, updatedAt: workflow.updatedAt };
      invalidate();
    }
    return () => {
      generation.current++;
      pending.current?.abort();
      window.removeEventListener(WORKFLOW_REFRESH_EVENT, onRefresh);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [key, workflow.workspaceId, workflow.id, workflow.updatedAt]);

  useEffect(() => { pending.current?.abort(); }, [dirty, data, resource.error, resource.revalidating]);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  async function change(stepId: string, destination: string, integration: string, revoke: boolean) {
    if (busy || latest.current.unavailable || (!revoke && (latest.current.dirty || latest.current.blocked)) || !data) return;
    setBusy(true);
    const controller = new AbortController();
    pending.current = controller;
    const epoch = generation.current;
    try {
      if (!revoke) {
        const confirmed = await confirmDialog({
          title: c.confirmTitle,
          description: `${c.step}: ${stepId}\n${c.destination}: ${destination}\n${c.integration}: ${integration}\n\n${c.warning}`,
          confirmLabel: c.confirm,
          cancelLabel: c.cancel,
          variant: "destructive",
          signal: controller.signal,
        });
        if (!confirmed || controller.signal.aborted || latest.current.dirty || latest.current.blocked) return;
      }
      const result = revoke
        ? await revokeWorkflowPublicationConsent(workflow.id, stepId)
        : await approveWorkflowPublicationConsent(workflow.id, stepId, data.workflowUpdatedAt, data.consentVersion);
      if (epoch === generation.current) {
        invalidateSurfaceCache(key);
        seedSurfaceCache(key, result);
      }
    } catch {
      if (epoch === generation.current) setFailed(true);
    } finally {
      if (pending.current === controller) pending.current = null;
      setBusy(false);
    }
  }

  const stepIds = [...new Set([...(data?.eligibleStepIds ?? []), ...(data?.consents.map(row => row.stepId) ?? [])])];
  return (
    <section className="space-y-3 rounded-xl border border-border p-4 min-w-0" aria-label={c.title}>
      <h2 className="text-sm font-semibold">{c.title}</h2>
      <p className="text-sm text-muted-foreground">{c.intro}</p>
      <p className="text-sm text-muted-foreground">{c.warning}</p>
      {resource.loading && <div aria-hidden="true" className="space-y-2"><Skeleton className="h-5 w-full" /><Skeleton className="h-11 w-full" /></div>}
      {(resource.error || failed) ? <p role="alert" className="text-sm text-destructive">{c.error}</p> : null}
      {data && !data.canManage && <p className="text-sm">{c.permission}</p>}
      {dirty && <p className="text-sm">{c.dirty}</p>}
      {data && !versionMatches && <p className="text-sm">{c.version}</p>}
      {data && stepIds.length === 0 && <p className="text-sm text-muted-foreground">{c.empty}</p>}
      {stepIds.map(stepId => {
        const consent = data?.consents.find(row => row.stepId === stepId);
        const step = workflow.definition.steps.find(row => row.id === stepId);
        const delivery = step?.type === "assistant_call" ? step.deliver : undefined;
        const fixed = delivery && "channelId" in delivery ? delivery : undefined;
        const eligible = !!data?.eligibleStepIds.includes(stepId) && !!fixed;
        const active = consent?.active && versionMatches && Date.parse(consent.expiresAt) > now;
        return <div key={stepId} className="space-y-2 border-t border-border pt-3 text-sm break-all">
          <p className="font-medium">{c.step}: {stepId}</p>
          <p>{c.destination}: {fixed?.channelId ?? consent?.channelId}</p>
          <p>{c.integration}: {fixed?.channelIntegrationId ?? consent?.channelIntegrationId}</p>
          {consent && <>
            <p>{active ? c.active : c.inactive}</p>
            <p>{c.approvedAt}: {consent.approvedAt}</p>
            <p>{c.expiresAt}: {consent.expiresAt}</p>
          </>}
          {(data?.canManage || consent) && <div className="flex flex-wrap gap-2">
            {eligible && data?.canManage && <Button className="max-sm:min-h-11" disabled={blocked || busy || dirty} onClick={() => void change(stepId, fixed!.channelId, fixed!.channelIntegrationId ?? "", false)}>{consent ? c.reapprove : c.approve}</Button>}
            {consent && <Button className="max-sm:min-h-11" variant="outline" disabled={unavailable || busy} onClick={() => void change(stepId, consent.channelId, consent.channelIntegrationId, true)}>{c.revoke}</Button>}
          </div>}
        </div>;
      })}
      <Button className="max-sm:min-h-11" variant="outline" disabled={busy || resource.revalidating} onClick={() => { setFailed(false); void resource.refresh(); }}>{c.refresh}</Button>
    </section>
  );
}

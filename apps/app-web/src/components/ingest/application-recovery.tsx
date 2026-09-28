"use client";

/** [COMP:app-web/ingest-application] Studio recovery for frozen ingest plans. */
import { useState } from "react";
import { confirmDialog } from "@/components/ui/confirm-dialog";
import { useT } from "@/lib/i18n/client";
import {
  listIngestApplications,
  retryIngestApplication,
  type IngestApplicationStatus,
} from "@/lib/api/ingest";
import { mutateSurfaceCache, useCachedResource } from "@/lib/surface-cache";
import { ingestApplicationsCacheKey } from "@/lib/surface-prefetch";

export function ApplicationRecovery({ workspaceId }: { workspaceId: string }) {
  const copy = useT().studioPage.ingestRules.applicationRecovery;
  const [retrying, setRetrying] = useState<string | null>(null);
  const cacheKey = workspaceId ? ingestApplicationsCacheKey(workspaceId) : null;
  const resource = useCachedResource<IngestApplicationStatus[]>(cacheKey, () =>
    listIngestApplications(workspaceId));
  const items = resource.data;

  async function retry(item: Extract<IngestApplicationStatus, { status: "tracked" }>) {
    const confirmed = await confirmDialog({
      title: copy.confirmTitle,
      description: copy.confirmBody,
      confirmLabel: copy.retry,
      cancelLabel: copy.cancel,
    });
    if (!confirmed) return;
    setRetrying(item.runId);
    try {
      const next = await retryIngestApplication({
        episodeId: item.episodeId,
        runId: item.runId,
        expectedPlanHash: item.planHash,
      });
      mutateSurfaceCache<IngestApplicationStatus[]>(cacheKey, (current) =>
        current.map((row) => row.episodeId === next.episodeId ? next : row));
    } catch {
      await resource.refresh();
    } finally {
      setRetrying(null);
    }
  }

  return (
    <section className="rounded-lg border border-border bg-card/50 px-4 py-3" aria-label={copy.title}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-[13px] font-medium">{copy.title}</h2>
          <p className="mt-0.5 text-[11px] text-muted-foreground">{copy.help}</p>
        </div>
        <button type="button" onClick={() => void resource.refresh()} className="text-xs font-medium text-primary hover:underline">
          {copy.refresh}
        </button>
      </div>
      {Boolean(resource.error) && <p className="mt-3 text-xs text-destructive">{copy.error}</p>}
      {items === undefined && !resource.error ? (
        <div className="mt-3 h-10 animate-pulse rounded-md bg-muted" aria-label={copy.loading} />
      ) : items?.length === 0 ? (
        <p className="mt-3 text-xs text-muted-foreground">{copy.empty}</p>
      ) : (
        <ul className="mt-3 space-y-2">
          {items?.map((item) => (
            <li key={item.episodeId} className="rounded-md border border-border px-3 py-2 text-xs">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-mono text-[11px] text-muted-foreground">{item.episodeId}</span>
                <span className="font-medium">
                  {item.status === "legacy_untracked"
                    ? copy.legacy
                    : item.applicationState === "complete"
                      ? copy.states.complete
                      : item.applicationState === "partial"
                        ? copy.states.partial
                        : item.applicationState === "blocked"
                          ? copy.states.blocked
                          : copy.states.not_started}
                </span>
              </div>
              {item.status === "tracked" && (
                <>
                  <p className="mt-1 text-muted-foreground">
                    {copy.committed}: {item.counts.committed + item.counts.alreadyApplied} · {copy.failed}: {item.counts.failed} · {copy.held}: {item.counts.held + item.counts.rejected}
                  </p>
                  {item.errorCode && <p className="mt-1 text-destructive">{copy.lastError}: {item.errorCode}</p>}
                  {item.resumable && (
                    <button
                      type="button"
                      disabled={retrying === item.runId}
                      onClick={() => void retry(item)}
                      className="mt-2 inline-flex h-7 items-center rounded-md bg-action px-3 font-medium text-action-foreground disabled:opacity-50"
                    >
                      {retrying === item.runId ? copy.retrying : copy.retry}
                    </button>
                  )}
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

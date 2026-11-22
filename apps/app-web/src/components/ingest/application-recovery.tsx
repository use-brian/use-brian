"use client";

/** [COMP:app-web/ingest-application] Studio recovery for frozen ingest plans. */
import { useState } from "react";
import { confirmDialog } from "@/components/ui/confirm-dialog";
import { useT } from "@/lib/i18n/client";
import {
  listIngestApplications,
  retryIngestApplication,
  type IngestApplicationPage,
  type IngestApplicationStatus,
} from "@/lib/api/ingest";
import { mutateSurfaceCache, useCachedResource } from "@/lib/surface-cache";
import { ingestApplicationsCacheKey } from "@/lib/surface-prefetch";

export function ApplicationRecovery({ workspaceId }: { workspaceId: string }) {
  return <ApplicationRecoveryPages key={workspaceId} workspaceId={workspaceId} />;
}

function ApplicationRecoveryPages({ workspaceId }: { workspaceId: string }) {
  const copy = useT().studioPage.ingestRules.applicationRecovery;
  const [cursors, setCursors] = useState<string[]>([]);
  const [retrying, setRetrying] = useState<string | null>(null);
  const [retryError, setRetryError] = useState<string | null>(null);
  const cursor = cursors.at(-1);
  const cacheKey = workspaceId ? ingestApplicationsCacheKey(workspaceId, cursor) : null;
  const resource = useCachedResource(cacheKey, () => listIngestApplications(workspaceId, cursor));
  const items = resource.data?.applications;
  const nextCursor = resource.data?.nextCursor;

  async function retry(item: Extract<IngestApplicationStatus, { status: "tracked" }>) {
    const confirmed = await confirmDialog({
      title: copy.confirmTitle,
      description: copy.confirmBody,
      confirmLabel: copy.retry,
      cancelLabel: copy.cancel,
    });
    if (!confirmed) return;
    setRetrying(item.runId);
    setRetryError(null);
    try {
      const next = await retryIngestApplication({
        episodeId: item.episodeId,
        runId: item.runId,
        expectedPlanHash: item.planHash,
      });
      mutateSurfaceCache<IngestApplicationPage>(cacheKey, (page) => ({
        ...page,
        applications: page.applications.map((row) => row.status === "tracked" && row.runId === item.runId ? next : row),
      }));
    } catch {
      setRetryError(item.runId);
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
        <button type="button" onClick={() => { setRetryError(null); void resource.refresh(); }} className="min-h-8 max-sm:min-h-11 text-xs font-medium text-primary hover:underline">
          {copy.refresh}
        </button>
      </div>
      {Boolean(resource.error) && <p className="mt-3 text-xs text-destructive">{copy.error}</p>}
      {items === undefined && !resource.error ? (
        <div className="mt-3 h-10 animate-pulse rounded-md bg-muted" aria-label={copy.loading} />
      ) : items?.length === 0 ? (
        <p className="mt-3 text-xs text-muted-foreground">{copy.empty}</p>
      ) : (
        <ul className="mt-3 divide-y divide-border">
          {items?.map((item) => (
            <li key={item.status === "tracked" ? item.runId : item.episodeId} className="py-2 text-xs">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-mono text-[11px] text-muted-foreground">{item.episodeId}</span>
                <span className="font-medium">
                  {item.status === "legacy_untracked"
                    ? copy.legacy
                    : item.applicationState === "complete" && item.counts.held > 0
                      ? copy.finishedWithHolds
                      : copy.states[item.applicationState]}
                </span>
              </div>
              {item.status === "tracked" && (
                <>
                  <p className="mt-1 text-muted-foreground">
                    {copy.committed}: {item.counts.committed + item.counts.already_applied} · {copy.failed}: {item.counts.failed} · {copy.held}: {item.counts.held}
                    {item.counts.rejected > 0 && <> · {copy.rejected}: {item.counts.rejected}</>}
                  </p>
                  {item.items.some(candidate =>
                    candidate.failureCode === "application_entity_identity_ambiguous"
                    || candidate.failureCode === "application_entity_alias_conflict"
                    || candidate.failureCode === "ambiguous_entity_reference"
                  ) && <p className="mt-1 text-muted-foreground">{copy.ambiguousIdentity}</p>}
                  {retryError === item.runId && <p role="alert" className="mt-1 text-destructive">{copy.error}</p>}
                  {item.errorCode && <p className="mt-1 text-destructive">{copy.lastError}: {item.errorCode}</p>}
                  {item.resumable && (
                    <button
                      type="button"
                      disabled={retrying !== null}
                      onClick={() => void retry(item)}
                      className="mt-2 inline-flex min-h-8 max-sm:min-h-11 items-center rounded-md bg-action px-3 font-medium text-action-foreground disabled:opacity-50"
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
      {(cursors.length > 0 || nextCursor) && (
        <div className="mt-2 flex flex-wrap gap-3">
          {cursors.length > 0 && <button type="button" disabled={retrying !== null} className="min-h-8 max-sm:min-h-11 text-xs font-medium text-primary" onClick={() => setCursors(cursors.slice(0, -1))}>{copy.newer}</button>}
          {nextCursor && <button type="button" disabled={retrying !== null} className="min-h-8 max-sm:min-h-11 text-xs font-medium text-primary" onClick={() => setCursors([...cursors, nextCursor])}>{copy.older}</button>}
        </div>
      )}
    </section>
  );
}

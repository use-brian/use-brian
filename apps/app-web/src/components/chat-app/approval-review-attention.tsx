"use client";

/**
 * Chat attention (docs/architecture/features/approval-review.md -> "Surfaces";
 * chat-app.md -> "Attention"). A notification icon in the chat top bar,
 * backed by actionable items DERIVED on the server from native state: the
 * viewer's waiting approval requests (with their assigned reviewer and why a
 * request is still with them), decisions a reviewer made on their behalf,
 * and workflow route blockers. Opening the panel marks items seen;
 * resolving a request removes it. No timers, reminders or outbound sends.
 * The panel also offers explicit reviewer assignment for one request,
 * "review now", and pattern inspection/revocation. Every action is the
 * signed-in person acting through the shared server services.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Bell } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { confirmDialog } from "@/components/ui/confirm-dialog";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { format, useT } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";
import { markSurfaceCacheStale, useCachedResource } from "@/lib/surface-cache";
import { APPROVALS_REFRESH_EVENT, type ApprovalsRefreshDetail } from "@/lib/approvals-events";
import { listWorkspaceAssistants } from "@/lib/api/views";
import {
  assignReviewer,
  attentionCacheKey,
  fetchAttention,
  listPatterns,
  markAttentionSeen,
  newIdempotencyKey,
  requestReview,
  revokePattern,
  revokeReviewer,
  type ApprovalPatternView,
  type AttentionItem,
} from "@/lib/api/approval-review";

type Dict = ReturnType<typeof useT>["chatApp"]["approvalReview"];

export function reasonText(t: Dict, reason: string): string {
  const [head] = reason.split(":");
  const known = t.reasons as Record<string, string>;
  return known[reason] ?? known[head] ?? format(t.reasons.other, { code: reason });
}

export function ApprovalReviewAttention({ workspaceId, sessionId, projectId }: {
  workspaceId: string
  sessionId: string | null
  projectId: string | null
}) {
  const t = useT().chatApp.approvalReview;
  const [open, setOpen] = useState(false);
  const [everywhere, setEverywhere] = useState(false);
  const [tab, setTab] = useState<"work" | "patterns">("work");
  const scoped = !everywhere && (projectId || sessionId) ? { projectId, sessionId } : {};
  const key = attentionCacheKey(workspaceId, scoped);
  const badgeKey = attentionCacheKey(workspaceId, {});
  const badge = useCachedResource(badgeKey, () => fetchAttention(workspaceId));
  const list = useCachedResource(open ? key : null, () => fetchAttention(workspaceId, scoped));

  // Persistent layout: subscribe to the workspace approval signal (realtime-sync.md).
  // Stale-while-revalidate keeps rows up; a resource that only holds an error
  // (no data to keep) is refetched outright.
  const resources = useRef({ badge, list });
  resources.current = { badge, list };
  useEffect(() => {
    const onRefresh = (event: Event) => {
      const detail = (event as CustomEvent<ApprovalsRefreshDetail>).detail;
      if (detail?.workspaceId && detail.workspaceId !== workspaceId) return;
      markSurfaceCacheStale(`approval-review:attention:${workspaceId}`);
      for (const r of [resources.current.badge, resources.current.list]) if (r.data === undefined) void r.refresh();
    };
    window.addEventListener(APPROVALS_REFRESH_EVENT, onRefresh);
    return () => window.removeEventListener(APPROVALS_REFRESH_EVENT, onRefresh);
  }, [workspaceId]);

  const unseen = badge.data?.unseen ?? 0;
  const onOpenChange = useCallback((next: boolean) => {
    setOpen(next);
    if (!next) return;
    const keys = (badge.data?.items ?? []).filter((i) => !i.seen).map((i) => i.key);
    if (keys.length) void markAttentionSeen(workspaceId, keys).then(() => markSurfaceCacheStale(`approval-review:attention:${workspaceId}`)).catch(() => {});
  }, [badge.data, workspaceId]);

  const label = unseen > 0 ? format(t.iconLabelCount, { count: String(unseen) }) : t.iconLabel;
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger
        aria-label={label}
        title={label}
        data-testid="approval-review-attention"
        className="relative inline-flex size-8 items-center justify-center rounded-md text-sidebar-foreground/80 transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground max-md:size-11"
      >
        <Bell className="size-4" aria-hidden />
        {unseen > 0 && (
          <span className="absolute -top-0.5 -right-0.5 min-w-4 rounded-full bg-primary px-1 text-[10px] font-semibold leading-4 text-primary-foreground" aria-hidden>
            {unseen > 9 ? "9+" : unseen}
          </span>
        )}
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[min(26rem,calc(100vw-1rem))] gap-2">
        <div className="flex items-center justify-between gap-2">
          <p className="text-sm font-semibold">{t.title}</p>
          <div role="tablist" aria-label={t.title} className="flex items-center gap-0.5 rounded-md bg-muted/60 p-0.5 text-xs">
            <button type="button" role="tab" aria-selected={tab === "work"} onClick={() => setTab("work")} className={tabCls(tab === "work")}>{t.tabWork}</button>
            <button type="button" role="tab" aria-selected={tab === "patterns"} onClick={() => setTab("patterns")} className={tabCls(tab === "patterns")}>{t.tabPatterns}</button>
          </div>
        </div>
        {tab === "work" ? (
          <>
            {(projectId || sessionId) && (
              <div className="flex gap-1 text-xs">
                <button type="button" aria-pressed={!everywhere} onClick={() => setEverywhere(false)} className={tabCls(!everywhere)}>{t.scopeHere}</button>
                <button type="button" aria-pressed={everywhere} onClick={() => setEverywhere(true)} className={tabCls(everywhere)}>{t.scopeAll}</button>
              </div>
            )}
            <AttentionList t={t} workspaceId={workspaceId} state={list} />
          </>
        ) : (
          <PatternList t={t} workspaceId={workspaceId} />
        )}
      </PopoverContent>
    </Popover>
  );
}

function tabCls(active: boolean) {
  return cn("min-h-7 rounded px-2 py-0.5 max-md:min-h-11", active ? "bg-background font-medium shadow-sm" : "text-muted-foreground hover:text-foreground");
}

function AttentionList({ t, workspaceId, state }: { t: Dict; workspaceId: string; state: ReturnType<typeof useCachedResource<{ items: AttentionItem[] }>> }) {
  if (state.loading && !state.data) return <div className="h-16 animate-pulse rounded-md bg-muted/50" aria-label={t.loading} />;
  if (state.error && !state.data) {
    return (
      <div className="space-y-2 text-xs">
        <p role="alert" className="text-destructive">{t.unavailable}</p>
        <Button size="sm" variant="outline" onClick={() => void state.refresh()}>{t.retry}</Button>
      </div>
    );
  }
  const items = state.data?.items ?? [];
  if (!items.length) return <p className="text-xs text-muted-foreground">{t.empty}</p>;
  return (
    <ul className="flex flex-col gap-2" data-testid="approval-review-items">
      {items.map((item) => <AttentionRow key={item.key} t={t} workspaceId={workspaceId} item={item} onChanged={() => void state.refresh()} />)}
    </ul>
  );
}

function AttentionRow({ t, workspaceId, item, onChanged }: { t: Dict; workspaceId: string; item: AttentionItem; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [assigning, setAssigning] = useState(false);
  const [reviewer, setReviewer] = useState("");
  const [assistants, setAssistants] = useState<Array<{ value: string; label: string }>>([]);
  const act = async (work: () => Promise<string | null>) => {
    setBusy(true);
    try { setStatus(await work()); markSurfaceCacheStale(`approval-review:attention:${workspaceId}`); onChanged(); }
    catch (error) { setStatus(format(t.error, { message: error instanceof Error ? error.message : String(error) })); }
    finally { setBusy(false); }
  };
  const openAssign = async () => {
    setAssigning(true);
    if (!assistants.length) {
      const rows = await listWorkspaceAssistants(workspaceId).catch(() => []);
      setAssistants(rows.map((a) => ({ value: a.id, label: a.name })));
    }
  };

  if (item.kind === "route_blocker") {
    return (
      <li className="rounded-md border p-2 text-xs" data-kind={item.kind}>
        <p className="font-medium">{t.routeBlocked}</p>
        <p className="text-muted-foreground">{(t.routeBlockers as Record<string, string>)[item.blocker] ?? item.blocker}</p>
        <Link className="mt-1 inline-block underline" href={`/w/${workspaceId}/workflow/${item.workflowId}`}>{t.openWorkflow}</Link>
      </li>
    );
  }
  if (item.kind === "delegated_decision") {
    const name = item.reviewerName ?? t.unknownReviewer;
    return (
      <li className="rounded-md border p-2 text-xs" data-kind={item.kind}>
        <p className="font-medium">{format(item.invalidated ? t.decidedInvalid : t.decided, { name })}</p>
        {item.toolName && <p className="truncate text-muted-foreground">{item.toolName}</p>}
        <Link className="mt-1 inline-block underline" href={`/w/${workspaceId}/approvals?id=${item.approvalId}`}>{t.open}</Link>
      </li>
    );
  }
  const review = item.review;
  return (
    <li className="space-y-1.5 rounded-md border p-2 text-xs" data-kind={item.kind}>
      <p className="font-medium">{t.waiting}</p>
      {(item.summary || item.toolName) && <p className="line-clamp-2 text-muted-foreground">{item.summary ?? item.toolName}</p>}
      <p>{review ? format(t.reviewer, { name: review.reviewerName ?? t.unknownReviewer }) : t.noReviewer}</p>
      {review?.lastAttempt && review.lastAttempt.outcome !== "resolved" && review.lastAttempt.reasons.length > 0 && (
        <div>
          <p className="text-muted-foreground">{t.reasonsLabel}</p>
          <ul className="list-disc pl-4">
            {review.lastAttempt.reasons.map((r) => <li key={r}>{reasonText(t, r)}</li>)}
          </ul>
        </div>
      )}
      <div className="flex flex-wrap gap-1.5">
        <Link className="inline-flex min-h-7 items-center underline max-md:min-h-11" href={`/w/${workspaceId}/approvals?id=${item.approvalId}`}>{t.open}</Link>
        {review ? (
          <>
            <Button size="sm" variant="outline" disabled={busy} onClick={() => void act(async () => {
              const r = await requestReview(workspaceId, item.approvalId);
              return r.outcome === "resolved" ? format(t.reviewResolved, { name: review.reviewerName ?? t.unknownReviewer }) : t.reviewLeft;
            })}>{busy ? t.reviewing : t.reviewNow}</Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => void act(async () => {
              await revokeReviewer(workspaceId, review.assignmentId);
              return t.removed;
            })}>{t.removeReviewer}</Button>
          </>
        ) : !assigning ? (
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void openAssign()}>{t.assign}</Button>
        ) : null}
      </div>
      {assigning && !review && (
        <div className="flex flex-col gap-1.5 sm:flex-row">
          <SearchableSelect value={reviewer} onValueChange={setReviewer} items={assistants} placeholder={t.assignPlaceholder} aria-label={t.assignPlaceholder} className="min-w-0 flex-1" />
          <Button size="sm" disabled={!reviewer || busy} onClick={() => void act(async () => {
            await assignReviewer(workspaceId, { reviewerAssistantId: reviewer, scopeKind: "request", scopeId: item.approvalId, idempotencyKey: newIdempotencyKey("chat-assign") });
            setAssigning(false);
            return t.assigned;
          })}>{t.assignSave}</Button>
        </div>
      )}
      {status && <p role="status" className="text-muted-foreground">{status}</p>}
    </li>
  );
}

function PatternList({ t, workspaceId }: { t: Dict; workspaceId: string }) {
  const state = useCachedResource(`approval-review:patterns:${workspaceId}`, () => listPatterns(workspaceId));
  const [status, setStatus] = useState<string | null>(null);
  if (state.loading && !state.data) return <div className="h-16 animate-pulse rounded-md bg-muted/50" aria-label={t.loading} />;
  if (state.error && !state.data) return <p role="alert" className="text-xs text-destructive">{t.unavailable}</p>;
  const patterns = (state.data?.patterns ?? []).filter((p) => p.status !== "revoked");
  if (!patterns.length) return <p className="text-xs text-muted-foreground">{t.patternsEmpty}</p>;
  const revoke = async (p: ApprovalPatternView) => {
    if (!await confirmDialog({ title: t.revokeTitle, description: t.revokeDescription, confirmLabel: t.revoke, variant: "destructive" })) return;
    try { await revokePattern(workspaceId, p.id, p.revision); setStatus(t.revoked); await state.refresh(); }
    catch (error) { setStatus(format(t.error, { message: error instanceof Error ? error.message : String(error) })); }
  };
  return (
    <ul className="flex flex-col gap-2" data-testid="approval-review-patterns">
      {patterns.map((p) => (
        <li key={p.id} className="flex items-start justify-between gap-2 rounded-md border p-2 text-xs">
          <div className="min-w-0">
            <p className="truncate font-medium">{p.actionKind}</p>
            <p className="text-muted-foreground">
              {(t.patternStatus as Record<string, string>)[p.status] ?? p.status}
              {" · "}
              {format(t.patternSupport, { count: String(p.support.approvedChains), required: String(p.support.required) })}
            </p>
          </div>
          <Button size="sm" variant="ghost" onClick={() => void revoke(p)}>{t.revoke}</Button>
        </li>
      ))}
      {status && <li role="status" className="text-xs text-muted-foreground">{status}</li>}
    </ul>
  );
}

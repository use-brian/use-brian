"use client";

/**
 * Direct work pickup (project-briefs.md -> "Work"): the viewer-bound Needs
 * you / My work / Needs assignment lists, shared by the Chat work entry and
 * the Brief pane. Rows and counts come from the server projection, which
 * already applied the viewer's access, so nothing here decides visibility.
 *
 * Every action is a canonical command: the guarded claim, the Brain inbox
 * adjust for an explicit follow-up, the Approvals panel for an answer, the
 * task detail, or a DRAFT-ONLY chat pickup the caller supplies (it fills a
 * composer; it never sends). Opening a card changes nothing. Loading,
 * unavailable (keeping the last good data, labelled stale) and an empty queue
 * are three different states.
 *
 * [COMP:app-web/brief-work]
 */
import Link from "next/link";
import { useId, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { Skeleton } from "@/components/skeleton";
import { format, useLocale, useT } from "@/lib/i18n/client";
import { adjustBrainRow } from "@/lib/api/brain-inbox";
import { listWorkspaceAssistants, type WorkspaceAssistantSummary } from "@/lib/api/views";
import {
  claimWorkTask,
  fetchWork,
  withoutTask,
  WorkRequestError,
  type WorkItem,
  type WorkProjection,
  type WorkScope,
  type WorkSectionKey,
} from "@/lib/api/work";
import { requestBrainRefresh } from "@/lib/brain-events";
import { brainRowUrl } from "@/lib/brain-deep-link";
import { mutateSurfaceCache, useCachedResource } from "@/lib/surface-cache";
import { workCacheKey } from "@/lib/surface-prefetch";

const SECTIONS: WorkSectionKey[] = ["needsYou", "myWork", "needsAssignment"];

type WorkT = ReturnType<typeof useT>["briefs"]["work"];

export function BriefWork({ workspaceId, scope, onContinueInChat, emptyState, title, hideWhenEmpty }: {
  workspaceId: string;
  scope: WorkScope;
  /** Draft-only pickup into a composer. Omitted: no chat action is offered. */
  onContinueInChat?: (item: WorkItem, draft: string) => void;
  /** What an authoritative empty queue shows instead of the default line. */
  emptyState?: ReactNode;
  title?: string;
  /** Render nothing for an authoritative empty queue (Chat: the composer above is the empty state). */
  hideWhenEmpty?: boolean;
}) {
  const t = useT().briefs.work;
  const headingId = useId();
  const key = workCacheKey(workspaceId, scope);
  const { data, error, loading, refresh } = useCachedResource<WorkProjection>(key, () => fetchWork(workspaceId, scope));
  const [pending, setPending] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  async function act(item: WorkItem, work: () => Promise<void>) {
    setPending(item.taskId);
    setActionError(null);
    try {
      await work();
      // The command succeeded: drop the card now, then let the event spine
      // repair every surface (this list, Tasks, the dock) from the server.
      mutateSurfaceCache<WorkProjection>(key, (current) => (current ? withoutTask(current, item.taskId) : current));
      requestBrainRefresh(workspaceId);
    } catch (err) {
      const code = err instanceof WorkRequestError ? err.code : err instanceof Error ? err.message : "";
      setActionError((t.errors as Record<string, string>)[code] ?? t.errors.generic);
    } finally {
      setPending(null);
    }
  }

  const total = data ? data.counts.needsYou + data.counts.myWork + data.counts.needsAssignment : 0;
  if (hideWhenEmpty && data && total === 0 && !error && !actionError) return null;

  return (
    <section aria-labelledby={headingId} aria-busy={loading || undefined} className="rounded-xl border border-border p-4" data-testid="brief-work">
      <h3 id={headingId} className="font-medium">{title ?? t.title}</h3>
      {loading && !data ? (
        <div aria-label={t.loading} className="mt-3 space-y-2"><Skeleton className="h-14 w-full rounded-lg" /><Skeleton className="h-14 w-full rounded-lg" /></div>
      ) : null}
      {error ? (
        <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
          <p role={data ? "status" : "alert"} className={data ? "text-muted-foreground" : "text-destructive"}>{data ? t.stale : t.unavailable}</p>
          <Button variant="outline" size="sm" onClick={() => void refresh()}>{t.retry}</Button>
        </div>
      ) : null}
      {actionError ? <p role="alert" className="mt-2 text-sm text-destructive">{actionError}</p> : null}
      {data && total === 0 && !error ? (emptyState ?? <p className="mt-2 text-sm text-muted-foreground">{t.empty}</p>) : null}
      {data ? SECTIONS.filter((section) => data.sections[section].length > 0).map((section) => (
        <div key={section} className="mt-3" data-section={section}>
          <h4 className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
            {t[section]}
            <span className="rounded-full bg-muted px-2 text-xs tabular-nums" aria-label={String(data.counts[section])}>{data.counts[section]}</span>
          </h4>
          <ul className="mt-2 space-y-2">
            {data.sections[section].map((item) => (
              <WorkCard key={item.taskId} t={t} item={item} workspaceId={workspaceId} viewerMemberId={data.viewer.memberId}
                busy={pending === item.taskId} act={act} onContinueInChat={onContinueInChat} />
            ))}
          </ul>
        </div>
      )) : null}
    </section>
  );
}

function WorkCard({ t, item, workspaceId, viewerMemberId, busy, act, onContinueInChat }: {
  t: WorkT;
  item: WorkItem;
  workspaceId: string;
  viewerMemberId: string;
  busy: boolean;
  act: (item: WorkItem, work: () => Promise<void>) => Promise<void>;
  onContinueInChat?: (item: WorkItem, draft: string) => void;
}) {
  const locale = useLocale();
  const [assistants, setAssistants] = useState<WorkspaceAssistantSummary[] | null>(null);
  const [picking, setPicking] = useState(false);
  const name = (value: string | null) => value || t.unknownName;
  const executor = item.executor.kind === "assistant" ? format(t.executorAssistant, { name: name(item.executor.name) })
    : item.executor.kind === "person" ? format(t.executorPerson, { name: name(item.executor.name) })
    : t.executorUnassigned;
  const followUp = item.followUp.source === "explicit" ? format(t.followUpExplicit, { name: name(item.followUp.name) })
    : item.followUp.source === "home_owners" ? (item.followUp.viewerIsOwner ? t.followUpOwnersYou : t.followUpOwners)
    : item.followUp.source === "missing_routing" ? t.followUpMissing
    : null;
  const facts = [executor, followUp, item.due ? format(t.due, { date: new Date(item.due).toLocaleDateString(locale) }) : null].filter(Boolean);

  async function openPicker() {
    setPicking(true);
    if (assistants) return;
    try {
      setAssistants((await listWorkspaceAssistants(workspaceId)).filter((a) => a.kind !== "app"));
    } catch {
      setAssistants([]);
    }
  }

  return (
    <li className="rounded-lg border border-border p-3" data-task-id={item.taskId} data-next-action={item.nextAction}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <Link href={brainRowUrl("", workspaceId, item.taskId, "task")} className="font-medium hover:underline max-sm:inline-flex max-sm:min-h-11 max-sm:items-center">{item.title}</Link>
        <span className="text-xs text-muted-foreground">{item.reasons.map((reason) => t.reasons[reason]).join(", ")}</span>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">{facts.join(" · ")}</p>
      {item.blockerReason ? <p className="mt-1 text-sm">{item.blockerReason}</p> : null}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {item.nextAction === "assign" ? <>
          <Button size="sm" disabled={busy} onClick={() => void act(item, async () => { await claimWorkTask(workspaceId, item.taskId, { kind: "person" }); })}>{t.actions.take}</Button>
          {picking ? (
            <SearchableSelect value="" placeholder={t.actions.assistantPlaceholder} disabled={busy || assistants === null}
              items={(assistants ?? []).map((a) => ({ value: a.id, label: a.name }))}
              onValueChange={(assistantId) => void act(item, async () => { await claimWorkTask(workspaceId, item.taskId, { kind: "assistant", assistantId }); })} />
          ) : (
            <Button size="sm" variant="outline" disabled={busy} onClick={() => void openPicker()}>{t.actions.assignAssistant}</Button>
          )}
        </> : null}
        {item.nextAction === "select_follow_up" && viewerMemberId ? (
          <Button size="sm" disabled={busy} onClick={() => void act(item, async () => {
            const result = await adjustBrainRow(workspaceId, "task", item.taskId, { follow_up_member_id: viewerMemberId });
            if (!result.ok) throw new Error(result.error);
          })}>{t.actions.followUpMyself}</Button>
        ) : null}
        {item.nextAction === "answer" ? (
          <Link href={`/w/${workspaceId}/p?panel=approvals`} className="text-sm underline max-sm:inline-flex max-sm:min-h-11 max-sm:items-center">{t.actions.answer}</Link>
        ) : null}
        {onContinueInChat && item.nextAction !== "assign" ? (
          <Button size="sm" variant="outline" disabled={busy}
            onClick={() => onContinueInChat(item, format(t.draft, { title: item.title, id: item.taskId }))}>{t.actions.continueInChat}</Button>
        ) : null}
        <Link href={brainRowUrl("", workspaceId, item.taskId, "task")} className="text-sm text-muted-foreground underline max-sm:inline-flex max-sm:min-h-11 max-sm:items-center">{t.actions.openTask}</Link>
      </div>
    </li>
  );
}

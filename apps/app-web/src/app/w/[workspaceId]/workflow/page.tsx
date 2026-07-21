"use client";

/**
 * Workflow list page — `/w/[workspaceId]/workflow` (app-web).
 *
 * Ported from `apps/web/src/app/(app)/workflow/page.tsx` as the workflow
 * surface migration of the app consolidation
 * (docs/architecture/features/doc.md §5a, after KB-gaps and
 * approvals). Workspace workflows as a card grid; clicking one opens the
 * board view (steps + trigger + runs). "Create workflow" opens an inline
 * modal rather than navigating to a separate route.
 *
 * app-web is single-workspace-per-route (no chrome switcher), so the list
 * scopes to the route workspace via `activeId` from the `useWorkspaces()`
 * adapter (`[COMP:app-web/workspaces-adapter]`); card + modal links are
 * prefixed with `/w/[workspaceId]`. The page renders full-width inside the
 * `/w/[workspaceId]` layout's `<main>` (its own chrome, not the doc page
 * shell).
 *
 * Spec: docs/architecture/features/workflow.md.
 * [COMP:app-web/workflow]
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useT } from "@/lib/i18n/client";
import { format } from "@/lib/i18n";
import type { Dictionary } from "@/lib/i18n";
import { useWorkspaces } from "@/contexts/workspace-context";
import {
  deleteAllWorkflows,
  deleteWorkflow,
  listWorkflows,
  restoreWorkflow,
  type WorkflowSummary,
  type WorkflowTrigger,
} from "@/lib/api/workflow";
import { confirmDialog } from "@/components/ui/confirm-dialog";
import {
  WORKFLOW_REFRESH_EVENT,
  type WorkflowRefreshDetail,
} from "@/lib/workflow-events";
import { CreateWorkflowModal } from "@/components/workflow/create-workflow-modal";
import { cn } from "@/lib/utils";

export default function WorkflowPage() {
  const t = useT();
  const { activeId } = useWorkspaces();
  const [workflows, setWorkflows] = useState<WorkflowSummary[] | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [archivedOpen, setArchivedOpen] = useState(false);
  const [restoringId, setRestoringId] = useState<string | null>(null);
  const [bulkMsg, setBulkMsg] = useState<
    { kind: "done"; count: number } | { kind: "error" } | null
  >(null);
  const [bulkWorking, setBulkWorking] = useState(false);

  const reload = useCallback(async () => {
    if (!activeId) return;
    // `includeArchived` so the collapsed Archived section can render;
    // the grid itself only shows live (active + stale) workflows.
    const list = await listWorkflows(activeId, { includeArchived: true });
    setWorkflows(list);
  }, [activeId]);

  useEffect(() => {
    if (!activeId) return;
    let cancelled = false;
    setWorkflows(null);
    void (async () => {
      const list = await listWorkflows(activeId, { includeArchived: true });
      if (!cancelled) setWorkflows(list);
    })();
    return () => {
      cancelled = true;
    };
  }, [activeId]);

  // Silent re-fetch on the workflow event bus — same-tab mutations AND the
  // shell's server leg (assistant chat, workers, another tab). No "…"
  // flash: the current grid stays put until the fresh list swaps in.
  useEffect(() => {
    if (!activeId) return;
    const handler = (ev: Event) => {
      const detail = (ev as CustomEvent<WorkflowRefreshDetail>).detail;
      if (detail?.workspaceId && detail.workspaceId !== activeId) return;
      void reload();
    };
    window.addEventListener(WORKFLOW_REFRESH_EVENT, handler);
    return () => window.removeEventListener(WORKFLOW_REFRESH_EVENT, handler);
  }, [activeId, reload]);

  const live = (workflows ?? []).filter((w) => w.lifecycleState !== "archived");
  const archived = (workflows ?? []).filter((w) => w.lifecycleState === "archived");

  const onRestore = async (workflowId: string) => {
    setRestoringId(workflowId);
    const ok = await restoreWorkflow(workflowId);
    setRestoringId(null);
    if (ok) void reload();
  };

  // Per-card delete — the same teardown the builder's Delete button runs,
  // without making the user open each workflow first.
  const onDelete = async (workflowId: string) => {
    const ok = await confirmDialog({
      title: t.workflowPage.builder.deleteConfirmTitle,
      description: t.workflowPage.builder.deleteConfirmBody,
      confirmLabel: t.workflowPage.builder.deleteConfirmAction,
      variant: "destructive",
    });
    if (!ok) return;
    if (await deleteWorkflow(workflowId)) void reload();
  };

  const onDeleteAll = async () => {
    if (!activeId || bulkWorking) return;
    const count = (workflows ?? []).length;
    const ok = await confirmDialog({
      title: t.workflowPage.list.deleteAllConfirmTitle,
      description: format(t.workflowPage.list.deleteAllConfirmBody, {
        count: String(count),
      }),
      confirmLabel: t.workflowPage.list.deleteAllConfirmAction,
      variant: "destructive",
    });
    if (!ok) return;
    setBulkWorking(true);
    setBulkMsg(null);
    const result = await deleteAllWorkflows(activeId);
    setBulkWorking(false);
    setBulkMsg(result.ok ? { kind: "done", count: result.deleted } : { kind: "error" });
    if (result.ok) void reload();
  };

  return (
    <div className="h-full w-full px-8 py-6 flex flex-col gap-5 overflow-y-auto">
      {/* max-md:pl-6 clears the chrome's fixed mobile hamburger (left-2
          top-2, md:hidden) — without it the title sits underneath. */}
      <header className="flex items-start justify-between gap-3 max-md:pl-6">
        <div className="flex flex-col gap-1">
          <h1 className="text-lg font-semibold">{t.workflowPage.title}</h1>
          <p className="text-sm text-muted-foreground">
            {t.workflowPage.description}
          </p>
        </div>
        <div className="shrink-0 flex items-center gap-3">
          {(workflows?.length ?? 0) > 0 && (
            <button
              type="button"
              onClick={() => void onDeleteAll()}
              disabled={bulkWorking}
              className="text-sm font-medium text-muted-foreground hover:text-red-400 transition-colors disabled:opacity-50"
            >
              {bulkWorking
                ? t.workflowPage.list.deleteAllWorking
                : t.workflowPage.list.deleteAll}
            </button>
          )}
          <button
            type="button"
            onClick={() => setCreateOpen(true)}
            className={cn(
              "inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium",
              "bg-primary text-primary-foreground hover:opacity-90 transition-opacity",
            )}
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.25"
              strokeLinecap="round"
              aria-hidden
            >
              <path d="M12 5v14M5 12h14" />
            </svg>
            {t.workflowPage.list.createButton}
          </button>
        </div>
      </header>

      {bulkMsg && (
        <p
          className={cn(
            "text-xs max-md:pl-6",
            bulkMsg.kind === "error" ? "text-red-400" : "text-muted-foreground",
          )}
        >
          {bulkMsg.kind === "error"
            ? t.workflowPage.list.deleteAllFailed
            : format(t.workflowPage.list.deleteAllDone, {
                count: String(bulkMsg.count),
              })}
        </p>
      )}

      {workflows === null ? (
        <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground">
          …
        </div>
      ) : live.length === 0 && archived.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center text-center gap-3 border border-border rounded-md bg-card/50">
          <svg
            width="40"
            height="40"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
            className="text-muted-foreground/40"
          >
            <circle cx="6" cy="6" r="2" />
            <circle cx="18" cy="6" r="2" />
            <circle cx="6" cy="18" r="2" />
            <circle cx="18" cy="18" r="2" />
            <path d="M8 6h8M6 8v8M18 8v8M8 18h8" />
          </svg>
          <div className="font-medium">{t.workflowPage.list.emptyTitle}</div>
          <p className="text-sm text-muted-foreground max-w-md">
            {t.workflowPage.list.emptyBody}
          </p>
          <button
            type="button"
            onClick={() => setCreateOpen(true)}
            className="mt-2 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium bg-primary text-primary-foreground hover:opacity-90"
          >
            {t.workflowPage.list.emptyCta}
          </button>
        </div>
      ) : (
        <div className="flex-1 min-h-0 overflow-y-auto">
          {/* pb-28 keeps the last card row clear of the fixed chat dock the
              chrome floats over this surface's bottom-right. */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 pb-6">
            {live.map((w) => (
              <WorkflowCard
                key={w.id}
                workflow={w}
                workspaceId={activeId ?? ""}
                t={t}
                onDelete={() => void onDelete(w.id)}
              />
            ))}
          </div>

          {archived.length > 0 && (
            <section className="pb-28">
              <button
                type="button"
                onClick={() => setArchivedOpen((v) => !v)}
                className="inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors"
                aria-expanded={archivedOpen}
              >
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.25"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden
                  className={cn("transition-transform", archivedOpen && "rotate-90")}
                >
                  <path d="m9 6 6 6-6 6" />
                </svg>
                {format(t.workflowPage.lifecycle.archivedSection, {
                  count: String(archived.length),
                })}
              </button>
              {archivedOpen && (
                <div className="mt-3 flex flex-col gap-2">
                  <p className="text-xs text-muted-foreground">
                    {t.workflowPage.lifecycle.archivedHint}
                  </p>
                  {archived.map((w) => (
                    <div
                      key={w.id}
                      className="flex items-center gap-3 rounded-lg border border-border bg-card/50 px-3 py-2"
                    >
                      <div className="min-w-0 flex-1">
                        <Link
                          href={`/w/${activeId ?? ""}/workflow/${encodeURIComponent(w.id)}`}
                          className="text-sm font-medium truncate hover:underline"
                        >
                          {w.name}
                        </Link>
                        {w.lifecycleReason ? (
                          <p className="text-xs text-muted-foreground truncate">
                            {w.lifecycleReason}
                          </p>
                        ) : null}
                      </div>
                      <button
                        type="button"
                        onClick={() => void onRestore(w.id)}
                        disabled={restoringId === w.id}
                        className="shrink-0 px-2.5 py-1 rounded-md border border-border text-xs font-medium hover:bg-muted disabled:opacity-50"
                      >
                        {restoringId === w.id
                          ? t.workflowPage.lifecycle.restoring
                          : t.workflowPage.lifecycle.restore}
                      </button>
                      <button
                        type="button"
                        onClick={() => void onDelete(w.id)}
                        aria-label={t.workflowPage.builder.deleteBtn}
                        className="shrink-0 px-2.5 py-1 rounded-md border border-red-400/30 text-xs font-medium text-red-400 hover:bg-red-400/10"
                      >
                        {t.workflowPage.builder.deleteConfirmAction}
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </section>
          )}
        </div>
      )}

      {createOpen && (
        <CreateWorkflowModal onClose={() => setCreateOpen(false)} />
      )}
    </div>
  );
}

function WorkflowCard({
  workflow,
  workspaceId,
  t,
  onDelete,
}: {
  workflow: WorkflowSummary;
  workspaceId: string;
  t: Dictionary;
  onDelete: () => void;
}) {
  const triggerKind = workflow.trigger.kind;
  return (
    <Link
      href={`/w/${workspaceId}/workflow/${encodeURIComponent(workflow.id)}`}
      className={cn(
        "group flex flex-col gap-3 rounded-xl border border-border bg-card p-4",
        "transition hover:border-primary/50 hover:shadow-md",
        !workflow.enabled && "opacity-75",
      )}
    >
      <div className="flex items-start gap-2.5">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.85"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            <circle cx="6" cy="6" r="2" />
            <circle cx="18" cy="18" r="2" />
            <path d="M8 6h8a4 4 0 0 1 4 4v4" />
            <path d="M16 18H8a4 4 0 0 1-4-4v-4" />
          </svg>
        </span>
        <div className="min-w-0 flex-1">
          <div className="font-medium text-sm truncate">{workflow.name}</div>
        </div>
        <button
          type="button"
          onClick={(e) => {
            // The card is a Link; keep the delete tap from navigating.
            e.preventDefault();
            e.stopPropagation();
            onDelete();
          }}
          aria-label={t.workflowPage.builder.deleteBtn}
          title={t.workflowPage.builder.deleteBtn}
          className="shrink-0 rounded-md p-1 text-muted-foreground/60 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 hover:text-red-400 hover:bg-red-400/10 transition"
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.85"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            <path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
            <path d="M10 11v6M14 11v6" />
          </svg>
        </button>
        {workflow.lifecycleState === "stale" && (
          <span
            title={workflow.lifecycleReason ?? undefined}
            className="shrink-0 text-[10px] px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-700 dark:text-amber-400 uppercase tracking-wide"
          >
            {t.workflowPage.lifecycle.staleBadge}
          </span>
        )}
        {!workflow.enabled && (
          <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground uppercase tracking-wide">
            {t.workflowPage.builder.disabledLabel}
          </span>
        )}
      </div>

      <p className="text-xs text-muted-foreground line-clamp-2 min-h-[2rem]">
        {workflow.description || ""}
      </p>

      <div className="flex items-center gap-2 flex-wrap text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1 rounded-md bg-muted px-1.5 py-0.5">
          <TriggerIcon kind={triggerKind} />
          {t.workflowPage.triggerShort[triggerKind]}
        </span>
        <span>
          {format(t.workflowPage.list.card.stepCount, {
            count: String(workflow.stepCount),
            s: workflow.stepCount === 1 ? "" : "s",
          })}
        </span>
        <span className="ml-auto">
          {format(t.workflowPage.list.card.updated, {
            date: new Date(workflow.updatedAt).toLocaleDateString(),
          })}
        </span>
      </div>
    </Link>
  );
}

function TriggerIcon({ kind }: { kind: WorkflowTrigger["kind"] }) {
  const common = {
    width: 11,
    height: 11,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 2.25,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
  };
  if (kind === "schedule") {
    return (
      <svg {...common}>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7v5l3 2" />
      </svg>
    );
  }
  if (kind === "webhook") {
    return (
      <svg {...common}>
        <path d="M9 17H6a4 4 0 0 1 0-8M15 7h3a4 4 0 0 1 0 8M8 12h8" />
      </svg>
    );
  }
  // manual
  return (
    <svg {...common}>
      <path d="M8 5v14l11-7L8 5Z" />
    </svg>
  );
}

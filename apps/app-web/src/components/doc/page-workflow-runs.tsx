"use client";

/**
 * Page-header workflow-runs chip (migration 282).
 *
 * The back-reference for the page → workflow event trigger. When a doc page's
 * lifecycle (created / updated / moved) fires an `event`-trigger workflow, the
 * run is stamped with the CHANGED page (`workflow_runs.trigger_page_id`). This
 * chip surfaces those runs ON the page itself: their live status, the outcome
 * summary once finished, and links to the run-detail page + the workflow board.
 *
 * It is chrome, never a doc-model block — it never touches the Yjs document and
 * never blocks page render. The initial fetch runs in an effect (post-paint)
 * and the chip renders nothing until it resolves with at least one run, so a
 * page that triggered nothing shows no UI. While any run is still in flight it
 * polls every 5s (the same cadence as the run-detail page), since those states
 * change server-side without a user action.
 *
 * [COMP:app-web/page-workflow-runs]
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Workflow } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useT, useLocale, format } from "@/lib/i18n/client";
import {
  WORKFLOW_REFRESH_EVENT,
  type WorkflowRefreshDetail,
} from "@/lib/workflow-events";
import { cn } from "@/lib/utils";
import {
  listPageWorkflowRuns,
  type PageWorkflowRunSummary,
} from "@/lib/api/workflow";

const NON_TERMINAL: ReadonlySet<PageWorkflowRunSummary["status"]> = new Set([
  "pending",
  "running",
  "awaiting_wait",
  "awaiting_input",
]);

function isInFlight(runs: PageWorkflowRunSummary[]): boolean {
  return runs.some((r) => NON_TERMINAL.has(r.status));
}

export function PageWorkflowRuns({
  pageId,
  workspaceId,
}: {
  pageId: string;
  workspaceId: string;
}) {
  const dict = useT();
  const t = dict.docPage.workflowRuns;
  const statusLabel = dict.workflowPage.builder.runStatus;
  const locale = useLocale();
  const [runs, setRuns] = useState<PageWorkflowRunSummary[]>([]);

  const load = useCallback(async () => {
    try {
      setRuns(await listPageWorkflowRuns(pageId));
    } catch {
      // Best-effort chrome: a fetch failure leaves the chip hidden rather than
      // surfacing an error on the page.
    }
  }, [pageId]);

  // Initial fetch after paint — never blocks the page render.
  useEffect(() => {
    void load();
  }, [load]);

  // Poll while any run is still in flight; stop once all are terminal.
  useEffect(() => {
    if (!isInFlight(runs)) return;
    const tid = window.setInterval(() => {
      void load();
    }, 5000);
    return () => window.clearInterval(tid);
  }, [runs, load]);

  // Server leg (realtime-sync): a `workflow_run` signal re-fetches even when
  // no run is in flight — the in-flight poll alone can never DISCOVER a new
  // run started by a schedule / webhook / assistant after mount.
  useEffect(() => {
    const handler = (ev: Event) => {
      const detail = (ev as CustomEvent<WorkflowRefreshDetail>).detail;
      if (detail?.workspaceId && detail.workspaceId !== workspaceId) return;
      if (detail?.primitive === "workflow") return;
      void load();
    };
    window.addEventListener(WORKFLOW_REFRESH_EVENT, handler);
    return () => window.removeEventListener(WORKFLOW_REFRESH_EVENT, handler);
  }, [workspaceId, load]);

  if (runs.length === 0) return null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <button
            type="button"
            aria-label={t.badgeAria}
            title={t.badgeAria}
            className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground aria-expanded:bg-muted"
          >
            <Workflow className="size-4" aria-hidden />
            <span className="hidden sm:inline">{t.badge}</span>
            <span className="ml-0.5 inline-flex min-w-4 items-center justify-center rounded-full bg-muted px-1 text-[0.625rem] font-semibold leading-4 text-muted-foreground">
              {runs.length}
            </span>
          </button>
        }
      />
      <DropdownMenuContent className="w-80 max-w-[90vw]">
        <div className="px-2.5 py-2">
          <p className="text-sm font-semibold text-foreground">{t.title}</p>
          <p className="mt-1 text-xs text-muted-foreground">{t.hint}</p>
        </div>
        <DropdownMenuSeparator />
        <WorkflowRunsList
          runs={runs}
          workspaceId={workspaceId}
          t={t}
          statusLabel={statusLabel}
          locale={locale}
        />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

type WorkflowRunsCopy = {
  started: string;
  viewRun: string;
};

/**
 * Pure presentational list of the runs a page triggered. Exported so it can be
 * rendered (and asserted) directly, without driving the floating dropdown.
 */
export function WorkflowRunsList({
  runs,
  workspaceId,
  t,
  statusLabel,
  locale,
}: {
  runs: PageWorkflowRunSummary[];
  workspaceId: string;
  t: WorkflowRunsCopy;
  statusLabel: Record<PageWorkflowRunSummary["status"], string>;
  locale: string;
}) {
  function fmtDate(iso: string): string {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    try {
      return d.toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" });
    } catch {
      return d.toLocaleString();
    }
  }

  return (
    <ul className="max-h-80 overflow-y-auto py-1">
      {runs.map((run) => (
        <li key={run.runId} className="px-2.5 py-2">
          <div className="flex items-start justify-between gap-2">
            <Link
              href={`/w/${workspaceId}/workflow/${run.workflowId}`}
              className="min-w-0 truncate text-sm font-medium text-foreground hover:underline"
            >
              {run.workflowName}
            </Link>
            <RunStatusPill status={run.status} label={statusLabel[run.status]} />
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {format(t.started, { when: fmtDate(run.startedAt) })}
          </p>
          {run.outcomeSummary && (
            <p className="mt-1 line-clamp-3 text-xs text-muted-foreground/80">
              {run.outcomeSummary}
            </p>
          )}
          <Link
            href={`/w/${workspaceId}/workflow/${run.workflowId}/runs/${run.runId}`}
            className="mt-1 inline-block text-xs font-medium text-primary hover:underline"
          >
            {t.viewRun}
          </Link>
        </li>
      ))}
    </ul>
  );
}

function RunStatusPill({
  status,
  label,
}: {
  status: PageWorkflowRunSummary["status"];
  label: string;
}) {
  return (
    <span
      className={cn(
        "shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide",
        status === "completed" &&
          "bg-green-500/10 text-green-700 dark:text-green-400",
        (status === "failed" || status === "timeout") &&
          "bg-red-500/10 text-red-700 dark:text-red-400",
        (status === "awaiting_wait" || status === "awaiting_input") &&
          "bg-amber-500/10 text-amber-700 dark:text-amber-400",
        (status === "pending" || status === "running") &&
          "bg-muted text-muted-foreground",
      )}
    >
      {label}
    </span>
  );
}

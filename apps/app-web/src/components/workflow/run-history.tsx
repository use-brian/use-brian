"use client";

/**
 * Recent runs of a workflow (app-web) — compact table with clickable
 * rows that drill into the run-detail page for a step-by-step trail.
 * Deliberately dense (small rows, capped height with internal scroll):
 * since the detail page went single-mode the history is ALWAYS on screen,
 * sharing it with the board and an open step editor.
 *
 * Ported from `apps/web/src/components/workflow/run-history.tsx` (app
 * consolidation §5a). app-web is workspace-scoped at `/w/[workspaceId]/…`,
 * so the row links are prefixed with the route workspace via the
 * `workspaceId` prop the detail page threads in.
 *
 * Spec: docs/architecture/features/workflow.md → Run history drill-down.
 * [COMP:app-web/workflow]
 */

import Link from "next/link";
import { useT } from "@/lib/i18n/client";
import type { Dictionary } from "@/lib/i18n";
import type { WorkflowRunSummary } from "@/lib/api/workflow";
import { elapsedLabel, isTerminalRunStatus } from "@/lib/workflow-live-run";
import { cn } from "@/lib/utils";

type Props = {
  workspaceId: string;
  workflowId: string;
  runs: WorkflowRunSummary[] | null;
};

export function RunHistory({ workspaceId, workflowId, runs }: Props) {
  const t = useT();
  return (
    <section className="border border-border rounded-md bg-card overflow-hidden">
      <div className="px-3 py-1.5 border-b border-border text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {t.workflowPage.builder.runsHeading}
      </div>
      {runs === null ? (
        <div className="px-3 py-2 text-xs text-muted-foreground">…</div>
      ) : runs.length === 0 ? (
        <div className="px-3 py-2 text-xs text-muted-foreground">
          {t.workflowPage.builder.noRunsYet}
        </div>
      ) : (
        <ul className="divide-y divide-border max-h-64 overflow-y-auto">
          {runs.map((r) => (
            <li key={r.id}>
              <Link
                href={`/w/${workspaceId}/workflow/${workflowId}/runs/${r.id}`}
                className="px-3 py-1.5 flex items-center gap-2.5 text-xs hover:bg-muted/40 transition-colors"
                aria-label={t.workflowPage.builder.runsOpenRun}
              >
                <StatusPill status={r.status} t={t} />
                <div className="flex-1 min-w-0">
                  <span className="text-xs text-muted-foreground">
                    {formatStarted(r.startedAt)} ·{" "}
                    {isTerminalRunStatus(r.status)
                      ? durationLabel(r.startedAt, r.finishedAt)
                      : // In-flight: elapsed so far, refreshed by the live poll.
                        elapsedLabel(r.startedAt, new Date())}
                  </span>
                  {r.error && (
                    <div className="text-xs text-red-600 dark:text-red-400 truncate">
                      {String(
                        (r.error as { message?: unknown }).message ?? "error",
                      )}
                    </div>
                  )}
                </div>
                <code className="text-[10px] text-muted-foreground/70 font-mono truncate max-w-[10rem]">
                  {r.id.slice(0, 8)}
                </code>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function StatusPill({
  status,
  t,
}: {
  status: WorkflowRunSummary["status"];
  t: Dictionary;
}) {
  const label = t.workflowPage.builder.runStatus[status];
  const inFlight = status === "pending" || status === "running";
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded uppercase tracking-wide font-medium",
        status === "completed" &&
          "bg-green-500/10 text-green-700 dark:text-green-400",
        status === "failed" && "bg-red-500/10 text-red-700 dark:text-red-400",
        status === "timeout" && "bg-red-500/10 text-red-700 dark:text-red-400",
        (status === "awaiting_wait" || status === "awaiting_input") &&
          "bg-amber-500/10 text-amber-700 dark:text-amber-400",
        inFlight && "bg-primary/10 text-primary",
      )}
    >
      {inFlight && (
        <svg
          width="9"
          height="9"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="3"
          strokeLinecap="round"
          className="animate-spin"
          aria-hidden
        >
          <path d="M21 12a9 9 0 1 1-6.2-8.56" />
        </svg>
      )}
      {label}
    </span>
  );
}

function formatStarted(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString();
}

function durationLabel(startedIso: string, finishedIso: string | null): string {
  if (!finishedIso) return "-";
  const ms = new Date(finishedIso).getTime() - new Date(startedIso).getTime();
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}min`;
}

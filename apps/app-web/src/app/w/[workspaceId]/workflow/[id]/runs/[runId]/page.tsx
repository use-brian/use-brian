"use client";

/**
 * Workflow run-detail page — `/w/[workspaceId]/workflow/[id]/runs/[runId]`
 * (app-web).
 *
 * Ported from `apps/web/src/app/(app)/workflow/[id]/runs/[runId]/page.tsx`
 * (app consolidation §5a). Drill-down into a single run: the run header
 * (status, duration, trigger kind, run id) plus a chronological step trail
 * with per-step status, input, output, error, and step-type-specific
 * affordances (branch resolution, wait deadline, tool name, approval-pause
 * indicator). Provides a stub "Re-run from here" action — the backend
 * doesn't yet support restart-from-step (tracked as a follow-up in
 * workflow.md), so the button explains why it's disabled.
 *
 * The back link is prefixed with the route `/w/[workspaceId]`. The page
 * renders full-width inside the `/w/[workspaceId]` layout's `<main>` (its own
 * chrome, not the doc page shell).
 *
 * Spec: docs/architecture/features/workflow.md → Run history drill-down.
 * [COMP:app-web/workflow]
 */

import { use, useCallback, useEffect, useState } from "react";
import { BackButton } from "@/components/ui/back-button";
import { useT } from "@/lib/i18n/client";
import { format as fmt } from "@/lib/i18n";
import type { Dictionary } from "@/lib/i18n";
import {
  getWorkflowFull,
  getWorkflowRun,
  type WorkflowFull,
  type WorkflowRunDetail,
  type WorkflowStepRunDetail,
} from "@/lib/api/workflow";
import { cn } from "@/lib/utils";

export default function WorkflowRunDetailPage({
  params,
}: {
  params: Promise<{ workspaceId: string; id: string; runId: string }>;
}) {
  const t = useT();
  const { workspaceId, id, runId } = use(params);
  const detailHref = `/w/${workspaceId}/workflow/${id}`;
  const [run, setRun] = useState<WorkflowRunDetail | null | undefined>(
    undefined,
  );
  const [workflow, setWorkflow] = useState<WorkflowFull | null | undefined>(
    undefined,
  );

  const load = useCallback(async () => {
    const [r, wf] = await Promise.all([
      getWorkflowRun(id, runId),
      getWorkflowFull(id),
    ]);
    setRun(r);
    setWorkflow(wf);
  }, [id, runId]);

  useEffect(() => {
    void load();
  }, [load]);

  // Auto-refresh while the run is still in flight — these states change
  // server-side without user action, so polling every 5s keeps the page
  // honest without overwhelming the API.
  useEffect(() => {
    if (!run) return;
    if (
      run.status !== "pending" &&
      run.status !== "running" &&
      run.status !== "awaiting_wait" &&
      run.status !== "awaiting_input"
    ) {
      return;
    }
    const tid = window.setInterval(() => {
      void load();
    }, 5000);
    return () => window.clearInterval(tid);
  }, [run, load]);

  if (run === undefined || workflow === undefined) {
    return (
      <div className="w-full px-6 py-10 text-sm text-muted-foreground">
        {t.workflowPage.builder.runDetail.loading}
      </div>
    );
  }

  if (run === null || workflow === null) {
    return (
      <div className="w-full px-6 py-20 text-center flex flex-col gap-3">
        <div className="font-medium">
          {t.workflowPage.builder.runDetail.notFound}
        </div>
        <BackButton
          href={detailHref}
          label={t.workflowPage.builder.runDetail.backLink}
          className="mx-auto"
        />
      </div>
    );
  }

  const durationMs = run.finishedAt
    ? new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime()
    : Date.now() - new Date(run.startedAt).getTime();

  return (
    // `[&>*]:shrink-0` stops the flex column from squeezing a child (e.g. an
    // overflow-auto output block) to zero height when the page overflows - the
    // page scrolls instead. pb-28 keeps the footer clear of the fixed chat dock.
    // (Same rationale as the workflow detail page.)
    <div className="w-full h-full overflow-y-auto px-6 pt-6 pb-28 flex flex-col gap-6 [&>*]:shrink-0">
      <BackButton
        href={detailHref}
        label={t.workflowPage.builder.runDetail.backLink}
      />

      {/* Header */}
      <header className="flex flex-col gap-3">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div className="flex flex-col gap-1 min-w-0">
            <div className="text-xs uppercase tracking-wide text-muted-foreground">
              {t.workflowPage.builder.runDetail.headingRun} ·{" "}
              <code className="font-mono">{run.id.slice(0, 8)}</code>
            </div>
            <h1 className="text-xl font-semibold">{workflow.name}</h1>
            {workflow.description && (
              <p className="text-sm text-muted-foreground">
                {workflow.description}
              </p>
            )}
          </div>
          <StatusBadge status={run.status} t={t} />
        </div>
        <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1 text-xs">
          <div className="flex gap-2">
            <dt className="text-muted-foreground">
              {fmt(t.workflowPage.builder.runDetail.startedAt, {
                when: formatDate(run.startedAt),
              })}
            </dt>
          </div>
          <div className="flex gap-2">
            <dt className="text-muted-foreground">
              {fmt(t.workflowPage.builder.runDetail.finishedAt, {
                when: run.finishedAt ? formatDate(run.finishedAt) : "-",
              })}
            </dt>
          </div>
          <div className="flex gap-2">
            <dt className="text-muted-foreground">
              {fmt(t.workflowPage.builder.runDetail.durationLabel, {
                value: formatDuration(durationMs),
              })}
            </dt>
          </div>
          <div className="flex gap-2">
            <dt className="text-muted-foreground">
              {fmt(t.workflowPage.builder.runDetail.triggerKindLabel, {
                kind: run.triggerKind,
              })}
            </dt>
          </div>
        </dl>
        {run.error && (
          <div className="text-sm text-red-600 dark:text-red-400 bg-red-500/5 border border-red-500/30 rounded-md px-3 py-2">
            {String(
              (run.error as { message?: unknown }).message ??
                JSON.stringify(run.error),
            )}
          </div>
        )}
      </header>

      {/* Step trail */}
      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold">
          {t.workflowPage.builder.runDetail.stepTrailHeading}
        </h2>
        {run.steps.length === 0 ? (
          <div className="text-sm text-muted-foreground">
            {t.workflowPage.builder.runDetail.stepTrailEmpty}
          </div>
        ) : (
          <ol className="flex flex-col gap-3">
            {run.steps.map((step, i) => (
              <StepRow
                key={step.id}
                index={i}
                step={step}
                runStatus={run.status}
                workflowId={id}
                runId={runId}
              />
            ))}
          </ol>
        )}
      </section>

      {/* Run input + vars */}
      <section className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <JsonCard
          heading={t.workflowPage.builder.runDetail.runInputHeading}
          data={run.input}
          emptyLabel={t.workflowPage.builder.runDetail.sectionEmpty}
        />
        <JsonCard
          heading={t.workflowPage.builder.runDetail.runVarsHeading}
          data={run.vars}
          emptyLabel={t.workflowPage.builder.runDetail.sectionEmpty}
        />
      </section>
    </div>
  );
}

// ── Step row ──────────────────────────────────────────────────────────────

function StepRow({
  index,
  step,
  runStatus,
  workflowId: _workflowId,
  runId: _runId,
}: {
  index: number;
  step: WorkflowStepRunDetail;
  runStatus: WorkflowRunDetail["status"];
  workflowId: string;
  runId: string;
}) {
  const t = useT();
  const durationMs =
    step.finishedAt
      ? new Date(step.finishedAt).getTime() - new Date(step.startedAt).getTime()
      : Date.now() - new Date(step.startedAt).getTime();
  const isActiveStep = step.status === "running" || step.status === "pending";
  const isWaiting =
    isActiveStep && step.type === "wait" && runStatus === "awaiting_wait";
  const isAwaitingApproval =
    isActiveStep && runStatus === "awaiting_input" && step.type === "tool_call";

  return (
    <li
      className={cn(
        "border rounded-md bg-card p-3 flex flex-col gap-2",
        step.status === "failed"
          ? "border-red-500/40"
          : step.status === "completed"
            ? "border-border"
            : "border-amber-500/40",
      )}
    >
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground font-mono">
          #{index + 1}
        </span>
        <span className="text-sm font-medium">{step.stepId}</span>
        <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
          {stepTypeLabel(step.type, t)}
        </span>
        <StepStatusPill status={step.status} t={t} />
        <span className="ml-auto text-xs text-muted-foreground font-mono">
          {fmt(t.workflowPage.builder.runDetail.stepDurationLabel, {
            value: formatDuration(durationMs),
          })}
        </span>
      </div>

      {/* Step-type-specific affordances */}
      {step.type === "tool_call" && toolNameOf(step.input) && (
        <div className="text-xs text-muted-foreground">
          <span className="uppercase tracking-wide mr-2">
            {t.workflowPage.builder.runDetail.stepToolNameLabel}
          </span>
          <code className="font-mono">{toolNameOf(step.input)}</code>
        </div>
      )}
      {step.type === "branch" && step.status === "completed" && (
        <div className="text-xs text-muted-foreground italic">
          {branchResolved(step.output)
            ? t.workflowPage.builder.runDetail.stepBranchTrue
            : t.workflowPage.builder.runDetail.stepBranchFalse}
        </div>
      )}
      {isWaiting && (
        <div className="text-xs text-amber-700 dark:text-amber-400">
          {fmt(t.workflowPage.builder.runDetail.stepWaitActive, {
            when: waitDeadline(step.input),
          })}
        </div>
      )}
      {isAwaitingApproval && (
        <div className="text-xs text-amber-700 dark:text-amber-400">
          {t.workflowPage.builder.runDetail.stepApprovalActive}
        </div>
      )}

      {/* Input / output / error — collapsed by default to keep the trail
          scannable; users open them as needed. */}
      <details className="text-xs">
        <summary className="cursor-pointer text-muted-foreground">
          {t.workflowPage.builder.runDetail.stepInputLabel}
        </summary>
        <JsonBlock data={step.input} />
      </details>
      {step.output !== null && step.status === "completed" && (
        <details className="text-xs">
          <summary className="cursor-pointer text-muted-foreground">
            {t.workflowPage.builder.runDetail.stepOutputLabel}
          </summary>
          <JsonBlock data={step.output} />
        </details>
      )}
      {step.error && (
        <div className="flex flex-col gap-1">
          <div className="text-xs font-medium text-red-600 dark:text-red-400">
            {t.workflowPage.builder.runDetail.stepErrorLabel}
          </div>
          <JsonBlock data={step.error} tone="error" />
        </div>
      )}

      {/* Re-run from here — disabled with explanation. The backend
          doesn't yet accept `restartFromStepId`; this is the placeholder
          that ships the affordance the spec asked for, gated so users
          aren't surprised when it doesn't work. */}
      {step.status === "failed" && (
        <button
          type="button"
          disabled
          title={t.workflowPage.builder.runDetail.rerunFromStepUnavailable}
          className="text-xs px-2 py-1 rounded border border-border self-start opacity-60 cursor-not-allowed"
        >
          {t.workflowPage.builder.runDetail.rerunFromStepBtn}
        </button>
      )}
    </li>
  );
}

function stepTypeLabel(
  type: WorkflowStepRunDetail["type"],
  t: Dictionary,
): string {
  switch (type) {
    case "assistant_call":
      return t.workflowPage.builder.stepTypeAssistantCall;
    case "tool_call":
      return t.workflowPage.builder.stepTypeToolCall;
    case "wait":
      return t.workflowPage.builder.stepTypeWait;
    case "branch":
      return t.workflowPage.builder.stepTypeBranch;
  }
}

function StatusBadge({
  status,
  t,
}: {
  status: WorkflowRunDetail["status"];
  t: Dictionary;
}) {
  const label = t.workflowPage.builder.runStatus[status];
  return (
    <span
      className={cn(
        "text-xs px-2 py-1 rounded uppercase tracking-wide font-medium",
        status === "completed" &&
          "bg-green-500/10 text-green-700 dark:text-green-400",
        status === "failed" && "bg-red-500/10 text-red-700 dark:text-red-400",
        status === "timeout" && "bg-red-500/10 text-red-700 dark:text-red-400",
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

function StepStatusPill({
  status,
  t,
}: {
  status: WorkflowStepRunDetail["status"];
  t: Dictionary;
}) {
  const label = stepStatusLabel(status, t);
  return (
    <span
      className={cn(
        "text-[10px] px-1.5 py-0.5 rounded uppercase tracking-wide font-medium",
        status === "completed" &&
          "bg-green-500/10 text-green-700 dark:text-green-400",
        status === "failed" && "bg-red-500/10 text-red-700 dark:text-red-400",
        status === "running" &&
          "bg-amber-500/10 text-amber-700 dark:text-amber-400",
        (status === "pending" || status === "skipped") &&
          "bg-muted text-muted-foreground",
      )}
    >
      {label}
    </span>
  );
}

function stepStatusLabel(
  status: WorkflowStepRunDetail["status"],
  t: Dictionary,
): string {
  // Re-use the run-status labels we already have rather than duplicate
  // per-step copy. They line up 1:1 for completed / failed; the others
  // map to their nearest equivalent.
  const map: Record<WorkflowStepRunDetail["status"], string> = {
    pending: t.workflowPage.builder.runStatus.pending,
    running: t.workflowPage.builder.runStatus.running,
    completed: t.workflowPage.builder.runStatus.completed,
    failed: t.workflowPage.builder.runStatus.failed,
    // No run-level analog for "skipped"; reuse the muted "Pending" tone.
    skipped: t.workflowPage.builder.runStatus.pending,
  };
  return map[status];
}

// ── JSON helpers ──────────────────────────────────────────────────────────

function JsonCard({
  heading,
  data,
  emptyLabel,
}: {
  heading: string;
  data: Record<string, unknown>;
  emptyLabel: string;
}) {
  const empty = !data || Object.keys(data).length === 0;
  return (
    <div className="border border-border rounded-md bg-card p-3 flex flex-col gap-2">
      <div className="text-xs uppercase tracking-wide text-muted-foreground">
        {heading}
      </div>
      {empty ? (
        <div className="text-xs text-muted-foreground">{emptyLabel}</div>
      ) : (
        <JsonBlock data={data} />
      )}
    </div>
  );
}

function JsonBlock({
  data,
  tone,
}: {
  data: unknown;
  tone?: "error";
}) {
  let pretty = "";
  try {
    pretty = JSON.stringify(data, null, 2);
  } catch {
    pretty = String(data);
  }
  return (
    <pre
      className={cn(
        "px-3 py-2 bg-background border rounded-md text-[11px] font-mono whitespace-pre-wrap break-all max-h-80 overflow-auto",
        tone === "error"
          ? "border-red-500/30 text-red-700 dark:text-red-400"
          : "border-border",
      )}
    >
      {pretty}
    </pre>
  );
}

// ── Formatting + safe destructuring ──────────────────────────────────────

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString();
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "-";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3_600_000) return `${(ms / 60_000).toFixed(1)}min`;
  return `${(ms / 3_600_000).toFixed(1)}h`;
}

function toolNameOf(input: Record<string, unknown>): string | null {
  const v = input?.toolName;
  return typeof v === "string" ? v : null;
}

function branchResolved(output: unknown): boolean {
  // The branch step's output is the resolved nextStepId or a boolean
  // result; we surface the truthy/falsy outcome regardless of shape.
  if (typeof output === "boolean") return output;
  if (output && typeof output === "object") {
    const r = (output as { result?: unknown }).result;
    if (typeof r === "boolean") return r;
  }
  return false;
}

function waitDeadline(input: Record<string, unknown>): string {
  const at = (input?.at ?? null) as { datetime?: string } | null;
  if (at?.datetime) return at.datetime;
  const until = (input?.until ?? null) as
    | { duration?: { minutes?: number; hours?: number; days?: number } }
    | null;
  if (until?.duration) {
    const d = until.duration;
    const parts: string[] = [];
    if (d.days) parts.push(`${d.days}d`);
    if (d.hours) parts.push(`${d.hours}h`);
    if (d.minutes) parts.push(`${d.minutes}m`);
    return parts.join(" ") || "-";
  }
  return "-";
}

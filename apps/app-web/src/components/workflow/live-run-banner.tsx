"use client";

/**
 * Live-run activity banner (app-web) — the "an assistant is working on this
 * right now" strip on the workflow detail page. Renders while the tracked
 * run is non-terminal: a spinner (or pause glyph), which step of how many is
 * executing, a ticking elapsed clock, a per-step progress bar, and a link to
 * the run-detail drill-down.
 *
 * When the run is paused on an approval (`awaiting_input`), the banner is
 * also the resolution surface: it fetches the pending `workflow_step`
 * approval for this run, renders Approve / Reject in place, and a
 * collapsible request review that reuses the approvals queue's per-tool
 * preview (`ToolPreview` — an email send shows as an email) with the raw
 * frozen input as the fallback. Resolution goes through `respondByKind`
 * (the unified respond route resumes the run); `onApprovalResolved` lets
 * the page force a live-poll tick so the board unfreezes immediately.
 *
 * Data comes from `useWorkflowLiveRun`'s `LiveRunView`; beyond the approval
 * fetch this component is presentation plus a 1 s clock tick.
 *
 * Spec: docs/architecture/features/workflow.md → "Live run activity".
 * [COMP:app-web/workflow]
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useT } from "@/lib/i18n/client";
import { format as fmt } from "@/lib/i18n";
import type { StudioAssistantSummary } from "@/lib/api/studio";
import type { WorkflowDefinition, WorkflowStep } from "@/lib/api/workflow";
import {
  listApprovals,
  respondByKind,
  type PendingApprovalRow,
} from "@/lib/api/approvals";
import {
  APPROVALS_REFRESH_EVENT,
  requestApprovalsRefresh,
  type ApprovalsRefreshDetail,
} from "@/lib/approvals-events";
import {
  extractAttachmentLines,
  parseToolPreview,
} from "@/lib/approval-previews";
import { ToolPreview } from "@/components/doc/panels/approval-tool-previews";
import {
  elapsedLabel,
  isActivelyExecuting,
  type LiveRunView,
  type StepLiveState,
} from "@/lib/workflow-live-run";
import { cn } from "@/lib/utils";

type Props = {
  workspaceId: string;
  workflowId: string;
  view: LiveRunView;
  definition: WorkflowDefinition;
  assistants: StudioAssistantSummary[];
  /** Called after an in-banner approve/reject lands, so the page can force
   *  an immediate live-poll tick instead of waiting for the idle cadence. */
  onApprovalResolved?: () => void;
};

export function LiveRunBanner({
  workspaceId,
  workflowId,
  view,
  definition,
  assistants,
  onApprovalResolved,
}: Props) {
  const t = useT();
  const b = t.workflowPage.builder;
  const now = useNowTick();

  const steps = definition.steps;
  const total = steps.length;
  const currentIdx = view.currentStepId
    ? steps.findIndex((s) => s.id === view.currentStepId)
    : -1;
  // When the run row hasn't stamped a current step yet, infer position from
  // what already completed so the banner never says "Step 0".
  const k = Math.min(
    total,
    Math.max(1, currentIdx >= 0 ? currentIdx + 1 : view.completedCount + 1),
  );
  const currentStep = currentIdx >= 0 ? steps[currentIdx] : null;
  const active = isActivelyExecuting(view.status);
  const awaitingApproval = view.status === "awaiting_input";

  const statusText = active
    ? b.liveRunning
    : view.status === "awaiting_wait"
      ? b.livePausedWait
      : b.livePausedApproval;

  return (
    <div
      role="status"
      className={cn(
        "rounded-lg border px-4 py-3 flex flex-col gap-2.5",
        active
          ? "border-primary/40 bg-primary/5"
          : "border-amber-500/40 bg-amber-500/10",
      )}
    >
      <div className="flex items-center gap-2.5 flex-wrap">
        {active ? (
          <Spinner className="text-primary" />
        ) : (
          <PauseGlyph className="text-amber-600 dark:text-amber-400" />
        )}
        <span className="text-sm font-medium">{statusText}</span>
        <span className="text-xs text-muted-foreground">
          {fmt(b.liveStepOfTotal, { k: String(k), n: String(total) })}
        </span>
        {currentStep && (
          <span className="truncate max-w-[18rem] text-xs font-medium text-foreground/80">
            {stepDisplayLabel(currentStep, assistants, t)}
          </span>
        )}
        <span className="ml-auto flex items-center gap-3 text-xs text-muted-foreground">
          <span className="font-mono tabular-nums">
            {fmt(b.liveElapsed, { value: elapsedLabel(view.startedAt, now) })}
          </span>
          <Link
            href={`/w/${workspaceId}/workflow/${workflowId}/runs/${view.runId}`}
            className="font-medium text-primary hover:underline"
          >
            {b.liveViewRun}
          </Link>
        </span>
      </div>

      {/* Segmented per-step progress — one segment per definition step. */}
      {total > 0 && (
        <div className="flex gap-1" aria-hidden>
          {steps.map((s) => (
            <span
              key={s.id}
              className={cn(
                "h-1.5 flex-1 rounded-full transition-colors",
                segmentClass(view.stepStates[s.id]),
              )}
            />
          ))}
        </div>
      )}

      {awaitingApproval && (
        <RunApprovalActions
          workspaceId={workspaceId}
          runId={view.runId}
          onResolved={onApprovalResolved}
        />
      )}
    </div>
  );
}

/**
 * In-banner resolution for the approval a paused run is waiting on. Finds
 * the pending row whose `workflowRunId` matches the live run; renders
 * Approve / Reject plus a collapsible request review (per-tool preview with
 * the raw input fallback). Missing row (already resolved elsewhere, or the
 * queue fetch failed) renders nothing — the "View run" link still covers it.
 */
function RunApprovalActions({
  workspaceId,
  runId,
  onResolved,
}: {
  workspaceId: string;
  runId: string;
  onResolved?: () => void;
}) {
  const t = useT();
  const b = t.workflowPage.builder;
  const [approval, setApproval] = useState<PendingApprovalRow | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);

  // Another tab / the queue panel resolving the same row also clears it here.
  useEffect(() => {
    const handler = (ev: Event) => {
      const detail = (ev as CustomEvent<ApprovalsRefreshDetail>).detail;
      if (detail?.workspaceId && detail.workspaceId !== workspaceId) return;
      setRefreshTick((n) => n + 1);
    };
    window.addEventListener(APPROVALS_REFRESH_EVENT, handler);
    return () => window.removeEventListener(APPROVALS_REFRESH_EVENT, handler);
  }, [workspaceId]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const rows = await listApprovals(workspaceId);
      if (cancelled) return;
      setApproval(rows.find((r) => r.workflowRunId === runId) ?? null);
    })();
    return () => {
      cancelled = true;
    };
  }, [workspaceId, runId, refreshTick]);

  const respond = useCallback(
    async (decision: "approved" | "rejected") => {
      if (!approval) return;
      setBusy(true);
      setError(null);
      const result = await respondByKind(approval, decision);
      setBusy(false);
      if (!result.ok) {
        setError(
          "error" in result ? result.error : t.approvalsPage.respondError,
        );
        return;
      }
      setApproval(null);
      requestApprovalsRefresh(workspaceId);
      onResolved?.();
    },
    [approval, workspaceId, onResolved, t],
  );

  if (!approval) return null;

  const preview = parseToolPreview(approval.toolName, approval.arguments);
  const description = approval.approvalPayload.description?.trim();

  return (
    <div className="flex flex-col gap-2 border-t border-amber-500/30 pt-2.5">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-xs text-foreground/80 min-w-0 truncate">
          {description || approval.toolName}
        </span>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="text-xs font-medium text-primary hover:underline"
        >
          {open ? b.liveHideRequest : b.liveReviewRequest}
        </button>
        <span className="ml-auto flex items-center gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => void respond("approved")}
            className="text-xs px-3 py-1.5 rounded-md bg-primary text-primary-foreground font-medium hover:opacity-90 disabled:opacity-50"
          >
            {t.approvalsPage.approveAction}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void respond("rejected")}
            className="text-xs px-3 py-1.5 rounded-md border border-border bg-background font-medium hover:bg-muted disabled:opacity-50"
          >
            {t.approvalsPage.rejectAction}
          </button>
        </span>
      </div>
      {error && (
        <span className="text-xs text-red-600 dark:text-red-400">{error}</span>
      )}
      {open &&
        (preview ? (
          <ToolPreview
            preview={preview}
            attachmentLines={extractAttachmentLines(
              approval.approvalPayload.displayLines,
            )}
          />
        ) : (
          <pre className="w-full text-[11px] font-mono bg-background/60 border border-border rounded px-2 py-1.5 max-h-40 overflow-auto whitespace-pre-wrap break-all max-w-2xl">
            {JSON.stringify(approval.arguments, null, 2)}
          </pre>
        ))}
    </div>
  );
}

function segmentClass(state: StepLiveState | undefined): string {
  switch (state) {
    case "completed":
      return "bg-emerald-500";
    case "running":
      return "bg-primary animate-pulse";
    case "waiting":
      return "bg-amber-500 animate-pulse";
    case "failed":
      return "bg-red-500";
    case "skipped":
      return "bg-muted-foreground/40";
    default:
      return "bg-muted";
  }
}

/** Human step label: author description, else assistant name, else the id. */
function stepDisplayLabel(
  step: WorkflowStep,
  assistants: StudioAssistantSummary[],
  t: ReturnType<typeof useT>,
): string {
  const desc = step.description?.trim();
  if (desc) return desc;
  if (step.type === "assistant_call") {
    const ref = step.target.assistantId;
    if (ref === "primary") return t.workflowPage.board.primaryAssistant;
    const match = assistants.find((a) => a.id === ref);
    if (match) return match.name;
  }
  if (step.type === "tool_call" && step.toolName) return step.toolName;
  return step.id;
}

/** 1 s clock so the elapsed label ticks while the banner is mounted. */
function useNowTick(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(id);
  }, []);
  return now;
}

function Spinner({ className }: { className?: string }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      className={cn("animate-spin shrink-0", className)}
      aria-hidden
    >
      <path d="M21 12a9 9 0 1 1-6.2-8.56" />
    </svg>
  );
}

function PauseGlyph({ className }: { className?: string }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      className={cn("shrink-0", className)}
      aria-hidden
    >
      <path d="M9 5v14M15 5v14" />
    </svg>
  );
}

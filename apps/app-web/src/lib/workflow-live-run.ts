"use client";

/**
 * Live workflow-run activity — pure helpers + polling hook.
 *
 * The workflow detail page shows what an active run is doing *while it runs*:
 * which step the assistant is working on, what already finished, how long the
 * run has been going. The substrate is the existing REST surface — the
 * executor stamps `workflow_runs.current_step_id` as each step starts and
 * `workflow_step_runs` rows carry per-step status — so the client only needs
 * to poll (`GET /workflows/:id/runs` + `GET /workflows/:id/runs/:runId`), the
 * same idiom the run-detail page and `PageWorkflowRuns` already use, just at
 * a tighter cadence while a run is actively executing. No SSE/backend change:
 * polling also picks up runs started elsewhere (schedule / webhook / event),
 * which a push channel scoped to the "Run now" POST would miss.
 *
 * Cadence: 2.5 s while a run is actively executing (`pending` / `running`),
 * 15 s otherwise (so a schedule/webhook fire lights the page up within one
 * idle tick). A run paused on `awaiting_wait` / `awaiting_input` still gets
 * the live overlay but polls at the idle cadence — a wait can sleep for days.
 * Ticks are skipped while the tab is hidden.
 *
 * Spec: docs/architecture/features/workflow.md → "Live run activity".
 * [COMP:app-web/workflow-live-run]
 */

import { useEffect, useMemo, useRef, useState } from "react";
import {
  getWorkflowRun,
  listWorkflowRuns,
  type WorkflowRunDetail,
  type WorkflowRunSummary,
} from "@/lib/api/workflow";

export const ACTIVE_POLL_MS = 2500;
export const IDLE_POLL_MS = 15000;

export type RunStatus = WorkflowRunSummary["status"];

const TERMINAL: ReadonlySet<RunStatus> = new Set([
  "completed",
  "failed",
  "timeout",
]);

/** True when the run reached a terminal state (nothing will change again). */
export function isTerminalRunStatus(status: RunStatus): boolean {
  return TERMINAL.has(status);
}

/** True when the executor is actively advancing the run right now. */
export function isActivelyExecuting(status: RunStatus): boolean {
  return status === "pending" || status === "running";
}

/**
 * The run the live overlay should track: the newest non-terminal run.
 * Defensive about ordering — the API returns newest-first, but we sort by
 * `startedAt` desc anyway so a reordered payload can't pin an old run.
 */
export function pickLiveRun(
  runs: WorkflowRunSummary[],
): WorkflowRunSummary | null {
  const open = runs.filter((r) => !isTerminalRunStatus(r.status));
  if (open.length === 0) return null;
  return open.reduce((a, b) =>
    new Date(b.startedAt).getTime() > new Date(a.startedAt).getTime() ? b : a,
  );
}

/** Per-step live state the board overlays onto its nodes. */
export type StepLiveState =
  | "running"
  | "completed"
  | "failed"
  | "skipped"
  | "waiting";

export type LiveRunView = {
  runId: string;
  status: RunStatus;
  startedAt: string;
  currentStepId: string | null;
  /** Latest state per step id (a resumed step's newest row wins). */
  stepStates: Record<string, StepLiveState>;
  /** Steps that finished successfully — drives "step k of n" fallbacks. */
  completedCount: number;
};

/**
 * Collapse a run summary + (optional) step trail into the per-step overlay.
 * The trail is chronological, so the last row per step id wins — a step
 * re-executed after a wait/approval resume reflects its newest pass. The
 * run row's `currentStepId` is authoritative for "what is happening now":
 * it marks the running step even before its step-run row lands, and flips
 * to `waiting` when the run paused on a wait or approval.
 */
export function buildLiveRunView(
  run: WorkflowRunSummary,
  detail: WorkflowRunDetail | null,
): LiveRunView {
  const stepStates: Record<string, StepLiveState> = {};
  if (detail && detail.id === run.id) {
    for (const s of detail.steps) {
      switch (s.status) {
        case "completed":
          stepStates[s.stepId] = "completed";
          break;
        case "failed":
          stepStates[s.stepId] = "failed";
          break;
        case "skipped":
          stepStates[s.stepId] = "skipped";
          break;
        case "running":
        case "pending":
          stepStates[s.stepId] = "running";
          break;
      }
    }
  }

  const paused =
    run.status === "awaiting_wait" || run.status === "awaiting_input";
  if (run.currentStepId) {
    if (paused) {
      stepStates[run.currentStepId] = "waiting";
    } else if (isActivelyExecuting(run.status)) {
      // Don't downgrade a step the trail already resolved (completed/failed):
      // between "step finished" and "next step's row appears" the run row can
      // briefly still point at the finished step.
      const known = stepStates[run.currentStepId];
      if (known === undefined || known === "running") {
        stepStates[run.currentStepId] = "running";
      }
    }
  }

  const completedCount = Object.values(stepStates).filter(
    (s) => s === "completed",
  ).length;

  return {
    runId: run.id,
    status: run.status,
    startedAt: run.startedAt,
    currentStepId: run.currentStepId,
    stepStates,
    completedCount,
  };
}

/** Compact elapsed label — "8s", "1m 12s", "1h 04m". Never negative. */
export function elapsedLabel(startedIso: string, now: Date): string {
  const ms = Math.max(0, now.getTime() - new Date(startedIso).getTime());
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (min < 60) return `${min}m ${String(sec).padStart(2, "0")}s`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${h}h ${String(m).padStart(2, "0")}m`;
}

/**
 * Poll the workflow's runs and expose the live view. `forceActive` keeps the
 * fast cadence while the caller knows a run is (about to be) in flight — the
 * detail page passes its "Run now request in flight" flag, which covers the
 * gap before the new run row is visible. `pollNow()` forces an immediate
 * tick (pressed alongside the Run now POST).
 */
export function useWorkflowLiveRun(
  workflowId: string,
  opts: { forceActive?: boolean; limit?: number } = {},
): {
  runs: WorkflowRunSummary[] | null;
  liveRun: WorkflowRunSummary | null;
  liveView: LiveRunView | null;
  pollNow: () => void;
} {
  const { forceActive = false, limit = 10 } = opts;
  const [runs, setRuns] = useState<WorkflowRunSummary[] | null>(null);
  const [liveDetail, setLiveDetail] = useState<WorkflowRunDetail | null>(null);
  const [epoch, setEpoch] = useState(0);
  const forceActiveRef = useRef(forceActive);
  forceActiveRef.current = forceActive;

  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;

    const loop = async () => {
      if (cancelled) return;
      let active = forceActiveRef.current;
      const visible =
        typeof document === "undefined" ||
        document.visibilityState === "visible";
      if (visible) {
        try {
          const list = await listWorkflowRuns(workflowId, limit);
          if (cancelled) return;
          setRuns(list);
          const live = pickLiveRun(list);
          if (live) {
            active = active || isActivelyExecuting(live.status);
            const detail = await getWorkflowRun(workflowId, live.id);
            if (cancelled) return;
            if (detail) setLiveDetail(detail);
          } else {
            setLiveDetail(null);
          }
        } catch {
          // Transient fetch failure — keep the last known state and retry.
        }
      }
      if (cancelled) return;
      timer = window.setTimeout(loop, active ? ACTIVE_POLL_MS : IDLE_POLL_MS);
    };

    void loop();
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [workflowId, limit, epoch]);

  const liveRun = useMemo(() => pickLiveRun(runs ?? []), [runs]);
  const liveView = useMemo(() => {
    if (!liveRun) return null;
    return buildLiveRunView(
      liveRun,
      liveDetail && liveDetail.id === liveRun.id ? liveDetail : null,
    );
  }, [liveRun, liveDetail]);

  return {
    runs,
    liveRun,
    liveView,
    // Restarting the effect fires a fresh tick immediately.
    pollNow: () => setEpoch((n) => n + 1),
  };
}

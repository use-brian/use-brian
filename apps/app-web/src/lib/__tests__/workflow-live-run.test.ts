import { describe, it, expect } from "vitest";
import {
  buildLiveRunView,
  elapsedLabel,
  isActivelyExecuting,
  isTerminalRunStatus,
  pickLiveRun,
} from "@/lib/workflow-live-run";
import type {
  WorkflowRunDetail,
  WorkflowRunSummary,
  WorkflowStepRunDetail,
} from "@/lib/api/workflow";

/**
 * [COMP:app-web/workflow-live-run] live-run overlay derivation for the
 * workflow detail page.
 *
 * `pickLiveRun` selects the newest non-terminal run regardless of payload
 * order; `buildLiveRunView` collapses the chronological step trail into a
 * latest-state-per-step map, letting the run row's `currentStepId` mark the
 * in-flight step (running) or the pause point (waiting) without downgrading
 * steps the trail already resolved. `elapsedLabel` is the ticking clock.
 */

function run(partial: Partial<WorkflowRunSummary>): WorkflowRunSummary {
  return {
    id: "run-1",
    workflowId: "wf-1",
    triggerKind: "manual",
    status: "running",
    currentStepId: null,
    startedAt: "2026-07-02T10:00:00.000Z",
    finishedAt: null,
    error: null,
    ...partial,
  };
}

function stepRun(
  partial: Partial<WorkflowStepRunDetail> & { stepId: string },
): WorkflowStepRunDetail {
  return {
    id: `sr-${partial.stepId}`,
    type: "assistant_call",
    status: "completed",
    input: {},
    output: null,
    error: null,
    startedAt: "2026-07-02T10:00:01.000Z",
    finishedAt: null,
    ...partial,
  };
}

function detail(
  runId: string,
  steps: WorkflowStepRunDetail[],
): WorkflowRunDetail {
  return { ...run({ id: runId }), input: {}, vars: {}, steps };
}

describe("[COMP:app-web/workflow-live-run] pickLiveRun", () => {
  it("returns null when every run is terminal", () => {
    expect(
      pickLiveRun([
        run({ id: "a", status: "completed" }),
        run({ id: "b", status: "failed" }),
        run({ id: "c", status: "timeout" }),
      ]),
    ).toBeNull();
    expect(pickLiveRun([])).toBeNull();
  });

  it("picks the newest non-terminal run even when the list is out of order", () => {
    const picked = pickLiveRun([
      run({ id: "old", status: "running", startedAt: "2026-07-02T09:00:00Z" }),
      run({ id: "done", status: "completed", startedAt: "2026-07-02T11:00:00Z" }),
      run({ id: "new", status: "pending", startedAt: "2026-07-02T10:30:00Z" }),
    ]);
    expect(picked?.id).toBe("new");
  });

  it("treats paused runs (awaiting_wait / awaiting_input) as live", () => {
    expect(pickLiveRun([run({ status: "awaiting_wait" })])?.id).toBe("run-1");
    expect(pickLiveRun([run({ status: "awaiting_input" })])?.id).toBe("run-1");
  });
});

describe("[COMP:app-web/workflow-live-run] status predicates", () => {
  it("classifies terminal vs live vs actively-executing statuses", () => {
    expect(isTerminalRunStatus("completed")).toBe(true);
    expect(isTerminalRunStatus("failed")).toBe(true);
    expect(isTerminalRunStatus("timeout")).toBe(true);
    expect(isTerminalRunStatus("running")).toBe(false);
    expect(isTerminalRunStatus("awaiting_wait")).toBe(false);
    expect(isActivelyExecuting("pending")).toBe(true);
    expect(isActivelyExecuting("running")).toBe(true);
    expect(isActivelyExecuting("awaiting_wait")).toBe(false);
    expect(isActivelyExecuting("awaiting_input")).toBe(false);
  });
});

describe("[COMP:app-web/workflow-live-run] buildLiveRunView", () => {
  it("marks the current step running even before its step-run row exists", () => {
    const view = buildLiveRunView(
      run({ status: "running", currentStepId: "step_1" }),
      null,
    );
    expect(view.stepStates).toEqual({ step_1: "running" });
    expect(view.completedCount).toBe(0);
  });

  it("collapses the trail to the latest state per step, last row wins", () => {
    const view = buildLiveRunView(
      run({ status: "running", currentStepId: "step_2" }),
      detail("run-1", [
        stepRun({ stepId: "step_1", status: "completed" }),
        stepRun({ stepId: "step_2", status: "running" }),
      ]),
    );
    expect(view.stepStates).toEqual({
      step_1: "completed",
      step_2: "running",
    });
    expect(view.completedCount).toBe(1);
  });

  it("never downgrades a step the trail resolved, even when currentStepId lags", () => {
    // Between "step finished" and "next row inserted", the run row can still
    // point at the finished step — it must stay completed.
    const view = buildLiveRunView(
      run({ status: "running", currentStepId: "step_1" }),
      detail("run-1", [stepRun({ stepId: "step_1", status: "completed" })]),
    );
    expect(view.stepStates.step_1).toBe("completed");
  });

  it("flips the pause point to waiting on awaiting_wait / awaiting_input", () => {
    const waiting = buildLiveRunView(
      run({ status: "awaiting_wait", currentStepId: "step_wait" }),
      detail("run-1", [
        stepRun({ stepId: "step_1", status: "completed" }),
        stepRun({ stepId: "step_wait", status: "running", type: "wait" }),
      ]),
    );
    expect(waiting.stepStates.step_wait).toBe("waiting");

    const approval = buildLiveRunView(
      run({ status: "awaiting_input", currentStepId: "step_tool" }),
      null,
    );
    expect(approval.stepStates.step_tool).toBe("waiting");
  });

  it("ignores a step trail from a different run", () => {
    const view = buildLiveRunView(
      run({ id: "run-2", status: "running", currentStepId: "step_1" }),
      detail("run-1", [stepRun({ stepId: "step_9", status: "completed" })]),
    );
    expect(view.stepStates).toEqual({ step_1: "running" });
  });

  it("carries failed and skipped states through", () => {
    const view = buildLiveRunView(
      run({ status: "running", currentStepId: null }),
      detail("run-1", [
        stepRun({ stepId: "a", status: "failed" }),
        stepRun({ stepId: "b", status: "skipped" }),
      ]),
    );
    expect(view.stepStates).toEqual({ a: "failed", b: "skipped" });
  });
});

describe("[COMP:app-web/workflow-live-run] elapsedLabel", () => {
  const started = "2026-07-02T10:00:00.000Z";
  it("formats seconds, minutes and hours compactly", () => {
    expect(elapsedLabel(started, new Date("2026-07-02T10:00:08Z"))).toBe("8s");
    expect(elapsedLabel(started, new Date("2026-07-02T10:01:12Z"))).toBe(
      "1m 12s",
    );
    expect(elapsedLabel(started, new Date("2026-07-02T11:04:00Z"))).toBe(
      "1h 04m",
    );
  });

  it("clamps a clock-skewed negative delta to zero", () => {
    expect(elapsedLabel(started, new Date("2026-07-02T09:59:59Z"))).toBe("0s");
  });
});

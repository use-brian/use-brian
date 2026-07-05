"use client";

/**
 * Live-run activity banner (app-web) — the "an assistant is working on this
 * right now" strip on the workflow detail page. Renders while the tracked
 * run is non-terminal: a spinner (or pause glyph), which step of how many is
 * executing, a ticking elapsed clock, a per-step progress bar, and a link to
 * the run-detail drill-down. Data comes from `useWorkflowLiveRun`'s
 * `LiveRunView`; this component is pure presentation plus a 1 s clock tick.
 *
 * Spec: docs/architecture/features/workflow.md → "Live run activity".
 * [COMP:app-web/workflow]
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { useT } from "@/lib/i18n/client";
import { format as fmt } from "@/lib/i18n";
import type { StudioAssistantSummary } from "@/lib/api/studio";
import type { WorkflowDefinition, WorkflowStep } from "@/lib/api/workflow";
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
};

export function LiveRunBanner({
  workspaceId,
  workflowId,
  view,
  definition,
  assistants,
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

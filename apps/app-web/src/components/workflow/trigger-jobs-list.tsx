"use client";

/**
 * Read-only list of the ACTUAL scheduled-trigger rows firing a workflow
 * (`WorkflowFull.triggerJobs`, any member's) — the drift-surfacing companion
 * to the TriggerEditor. The `trigger` display column can disagree with the
 * firing rows (the 2026-06-10 incident: "manual" while two hourly crons
 * fired); when it does, an amber note says the rows are the truth. Rendered
 * on the workflow detail page whenever rows exist, edit mode or not.
 *
 * Spec: docs/architecture/features/workflow.md -> "Trigger surface".
 * [COMP:app-web/workflow]
 */

import { useT } from "@/lib/i18n/client";
import type { Dictionary } from "@/lib/i18n";
import type {
  ScheduleConfig,
  WorkflowTrigger,
  WorkflowTriggerJob,
} from "@/lib/api/workflow";
import { InfoTip } from "@/components/workflow/field";
import { cn } from "@/lib/utils";

function scheduleLabel(schedule: ScheduleConfig, t: Dictionary): string {
  const b = t.workflowPage.builder;
  switch (schedule.type) {
    case "once":
      return format(b.triggerJobsOnce, { datetime: schedule.datetime });
    case "daily":
      return format(b.triggerJobsDaily, { time: schedule.time });
    case "weekly":
      return format(b.triggerJobsWeekly, {
        days: schedule.days.join(", "),
        time: schedule.time,
      });
    case "monthly":
      return format(b.triggerJobsMonthly, {
        day: String(schedule.dayOfMonth),
        time: schedule.time,
      });
    case "cron":
      return format(b.triggerJobsCron, { expression: schedule.expression });
  }
}

function format(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? "");
}

export function TriggerJobsList({
  trigger,
  jobs,
}: {
  trigger: WorkflowTrigger;
  jobs: WorkflowTriggerJob[];
}) {
  const t = useT();
  const b = t.workflowPage.builder;
  if (jobs.length === 0) return null;

  const enabledJobs = jobs.filter((j) => j.enabled);
  // Drift: the display trigger disagrees with what actually fires.
  const driftManual = trigger.kind !== "schedule" && enabledJobs.length > 0;
  const duplicate = enabledJobs.length > 1;

  return (
    <div className="border border-border/60 rounded-xl bg-card overflow-hidden">
      <div className="px-4 py-2 border-b border-border/60 flex items-center gap-1.5">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/60">
          {b.triggerJobsHeading}
        </span>
        {/* The "these rows are the truth" explainer moved off the card body
            into a tip — visible on demand, no longer a standing paragraph. */}
        <InfoTip text={b.triggerJobsHint} />
      </div>
      <div className="p-4 flex flex-col gap-2">
        {driftManual && (
          <div className="text-xs rounded-md border border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400 px-3 py-2">
            {b.triggerJobsDriftManual}
          </div>
        )}
        {duplicate && (
          <div className="text-xs rounded-md border border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400 px-3 py-2">
            {b.triggerJobsDuplicate}
          </div>
        )}
        <ul className="flex flex-col gap-1.5">
          {jobs.map((j) => (
            <li
              key={j.id}
              className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm"
            >
              <span
                className={cn(
                  "inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium",
                  j.enabled
                    ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
                    : "bg-muted text-muted-foreground",
                )}
              >
                {j.enabled ? b.triggerJobsEnabled : b.triggerJobsPaused}
              </span>
              <span className="font-medium">{scheduleLabel(j.schedule, t)}</span>
              <span className="text-xs text-muted-foreground">{j.timezone}</span>
              <span className="text-xs text-muted-foreground">
                {format(b.triggerJobsNext, {
                  time: new Date(j.nextRunAt).toLocaleString(),
                })}
              </span>
              {!j.ownedByMe && (
                <span className="text-xs text-muted-foreground">
                  {b.triggerJobsTeammate}
                </span>
              )}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

"use client";

/**
 * Page-header schedule badge (migration 229).
 *
 * Surfaces the recurring "research & update this page" jobs the assistant set
 * up for the page in view — so a user can *see*, on the page itself, that it
 * refreshes daily at 07:00 (and when it last ran). One page can carry several
 * schedules (the FK lives on the job), so this lists them, soonest first.
 *
 * It's informational: the schedule is created and managed through the
 * assistant chat (the `createScheduledJob` / `updateScheduledJob` tools), not
 * edited from this surface — the popover says so. Data arrives on
 * `ViewMetadata.scheduledJobs` from `GET /api/views/:id`; the badge renders
 * nothing when there are none.
 *
 * Cadence formatting is split: `describeCadence` (pure, tested) normalises the
 * structured schedule; this component maps that to localised copy. Run times
 * use the browser's locale-aware date formatting.
 *
 * [COMP:app-web/schedule-badge]
 */

import { CalendarClock } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useT, useLocale, format } from "@/lib/i18n/client";
import { describeCadence } from "@/lib/schedule-cadence";
import type { ScheduledJobSummary } from "@/lib/api/views";

export function ScheduleBadge({ jobs }: { jobs: ScheduledJobSummary[] }) {
  const t = useT().docPage;
  const locale = useLocale();

  if (jobs.length === 0) return null;

  function cadenceLabel(job: ScheduledJobSummary): string {
    const c = describeCadence(job.schedule);
    switch (c.kind) {
      case "daily":
        return format(t.cadenceDaily, { time: c.time });
      case "weekly": {
        const days = c.dayIndexes
          .map((i) => t.scheduleDays[i] ?? "")
          .filter(Boolean)
          .join(", ");
        return format(t.cadenceWeekly, { days, time: c.time });
      }
      case "monthly":
        return format(t.cadenceMonthly, { day: c.dayOfMonth, time: c.time });
      case "cron":
        return format(t.cadenceCron, { expression: c.expression });
      case "once":
        return t.cadenceOnce;
      default:
        return t.cadenceUnknown;
    }
  }

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
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <button
            type="button"
            aria-label={t.scheduleBadgeAria}
            title={t.scheduleBadgeAria}
            className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground aria-expanded:bg-muted"
          >
            <CalendarClock className="size-4" aria-hidden />
            <span className="hidden sm:inline">{t.scheduleBadge}</span>
            {jobs.length > 1 && (
              <span className="ml-0.5 inline-flex min-w-4 items-center justify-center rounded-full bg-muted px-1 text-[0.625rem] font-semibold leading-4 text-muted-foreground">
                {jobs.length}
              </span>
            )}
          </button>
        }
      />
      <DropdownMenuContent className="w-80 max-w-[90vw]">
        <div className="px-2.5 py-2">
          <p className="text-sm font-semibold text-foreground">{t.scheduleTitle}</p>
          <p className="mt-1 text-xs text-muted-foreground">{t.scheduleHint}</p>
        </div>
        <DropdownMenuSeparator />
        <ul className="max-h-80 overflow-y-auto py-1">
          {jobs.map((job) => (
            <li key={job.id} className="px-2.5 py-2">
              <p className="text-sm font-medium text-foreground">{cadenceLabel(job)}</p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {format(t.scheduleNextRun, { when: fmtDate(job.nextRunAt) })}
              </p>
              <p className="text-xs text-muted-foreground">
                {job.lastRunAt
                  ? format(t.scheduleLastRun, { when: fmtDate(job.lastRunAt) })
                  : t.scheduleNeverRun}
              </p>
              {job.lastStatus === "failed" && (
                <p className="text-xs text-destructive">{t.scheduleStatusFailed}</p>
              )}
              {job.summary && (
                <p className="mt-1 line-clamp-2 text-xs text-muted-foreground/80">
                  {job.summary}
                </p>
              )}
            </li>
          ))}
        </ul>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

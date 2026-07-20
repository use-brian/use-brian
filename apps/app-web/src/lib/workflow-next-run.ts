/**
 * Next-run computation for the Workflow sidebar quick-switcher.
 *
 * The sidebar ranks the workspace's workflows soonest-next-run first, so it
 * needs a sortable timestamp for each one. `WorkflowSummary.trigger` carries the
 * `schedule` (a `ScheduleConfig` identical in shape to core's
 * `StructuredSchedule`), so the next fire time is derivable client-side. This is
 * a faithful port of `computeNextRun` from `packages/core/src/scheduling/schedule.ts`
 * — app-web deliberately does NOT depend on `@use-brian/core` (only
 * `@use-brian/shared` + `@use-brian/views-renderer`), the same reason the
 * `/api/views` SDK is duplicated rather than imported. Kept pure (Intl + Date
 * only, no React) so it's unit-testable.
 *
 * Crucial difference from the core version: this NEVER throws. The public
 * `workflowNextRun` returns `Date | null` — `null` for `manual` / `webhook` /
 * `event` triggers, a `once` schedule that has already fired, an unsupported
 * cron expression, or any malformed schedule. A `null` sorts last (no upcoming
 * run), so it can sit inside a `.sort()` comparator without crashing the render.
 *
 * The weekday-name map is shared with `lib/schedule-cadence.ts`
 * (`DAY_NAME_TO_INDEX`) rather than re-derived.
 *
 * [COMP:app-web/workflow-next-run]
 */

import type { ScheduleConfig, WorkflowTrigger } from "@/lib/api/workflow";
import { DAY_NAME_TO_INDEX } from "@/lib/schedule-cadence";

/**
 * The next fire time for a workflow, or `null` when there is no upcoming
 * scheduled run (non-schedule trigger, finished one-time run, unsupported
 * cron, or malformed schedule). `after` defaults to now; it's a parameter so
 * tests are deterministic.
 */
export function workflowNextRun(
  trigger: WorkflowTrigger,
  after: Date = new Date(),
): Date | null {
  if (trigger.kind !== "schedule") return null;
  const schedule = trigger.schedule;
  if (!schedule) return null;
  const timezone = trigger.timezone ?? "UTC";
  try {
    const next = computeNextRun(schedule, timezone, after);
    if (Number.isNaN(next.getTime())) return null;
    // A one-time schedule whose moment has passed will never fire again — it
    // has no "next run", so it sorts last alongside manual triggers.
    if (schedule.type === "once" && next.getTime() <= after.getTime()) {
      return null;
    }
    return next;
  } catch {
    // Unsupported cron expression or any other parse failure → no ranking.
    return null;
  }
}

/**
 * Comparator for ranking workflows soonest-next-run first. Workflows with no
 * upcoming run (`null`) sort to the end, preserving their relative order.
 */
export function compareByNextRun(
  a: Date | null,
  b: Date | null,
): number {
  if (a && b) return a.getTime() - b.getTime();
  if (a) return -1;
  if (b) return 1;
  return 0;
}

// ── Ported schedule math (mirror of packages/core/src/scheduling/schedule.ts) ──

function computeNextRun(
  schedule: ScheduleConfig,
  timezone: string,
  after: Date,
): Date {
  switch (schedule.type) {
    case "daily":
      return nextDailyRun(schedule.time, timezone, after);
    case "weekly":
      return nextWeeklyRun(schedule.days, schedule.time, timezone, after);
    case "monthly":
      return nextMonthlyRun(schedule.dayOfMonth, schedule.time, timezone, after);
    case "cron":
      return nextCronRun(schedule.expression, after);
    case "once":
      return parseOnceDateTime(schedule.datetime, timezone);
  }
}

function nextDailyRun(time: string, timezone: string, after: Date): Date {
  const [hours, minutes] = time.split(":").map(Number);
  const candidate = dateInTimezone(after, timezone, hours, minutes);
  if (candidate > after) return candidate;
  return dateInTimezone(
    new Date(after.getTime() + 24 * 60 * 60 * 1000),
    timezone,
    hours,
    minutes,
  );
}

function nextWeeklyRun(
  days: string[],
  time: string,
  timezone: string,
  after: Date,
): Date {
  const [hours, minutes] = time.split(":").map(Number);
  const targetDays = days
    .map((d) => DAY_NAME_TO_INDEX[d.toLowerCase()])
    .filter((d) => d !== undefined)
    .sort();

  if (targetDays.length === 0) return nextDailyRun(time, timezone, after);

  for (let offset = 0; offset <= 7; offset++) {
    const checkDate = new Date(after.getTime() + offset * 24 * 60 * 60 * 1000);
    const dayOfWeek = getLocalDay(checkDate, timezone);
    if (targetDays.includes(dayOfWeek)) {
      const candidate = dateInTimezone(checkDate, timezone, hours, minutes);
      if (candidate > after) return candidate;
    }
  }

  return nextWeeklyRun(
    days,
    time,
    timezone,
    new Date(after.getTime() + 7 * 24 * 60 * 60 * 1000),
  );
}

function nextMonthlyRun(
  dayOfMonth: number,
  time: string,
  timezone: string,
  after: Date,
): Date {
  const [hours, minutes] = time.split(":").map(Number);
  const candidate = dateInTimezoneWithDay(after, timezone, dayOfMonth, hours, minutes);
  if (candidate > after) return candidate;

  const nextMonth = new Date(after);
  nextMonth.setMonth(nextMonth.getMonth() + 1);
  return dateInTimezoneWithDay(nextMonth, timezone, dayOfMonth, hours, minutes);
}

/**
 * Simple cron parser — supports the same subset core does (`*`, `N`, `*​/N` on
 * the minute + hour fields). Anything else throws, and `workflowNextRun`'s
 * try/catch turns that into a `null` (sorted last) rather than a render crash.
 */
class UnsupportedCronExpressionError extends Error {}

type FieldSpec =
  | { kind: "any" }
  | { kind: "fixed"; value: number }
  | { kind: "step"; step: number };

function parseCronField(expr: string, max: number): FieldSpec {
  if (expr === "*") return { kind: "any" };
  const stepMatch = expr.match(/^\*\/(\d+)$/);
  if (stepMatch) {
    const step = parseInt(stepMatch[1], 10);
    if (!Number.isInteger(step) || step <= 0 || step > max) {
      throw new UnsupportedCronExpressionError();
    }
    return { kind: "step", step };
  }
  if (/^\d+$/.test(expr)) {
    const value = parseInt(expr, 10);
    if (!Number.isInteger(value) || value < 0 || value > max) {
      throw new UnsupportedCronExpressionError();
    }
    return { kind: "fixed", value };
  }
  throw new UnsupportedCronExpressionError();
}

function nextCronRun(expression: string, after: Date): Date {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) throw new UnsupportedCronExpressionError();
  const minuteSpec = parseCronField(parts[0], 59);
  const hourSpec = parseCronField(parts[1], 23);

  const candidate = new Date(after.getTime() + 60_000);
  candidate.setUTCSeconds(0, 0);

  const maxIterations = 60 * 24 * 32; // a month of minutes — upper bound
  for (let i = 0; i < maxIterations; i++) {
    if (cronMatches(candidate, minuteSpec, hourSpec)) {
      if (Number.isNaN(candidate.getTime())) {
        throw new UnsupportedCronExpressionError();
      }
      return candidate;
    }
    candidate.setUTCMinutes(candidate.getUTCMinutes() + 1);
  }
  throw new UnsupportedCronExpressionError();
}

function cronMatches(d: Date, minute: FieldSpec, hour: FieldSpec): boolean {
  const m = d.getUTCMinutes();
  const h = d.getUTCHours();
  if (minute.kind === "fixed" && m !== minute.value) return false;
  if (minute.kind === "step" && m % minute.step !== 0) return false;
  if (hour.kind === "fixed" && h !== hour.value) return false;
  if (hour.kind === "step" && h % hour.step !== 0) return false;
  return true;
}

function parseOnceDateTime(datetime: string, timezone: string): Date {
  // Strip any timezone suffix — the separate `timezone` param is authoritative
  // (mirrors core; LLM-authored datetimes often append a stray "Z").
  const bare = datetime.replace(/Z|[+-]\d{2}:\d{2}$/, "");
  const match = bare.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!match) return new Date(datetime);

  const [, year, month, day, hoursStr, minutesStr] = match;
  const hours = parseInt(hoursStr, 10);
  const minutes = parseInt(minutesStr, 10);
  const noonUtc = new Date(`${year}-${month}-${day}T12:00:00Z`);
  return dateInTimezone(noonUtc, timezone, hours, minutes);
}

// ── Timezone helpers (verbatim from core) ──────────────────────────────────

function dateInTimezone(
  baseDate: Date,
  timezone: string,
  hours: number,
  minutes: number,
): Date {
  const dateStr = baseDate.toLocaleDateString("en-CA", { timeZone: timezone });
  const target = new Date(`${dateStr}T${pad(hours)}:${pad(minutes)}:00`);

  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts = formatter.formatToParts(target);
  const localStr = `${getPart(parts, "year")}-${getPart(parts, "month")}-${getPart(parts, "day")}T${getPart(parts, "hour")}:${getPart(parts, "minute")}:00`;

  const local = new Date(localStr);
  const offset = target.getTime() - local.getTime();
  return new Date(target.getTime() + offset);
}

function dateInTimezoneWithDay(
  baseDate: Date,
  timezone: string,
  day: number,
  hours: number,
  minutes: number,
): Date {
  const dateStr = baseDate.toLocaleDateString("en-CA", { timeZone: timezone });
  const [year, month] = dateStr.split("-");
  const clampedDay = Math.min(day, daysInMonth(parseInt(year), parseInt(month)));
  const targetStr = `${year}-${month}-${pad(clampedDay)}T${pad(hours)}:${pad(minutes)}:00`;
  const target = new Date(targetStr);

  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts = formatter.formatToParts(target);
  const localStr = `${getPart(parts, "year")}-${getPart(parts, "month")}-${getPart(parts, "day")}T${getPart(parts, "hour")}:${getPart(parts, "minute")}:00`;
  const local = new Date(localStr);
  const offset = target.getTime() - local.getTime();
  return new Date(target.getTime() + offset);
}

function getLocalDay(date: Date, timezone: string): number {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "long",
  });
  const dayName = formatter.format(date).toLowerCase();
  return DAY_NAME_TO_INDEX[dayName] ?? 0;
}

function getPart(parts: Intl.DateTimeFormatPart[], type: string): string {
  return parts.find((p) => p.type === type)?.value ?? "00";
}

function pad(n: number): string {
  return n.toString().padStart(2, "0");
}

function daysInMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate();
}

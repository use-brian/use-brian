/**
 * Pure cadence normaliser for the page-header schedule badge (migration 229).
 *
 * Turns a `ScheduleSpec` (the structured cadence carried by a scheduled job,
 * mirrored from `packages/core/src/scheduling/schedule.ts`) into a small,
 * locale-agnostic descriptor the badge component can render via i18n. Keeping
 * this pure (no i18n, no Date) is what makes it unit-testable — the component
 * maps the descriptor's `kind` to a template string and maps `dayIndexes` to
 * localised day labels.
 *
 * The real logic worth testing lives here: parsing the weekly day-name strings
 * into ordered, de-duped weekday indexes (0 = Sunday … 6 = Saturday, matching
 * `Date.getDay()` and the dictionary's `schedule.days` array), clamping the
 * monthly day-of-month, and defensively collapsing a malformed schedule to
 * `{ kind: "unknown" }` rather than throwing.
 *
 * [COMP:app-web/schedule-cadence]
 */

import type { ScheduleSpec } from "@/lib/api/views";

/**
 * Lowercase English weekday name → `Date.getDay()` index (0 = Sunday).
 * Exported so the sibling next-run helper (`lib/workflow-next-run.ts`) parses
 * weekly schedules against the same map rather than re-deriving it.
 */
export const DAY_NAME_TO_INDEX: Record<string, number> = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
};

/**
 * Normalised cadence — the badge component switches on `kind`. Times are the
 * raw `HH:MM` strings from the schedule (the badge shows them verbatim);
 * `dayIndexes` are sorted + de-duped weekday indexes for the component to map
 * to localised short labels.
 */
export type CadenceDescriptor =
  | { kind: "once" }
  | { kind: "daily"; time: string }
  | { kind: "weekly"; dayIndexes: number[]; time: string }
  | { kind: "monthly"; dayOfMonth: number; time: string }
  | { kind: "cron"; expression: string }
  | { kind: "unknown" };

/**
 * Parse the weekly `days` array into ordered, de-duped weekday indexes.
 * Unknown / malformed entries are ignored (defensive — the data crosses a
 * JSONB boundary). Case-insensitive; trims surrounding whitespace.
 */
function parseDayIndexes(days: unknown): number[] {
  if (!Array.isArray(days)) return [];
  const seen = new Set<number>();
  for (const d of days) {
    if (typeof d !== "string") continue;
    const idx = DAY_NAME_TO_INDEX[d.trim().toLowerCase()];
    if (idx !== undefined) seen.add(idx);
  }
  return [...seen].sort((a, b) => a - b);
}

export function describeCadence(schedule: ScheduleSpec): CadenceDescriptor {
  switch (schedule?.type) {
    case "once":
      return { kind: "once" };
    case "daily":
      return { kind: "daily", time: schedule.time };
    case "weekly":
      return {
        kind: "weekly",
        dayIndexes: parseDayIndexes(schedule.days),
        time: schedule.time,
      };
    case "monthly":
      return {
        kind: "monthly",
        // Clamp to a real day-of-month; the server already clamps to the
        // target month's length, but guard the display against bad data.
        dayOfMonth: Math.min(31, Math.max(1, Math.trunc(schedule.dayOfMonth))),
        time: schedule.time,
      };
    case "cron":
      return { kind: "cron", expression: schedule.expression };
    default:
      return { kind: "unknown" };
  }
}
